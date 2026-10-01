/**
 * dsh-shell-restart —— 把「重启 DSH 桌面外壳」做成模型可调用的工具。
 *
 * 为什么需要它：DSH 用作业对象托管 agent 的命令，**agent 自己 spawn 的子进程活不过那一轮命令**
 * （实测：`Start-Process` 与 WMI 创建都秒退且无日志）；而在命令里直接杀宿主 = 杀掉执行自己的进程，
 * 后半截"重新拉起"永远没人执行。所以唯一可靠的路子是：**把重启排进任务计划程序**，
 * 让调度服务在 agent 这一轮结束之后去停旧进程、用 WMI 拉起新实例。
 *
 * 本插件只负责"排任务 + 汇报基线"，**不等结果** —— 等结果就是等自己被杀死。
 *
 * 注册三个工具：
 *   - desktop_shell_status   看清当前是不是桌面端在跑、端口、待执行任务、最近一次重启账本
 *   - restart_desktop_shell  排定重启（支持 dry_run 只看计划）
 *   - cancel_desktop_restart 取消已排定的重启
 *
 * 依赖：零依赖。`ctx.tools.register()` 接受原始定义（手写 JSON Schema + 自带 render），
 * 因此不需要 `defineTool`，也就不需要把 @deepseek-ai/dsh-tools 装进来
 * （npm 上该包只到 0.0.1-rc.1，与本机 0.1.7-alpha.2 不一致，装进来反而是隐患）。
 */
import {
  assessProbe, buildHelperScript, computeStartTime, formatStatus, normalizeDelay,
  parseElectronCommandLine, summarizeBaseline, TASK_NAME,
} from './shell.js';
import {
  createTask, deleteTask, helperLogPath, helperScriptPath, probe, readHelperLogTail,
  writeHelperScript,
} from './win.js';

export const name = 'desktop-restart';
/** 需要 tools 服务来注册工具。 */
export const inject = ['tools'];

/** 助手脚本自身的启动延迟：真正的"提前量"由任务计划时间承担。 */
const HELPER_DELAY_SECONDS = 5;

/**
 * 宿主 pid：默认就是本进程（插件就跑在宿主里）。
 * 允许用环境变量覆盖，是为了能在宿主之外做冒烟测试 —— 否则探针沿着
 * "测试脚本自己"的父进程链走，永远找不到 electron 祖先，只会得到拒绝结论。
 */
function hostPid() {
  const override = Number(process.env.DSH_DESKTOP_HOST_PID);
  return Number.isFinite(override) && override > 0 ? override : process.pid;
}

const asText = (value) => [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }];

/** 采集探针并就地解析出 exe / 启动参数 / 应用目录。 */
async function snapshot() {
  const raw = await probe(hostPid());
  const parsed = parseElectronCommandLine(raw.appCommandLine);
  return {
    ...raw,
    appExe: parsed.exe,
    appDir: parsed.appDir,
    launchArgs: parsed.launchArgs,
    appDirSource: parsed.appDirSource,
  };
}

