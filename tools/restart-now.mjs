/**
 * 从**磁盘上的插件代码**真实排定一次重启（不是 dry_run）。
 *
 * 为什么需要它：插件以 `link:` 方式装入 profile 后，运行中的宿主把模块缓存在内存里 ——
 * 改了源码，宿主**不会**重新加载。这时用宿主内的工具调用，跑的仍是旧代码。
 * 本脚本直接用最新的源码调同一个 execute()，因此既能把新代码真正跑一遍，
 * 也能在"宿主内的副本陈旧"时作为命令行兜底。
 *
 * 用法：
 *   node tools/restart-now.mjs            # 默认延迟 120 秒
 *   node tools/restart-now.mjs 300        # 自定义延迟
 *   node tools/restart-now.mjs --dry-run  # 只看计划，不排任务
 *
 * 注意：排的是**真任务**（schtasks），到点会停掉当前宿主与它拉起的 dsh，然后重新拉起。
 * 当前会话页面会断开 —— 这是设计使然，不是故障。
 */
import { apply } from '../src/index.js';
import { runPowerShell } from '../src/win.js';

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const delayArg = args.find((a) => /^\d+$/.test(a));
const delay = delayArg ? Number(delayArg) : 120;

// 1) 找出当前 dsh 宿主 pid（桌面端拉起的那个 node 进程），让探针沿真实父进程链走
const findHost = `
$p = @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
  Where-Object { $_.CommandLine -like '*deepseek-ai*' -and $_.CommandLine -notlike '*subprocess-local*' })
if ($p.Count -gt 0) { $p[0].ProcessId } else { 0 }
`;
const hostPid = Number(String(await runPowerShell(findHost)).trim());
if (!hostPid) {
  console.error('[restart-now] 没找到 dsh 宿主进程（桌面端没在跑？）—— 不排任务。');
  process.exit(1);
}
process.env.DSH_DESKTOP_HOST_PID = String(hostPid);
console.log(`[restart-now] dsh 宿主 pid=${hostPid}  延迟=${delay}s  dry_run=${dryRun}`);

// 2) 接出工具定义并直接调用（跑的是磁盘上的最新代码）
const tools = new Map();
apply({ tools: { register: (definition) => tools.set(definition.name, definition) }, logger: { info() {} } }, {});

const tool = tools.get('restart_desktop_shell');
if (!tool) {
  console.error('[restart-now] 没能注册 restart_desktop_shell —— 插件代码有问题。');
  process.exit(1);
}
const result = await tool.execute({ delay_seconds: delay, dry_run: dryRun }, {});
console.log('\n' + result);
