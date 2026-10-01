# dsh-shell-restart

把 **「重启 DSH 桌面外壳」做成模型可调用的工具**。

它不是一个便利脚本，而是把一整套**踩出来的约束**固化下来 —— 每一条都对应一次真实失败，
所以这个插件的价值在于「下次不用重新踩」。

## 为什么需要它：三条绕不过去的硬约束

| # | 约束 | 现象（实测） |
|---|---|---|
| 1 | **agent 不能直接杀宿主** | 杀掉宿主 = 杀掉正在执行自己的进程，后半截"重新拉起"永远没人执行，用户还收不到任何提示 |
| 2 | **agent 自己 spawn 的子进程活不过那一轮命令** | DSH 用作业对象（Job Object）托管命令；`Start-Process` 与 WMI 创建都试过 —— 秒退且无日志 |
| 3 | **结论：只能"排任务"，不能"等结果"** | 于是重启必须交给任务计划程序（`schtasks`）在外部触发 —— 它由调度服务启动，不受作业对象约束，且跑在交互会话里 |

## 三个工具

### `desktop_shell_status`
看清现状：宿主进程与父进程、它拉起的 dsh 子进程与监听端口、有没有**可见的控制台窗口**、
有没有待执行的重启任务，以及最近一次自助重启的账本（助手日志尾部）。
**打算重启前先跑它**，确认"当前确实跑在桌面外壳里"。

### `restart_desktop_shell({ delay_seconds?, dry_run? })`
排定一次重启（默认延迟 120 秒，允许 30–3600）。返回**计划 + 基线**后立刻结束 —— 因为到点后本会话页面会断开。

`dry_run: true` 只返回计划，不创建任务。

### `cancel_desktop_restart()`
删除尚未触发的计划任务（排错了、改主意了就撤）。

## 到点时助手脚本做的事（每一步都有理由）

```
1. 按 PID 停掉 dsh 子进程          ← 强杀宿主不会替我们清理它 spawn 的 dsh，那个 node 会继续占着 3081
2. 按 PID 停掉宿主                ← 只按 PID，绝不用 taskkill /T（/T 会把启动者连同父进程一起带走）
3. 清理残留应用实例               ← 否则新实例被单实例锁挡下，表现为"双击没反应"
4. 等端口 3080-3083 释放（≤20s）  ← 端口没放掉时新 dsh 绑不上，应用会等 90 秒后弹窗退出（真实踩过）
5. 用 **WMI 创建**拉起新实例      ← 而不是 Start-Process：后者让应用继承脚本控制台，会留一个黑窗口，
                                     而且只要应用活着它就不走；误点它的 × 甚至会把应用一起带走
6. 照抄**原始启动参数**           ← 漏了应用目录参数时 electron.exe 会启动自带的欢迎应用（真实踩过）
7. 轮询等新 dsh 出现（≤45s）      ← 失败时日志直接给出 1)2)3) 排查顺序
```

全部动作与判定都写进助手日志（默认 `%LOCALAPPDATA%\dsh-shell-restart\restart-helper.log`）。

## 定位：与既有实现的区别

这是一个 **Windows + DSH 桌面外壳** 专用的重启插件。生态里已经有两个成熟的重启插件，但它们的实现路径在 Windows 上不成立：

| 既有实现 | 月下载 | 它的路径 | 为什么在 Windows 桌面外壳上不适用 |
|---|---|---|---|
| `@moon16u/dsh-plugin-restart` | 899 | bash 脚本 + SIGTERM 优雅退出 + detached worker | 建立在 POSIX 信号与 shell 上；Windows 没有 SIGTERM，且桌面端的本体不是一个可被 kill 的 `dsh web` 进程 |
| `dsh-restart-button` | 332 | 侧边栏按钮 → SIGTERM → 同一命令行 detached 重启 | 同上，它重启的是 `dsh web` 服务进程本身 |
| `dsh-desktop-restart` | 100 | 在自家 DSH Desktop 的托盘菜单加一项 | 依赖那套桌面端；且不是模型可调用的工具 |

本插件的差异（也是它存在的理由）：

1. **Windows 原生**：用任务计划程序（`schtasks`）在外部触发 —— 因为 DSH 用作业对象托管 agent 的命令，agent 自己 spawn 的子进程活不过那一轮（实测 `Start-Process` 与 WMI 创建都秒退）；
2. **桌面外壳语义**：沿父进程链认出 Electron 宿主 → 停它**和它拉起的 dsh** → 照抄原始命令行重新拉起；
3. **不留黑窗口**：用 WMI 创建进程（不继承控制台），而不是 `Start-Process`；
4. **失败即拒绝**：非 Windows、非桌面宿主、解析不出可执行文件一律拒绝，绝不"猜着杀"。

> **POSIX 用户请用前两个**：它们在 Linux/macOS 上比我成熟（失败可见性、页面自动刷新、环境变量保留）。

## 安装

