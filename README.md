# Pi Virtual Employee

**简体中文** | [English](README.en.md)

桌面形态的**虚拟员工（Virtual Employee）**应用：以 [pi agent SDK](https://github.com/earendil-works/pi)（`@earendil-works/pi-agent-core`）的 `Agent` 为对话内核，[Electron](https://www.electronjs.org/) 承载，接入钉钉等 IM 渠道，让一个真正动手干活的 AI 员工为团队服务——先用手头的工具把事情办成，再回复，而不是把任务推回给人。

界面参考 [LobsterAI](https://github.com/netease-youdao/LobsterAI) 风格。产品定位是**单一内置员工**：一个持久在线、可配置、可对话、可定时干活的数字员工，不做多 agent 编排。

**与 Hermes 这类「过程播报」机器人的区别**：Hermes 每执行一步工具调用就把中间结果回复到群里，一个长任务动辄刷屏几十条消息；虚拟员工以**结果为导向**——接受任务后静默执行，只在完成时回复最终结果，长任务期间按可配置的固定间隔定时汇报一次任务进度，过程细节不打扰群内其他人。

**与龙虾（LobsterAI）的区别**：龙虾没有自进化体系；它的梦境系统（记忆整理）在泛化归并时会丢失精细化数据——记忆被概括之后部分精度就没了。虚拟员工两者都补上：**自进化闭环**（运行遥测 → 失败聚类 → 改进提案 → 提示词自评测 `prompt_lab`，关键红线用例一票否决）；知识整理时**关键数据逐字保留**，被归并的原始条目仅归档不删除、可随时恢复，泛化与精度兼得。

**群内权限分级与原生知识库，都是内置能力**：虚拟员工做了**群内的权限分级管理体系**——钉钉等平台验证的成员身份映射为 viewer / operator / admin 三级角色，命令执行、能力开关、危险操作确认在单聊与群聊中统一按角色管控，而不是群内人人同权；知识库也是**原生内置**（全文检索 + 向量检索 + 长期记忆层，支持外接），无需外挂第三方知识库产品。

## 功能特性

- **面向知识库的企业级机器人**：支持**内置知识库和外接知识库**。内置知识库结合全文检索、向量检索与长期记忆，也可对接企业已有知识库，通过钉钉等 IM 渠道提供知识问答与任务执行能力，并配备角色权限控制和危险操作确认机制。

- **对话引擎**：多轮会话、流式输出、自动上下文压缩（阈值触发 + 手动 `/compact`）、停滞看门狗（模型调用进行中视为存活，绝不误杀）
- **长任务保障**：任务超时自动触发旁路总结；长任务执行期间按固定时间间隔主动上报进度，避免长时间无反馈。
- **IM 集成**：钉钉单聊 / 群聊（Stream 长连接，无需公网地址；AI 卡片流式回复、表情回应、文件收发、@提及与斜杠命令解析）；echo 测试通道
- **工具体系**：知识库（全文 + 向量检索，含长期记忆层）、联网调研、浏览器自动化（复杂表单 / iframe / 下载）、本地文件、文档资源库、受控命令执行（后台会话 / 白名单 / 双重确认）、Computer Use 桌面操控、**MCP 外部工具**（原生 MCP 连接器：标准 mcpServers 配置，stdio / Streamable HTTP，工具桥接为 `mcp__服务器__工具`，统一按角色管控）
- **定时任务**：cron 调度、无人值守执行、结果自动推送回创建会话、任务跟随创建人权限
- **自主任务**：从对话里发现值得长期跟进的目标 → 提案 → 你确认后开工；不用写 cron，员工自己记条件、记进展、记踩坑，按「观察点」（数据什么时候生成、批次什么时候跑完、结果什么时候出来）判断下次什么时候再看，一天可跟进多次，卡住时先来问你
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

### 自主工作：先提案，再确认

自主任务是**持续跟进的长期目标，不要求提供 cron**。管理员在来源单聊/群聊说「总结下最近有什么可以自主做的」（`manage_work_items action=mine`），默认读取该会话近 **24 小时**的有界摘录。提案包含 ID、标题、目标、完整条件及原句/消息来源；只保存为 `proposed`，**不自动开工**。在同一来源会话回复「确认创建 <id/标题>」才执行；确认时可以直接按管理员要求改写提案的标题/目标/执行条件（`action=confirm` 附带 `title/goal/conditions`），不必原样接受。用 `action=list/get` 查状态和笔记；即使推送失败，提案仍可查询，失败不能当作已送达。

后台挖掘**默认关闭**。管理员在 **IM 单聊**用 `manage_settings`（当前消息须含「确认」）配置：

- 开启：`action=set path=capabilities.autonomousMining.enabled value=true`；关闭用 `false`。
- 周期：`action=set path=capabilities.autonomousMining.intervalHours value=4`（默认 **4 小时**，范围 **1–24**；后台每小时检查一次，不保证精确到点）。

后台按来源会话独立调用模型，SQLite 保存每源进度；不混合跨聊天摘要，不向模型附带其他会话的标题或知识库内容，不把私聊提案转发到群。历史是**不可信数据**，不能覆盖系统规则；来源 ID 与原句/消息 ID 必须通过校验，敏感消息会过滤。摘录会发给配置的模型供应商，请先确认组织的数据政策。

执行窗口中用 `manage_work` 保存条件、进展、踩坑；**下次跟进时间完全由本次执行结果决定，不约定频率**：有卡点（等第三方、等对方处理）且不确定何时解决，员工会把问题抛到来源会话问清 ETA 再定下次；深夜/非工作时间对方通常不处理，不空查；按**观察点**（数据何时生成、批次何时跑完、何时出结果）一天查多次或隔天查，而不是固定高频轮询。首个执行窗口会先给出简要跟进计划（列出今天的观察点及依据、怎么覆盖）再开始第一步。执行中管理员仍可随时调整：`action=update` 修改标题/目标/条件（执行中也可改）或改约下次跟进时间（最小间隔 15 分钟，执行中不能改期），`action=pause` 立即暂停当前窗口并等管理员明确恢复。长期目标可跨窗口持续推进，明确完成才结束。**条件是提示约束，不是硬时间锁或业务校验器**。缺资源、需要真人处理或跨单位协调时，暂停等待管理员；管理员在来源会话直接回复答复内容即可恢复（恢复无需确认口令，创建时已授权）。可复用、非敏感的经验可在现有知识库权限下沉淀，私有内容不要共享。

限制：每次最多扫描 12 个来源、每源 25 条消息（用户原文最多 1000 字）、最多 5 个提案，整体 3 分钟、每源模型调用最多 60 秒。后台从上次成功页继续，首次回看 24 小时；按需扫描不推进后台游标。截断/证据严格校验可能漏提案，不能当作完整审计。推送超时只表示送达未知，不会重复自动创建执行任务。

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

Windows(NSIS) 安装包与自动更新文件上传到 Gitee 仓库的 `latest` tag release（国内网络下载快），已安装客户端经 electron-updater 自动检查更新；**同一版本同时发布到 GitHub Releases，带 Windows 与 macOS(Apple Silicon) 双端安装包**。Linux(AppImage) 支持本地构建。

```bash
cp .env.example .env       # 填入 GITEE_TOKEN（需 projects 权限）
npm run package:win        # Windows 安装包（typecheck + build + 原生二进制 + electron-builder）
npm run package:mac        # macOS dmg（Apple Silicon，未签名）
npm run release            # 发布前自动跑 immutable 校验与全部测试；Gitee + GitHub 双端上传
```

macOS 包未做签名/公证：首次打开需在应用上**右键 → 打开**以绕过 Gatekeeper。`gh` CLI 需已登录（GitHub 上传走它）。

原生模块（better-sqlite3 + sqlite-vec）按目标平台预编译进安装包（`resources/native/`），打包机无需目标平台编译工具链。

## License

[Apache-2.0](LICENSE)
