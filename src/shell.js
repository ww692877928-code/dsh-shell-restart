/**
 * 纯逻辑层：**不碰文件系统、不执行命令**，因此可以用表驱动测试穷举。
 *
 * 这里沉淀的是整套自助重启里"用血换来的"约束 —— 每一条都对应一次真实失败：
 *
 *   1. agent 直接杀宿主 = 杀掉执行自己的进程，后面的"重新拉起"没人执行
 *      → 必须交给任务计划程序（schtasks）在外部触发
 *   2. agent 自己 Start-Process 的子进程活不过那一轮命令（DSH 用作业对象托管）
 *      → 所以插件只"排任务"，不"等结果"
 *   3. 只能按 PID 杀，绝不能 taskkill /T
 *      → /T 会把启动者连同父进程一起带走
 *   4. 拉起时必须带应用目录参数
 *      → 漏了 electron.exe 会启动自带的欢迎应用，且不会拉起任何 dsh
 *   5. 用 WMI 创建而不是 Start-Process
 *      → Start-Process 让应用继承脚本控制台，任务计划会留一个黑窗口（误点 × 还会连带杀掉应用）
 *   6. 拉起前要清残留实例、等端口释放
 *      → 否则新实例被单实例锁挡下，或新 dsh 绑不上端口，应用 90 秒后弹窗退出
 */

/** 计划任务名（固定，便于取消与查询）。 */
export const TASK_NAME = 'DshDesktopSelfRestart';
/** 默认延迟：给"排任务"那一轮对话留出把消息送到用户面前的时间。 */
export const DEFAULT_DELAY_SECONDS = 120;
export const MIN_DELAY_SECONDS = 30;
export const MAX_DELAY_SECONDS = 3600;

/** PowerShell 单引号字符串转义：内部单引号要写成两个。 */
export function psQuote(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

/** UTF-8 BOM。写 .ps1 必须带它 —— 见 withBom 的说明。 */
export const UTF8_BOM = '\uFEFF';

/**
 * 给文本加 UTF-8 BOM（已有则不重复加）。
 *
 * 为什么必须：Windows PowerShell 5.1 读**无 BOM** 的 .ps1 会按系统 ANSI 码页（本机是 GBK）解码。
 * 脚本里有中文时 → 轻则日志乱码，重则被解出非法语法而直接退出（真实踩过：
 * 一个坏脚本因为"解析检查"用错 API 而连起了两次）。所以生成 .ps1 一律带 BOM。
 */
export function withBom(text) {
  const value = String(text);
  return value.startsWith(UTF8_BOM) ? value : UTF8_BOM + value;
}

/**
 * 从 electron 进程的命令行解析出「可执行文件 / 原始启动参数 / 应用目录」。
 *
 * 为什么要保留**原始启动参数**而不是自己拼应用目录：这样打包版也能支持 ——
 * 开发版是 `electron.exe .`（或跟一个目录），打包版是 `DSH 桌面端.exe`（没有参数）。
 * 照抄原参数比假设形态更不容易错。
 *
 * @param {string} commandLine 形如 `"D:\...\electron.exe" .` 或 `"D:\...\electron.exe" "D:\app"`。
 */
export function parseElectronCommandLine(commandLine) {
  const text = String(commandLine ?? '').trim();
  if (!text) return { exe: undefined, launchArgs: '', appDir: undefined, appDirSource: 'empty' };
  const tokens = [];
  const re = /"([^"]*)"|(\S+)/g;
  let match;
  while ((match = re.exec(text)) !== null) tokens.push(match[1] ?? match[2]);
  const exe = tokens[0];
  if (!exe) return { exe: undefined, launchArgs: '', appDir: undefined, appDirSource: 'empty' };

  const rest = tokens.slice(1);
  // 给"像路径的参数"一律加引号：宁可多加，也别让路径里的空格/&/括号把命令行拆坏。
  const launchArgs = rest.length === 0
    ? ''
    : ` ${rest.map((token) => (/^[A-Za-z]:[\\/]|^\\\\|[\s&()^]/.test(token) ? `"${token}"` : token)).join(' ')}`;

  // 应用目录：优先取第一个绝对路径参数；`.` 或没有参数时按 exe 位置反推
  // （开发版布局：<appDir>\node_modules\electron\dist\electron.exe）
  let appDir;
  let appDirSource = 'derived-from-exe';
  const firstPathLike = rest.find((token) => /^[A-Za-z]:[\\/]|^\\\\/.test(token));
  if (firstPathLike) {
    appDir = firstPathLike.replace(/[\\/]+$/, '');
    appDirSource = 'argv';
  } else {
    const parts = exe.split(/[\\/]/);
    const idx = parts.findIndex((part, i) => part === 'node_modules' && parts[i + 1] === 'electron');
    if (idx > 0) appDir = parts.slice(0, idx).join('\\');
    else {
      appDir = parts.slice(0, -1).join('\\') || undefined;
      appDirSource = 'dir-of-exe';
    }
  }
  return { exe, launchArgs, appDir, appDirSource };
}

