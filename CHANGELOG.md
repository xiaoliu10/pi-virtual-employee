# 更新日志

本项目遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 格式，版本号遵循语义化版本。

开源前的内部迭代细节不在此逐一罗列（完整历史见 git log）；以下从开源基线版本开始记录。

## v0.2.178 — Widget ticket auth & business-side role passthrough / 小组件票据鉴权与业务方权限透传

### English

The embedded assistant now honours the BUSINESS system's own account model: a user who is an admin over there can act as an admin here, and the port is closed to anyone without credentials.

- **Session tickets replace trust-the-browser role claims.** The business system's backend calls `POST /api/widget/session` (Bearer widget token + `X-VE-Secret` header) with `{user, role}` and receives a short-lived ticket (TTL 5 min). The browser only ever holds the ticket — the secret never reaches a page.
- **Tickets are bound to their declared consumer**: the exchange declares the `origin` (and optionally `clientIp`) of the browser that will use the ticket. A ticket replayed from another machine or origin is refused with a specific reason.
- **Roles ascend to admin, never owner**: a ticketed admin passes the same gates as a local admin (shell, settings, task management, confirmations); `owner` remains deployment-owner-only. A widget actor with no verified role is a viewer — `security.defaultRole` does not apply.
- **Reverse-proxy aware**: configure trusted proxy addresses; only their `X-Forwarded-For` is honoured, and only when the chain's last hop names the trusted proxy itself (fail-closed against forged chains).
- **CORS preflight allows `X-VE-Ticket`**, so the cross-origin embed works in real browsers.

### 中文

小组件现在尊重业务系统自己的账号体系：在那边是管理员的用户，在这里也能以管理员身份行事；而没有凭据的任何人都进不了这个端口。

- **会话票据取代「浏览器说了算」的角色声明**。业务系统后端调用 `POST /api/widget/session`（携带 Bearer 访问令牌 + `X-VE-Secret` 头）提交 `{user, role}`，换取一张短期票据（5 分钟有效）。浏览器只持有票据——接入密钥永远不会出现在页面里。
- **票据绑定「声明的使用方」**：换票时声明使用方浏览器的 `origin`（可选 `clientIp`）；票据被转到别的机器或别的来源会以明确原因拒绝。
- **角色上限 admin，永远到不了 owner**：持票据的 admin 与本地管理员走完全相同的门禁（命令、设置、任务管理、确认授权）；`owner` 仍是部署者专属。无票据的 widget 会话是 viewer——不受「默认角色」影响。
- **支持反向代理**：配置信任的代理地址后才会采用 `X-Forwarded-For`，且要求链的最后一跳就是该可信代理（对伪造链 fail-closed）。
- **CORS 预检放行 `X-VE-Ticket`**，跨域嵌入在真实浏览器中可用。

## v0.2.177 — Widget port allocation across profiles / 多 profile 小组件端口自动分配

### English

Running several profiles on one machine (`--profile Nova`, `--profile Orion`, …) used to break the widget: every profile defaulted to port 17880, so the second listener died on `EADDRINUSE` while the settings page still showed "enabled".

- **Automatic port allocation**: at startup the widget probes the configured port, and if it is busy walks forward from 17880 to the first free one, then **persists it into that profile's config** — the address stays stable across restarts, which matters because business systems embed a literal URL.
- **Manual "自动分配" button** in Settings → 助理小组件 to re-pick deterministically without a restart.
- **Failures are visible now**: the settings page shows "服务运行中 :17881" or the actual reason ("端口 17880 已被占用（可能是同机另一个 profile 的实例）") instead of one line in `main.log`.
- **Cross-mode conflict detection**: probing only the widget's own bind host is wrong — measured on macOS, a `0.0.0.0` holder does NOT block a later `127.0.0.1` bind (SO_REUSEADDR), so a loopback profile could claim a port a lan profile already owned. Ports are now treated as taken when **any** interface holds them.

### 中文

同机跑多个 profile（`--profile Nova`、`--profile Orion` 等）时小组件会坏：每个 profile 都默认 17880，第二个监听直接 `EADDRINUSE` 死掉，而设置页还显示「已启用」。

- **自动分配端口**：启动时探测配置端口，被占用就从 17880 往后找第一个空闲端口，并**写回该 profile 的配置**——重启后地址不变，因为业务系统嵌入的是写死的 URL。
- 设置页新增**「自动分配」按钮**，不用重启就能确定性地重选。
- **失败可见**：设置页直接显示「服务运行中 :17881」或真实原因（「端口 17880 已被占用（可能是同机另一个 profile 的实例）」），不再只是 `main.log` 里一行 WARN。
- **跨暴露模式冲突检测**：只探自己的绑定地址是错的——macOS 实测，`0.0.0.0` 已占用并不阻止之后 `127.0.0.1` 绑定（SO_REUSEADDR），loopback profile 会抢走 lan profile 已占的端口。现在只要求**任一接口**占用即判定为不可用。

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
