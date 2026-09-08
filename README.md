# pi-virtual-employee

桌面形态的**虚拟员工**应用,以 [pi agent SDK](https://github.com/earendil-works/pi)(`@earendil-works/pi-agent-core`)的 `Agent` 为对话内核,[Electron](https://www.electronjs.org/) 承载,界面参考 [LobsterAI](https://github.com/netease-youdao/LobsterAI) 风格。

**产品定位(已收敛)**:单一内置员工 + 可 GUI 编辑的配置 + 对话 + 任务展示。不做"自定义/多 agent"功能——单进程多 agent 虽不会对话记忆串扰(每个 `Agent` 独立持有 transcript),但共享堆、故障不隔离,暂不引入。

## 能力

- **对话**:多轮会话,SSE 流式输出,工具调用(知识库 / 订单 / 转人工)以 chip 展示。
- **配置 GUI**:模型(provider / modelId / API key)、IM(渠道 / appId / secret / 开关)、开机自启动。配置存 SQLite,可在界面修改并持久化。
- **任务展示**:侧边栏列出历史会话(每个会话即一个"任务"),可切换 / 删除。
- **IM 接入**:已接入**钉钉**(Stream 模式长连接,无需公网地址)与 `echo` 测试通道;在设置页配置 ClientID / ClientSecret 并启用。

## 架构

```
Electron 主进程
├─ src/db        better-sqlite3:config / conversations / messages
├─ src/engine    单员工引擎:Agent 内核 + 会话管理 + 持久化 + 模型/key 解析
├─ src/transport HTTP+SSE(复用上一轮),渲染进程经 localhost 读流
└─ src/im        IMAdapter 抽象 + manager + echo 适配器
渲染进程(renderer/, React + Vite + Tailwind)
├─ Sidebar(任务列表 + 左下角设置入口 + 模型徽标)
├─ ChatPage(消息流 + 工具 chip + Composer)
└─ SettingsPage(模型 / IM / 通用 三分区)
```

- 对话流式:主进程内嵌 HTTP+SSE(端口经 IPC 告知渲染进程),渲染进程用 `fetch + ReadableStream` 解析。
- 配置 / 任务 / 开机启动:走 IPC(SQLite 为原生模块,不进渲染进程)。
- 模型热切换:对**新会话**生效(已有会话沿用创建时的模型)。

## 安装与运行

```bash
# 1) 安装依赖(本环境无法直连 github,better-sqlite3 的 node26 源码编译会失败,
#    故跳过 install 脚本,稍后单独对 Electron 头重编译)
npm install --ignore-scripts

# 2) Electron 二进制走 npmmirror 镜像(.npmrc 已配 ELECTRON_MIRROR);
#    若自动下载不完整,手动拉取:
VER=$(node -p "require('./node_modules/electron/package.json').version")
cd node_modules/electron && rm -rf dist
curl -L -o /tmp/electron.zip "https://cdn.npmmirror.com/binaries/electron/${VER}/electron-v${VER}-darwin-arm64.zip"
unzip -q /tmp/electron.zip -d dist
printf 'Electron.app/Contents/MacOS/Electron' > path.txt   # 注意不带 dist/ 前缀
cd -

# 3) better-sqlite3 针对 Electron ABI 重编译
npx electron-rebuild -f -w better-sqlite3

# 4) 启动(开发:HMR + Electron)
npm run dev

# 生产构建:渲染进程 → renderer/dist,主进程 → dist-electron/
npm run build
```

> 国内网络已在 `.npmrc` 配置 `ELECTRON_MIRROR`。对话需在 **设置 → 模型配置** 填入 API key(或依赖环境变量 `ANTHROPIC_API_KEY` / `OPENAI_API_KEY`)。

## 命令执行与后台会话

短命令使用 `run_command` 同步等待；长时间采集使用 `background: true`，启动后拿到 `sessionId`，由 `manage_process` 继续等待和读取输出。后台进程的运行时限与单次查询的等待时间相互独立，**一次等待结束不会终止后台进程**。

在 **设置 → 通用 → 受限命令执行** 可分别配置：

| 配置项（前缀 `capabilities.shell.`） | 默认值 | 作用 |
| --- | --- | --- |
| `timeoutSec` | 60 秒 | 同步命令的运行时限，0 = 不限制 |
| `backgroundTimeoutSec` | 0 | 后台命令的运行时限，0 = 不限制 |
| `pollTimeoutSec` | 30 秒 | 单次 `poll` 默认等待时间，0 = 立即返回 |

三项均支持管理员在 IM 单聊中通过 `manage_settings` 修改，例如「确认，把后台命令运行时限设为 0，把单次轮询等待改为 120 秒」。运行时限对新启动的命令生效，正在运行的命令沿用启动时的值；等待时间对下一次 `poll` 生效，无需重启。`general.requestTimeoutMin` 单独控制模型请求超时，单位为分钟。旧配置自动补齐默认值；非法值回退到默认值，正数按整数秒处理且最少 1 秒，最大 2,147,483 秒（避免定时器溢出）。

先把采集逻辑和参数写入本地脚本/配置文件，脚本启动时向 stdout 输出 `observer start` 和时间戳，完整采集结果写入文件。启动命令只保留一行，例如以下工具参数（解释器需已加入命令白名单）：

```json
{"command":"powershell -NoProfile -File collect.ps1","workingDir":"C:\\jobs","background":true}
```

拿到会话 ID 后，用 `manage_process` 的 `log` 检查启动日志，再用 `poll` 等待到结束，核对退出码和结果。`poll` 可传 `waitSec` 覆盖本次等待时间；几分钟以上的任务可用 `840` 秒长等待，减少短轮询。读取结果会返回 `nextOffset`，下次传入 `offset` 即可读新增输出：

```json
{"action":"poll","sessionId":"上一步返回的会话 ID","waitSec":30,"offset":0}
```

`list` 列出当前对话的会话，`log` 立即读取日志，`kill` 终止进程树。每次操作校验当前管理员身份，只能访问自己在当前对话启动的命令；查询无需重复确认，启动和终止仍需当前消息明确确认。定时任务沿用创建者管理员身份，可启动并跟踪自身命令。取消一次 `poll` 仅停止等待，进程继续运行。

会话由应用托管，工具或对话模型重建不会丢失会话；应用退出会终止进程，重启后不能续接。后台命令计入忙碌状态，自动更新会等它们结束。最多同时运行 16 条命令，完成会话最多保留 24 小时、总计最多 100 个；每个会话保留最近 256 KB stdout/stderr，每页返回最多 32 KB。完整日志和敏感参数使用本地文件，不在命令行或 stdout 回显密钥；不需要再用 `nohup` 或自行编写脱离托管的 launcher。

## 发布

当前发布脚本将 **Windows(NSIS)** 安装包与自动更新文件上传到 Gitee 的 `latest` tag release；Linux(AppImage) 支持本地构建，尚未接入发布上传。已安装的 Windows 客户端会通过 `electron-updater` 自动检查更新（仅打包后的 Windows 生效，dev / macOS 为 no-op）。

### 一次性准备

在项目根的 `.env`(已被 `.gitignore` 忽略)填入 Gitee 个人访问令牌:

```bash
cp .env.example .env
# 编辑 .env,设置 GITEE_TOKEN=<你的令牌>
```

令牌在 https://gitee.com/profile/personal_access_tokens 生成,勾选 **projects** 权限(release 资产读写)。

### 发版流程

```bash
# 1) 升版本号(会改 package.json 并打 git tag)
npm version patch        # 或 minor / major

# 2) 打包 Windows 安装包（typecheck + build + 平台原生二进制 + electron-builder）
npm run package:win
# Linux 如需本地构建：npm run package:linux

# 3) 预览将要上传的产物(不碰 Gitee)
npm run release:dry

# 4) 实发:删旧 latest release+tag → 新建 → 上传全部产物 → 校验每个链接可达
npm run release
```

发布说明从 `docs/releases/v<版本号>.md` 读取；发布前先将对应源码提交和版本标签推送到远端，使安装包与源码版本一致。

token 的取值优先级:命令行 `GITEE_TOKEN=xxx npm run release` > `.env` 文件 > 报错。

### 产物与命名

| 平台 | 产物文件名 | 自动更新元数据 |
|---|---|---|
| Windows (x64) | `Pi-Virtual-Employee-Setup-<ver>-x64.exe` + `.blockmap` | `latest.yml` |
| Linux (x64) | `Pi-Virtual-Employee-<ver>-x86_64.AppImage` | `latest-linux.yml` |

注意 AppImage 的 `${arch}` 产物为 `x86_64`(非 NSIS 的 `x64`),其 blockmap **内嵌**在镜像中(无独立 `.blockmap` 文件)。自动更新元数据 `latest*.yml` 由 electron-builder 自动生成,文件名须与 `electron/updater.ts` 的 `manualUrl()` 保持一致。

### 原生模块(`better-sqlite3` + `sqlite-vec`)

两套安装包都内嵌目标平台的预编译原生二进制(放在 `resources/native/`,运行时由 `electron/main.ts` 跨平台解析):

- **Windows**:`prepare-win-native.mjs` → `better_sqlite3.node` + `vec0.dll`(PE)
- **Linux**:`prepare-linux-native.mjs` → `better_sqlite3.node` + `vec0.so`(ELF)

平台头 ABI 由 `node-abi` 的 `getAbi(electronVersion, "electron")` 解析;脚本内置魔数校验(PE `MZ` / ELF `\x7fELF`)防止下错平台。`npmRebuild: false` —— 打包机**不需要**安装各平台编译工具链。

> 在 macOS 上即可同时打出 Win + Linux 包(electron-builder 会拉取目标平台的 electron + 打包工具),无需 Linux 宿主。

## 扩展点(内部抽象,非"造 agent"产品功能)

| 抽象 | 位置 | 用途 |
|---|---|---|
| `IMAdapter` | `src/im/types.ts` | 新增 IM 渠道 = 新增一个适配器并注册到 `manager.ts` 的 `REGISTRY` |
| `SessionStore`(概念)/`HistoryStore` | `src/db` | 会话 / 消息持久化,可替换为 Redis 等 |
| `EmployeeRuntime` | `src/engine/engine.ts` | 传输层(HTTP / IM)驱动员工的统一接口 |
| 工具 | `src/engine/tools/` | 员工能力,直接增删 |

## 目录

```
electron/       main.ts(窗口/IPC/启动) + preload.ts(contextBridge)
src/db          sqlite / config-store / history-store
src/engine      engine.ts + definition.ts + prompt.ts + tools/
src/transport   http.ts(SSE)
src/im          types / manager + adapters/echo
renderer/src    React GUI(pages / components / lib)
scripts/        dev.mjs / build-electron.mjs / prepare-{win,linux}-native.mjs / publish.mjs
```

## 已知限制

- 重启应用后重开会话,展示历史仍在,但对话 transcript 从新开始(v1)。
- 开机自启动在**未签名 dev 二进制**下会被 macOS 拒绝(日志可见),签名打包后正常。
- IM 已接入钉钉;飞书 / 企业微信等渠道待实现(适配器模式,新增即插即用)。