/** 把延迟收敛到 [MIN, MAX]，非法值退回默认并给出告警。 */
export function normalizeDelay(value) {
  const warnings = [];
  if (value === undefined || value === null) {
    return { seconds: DEFAULT_DELAY_SECONDS, warnings };
  }
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return { seconds: DEFAULT_DELAY_SECONDS, warnings: [`delay_seconds 不是数字（收到 ${typeof value}），已用默认值 ${DEFAULT_DELAY_SECONDS}`] };
  }
  let seconds = Math.round(value);
  if (seconds < MIN_DELAY_SECONDS) {
    warnings.push(`delay_seconds=${seconds} 太短，已提升到 ${MIN_DELAY_SECONDS}（否则消息还没送到页面就断了）`);
    seconds = MIN_DELAY_SECONDS;
  }
  if (seconds > MAX_DELAY_SECONDS) {
    warnings.push(`delay_seconds=${seconds} 太长，已截断到 ${MAX_DELAY_SECONDS}`);
    seconds = MAX_DELAY_SECONDS;
  }
  return { seconds, warnings };
}

/**
 * 计算任务的启动时刻。
 *
 * schtasks /SC ONCE 的粒度为**分钟**，所以必须向上取整到整分钟，并保证
 * 实际延迟 **不小于** 请求的延迟（宁可晚一点，也不能早到把消息截断）。
 *
 * @param {Date} now 当前时间。
 * @param {number} delaySeconds 期望延迟秒数。
 * @returns {{hhmm: string, target: Date, actualDelaySeconds: number}}
 */
export function computeStartTime(now, delaySeconds) {
  const desired = new Date(now.getTime() + delaySeconds * 1000);
  // 秒/毫秒不为 0 就进位到下一分钟
  const target = new Date(desired.getTime());
  if (target.getSeconds() !== 0 || target.getMilliseconds() !== 0) {
    target.setSeconds(0, 0);
    target.setMinutes(target.getMinutes() + 1);
  }
  const hh = String(target.getHours()).padStart(2, '0');
  const mm = String(target.getMinutes()).padStart(2, '0');
  return {
    hhmm: `${hh}:${mm}`,
    target,
    actualDelaySeconds: Math.round((target.getTime() - now.getTime()) / 1000),
  };
}

/** 生成 schtasks 创建任务的参数数组（用数组而不是拼字符串，避免引号地狱）。 */
export function buildCreateArgs({ taskName = TASK_NAME, scriptPath, hhmm }) {
  const action = `powershell.exe -NoProfile -ExecutionPolicy Bypass -File "${scriptPath}"`;
  return ['/Create', '/TN', taskName, '/TR', action, '/SC', 'ONCE', '/ST', hhmm, '/F'];
}

/** 生成删除任务的参数数组。 */
export function buildDeleteArgs(taskName = TASK_NAME) {
  return ['/Delete', '/TN', taskName, '/F'];
}

/**
 * 生成重启助手脚本全文（值全部烘入，不再走命令行参数 —— 参数丢失是踩过的坑）。
 * @param {{exe: string, appDir: string, launchArgs: string, logPath: string, delaySeconds: number,
 *          appPid: number, dshPids?: number[], portRange?: [number, number]}} values
 */
