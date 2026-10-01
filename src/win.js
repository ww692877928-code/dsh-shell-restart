/**
 * 执行层：所有跟 Windows 打交道的动作都集中在这里（探针 / 写助手脚本 / 排任务 / 删任务）。
 *
 * 设计约束（都是实测结论，不是偏好）：
 *   - **只排任务，不等结果**。本插件跑在宿主进程里，宿主要被重启 —— 想"等它重启完再回报"
 *     等于等自己被杀死。所以工具只负责把任务排上，然后把时间、基线、日志路径交出去。
 *   - **绝不 taskkill /T**：会把启动者连同父进程一起带走。
 *   - **schtasks 用参数数组**（`execFile`），不拼命令行字符串 —— 路径带空格时拼字符串必炸。
 */
import { execFile } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { TASK_NAME, buildCreateArgs, buildDeleteArgs, withBom } from './shell.js';

/**
 * 助手日志与脚本的落点（放 LOCALAPPDATA，避免污染项目目录）。
 * 允许用环境变量重定向 —— 测试要能验"写出来的真实字节"，又不该覆盖正在用的那份脚本。
 */
export function stateDir() {
  const override = process.env.DSH_DESKTOP_RESTART_DIR;
  if (override) return override;
  const base = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  return path.join(base, 'dsh-shell-restart');
}

export function helperScriptPath() {
  return path.join(stateDir(), 'restart-shell.ps1');
}

export function helperLogPath() {
  return path.join(stateDir(), 'restart-helper.log');
}

/** 跑一段 PowerShell 并取回 stdout（失败时把 stderr 一起回传，便于诊断）。 */
export function runPowerShell(script, { timeoutMs = 30000 } = {}) {
  return new Promise((resolve, reject) => {
    execFile(
      'powershell.exe',
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
      { timeout: timeoutMs, windowsHide: true, maxBuffer: 8 * 1024 * 1024, encoding: 'utf8' },
      (error, stdout, stderr) => {
        if (error && !stdout) {
          reject(new Error(`PowerShell 执行失败：${error.message}${stderr ? ` / ${String(stderr).trim()}` : ''}`));
          return;
        }
        resolve(String(stdout ?? ''));
      },
    );
  });
}

/** 跑一个可执行文件（用于 schtasks），参数走数组。 */
export function runExe(file, args, { timeoutMs = 30000 } = {}) {
  return new Promise((resolve) => {
    execFile(file, args, { timeout: timeoutMs, windowsHide: true, maxBuffer: 4 * 1024 * 1024, encoding: 'utf8' },
      (error, stdout, stderr) => resolve({
        code: error && typeof error.code === 'number' ? error.code : (error ? 1 : 0),
        stdout: String(stdout ?? ''), stderr: String(stderr ?? ''), failed: Boolean(error),
      }));
  });
}

/**
 * 收集一次环境快照。返回的是**原始事实**，是否可重启由 shell.assessProbe() 判断。
 * @param {number} hostPid 当前宿主进程 pid（插件就跑在它里面）。
 */
export async function probe(hostPid) {
  const script = `
$ErrorActionPreference = 'SilentlyContinue'
$out = [ordered]@{}
$out.platform = 'win32'
$out.hostPid = ${Number(hostPid)}

# 沿父进程链找 electron 祖先 —— 桌面外壳就是它。找不到说明宿主不是桌面端拉起的。
$cur = ${Number(hostPid)}
$names = @()
for ($i = 0; $i -lt 12 -and $cur -gt 0; $i++) {
  $p = Get-CimInstance Win32_Process -Filter "ProcessId=$cur"
  if (-not $p) { break }
  $names += ($p.Name + ':' + $p.ProcessId)
  if ($p.Name -eq 'electron.exe') {
    $out.appPid = $p.ProcessId
    $out.appCommandLine = $p.CommandLine
    $out.appExePath = $p.ExecutablePath
    $pp = Get-CimInstance Win32_Process -Filter ("ProcessId=" + $p.ParentProcessId)
    if ($pp) { $out.appParent = ($pp.Name + ':' + $pp.ProcessId) }
    break
  }
  $cur = $p.ParentProcessId
}
$out.ancestry = ($names -join ' <- ')

# 待停的 dsh：只取**宿主拉起的那些**（避免误伤同机上的其它 dsh 实例），
# 并一定包含本插件所在的宿主进程 pid —— 否则助手会漏掉它，留下"半死"状态。
if ($out.appPid) {
  $out.dshPids = @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
    Where-Object { $_.ParentProcessId -eq $out.appPid -and $_.CommandLine -notlike '*subprocess-local*' } |
    ForEach-Object { $_.ProcessId })
} else {
  $out.dshPids = @()
}
if ($out.dshPids -notcontains ${Number(hostPid)}) { $out.dshPids += ${Number(hostPid)} }
$out.listeners = @(Get-NetTCPConnection -State Listen |
  Where-Object { $_.LocalPort -ge 3080 -and $_.LocalPort -le 3099 } |
  ForEach-Object { $_.LocalPort })
$out.consoleWindows = @(Get-Process |
  Where-Object { $_.MainWindowTitle -and $_.ProcessName -match 'powershell|cmd|conhost|pwsh' }).Count
$out.stopShellCount = @(Get-CimInstance Win32_Process -Filter "Name='electron.exe'" |
  Where-Object { $_.CommandLine -notmatch '--type=' -and $_.ExecutablePath -ne $out.appExePath }).Count

$t = schtasks /Query /TN "${TASK_NAME}" /FO LIST /V 2>$null
if ($LASTEXITCODE -eq 0 -and $t) {
  $next = ($t | Select-String -Pattern 'Next Run Time' | Select-Object -First 1).Line
  $last = ($t | Select-String -Pattern 'Last Result' | Select-Object -First 1).Line
  $out.pendingTask = [ordered]@{ name = '${TASK_NAME}'; nextRun = ("$next" -replace '^\\s*Next Run Time:\\s*', ''); lastResult = ("$last" -replace '^\\s*Last Result:\\s*', '') }
}
$out | ConvertTo-Json -Depth 6 -Compress
`;
  const raw = await runPowerShell(script);
  const jsonLine = raw.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).pop() ?? '{}';
  try {
    return JSON.parse(jsonLine);
  } catch {
    throw new Error(`探针输出不是合法 JSON：${jsonLine.slice(0, 300)}`);
  }
}

/** 把助手脚本写到落点（每次都覆盖，保证与插件版本一致）。 */
export function writeHelperScript(content) {
  const dir = stateDir();
  mkdirSync(dir, { recursive: true });
  const target = helperScriptPath();
  // 必须带 BOM：PowerShell 5.1 会把无 BOM 的 .ps1 按 ANSI 解码，中文注释/文案会被解坏。
  writeFileSync(target, withBom(content), 'utf8');
  return target;
}

/** 读助手日志尾部（用于状态报告）。 */
export function readHelperLogTail(lines = 12) {
  const target = helperLogPath();
  if (!existsSync(target)) return { path: target, lines: [] };
  const all = readFileSync(target, 'utf8').split(/\r?\n/).filter(Boolean);
  return { path: target, lines: all.slice(-lines) };
}

/** 排定重启任务。 */
export async function createTask(scriptPath, hhmm) {
  return runExe('schtasks.exe', buildCreateArgs({ scriptPath, hhmm }));
}

/** 取消重启任务。 */
export async function deleteTask() {
  return runExe('schtasks.exe', buildDeleteArgs());
}
