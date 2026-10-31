# 更新日志

本项目遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 格式，版本号遵循语义化版本。

开源前的内部迭代细节不在此逐一罗列（完整历史见 git log）；以下从开源基线版本开始记录。

## v0.2.176 — Embeddable assistant widget for business systems / 可嵌入业务系统的 AI 助理小组件

### English

A business system can now embed the virtual employee as an AI assistant panel — a floating bubble (Shadow DOM, no style leakage) or a full-page chat — served over a small HTTP surface on the VE host.

- **New widget server** (`GET /widget.js`, `GET /widget`, `GET /api/widget/config`, `POST /api/widget/chat`). Style follows the Alibaba Cloud console assistant: bubble → panel with title, greeting, suggestion chips, message list, Shift+Enter input, AI disclaimer.
- **Bearer token = access token**, not an admin credential. End users are addressed as `widget-user-<key>` and are **clamped to the viewer role** — `security.defaultRole` cannot lift them.
- **Widget conversations are a remote, untrusted channel** (`widget:` origin). They are not the local console: no profile-scope memory writes, no actorless admin path.
- **Same outbound credential gate as IM group pushes**: replies carrying credentials are withheld.
- **Abuse limits**: 256KB body cap, 4000-char message cap, 30 req/min per token+client, one in-flight turn per conversation.
- Configurable from Settings → 助理小组件 (port 17880, loopback/LAN exposure, token, title, suggestions, disclaimer, allowed origins).

### 中文

业务系统现在可以把虚拟员工嵌成 AI 助理面板——右下角浮窗（Shadow DOM，样式不互相污染）或整页对话，由 VE 主机上一个小型 HTTP 服务提供。

- **新增小组件服务**（`GET /widget.js`、`GET /widget`、`GET /api/widget/config`、`POST /api/widget/chat`）。样式对齐阿里云控制台 AI 助理：气泡 → 面板（标题、欢迎语、建议 chips、消息列表、Shift+Enter 输入、AI 声明）。
- **Bearer 令牌是访问令牌**，不是管理员凭据。终端用户身份为 `widget-user-<key>`，角色**强制封顶 viewer**——`security.defaultRole` 无法提权。
- **widget 会话是远端不可信通道**（`widget:` 来源），不等同本机控制台：不能写 profile 作用域记忆，也没有无 actor 的 admin 兜底路径。
- **与 IM 群推送同一道出站凭据门禁**：带凭据的回复会被拦下。
- **滥用防护**：body 上限 256KB、消息上限 4000 字、每 token+客户端 30 次/分钟、同一会话同时仅一个在途回合。
- 设置页「助理小组件」可配：端口 17880、暴露范围（本机/局域网）、令牌、标题、建议问题、免责声明、允许的来源域名。

## [0.2.91] — 2026-09-21

### 开源基线

首个开源发布版本。桌面形态的虚拟员工（Virtual Employee）应用：以 pi agent SDK 为对话内核、Electron 承载，接入钉钉/飞书等 IM 渠道，让一个真正动手干活的 AI 员工为团队服务。

### 核心能力

- **对话引擎**：多轮对话、自动上下文压缩（/compact 与阈值触发双通路）、长任务进度心跳、停滞看门狗（in-flight 模型调用视为存活）
- **IM 集成**：钉钉单聊/群聊（AI 卡片流式回复、表情回应、文件收发、@提及解析）、飞书、企微适配器
- **工具体系**：知识库（含向量检索与记忆层）、联网调研、浏览器自动化、本地文件、文档库、报告发布、受控命令执行、Computer Use 桌面操控
- **定时任务**：cron 调度、无人值守执行、结果自动推送回创建会话、跟随创建人权限
- **权限模型**：平台验证身份的三级角色（viewer/operator/admin）+ 会话能力门槛 + 危险操作「确认」门
- **自我运维**：应用自动更新（独立 watchdog 安装器 + 熔断）、运行遥测、失败聚类、改进提案回路、提示词自评测（prompt_lab）
- **不可变内核**：安全红线、数据真实性红线、权限判定、更新熔断等关键区域哈希钉死，变更必须显式确认

### 暂未开源的历史能力

内置提示词中沉淀的特定部署环境运维经验（登录态实测、堡垒机 canvas 操作等）已从开源版本中移除，核心红线（不泄露凭据、不编造数据）完整保留。
