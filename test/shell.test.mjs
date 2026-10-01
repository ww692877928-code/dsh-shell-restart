/**
 * 纯逻辑与"生成物"的测试。
 *
 * 重点不是覆盖率，而是**把每次真实失败固化成断言**：
 *   - 生成出来的 PowerShell 必须能被真解析器解析通过（我踩过：用只分词不查语法的 API 得到假阴性，
 *     把一个坏脚本连起了两次）
 *   - 生成的脚本里绝不能出现 taskkill /T 或 /T /F（会把启动者连同父进程一起带走）
 *   - 计划时刻必须**不小于**请求延迟（否则"即将重启"的提示还没送到页面就断了）
 *
 * 运行：npm test
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { writeFileSync, readFileSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  assessProbe, buildCreateArgs, buildDeleteArgs, buildHelperScript, computeStartTime,
  formatStatus, normalizeDelay, parseElectronCommandLine, psQuote, summarizeBaseline,
  withBom, DEFAULT_DELAY_SECONDS, MAX_DELAY_SECONDS, MIN_DELAY_SECONDS, TASK_NAME,
} from '../src/shell.js';
import { writeHelperScript } from '../src/win.js';

test('normalizeDelay：默认值 / 上下限 / 非数字', () => {
  assert.equal(normalizeDelay(undefined).seconds, DEFAULT_DELAY_SECONDS);
  assert.equal(normalizeDelay(10).seconds, MIN_DELAY_SECONDS);
  assert.ok(normalizeDelay(10).warnings.length > 0, '抬升下限时应告警');
  assert.equal(normalizeDelay(999999).seconds, MAX_DELAY_SECONDS);
  assert.equal(normalizeDelay('abc').seconds, DEFAULT_DELAY_SECONDS);
  assert.equal(normalizeDelay(180).seconds, 180);
});

test('computeStartTime：向上取整到整分钟，且实际延迟不小于请求', () => {
  const now = new Date(2026, 9, 1, 10, 0, 30);
  const r = computeStartTime(now, 120);
  assert.equal(r.hhmm, '10:03', '10:00:30 + 120s = 10:02:30 → 进位到 10:03');
  assert.ok(r.actualDelaySeconds >= 120);

  const exact = computeStartTime(new Date(2026, 9, 1, 10, 0, 0), 120);
  assert.equal(exact.hhmm, '10:02', '整分钟不需要进位');

  const short = computeStartTime(new Date(2026, 9, 1, 10, 0, 59), 30);
  assert.equal(short.hhmm, '10:02');
  assert.ok(short.actualDelaySeconds >= 30);
});

test('psQuote：单引号转义成两个，避免注入/语法错误', () => {
  assert.equal(psQuote("C:\\a\\b"), "'C:\\a\\b'");
  assert.equal(psQuote("it's"), "'it''s'");
});

test('parseElectronCommandLine：开发版（. 参数）反推出应用目录', () => {
  const r = parseElectronCommandLine('"D:\\work\\dsh-desktop\\node_modules\\electron\\dist\\electron.exe" .');
  assert.equal(r.exe, 'D:\\work\\dsh-desktop\\node_modules\\electron\\dist\\electron.exe');
  assert.equal(r.launchArgs, ' .');
  assert.equal(r.appDir, 'D:\\work\\dsh-desktop');
  assert.equal(r.appDirSource, 'derived-from-exe');
});

test('parseElectronCommandLine：显式目录参数优先', () => {
  const r = parseElectronCommandLine('"D:\\x\\electron.exe" "D:\\work\\dsh-desktop"');
  assert.equal(r.appDir, 'D:\\work\\dsh-desktop');
  assert.equal(r.appDirSource, 'argv');
  assert.equal(r.launchArgs, ' "D:\\work\\dsh-desktop"');
});

test('parseElectronCommandLine：打包版（无参数）也能处理', () => {
  const r = parseElectronCommandLine('"C:\\Program Files\\DSH\\DSH 桌面端.exe"');
  assert.equal(r.exe, 'C:\\Program Files\\DSH\\DSH 桌面端.exe');
  assert.equal(r.launchArgs, '');
  assert.equal(r.appDir, 'C:\\Program Files\\DSH');
});

test('parseElectronCommandLine：空命令行不炸', () => {
  const r = parseElectronCommandLine('');
  assert.equal(r.exe, undefined);
  assert.equal(r.launchArgs, '');
});

test('schtasks 参数：脚本路径带空格时仍是**一个**参数', () => {
  const args = buildCreateArgs({ scriptPath: 'C:\\a b\\restart-shell.ps1', hhmm: '10:03' });
  assert.deepEqual(args.slice(0, 2), ['/Create', '/TN']);
  assert.ok(args.includes(TASK_NAME));
  assert.ok(args.includes('/SC') && args.includes('ONCE') && args.includes('10:03') && args.includes('/F'));
  const action = args[args.indexOf('/TR') + 1];
  assert.equal(action, 'powershell.exe -NoProfile -ExecutionPolicy Bypass -File "C:\\a b\\restart-shell.ps1"');
  assert.deepEqual(buildDeleteArgs(), ['/Delete', '/TN', TASK_NAME, '/F']);
});

test('assessProbe：非 Windows / 非桌面宿主 / 解析不出 exe 都要拒绝', () => {
  assert.equal(assessProbe({ platform: 'linux', appPid: 1, appExe: 'x' }).canRestart, false);
  assert.equal(assessProbe(undefined).canRestart, false);
  const noApp = assessProbe({ platform: 'win32', dshPids: [1] });
  assert.equal(noApp.canRestart, false);
  assert.match(noApp.reason, /不是由 DSH 桌面端启动/);
  assert.equal(assessProbe({ platform: 'win32', appPid: 100 }).canRestart, false);
  assert.equal(assessProbe({ platform: 'win32', appPid: 100, appExe: 'D:\\e\\electron.exe' }).canRestart, true);
});

test('summarizeBaseline / formatStatus 输出关键事实', () => {
  const probe = {
    platform: 'win32', appPid: 90296, appParent: 'explorer.exe:88688',
    appExe: 'D:\\e\\electron.exe', appDir: 'D:\\app', dshPids: [94704],
    listeners: [3081], consoleWindows: 0, pendingTask: null,
  };
  const base = summarizeBaseline(probe);
  assert.match(base, /90296/);
  assert.match(base, /94704/);
  assert.match(base, /3081/);
  const status = formatStatus(probe, ['22:06:00 助手启动']);
  assert.match(status, /可见控制台窗口: 0/);
  assert.match(status, /待执行的重启任务: 无/);
  assert.match(status, /助手启动/);
});

test('生成的助手脚本包含全部关键约束（每条都对应一次真实失败）', () => {
  const script = buildHelperScript({
    exe: 'D:\\app\\node_modules\\electron\\dist\\electron.exe',
    appDir: 'D:\\app',
    launchArgs: ' .',
    logPath: 'C:\\logs\\restart.log',
    delaySeconds: 5,
    appPid: 4242,
    dshPids: [11, 22],
  });
  // 烘入的值（注意：生成物里是单个反斜杠，正则要写 \\ 来匹配一个）
  assert.match(script, /D:\\app\\node_modules\\electron\\dist\\electron\.exe/);
  assert.match(script, /C:\\logs\\restart\.log/);
  assert.match(script, /DelaySeconds = 5/);
  assert.match(script, /\$AppPid = 4242/);
  assert.match(script, /\$DshPids = @\(11, 22\)/);
  // 1) 只按 PID 杀（注释里会提到"绝不用 taskkill /T"这句规约，所以只查真的当命令在用）
  assert.match(script, /Stop-Process -Id \$AppPid/);
  assert.match(script, /Stop-Process -Id \$dshPid/);
  assert.ok(!/(^|\n)\s*taskkill\b/i.test(script), '绝不能把 taskkill 当命令用（尤其 /T）');
  assert.ok(!/\/T\s+\/F/.test(script), '绝不能出现 /T /F');
  // 2) 先停 dsh 再停宿主
  assert.ok(script.indexOf('停止 dsh 子进程') < script.indexOf('停止宿主 pid='));
  // 3) **回归锁**：宿主必须按 PID 定位，不能再按目录名字符串猜
  //    （上一版按 '*dsh-desktop*' 猜；换到别人的桌面端会"只杀 dsh 不杀宿主"，留下半死状态）
  assert.ok(!/\*dsh-desktop\*/.test(script), '不得再用目录名匹配宿主进程');
  assert.match(script, /ExecutablePath -eq \$Exe/, '残留清理应按可执行文件路径（通用）');
  // 4) WMI 拉起（脱离控制台）+ 回退分支
  assert.match(script, /Invoke-CimMethod -ClassName Win32_Process -MethodName Create/);
  assert.match(script, /CurrentDirectory = \$WorkDir/);
  assert.match(script, /回退：改用 Start-Process/);
  // 5) 照抄原始启动参数（漏了会拉起 Electron 欢迎应用）
  assert.match(script, /\$launchLine = '"' \+ \$Exe \+ '"' \+ \$LaunchArgs/);
  // 6) 新 dsh 判定优先用"新宿主的子进程"；端口等待用可配变量
  assert.match(script, /ParentProcessId -eq \$NewAppPid/);
  assert.match(script, /\$PortLow \+ '-' \+ \$PortHigh \+ ' 已释放/);
  assert.match(script, /发现残留应用实例，一并清理/);
  assert.match(script, /等待 dsh 出现用了/);
  // 7) 模板里不能残留未替换的 ${（会被 JS 模板字符串吃掉）
  assert.ok(!script.includes('${'), '生成物里不应出现 ${');
});