export function buildHelperScript({ exe, appDir, launchArgs = '', logPath, delaySeconds, appPid, dshPids = [], portRange = [3080, 3083] }) {
  // 为什么 appPid 必须显式给出：探针已经**确切知道**谁是宿主，助手脚本没有理由再按命令行字符串猜一遍。
  // 上一版是按 `*dsh-desktop*` 猜的 —— 那是我这台机器的目录名；换到别人的桌面端会找不到宿主，
  // 于是"只杀了 dsh、没杀宿主"，留下一个窗口还在但后端已死的残缺状态（比重启失败更糟）。
  if (!Number.isFinite(appPid) || appPid <= 0) {
    throw new Error('buildHelperScript: 必须提供宿主 appPid（探针已确认宿主，助手脚本不应再猜）');
  }
  const dshList = (Array.isArray(dshPids) ? dshPids : []).filter((pid) => Number.isFinite(pid) && pid > 0);
  const [portLow, portHigh] = Array.isArray(portRange) && portRange.length === 2 ? portRange : [3080, 3083];
  return `# 由 dsh-shell-restart 插件生成的自助重启助手（值已烘入，勿手改）。
#
# 只按 PID 杀、绝不用 taskkill /T：/T 会把启动者连同父进程一起带走。
# 先停 dsh 再停宿主：强杀宿主不会替我们清理它 spawn 的 dsh，那个 node 会继续占着端口。
# 拉起用 WMI 而不是 Start-Process：后者让应用继承本脚本的控制台，任务计划会留下黑窗口。
# 宿主与 dsh 都由探针给定 PID，脚本不再靠命令行字符串猜（那会把别人机器上的目录名绑死）。
$ErrorActionPreference = 'Continue'
$Exe = ${psQuote(exe)}
$WorkDir = ${psQuote(appDir)}
$LaunchArgs = ${psQuote(launchArgs)}
$LogPath = ${psQuote(logPath)}
$DelaySeconds = ${Number(delaySeconds)}
$AppPid = ${Number(appPid)}
$DshPids = @(${dshList.join(', ')})
$PortLow = ${Number(portLow)}
$PortHigh = ${Number(portHigh)}

function Write-Log {
  param([string]$Message)
  $line = (Get-Date -Format 'HH:mm:ss') + ' ' + $Message
  try { Add-Content -Path $LogPath -Value $line -Encoding UTF8 } catch { }
}

Write-Log ('助手启动：自身 pid=' + $PID + '，延迟 ' + $DelaySeconds + ' 秒')
Start-Sleep -Seconds $DelaySeconds

Write-Log ('目标宿主 pid=' + $AppPid + '，待停 dsh: ' + ($DshPids -join ', ') + '，端口范围 ' + $PortLow + '-' + $PortHigh)

# 1) 先停 dsh：强杀宿主不会替我们清理它 spawn 的 dsh，那个 node 会继续占着端口。
#    按探针给定的 PID 停，不做任何字符串猜测；找不到就补一次"宿主的子进程"扫描兜底。
$stopped = 0
foreach ($dshPid in $DshPids) {
  if (Get-Process -Id $dshPid -ErrorAction SilentlyContinue) {
    Write-Log ('停止 dsh 子进程 pid=' + $dshPid)
    Stop-Process -Id $dshPid -Force -ErrorAction SilentlyContinue
    $stopped = $stopped + 1
  }
}
if ($stopped -eq 0) {
  $children = @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
    Where-Object { $_.ParentProcessId -eq $AppPid })
  foreach ($child in $children) {
    Write-Log ('兜底：停止宿主的 node 子进程 pid=' + $child.ProcessId)
    Stop-Process -Id $child.ProcessId -Force -ErrorAction SilentlyContinue
  }
}
Start-Sleep -Seconds 2

# 2) 再停宿主（同样只按 PID）
Write-Log ('停止宿主 pid=' + $AppPid)
Stop-Process -Id $AppPid -Force -ErrorAction SilentlyContinue
Start-Sleep -Seconds 4

# 3) 残留清理：按**可执行文件路径**找同源实例 —— 这是通用的（任何桌面端都有自己的 exe 路径），
#    不依赖目录名，也不会误伤别的 Electron 应用。
$leftover = @(Get-CimInstance Win32_Process -Filter "Name='electron.exe'" |
  Where-Object { $_.ExecutablePath -eq $Exe -and $_.CommandLine -notlike '*--type=*' })
foreach ($item in $leftover) {
  Write-Log ('发现残留应用实例，一并清理 pid=' + $item.ProcessId)
  Stop-Process -Id $item.ProcessId -Force -ErrorAction SilentlyContinue
}
if ($leftover.Count -gt 0) { Start-Sleep -Seconds 2 }

$portWait = 0
$busy = @()
while ($portWait -lt 20) {
  $busy = @(Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue |
    Where-Object { $_.LocalPort -ge $PortLow -and $_.LocalPort -le $PortHigh })
  if ($busy.Count -eq 0) { break }
  Start-Sleep -Seconds 1
  $portWait = $portWait + 1
}
if ($busy.Count -eq 0) {
  Write-Log ('端口 ' + $PortLow + '-' + $PortHigh + ' 已释放（等待 ' + $portWait + ' 秒）')
} else {
  Write-Log ('端口仍被占用，等待 ' + $portWait + ' 秒后放弃：' + (($busy | ForEach-Object { $_.LocalPort }) -join ', '))
  Write-Log ('   提示：若长期被别的程序占用，可在插件 config 里把 portRange 改到别的区间')
}

if (-not (Test-Path $Exe)) {
  Write-Log ('找不到可执行文件：' + $Exe)
  exit 1
}

Write-Log ('重新拉起：' + $Exe + $LaunchArgs + ' （工作目录 ' + $WorkDir + '）')
$launchLine = '"' + $Exe + '"' + $LaunchArgs
$launched = $false
$NewAppPid = 0
try {
  $created = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{
    CommandLine = $launchLine
    CurrentDirectory = $WorkDir
  }
  if ($created.ReturnValue -eq 0) {
    $NewAppPid = $created.ProcessId
    Write-Log ('拉起成功：pid=' + $NewAppPid + '（WMI 创建，未继承控制台）')
    $launched = $true
  } else {
    Write-Log ('WMI 拉起失败：ReturnValue=' + $created.ReturnValue)
  }
} catch {
  Write-Log ('WMI 拉起异常：' + $_.Exception.Message)
}
if (-not $launched) {
  Write-Log '回退：改用 Start-Process（会带出一个黑窗口，但至少能起来）'
  try {
    $fallback = Start-Process -FilePath $Exe -ArgumentList $WorkDir -WorkingDirectory $WorkDir -PassThru
    if ($fallback) { $NewAppPid = $fallback.Id }
    Write-Log '回退拉起命令已发出'
  } catch {
    Write-Log ('回退拉起也失败：' + $_.Exception.Message)
  }
}

# 新 dsh 的判定：优先"新宿主的直接子进程"（精确且通用），再用 DSH 包名兜底。
# 注意包名兜底是通用的（任何机器上 DSH 的安装路径都含 deepseek-ai），而"目录名"不是。
$dshWait = 0
$newDsh = @()
while ($dshWait -lt 45) {
  if ($NewAppPid -gt 0) {
    $newDsh = @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
      Where-Object { $_.ParentProcessId -eq $NewAppPid -and $_.CommandLine -notlike '*subprocess-local*' })
  }
  if ($newDsh.Count -eq 0) {
    $newDsh = @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
      Where-Object { $_.CommandLine -like '*deepseek-ai*' -and $_.CommandLine -notlike '*subprocess-local*' })
  }
  if ($newDsh.Count -gt 0) { break }
  Start-Sleep -Seconds 2
  $dshWait = $dshWait + 2
}
Write-Log ('等待 dsh 出现用了 ' + $dshWait + ' 秒')
$newMain = @(Get-CimInstance Win32_Process -Filter "Name='electron.exe'" |
  Where-Object { $_.ExecutablePath -eq $Exe -and $_.CommandLine -notlike '*--type=*' })

$mainText = ''
foreach ($item in $newMain) { $mainText = $mainText + 'pid=' + $item.ProcessId + ' ' }
$dshText = ''
foreach ($item in $newDsh) {
  $port = '?'
  if ($item.CommandLine -match '--port (\\d+)') { $port = $matches[1] }
  $dshText = $dshText + 'pid=' + $item.ProcessId + '/端口=' + $port + ' '
}
Write-Log ('新宿主：' + $mainText)
Write-Log ('新 dsh ：' + $dshText)
if ($newDsh.Count -eq 0) {
  Write-Log '45 秒内没出现 dsh 子进程：这次重启等于没成功。排查顺序：'
  Write-Log '   1) 是否漏传应用目录参数（漏了会拉起 Electron 自带欢迎应用）'
  Write-Log ('   2) 端口 ' + $PortLow + '-' + $PortHigh + ' 是否被别的进程占着（新 dsh 绑不上，应用会等 90 秒后弹窗退出）')
  Write-Log '   3) 应用窗口上是否弹了启动失败对话框，看它的提示文字'
}
Write-Log '助手结束'
`;
}

