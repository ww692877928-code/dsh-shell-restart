/**
 * 宿主外冒烟测试：不开 DSH，直接把插件的工具定义接出来真跑一遍。
 *
 * 安全性：只用 `dry_run: true` 走"状态查询 + 计划生成"两条路径，**绝不创建计划任务**，
 * 因此不会重启任何东西。
 *
 * 用法（在 DSH 桌面端正在运行时）：
 *   node tools/smoke.mjs
 * 它会自己找出当前 dsh 宿主的 pid，并通过 DSH_DESKTOP_HOST_PID 让插件的探针沿着
 * "宿主 → electron 祖先"这条真实链路走。
 */
import { apply } from '../src/index.js';

// 1) 找出当前 dsh 宿主 pid（桌面端拉起的那个 node 进程）
const findHost = `
$p = @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
  Where-Object { $_.CommandLine -like '*deepseek-ai*' -and $_.CommandLine -notlike '*subprocess-local*' })
if ($p.Count -gt 0) { $p[0].ProcessId } else { 0 }
`;
const { runPowerShell } = await import('../src/win.js');
const hostPid = Number(String(await runPowerShell(findHost)).trim());
console.log(`[smoke] 找到 dsh 宿主 pid=${hostPid}`);
if (!hostPid) {
  console.log('[smoke] 没找到 dsh 宿主（桌面端没在跑？）—— 那就只验证工具注册与拒绝路径');
}
process.env.DSH_DESKTOP_HOST_PID = String(hostPid);

// 2) 用假 ctx 接出工具定义（只实现 register，就够验证注册与执行）
const tools = new Map();
const ctx = { tools: { register: (definition) => tools.set(definition.name, definition) }, logger: { info() {} } };
apply(ctx, { logTailLines: 10 });

console.log(`[smoke] 注册的工具: ${[...tools.keys()].join(', ')}`);
for (const [name, def] of tools) {
  const props = Object.keys(def.parameters?.properties ?? {});
  console.log(`[smoke]   ${name}: 参数=[${props.join(', ') || '无'}] output.schema.type=${def.output?.schema?.type} render=${typeof def.output?.render}`);
}

// 3) 状态工具：真跑（只读）
console.log('\n===== desktop_shell_status =====');
console.log(await tools.get('desktop_shell_status').execute({ include_log_tail: true }, {}));

// 4) 重启工具：dry_run，只出计划
console.log('\n===== restart_desktop_shell(dry_run) =====');
console.log(await tools.get('restart_desktop_shell').execute({ delay_seconds: 120, dry_run: true }, {}));

// 5) 参数校验路径：非法延迟应被抬到下限并告警
console.log('\n===== restart_desktop_shell(delay_seconds=5, dry_run) =====');
console.log(await tools.get('restart_desktop_shell').execute({ delay_seconds: 5, dry_run: true }, {}));

console.log('\n[smoke] 完成：没有创建任何计划任务');