test('端口范围可配（别人的桌面端端口不同也能用）', () => {
  const script = buildHelperScript({
    exe: 'D:\\e\\electron.exe', appDir: 'D:\\e', launchArgs: '', logPath: 'C:\\l.log',
    delaySeconds: 5, appPid: 100, dshPids: [], portRange: [4000, 4002],
  });
  assert.match(script, /\$PortLow = 4000/);
  assert.match(script, /\$PortHigh = 4002/);
  assert.ok(!/\$PortLow = 3080/.test(script), '自定义范围不应被默认值覆盖');
});

test('缺少宿主 PID 时必须抛错（宁可报错，也不能按猜的杀进程）', () => {
  assert.throws(() => buildHelperScript({
    exe: 'D:\\e\\electron.exe', appDir: 'D:\\e', launchArgs: '', logPath: 'C:\\l.log', delaySeconds: 5,
  }), /必须提供宿主 appPid/);
});

test('生成的助手脚本能被真正的 PowerShell 解析器解析（不是分词器）', { skip: process.platform !== 'win32' }, () => {
  const script = buildHelperScript({
    exe: 'C:\\Program Files\\app\\electron.exe',
    appDir: 'C:\\Program Files\\app',
    launchArgs: ' .',
    logPath: "C:\\Users\\o'brien\\restart.log", // 故意带单引号，检验转义
    delaySeconds: 5,
    appPid: 777,
    dshPids: [778],
  });
  const tmp = `${process.env.TEMP}\\dsh-shell-restart-selftest.ps1`;
  writeFileSyncWithBom(tmp, script);
  const out = execFileSync('powershell.exe', ['-NoLogo', '-NoProfile', '-Command',
    `$e=$null; $null=[System.Management.Automation.Language.Parser]::ParseFile('${tmp.replace(/'/g, "''")}',[ref]$null,[ref]$e); if($e){ $e | ForEach-Object { 'ERR L' + $_.Extent.StartLineNumber + ': ' + $_.Message } } else { 'PARSE-OK' }`],
  { encoding: 'utf8' });
  assert.match(out, /PARSE-OK/, `PowerShell 解析失败：${out}`);
});