/**
 * 判定"现在能不能重启"。纯函数，便于测试各种拒绝场景。
 * @param {object} probe 探针结果（见 win.js 的 probe()）。
 * @returns {{canRestart: boolean, reason: string}}
 */
export function assessProbe(probe) {
  if (!probe || typeof probe !== 'object') {
    return { canRestart: false, reason: '探针没有返回任何结果（无法判断当前是否运行在桌面外壳里）' };
  }
  if (probe.platform && probe.platform !== 'win32') {
    return { canRestart: false, reason: `当前平台是 ${probe.platform}，本插件的重启流程只实现了 Windows（依赖任务计划程序 + WMI）` };
  }
  if (!probe.appPid) {
    return {
      canRestart: false,
      reason: '没找到桌面外壳进程：当前宿主不是由 DSH 桌面端启动的（很可能是命令行 dsh web）。'
        + '命令行宿主的重启请直接用终端操作，不需要本工具。',
    };
  }
  if (!probe.appExe) {
    return { canRestart: false, reason: '找到了桌面外壳进程，但它的命令行里解析不出可执行文件路径' };
  }
  return { canRestart: true, reason: 'ok' };
}

/** 把探针结果整理成"重启前基线"一行文字。 */
export function summarizeBaseline(probe) {
  const parts = [];
  parts.push(`应用 pid=${probe.appPid}${probe.appParent ? `（父=${probe.appParent}）` : ''}`);
  parts.push(probe.dshPids && probe.dshPids.length ? `dsh pid=${probe.dshPids.join(', ')}` : 'dsh 未识别');
  parts.push(probe.listeners && probe.listeners.length ? `监听 ${probe.listeners.join(', ')}` : '无监听端口');
  return parts.join('；');
}