export function apply(ctx, rawConfig = {}) {
  const config = typeof rawConfig === 'object' && rawConfig !== null ? rawConfig : {};
  const logTailLines = Number.isFinite(config.logTailLines) && config.logTailLines > 0
    ? Math.min(Math.round(config.logTailLines), 80)
    : 12;
  // 端口范围用于判断"上一代是否退干净"：新 dsh 绑不上端口时，应用会等 90 秒后弹窗退出（真实踩过）。
  // 默认 3080-3083 是 DSH 桌面外壳的默认区间；别人若改过端口，在这里覆盖。
  const portRange = Array.isArray(config.portRange)
    && config.portRange.length === 2
    && config.portRange.every((n) => Number.isInteger(n) && n > 0 && n < 65536)
    ? [config.portRange[0], config.portRange[1]]
    : [3080, 3083];

  ctx.tools.register({
    name: 'desktop_shell_status',
    description:
      '查看 DSH 桌面外壳（Electron 宿主）的运行状态：宿主进程与父进程、它拉起的 dsh 子进程与监听端口、'
      + '是否有待执行的重启任务、有没有可见的控制台窗口，以及最近一次自助重启的账本。'
      + '在打算重启桌面端之前先用它确认"当前确实跑在桌面外壳里"。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        include_log_tail: {
          type: 'boolean',
          description: '是否附上最近一次自助重启的日志尾部（默认 true）。',
        },
      },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => asText(value) },
    async execute(args) {
      try {
        const info = await snapshot();
        const includeTail = args?.include_log_tail !== false;
        const tail = includeTail ? readHelperLogTail(logTailLines) : { lines: [] };
        const verdict = assessProbe(info);
        const lines = [formatStatus(info, tail.lines)];
        if (!verdict.canRestart) lines.push(`  ⚠️ 不可由本工具重启：${verdict.reason}`);
        lines.push(`  助手脚本: ${helperScriptPath()}`);
        return lines.join('\n');
      } catch (error) {
        return `采集状态失败：${error && error.message ? error.message : String(error)}`;
      }
    },
  });

  ctx.tools.register({
    name: 'restart_desktop_shell',
    description:
      '重启 DSH 桌面外壳（Electron 宿主）：排定一个 Windows 计划任务，在指定延迟后停掉当前宿主与它拉起的 dsh，'
      + '再用 WMI 拉起新的桌面端实例。用于插件/配置改动需要宿主重启才能生效的场景。'
      + '**重要**：本工具只负责"排定"，返回时重启尚未发生；到点后当前会话页面会断开，'
      + '用户需要重新打开桌面端窗口（会话记录不会丢）。用 dry_run 可以只看计划不动手。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        delay_seconds: {
          type: 'integer',
          description: '多久之后执行重启（秒，30-3600，默认 120）。留出时间让"即将重启"的提示送达用户。',
        },
        dry_run: {
          type: 'boolean',
          description: '只返回计划（探针结果、脚本路径、计划时刻），不真的创建计划任务。',
        },
      },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => asText(value) },
    async execute(args) {
      const { seconds, warnings } = normalizeDelay(args?.delay_seconds);
      let info;
      try {
        info = await snapshot();
      } catch (error) {
        return `无法采集环境（重启未排定）：${error && error.message ? error.message : String(error)}`;
      }
      const verdict = assessProbe(info);
      if (!verdict.canRestart) {
        return `拒绝重启：${verdict.reason}`;
      }

      const now = new Date();
      const start = computeStartTime(now, seconds);
      const logPath = helperLogPath();
      const script = buildHelperScript({
        exe: info.appExe,
        appDir: info.appDir,
        launchArgs: info.launchArgs,
        logPath,
        delaySeconds: HELPER_DELAY_SECONDS,
        appPid: info.appPid,
        dshPids: info.dshPids,
        portRange,
      });
      const scriptPath = writeHelperScript(script);

      const head = [
        `当前时间: ${now.toLocaleString('zh-CN')}`,
        `重启前基线: ${summarizeBaseline(info)}`,
        `可执行文件: ${info.appExe}`,
        `启动参数: ${info.launchArgs.trim() || '(无)'}   工作目录: ${info.appDir ?? '(未解析出)'}`,
        `助手脚本: ${scriptPath}`,
        `助手日志: ${logPath}`,
        `计划任务: ${TASK_NAME} @ ${start.hhmm}（实际延迟约 ${start.actualDelaySeconds} 秒）`,
      ];
      if (warnings.length > 0) head.push(`配置告警: ${warnings.join('；')}`);

      if (args?.dry_run) {
        head.push('', '这是 dry_run：没有创建计划任务，什么都不会发生。');
        return head.join('\n');
      }

      const result = await createTask(scriptPath, start.hhmm);
      if (result.failed) {
        head.push('', `排定失败：schtasks 退出码=${result.code}`);
        head.push(result.stdout.trim());
        head.push(result.stderr.trim());
        return head.join('\n');
      }

      head.push('');
      head.push(`${TASK_NAME} 已排定，${start.hhmm} 触发。`);
      head.push('到点后的动作：停 dsh 子进程 → 停宿主 → 等端口释放 → WMI 拉起新实例（不继承控制台，不会留黑窗口）→ 轮询等新 dsh 就绪。');
      head.push('届时本会话页面会断开；重新打开桌面端窗口即可继续，会话记录不丢。');
      head.push(`查看结果：desktop_shell_status，或直接读 ${logPath}`);
      return head.join('\n');
    },
  });

  ctx.tools.register({
    name: 'cancel_desktop_restart',
    description: `取消已排定但尚未触发的 DSH 桌面端重启（删除计划任务 ${TASK_NAME}）。`,
    parameters: { type: 'object', additionalProperties: false, properties: {} },
    output: { schema: { type: 'string' }, render: (_args, value) => asText(value) },
    async execute() {
      const result = await deleteTask();
      if (result.failed && !/cannot find|找不到|ERROR/i.test(`${result.stdout}${result.stderr}`)) {
        return `取消失败：schtasks 退出码=${result.code}\n${result.stdout}\n${result.stderr}`;
      }
      const info = await snapshot().catch(() => undefined);
      const still = info && info.pendingTask ? `⚠️ 任务似乎仍存在：${info.pendingTask.nextRun}` : '✅ 已无待执行的重启任务';
      return `${still}\n（schtasks 输出：${(result.stdout || result.stderr || '').trim() || '空'}）`;
    },
  });
}

export default { name, inject, apply };
