# Pi Virtual Employee

桌面形态的**虚拟员工（Virtual Employee）**应用：以 [pi agent SDK](https://github.com/earendil-works/pi)（`@earendil-works/pi-agent-core`）的 `Agent` 为对话内核，[Electron](https://www.electronjs.org/) 承载，接入钉钉等 IM 渠道，让一个真正动手干活的 AI 员工为团队服务——先用手头的工具把事情办成，再回复，而不是把任务推回给人。

界面参考 [LobsterAI](https://github.com/netease-youdao/LobsterAI) 风格。产品定位是**单一内置员工**：一个持久在线、可配置、可对话、可定时干活的数字员工，不做多 agent 编排。

## 功能特性

- **对话引擎**：多轮会话、流式输出、自动上下文压缩（阈值触发 + 手动 `/compact`）、长任务进度心跳、停滞看门狗（模型调用进行中视为存活，绝不误杀）
- **IM 集成**：钉钉单聊 / 群聊（Stream 长连接，无需公网地址；AI 卡片流式回复、表情回应、文件收发、@提及与斜杠命令解析）；echo 测试通道
- **工具体系**：知识库（全文 + 向量检索，含长期记忆层）、联网调研、浏览器自动化（复杂表单 / iframe / 下载）、本地文件、文档资源库、受控命令执行（后台会话 / 白名单 / 双重确认）、Computer Use 桌面操控
- **定时任务**：cron 调度、无人值守执行、结果自动推送回创建会话、任务跟随创建人权限
- **报告发布**：任务产物保存为 HTML 并发布成本地可访问链接，长报告自动分段推送
- **权限与安全**：平台验证身份的三级角色（viewer / operator / admin）+ 会话能力门槛 + 危险操作「确认」门 + 提示注入防线（页面 / 文件内容视为数据而非指令）
- **自我运维**：应用自动更新（独立 watchdog 安装器 + 版本熔断）、运行遥测、失败聚类、改进提案回路、提示词自评测（prompt_lab，关键红线用例一票否决）
- **控制台 GUI**：对话、会话管理、模型 / IM / 能力 / 权限可视化配置，多 profile 隔离（`--profile`）

## 快速开始

环境要求：Node.js 20+，npm。

```bash
# 1) 安装依赖（better-sqlite3 跳过 install 脚本，稍后对 Electron ABI 重编译）
npm install --ignore-scripts

# 2) Electron 二进制走 npmmirror 镜像（.npmrc 已配 ELECTRON_MIRROR）；
#    若自动下载不完整，手动拉取：
VER=$(node -p "require('./node_modules/electron/package.json').version")
cd node_modules/electron && rm -rf dist
curl -L -o /tmp/electron.zip "https://cdn.npmmirror.com/binaries/electron/${VER}/electron-v${VER}-darwin-arm64.zip"
unzip -q /tmp/electron.zip -d dist
printf 'Electron.app/Contents/MacOS/Electron' > path.txt
cd -

# 3) better-sqlite3 针对 Electron ABI 重编译
npx electron-rebuild -f -w better-sqlite3

# 4) 启动开发模式（HMR + Electron）
npm run dev

# 生产构建
npm run build
```

## 配置说明

全部配置存 SQLite，可在**设置页**修改，也可由管理员在 IM 单聊里用 `manage_settings` 对话完成：

| 配置 | 说明 |
| --- | --- |
| 模型 | provider / modelId / API key / contextWindow；也支持 `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` 环境变量 |
| IM | 钉钉：创建内部应用 → 取 AppKey/AppSecret → 添加机器人能力、选择 Stream 模式 → 填入设置页并启用 |
| 员工人设 | 姓名 / 角色 / 职责 / 服务时间 / 回复语言；内置安全红线与数据真实性红线常驻、不可被自定义规则关闭 |
| 能力开关 | 知识库、联网、浏览器、文件、报告、命令执行、Computer Use 等逐项开关 |
| 员工权限 | 在 IM 单聊里用 `manage_access` 维护人员角色与会话门槛 |

### IM 管理命令

群聊 @机器人 或单聊直接发送：`/new` 新会话、`/compact` 压缩上下文、`/stop` 停止当前任务、`/model` 切换模型、`/perm` 查看权限。定时任务用自然语言创建（「每天早上 9 点把……」），到点自动执行并推送结果回创建会话。

## 架构

```
electron/            主进程（窗口 / IPC / 自动更新 watchdog）+ preload
src/
├─ engine/           员工引擎：Agent 内核 + 会话管理 + prompt 装配 + tools/
├─ im/               IMAdapter 抽象 + 钉钉适配器（Stream / AI 卡片 / 文件）+ 命令解析 + 看门狗
├─ scheduler/        定时任务调度 + 无人值守运行 + 权限继承
├─ knowledge/        知识库（sqlite-vec 向量检索 + 记忆层）
├─ security/         RBAC：三级角色 + 会话门槛 + 能力表
├─ reports/          报告生成与发布服务
├─ computer/         Cua Driver 安装与桌面会话管理
├─ transport/        HTTP+SSE（渲染进程经 localhost 读流）
└─ db/               better-sqlite3：config / conversations / telemetry
renderer/src/        React + Vite + Tailwind 控制台
```

## 测试与护栏

```bash
npm run test:all           # 全部测试套件（提示词红线 / 权限模型 / 看门狗 / 压缩 / 分段 …）
npm run verify:immutable   # 不可变内核绊线：安全红线、权限判定、更新熔断等区域哈希校验
```

`docs/immutable.manifest.json` 钉住关键护栏区域的 SHA-256：改动这些区域必须以 `IMMUTABLE_ACK="<理由>"` 显式确认，让护栏变更**不可能不被注意**。

## 打包与发布

Windows(NSIS) 安装包与自动更新文件上传到 Gitee 仓库的 `latest` tag release（国内网络下载快）；已安装客户端经 electron-updater 自动检查更新。Linux(AppImage) 支持本地构建。

```bash
cp .env.example .env       # 填入 GITEE_TOKEN（需 projects 权限）
npm run package:win        # typecheck + build + 原生二进制 + electron-builder
npm run release            # 发布前自动跑 immutable 校验与全部测试
```

原生模块（better-sqlite3 + sqlite-vec）按目标平台预编译进安装包（`resources/native/`），打包机无需目标平台编译工具链。

## License

[Apache-2.0](LICENSE)