test('withBom：无 BOM 补上、已有 BOM 不重复', () => {
  assert.equal(withBom('abc'), `\uFEFFabc`);
  assert.equal(withBom('\uFEFFabc'), '\uFEFFabc');
});

test('writeHelperScript 写出的**真实字节**必须带 BOM', { skip: process.platform !== 'win32' }, () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'dsh-shell-restart-test-'));
  const previous = process.env.DSH_DESKTOP_RESTART_DIR;
  process.env.DSH_DESKTOP_RESTART_DIR = dir;
  try {
    const target = writeHelperScript('# 中文注释会暴露编码问题\nWrite-Log "x"\n');
    const bytes = readFileSync(target);
    assert.deepEqual([...bytes.slice(0, 3)], [0xEF, 0xBB, 0xBF], '生成的 .ps1 必须带 UTF-8 BOM');
  } finally {
    if (previous === undefined) delete process.env.DSH_DESKTOP_RESTART_DIR;
    else process.env.DSH_DESKTOP_RESTART_DIR = previous;
    rmSync(dir, { recursive: true, force: true });
  }
});

/** 写 UTF-8 带 BOM：PowerShell 5.1 读无 BOM 的 .ps1 会按 ANSI 解码。 */
function writeFileSyncWithBom(target, content) {
  writeFileSync(target, `\uFEFF${content}`, 'utf8');
}