```bat
:: A) 从 npm 装（发布后最省事）
dsh plugin --profile web add dsh-shell-restart

:: B) 直接从 GitHub 装（无需先发 npm）
dsh plugin --profile web add github:ww692877928-code/dsh-shell-restart

:: C) 本地目录（开发用，改源码即时生效）
dsh plugin --profile web add link:<插件目录>

:: 装完在 profile 的 cordis.patch.yml 插入加载行
:: （普通插件必须用 insert:；裸 - name: 会被静默忽略）
::    - insert:
::        - id: shell-restart
::          name: 'dsh-shell-restart'
::          config:
::            logTailLines: 12
```

用自带的 rollback 工具做更稳（装前快照、装后静态+启动双层自检、不兼容自动回退）：

```bat
cd /d <回退工具目录>
dsh-rollback.cmd add dsh-shell-restart
```

## 配置

| 字段 | 默认 | 含义 |
|---|---|---|
| `logTailLines` | `12` | `desktop_shell_status` 附带多少行助手日志 |

## 测试

```bat
cd /d <插件目录>
npm test        :: node --test test/shell.test.mjs   —— 12 条，全绿
```

测试的重点不是覆盖率，而是把每次真实失败固化成断言：

- 生成的 PowerShell 必须能被**真解析器**（`Language.Parser::ParseFile`）解析通过 ——
  这条最值钱：我踩过用 `PSParser::Tokenize`（只分词、不查语法）得到"解析 OK"的假阴性，
  于是一个有语法错误的脚本被连起了两次；
- 生成物里**不能把 `taskkill` 当命令用**（尤其 `/T`）；断言只看命令、不误伤注释里的规约说明；
- 计划时刻必须**不小于**请求延迟（`schtasks` 只有分钟粒度，向上取整）；
- 开发版（`electron.exe .`）、显式目录版、**打包版（无参数）**三种命令行都要能解析出 exe/参数/工作目录；
- 非 Windows、非桌面宿主、解析不出 exe —— 三种情况都必须**拒绝重启**而不是硬来。

## 验证

```bat
:: 单元测试（12 条，含真解析器解析生成物）
cd /d <插件目录>
npm test

:: 宿主外冒烟测试：接出工具定义真跑一遍，只走"只读 + dry_run"，绝不创建任务
node tools/smoke.mjs
```

冒烟测试会自己找出当前 dsh 宿主 pid，并通过 `DSH_DESKTOP_HOST_PID` 让探针沿
"宿主 → electron 祖先"这条真实链路走（否则探针沿测试脚本自己的父进程链找，只会得到拒绝结论）。
实测输出（本例）：

```
应用: pid=87900 父=WmiPrvSE.exe:5984
可执行: <项目目录>\node_modules\electron\dist\electron.exe
工作目录: <项目目录>
dsh 子进程: 85468   监听端口: 3081   可见控制台窗口: 0 个
计划任务: DshDesktopSelfRestart @ 22:15（实际延迟约 77 秒）  ← delay_seconds=5 被抬到 30
配置告警: delay_seconds=5 太短，已提升到 30
```

## 给别人用之前要改什么

| 项 | 为什么 | 怎么改 |
|---|---|---|
| `portRange` | 默认 `3080-3083` 是 DSH 桌面外壳的默认区间；你的宿主若换过端口，"上一代是否退干净"的判断就会失准 | patch 行的 config 里加 `portRange: [下限, 上限]` |
| 桌面外壳本身 | 本插件只负责"重启一个由 Electron 宿主承载的 DSH"；它沿**父进程链**找 electron 祖先，找不到就明确拒绝（命令行 `dsh web` 不适用） | **不需要改代码** |
| 平台 | 依赖 `schtasks` 与 `Win32_Process.Create` | 非 Windows 会被明确拒绝并说明原因 |

**它不绑定任何目录名**：待停的宿主与 dsh 都由探针给定 PID。
这是刻意设计 —— 早期版本按命令行里的 `*dsh-desktop*` 找宿主，换到别人的桌面端会
**"只杀 dsh、不杀宿主"**，留下窗口还在但后端已死的残缺状态（比重启失败更糟）。
测试里加了回归锁（`不得再用目录名匹配宿主进程`）防止改回去。

## 零依赖

`ctx.tools.register()` 接受**原始工具定义**（手写 JSON Schema + 自带 `render`），
所以不需要 `defineTool`，也就不需要引入 `@deepseek-ai/dsh-tools`。

这不是洁癖：npm 上该包的 `latest` 只到 **0.0.1-rc.1**，而本机 DSH 是 **0.1.7-alpha.2** ——
引进来等于把一个版本错位的副本塞进插件，风险大于收益。

## 已知限制

1. **只实现了 Windows**（依赖 `schtasks` 与 `Win32_Process.Create`）；其他平台会被明确拒绝并说明原因。
2. **重启期间会丢一次页面**：这是设计使然（宿主要被杀）。会话记录不丢，重新打开窗口即可继续。
3. **不支持"重启后自动回报"**：插件跑在宿主里，宿主要死 —— 想等结果就是等自己被杀死。
   要看结果用 `desktop_shell_status`。
4. **被拒绝启动的实例无法自动补救**：如果新实例因为环境原因（例如端口被别的程序长期占用）起不来，
   助手日志会写明，最终仍需人工介入。它不是守护进程。
5. **`delay_seconds` 有下限 30 秒**：再短的话"即将重启"的提示还没送到用户面前页面就断了。