/** 把探针结果整理成人类可读的状态报告。 */
export function formatStatus(probe, logTail = []) {
  const lines = [];
  lines.push('DSH 桌面外壳状态');
  lines.push(`  平台: ${probe.platform}`);
  lines.push(`  应用: ${probe.appPid ? `pid=${probe.appPid} 父=${probe.appParent ?? '?'}` : '未运行'}`);
  if (probe.appExe) lines.push(`  可执行: ${probe.appExe}`);
  if (probe.appDir) lines.push(`  工作目录: ${probe.appDir}`);
  lines.push(`  dsh 子进程: ${probe.dshPids && probe.dshPids.length ? probe.dshPids.join(', ') : '无'}`);
  lines.push(`  监听端口: ${probe.listeners && probe.listeners.length ? probe.listeners.join(', ') : '无'}`);
  lines.push(`  可见控制台窗口: ${probe.consoleWindows ?? 0} 个`);
  lines.push(`  待执行的重启任务: ${probe.pendingTask ? `${probe.pendingTask.name} @ ${probe.pendingTask.nextRun ?? '?'}` : '无'}`);
  if (probe.helperLog) lines.push(`  助手日志: ${probe.helperLog}`);
  if (logTail.length > 0) {
    lines.push('  最近的重启记录:');
    for (const line of logTail) lines.push(`    ${line}`);
  }
  return lines.join('\n');
}
