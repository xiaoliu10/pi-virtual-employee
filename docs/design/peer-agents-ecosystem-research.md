# 同类 Agent 竞品调研与生态全景（Grok bot / Dots / 开源同类）

> 真实意图：老板想了解同类 AI 员工/助理 agent（点名 Grok bot、Dots 等）都有什么能力、哪些值得借鉴进 VE；顺带产出一张 agent 生态架构/全景图供学习。
> 日期：2026-10-21 ／ 状态：完成（2.1 商业同类已于 2026-10-23 补核；dots 细节仍为二手来源）
> 方法：auto-research 流程（内部摸底 → 外部调研 → 交叉综合）。事实标注来源；推断显式标注。

## 0. 问题定义（Phase 0）

- **真实意图**：不是要抄某个产品，而是回答两个问题——①「同类 IM/个人 AI 员工已经把哪些能力做成了标配？VE 缺哪些？」②「这个生态的架构分层长什么样？」产出要能直接转化成 VE 的路线图候选条目。
- **本项目约束**：Electron 桌面应用 + 进程内引擎（刚完成 pi-session 内核迁移，扩展运行时已通但插件对接未做）；单渠道钉钉（IMAdapter 抽象可扩）；单内置员工定位（明确不做多 agent 编排）；Gitee 100MiB 分发红线；现场盒子网络受限（GitHub 不通，npmmirror/Gitee 通）。
- **好产出标准**：①能力矩阵（同类产品 × 能力，VE 现状一列）；②借鉴清单每条落到 VE 具体模块/文件与契约；③生态全景图（协议层/内核层/渠道层/技能层）；④明确「不借鉴什么」及反面证据；⑤留给用户拍板的决策点。

## 1. 现状与接入点（Phase 1，来源：代码实测 2026-10-21 @ main=324e3f5）

### 1.1 VE 能力现状速览

**形态**：Electron 主进程内跑 `EmployeeEngine`（facade 冻结）；会话内核 = 自建 `Agent`（pi-agent-core 1.2.0）＋可选 `AgentSession` 会话壳（`general.engineKernel`，默认 `legacy`，扩展运行时已通、插件对接未做——`src/engine/session-host.ts`）。

**渠道**：钉钉单聊/群聊（Stream 长连接 + AI 卡片流式）+ echo 测试通道（`src/im/manager.ts:41-44`）。多渠道是抽象好的扩展点（`IMAdapter` 接口，`src/im/types.ts:95`）。

**工具面（60+，`src/engine/tools/*.ts` 注册于 definition.ts）**：
- 知识/记忆：search_knowledge_base、save_to_knowledge、remember、manage_knowledge_base、read_skill_asset
- 执行：run_command（同步 300s/后台）、list_directory/read_file/delete_files、computer_use、browser_*（14 个）、research_web
- 任务：create/get/list/update/toggle/resume/delete_scheduled_task、manage_work（自主任务窗口）、manage_work_items（客户端自主任务）
- 运维/自进化：my_stats、propose_improvement、prompt_lab、manage_update、manage_settings、manage_access、manage_admin、manage_capabilities、manage_skills、manage_computer、manage_process
- 交付：save_report、provide_document、send_image、inspect_spreadsheet、lookup_order、save_document/list_documents

**既有「同类实现」参考（项目内）**：
- 主动行为：长任务心跳（固定间隔进度，`src/engine/progress.ts`）、自主任务观察点调度（`src/scheduler/autonomous.ts`、work-service 窗口循环）
- 自进化闭环：遥测 → 失败聚类 → 提案（improve_proposals 表）→ prompt_lab 红线评测
- 定时任务：cron + 创建人权限继承 + 结果回推

**约束与坑（本会话/记忆实测）**：
- Gitee 100MiB 单资产红线（exe 99.3MB，只剩 ~0.7MB 余量）→ 任何「内置大模型/大运行时」的借鉴都不可行，走 VE 已验证的 runtime 外置分发模式
- 现场盒子只有 Gitee/npmmirror 可达 → 借鉴项若依赖外网服务需带来源链
- 群聊凭据出站门禁刚落地（#95）→ 借鉴「群内交互增强」类能力时要过安全审查
- 常驻巡检 DONE 防护（#92）→ 主动类能力的「模型自行判断完成」是已知风险面
- IM 命令解析只能一份实现、必须容错（记忆 ir-im-command-parsing）

### 1.2 数据流（改动前，供对照借鉴项）

```
钉钉(DingTalk Stream) ─┐
控制台 React UI ───────┼─→ IMAdapterManager/HTTP ─→ EmployeeEngine.send()
定时/自主调度器 ───────┘         │                      ├─ promptWithRetry 梯子
                                │                      ├─ 压缩闸门(context.ts)
                                │                      ├─ 60+ 工具(definition.ts)
                                │                      └─ 遥测→聚类→提案→prompt_lab
                                └─ 推送：pushToConversation(凭据门禁→splitForPush)
```

### 1.3 规模判断

借鉴项多数落在「工具新增 / IMAdapter 扩渠道 / scheduler 行为扩展」，属中小改动；若借鉴「多 agent 编排」类则与产品定位冲突，直接列入不借鉴。

## 2. 外部调研（Phase 2，进行中）

- [ ] 2.1 商业/闭源同类：Grok bot（X DM/Tasks）、钉钉 AI 助理、扣子 Coze、ChatGPT Tasks/Agent —— subagent A
- [ ] 2.2 开源同类源码级：OpenClaw（网关/skills/heartbeat/memory）、LobsterAI、中文 IM bot 框架、Goose/OpenHands 能力面 —— subagent B
- [ ] 2.3 Dots 消歧（dots.ocr vs Dots agent）+ 协议生态（MCP/A2A/SKILL.md/pi packages）+ 通用 AI 员工（Manus 等）—— subagent C

（Phase 3 综合与生态图待外部材料回收后补全）

### 2.1 商业/闭源同类（2026-10-23 补核）

**Grok Bot（xAI，官方一手：x.ai/news/introducing-grok-bot + docs.x.ai/grok-bot/*）**
- 定位原文："Grok Bot is your team of always-on agents. They have their own computer, work inside tools and apps like you do, and keep working 24/7."——有名字/职责的「AI 队友」，上下文随合作累积；像给同事派活一样派工
- 架构：**持久云电脑**（浏览器/命令行/文件/已连接工具），合盖不停工；账号级**一台共享电脑**——cookies/登录态/CLI 凭据全 Bot 共享，官方明示「屏幕是独立工作面，**不是安全边界**」，别放其他 Bot 不该碰的凭据/文件；每 Bot 一块屏幕，可并行但一次一个 computer-use 任务
- **人工接管模式**：密码/passkey、2FA、CAPTCHA、支付/身份核验时 Bot 主动请人接管，做完交还；本地电脑策略三态（每次问/总是允许/从不），默认每次问；对话存电脑外，reset 电脑不丢对话
- Beta：SuperGrok 三档 + Cursor 订阅可用，独立用量配额；企业 waitlist
- Grok Tasks（X 内）：定时执行 prompt 并通知（二手日媒/评测，官方细节待补）
- 适配判断：最像 VE 的对标（持久/主动/记忆/接管制）。「共享电脑不是安全边界」反证 VE 本机单员工 + 凭据出站门禁的隔离更干净；「敏感步骤人工接管」与 VE 的确认门是同一哲学

**ChatGPT Tasks / Work（OpenAI，官方一手：help.openai.com）**
- 演进：**agent mode 已下线**，长任务与交付物改由「ChatGPT Work」承接，浏览器流程走 cloud browser；scheduled tasks 已开放免费档（二手报道：最多 3 个任务、每日最多一次）
- Tasks 能力：一次性/周期任务、监控网页变化、**事件触发任务**（webhook 基座，响应 Gmail/Slack/GitHub 事件，Plus/Pro/Business/Enterprise 可用）；chatgpt.com/schedules 统一管理；agent 用量按档限月（Plus 40/Pro 400/Business 40 条），**排程任务计入限额**
- 安全模式原文要点：高影响动作要求确认、拒绝模式、**prompt injection 监控**、特定站点「监看模式」；官方建议「避免在消息里直接输入密码，敏感输入用接管模式」
- 适配判断：与 VE 的确认门/prompt 注入防线/凭据门禁同向互证；「事件触发任务」是 VE 定时任务之外可考虑的增量（webhook → 触发 sched 会话）

**钉钉 AI 助理（官方应用描述 + alizila 报道）**
- DingTalk 8.0 定位「AI 原生生产力套件」（CEO 原话 "AI DingTalk 1.0"），十余个 agent 驱动功能；AI Assistant（A1）：自动摘要/To-Do 生成、与 AI Tables 同步；Docs AI（文档内嵌表格/脑图/工作流的活知识库）；Meeting AI
- 知识库答员工问（行政制度/HR 政策）为标配场景【二手 awesome-deepseek 收录描述】
- 适配判断：平台级「全家桶」（IM+文档+表格+会议全贯通），VE 无法也不必对标；VE 的错位在**跨组织自托管 + 开源可审计**。平台本身是 VE 的渠道层，AI 助理与 VE 是共存关系

**扣子 Coze（字节，官方文档 llms.txt + 二手教程）**
- 能力面：人设与提示词、插件（内置市场 + 自定义 API）、**工作流**（拖拽节点：意图识别/循环/选择器/HTTP/代码）、记忆库（对话细节 + 知识库文档分片 + 数据库自然语言增删改查 + 长期记忆）、**定时任务**（到点自动触发 bot 发消息）、多渠道发布（抖音/飞书/微信/掘金等）、开场白/问题建议/音色
- 文档形态值得注意：docs.coze.cn 提供 llms.txt + markdown 直链（.md）——文档对 agent 友好正在成为行业惯例
- 适配判断：零代码编排平台的「工作流节点类型清单」是 VE 工具体系做「组合任务」时的参考词汇表；但 VE 定位「一个真员工」而非「建 bot 的平台」，直接竞争弱

### 2.2 开源同类源码级（subagent B，已完成，产出存档：subagent-artifacts/94a5d567，方法：gh api 直读源码，无二手转述）

**对象与体量**：openclaw/openclaw（★392,751）、netease-youdao/LobsterAI（★6,139）、AstrBotDevs/AstrBot（★42,780）、Goose/OpenHands 速览。

**OpenClaw 关键事实**：
- 渠道抽象 = 一个 `ChannelPlugin` 类型 + 近 30 个**可选能力槽**（pairing/security/allowlist/heartbeat/agentTools/…），不是大基类；渠道有 bundled/official/external 三级；「不跨渠道翻译 sender id」是显式文档语义（access-groups.md）
- heartbeat **已废弃**迁往 automations/cron：job 定义+运行态+历史持久 SQLite；**启动时过期任务重排期而非立即补跑**（把模型执行挡在启动路径外）；interrupted ⇒ delivery Unknown，**任意中断的工具副作用不保证 exactly once**（官方自述）
- memory 五层（instructions / curated core / episodic / prospective / review）；「**写入路径即安全边界**」——内容级扫描抓不住投毒事实，写入时做 provenance 分级 + 结构化晋升门槛；「**memory 失败绝不阻塞回复**」（每步超时+降级）；引 LongMemEval："what was written matters more than how it is indexed"
- skills = SKILL.md 事实标准（frontmatter name + description ≤160 字符 lint）、watch 热加载、per-agent 白名单、`install.allowUploadedArchives: false` 安全默认
- 已知坑（issue 实证）：#8776 soul-evil hook 静默劫持（agent 可写自身 prompt/配置 = 提权面，组合 CVE-2026-25253）；#75621 MCP stdio 子进程按 session 重复孵化泄漏（要 config-hash 单例）；#75688/#8786/#136175 memory 索引打满 CPU 阻塞诊断；#58691 权限配置被硬编码审批覆盖（权限模型要单一真源）；#3275/#53870 npm 包名劫持/投毒（分发需来源校验）

**LobsterAI 关键事实**：分层 = Cowork（产品/会话层）+ OpenClaw（运行时网关），原文 "keep local persistence, permissions, UI state, artifacts, agents, memory, and IM bindings in the desktop app while using OpenClaw for agent execution"；IM 网关统管 10 平台；钉钉配置有 `dmPolicy: open|pairing|allowlist` 三态、`groupSessionScope: group|group_sender` 群会话隔离、`DingTalkGatewayStatus{connected,startedAt,lastError,lastInboundAt,lastOutboundAt}` 状态五字段；`imReplyGuard`（空回复/thinking 泄漏兜底）；IM 内自然语言建定时任务 + `cronDeliveryTarget`（投递目标与创建会话解耦）；28 内置技能 + Expert Kits；多 agent（identity/model/skills/IM bindings 独立，SQLite agents 表）

**AstrBot 关键事实**：18 个平台适配器；`Platform(abc)` 三件套 run/meta/terminate + `PlatformStatus` 状态机 + error 列表 + `get_stats()`；`register_platform_adapter(config_metadata=…)` **配置元数据驱动 WebUI 自动生成表单**；`send_by_session(持久化会话, 消息链)` 不依赖 event 对象；`unified_webhook` 单端口分发

**Goose/OpenHands**：Goose 有 ACP（复用用户已有订阅而非 API key）+ custom distro 预配置打包；OpenHands 的「执行后端可插拔」（local/docker/remote）抽象值得借鉴，其自动化/webhook 服务端形态不适用

### 2.3 Dots 消歧 + 协议生态（subagent C，已完成，产出存档：subagent-artifacts/afd308ba；⚠️ openai.com 403，dots 细节为二手日媒多源交叉，非一手）

**Dots 消歧结论**：
1. **OpenAI「dots」**【二手多源一致，官方页存在但未能直读】：2026-09-29 发布的常驻 AI agent——目标驱动持续工作、专用云电脑（可选用自己 PC）、4,000+ 应用集成、记忆、**权限三级制**（自主做：调研/草稿；需许可：发消息/改联动应用/操作浏览器桌面；必须批准：购买/删除/改密码/汇款）；Pro 档可用。⚠️ 标注：GPT-6 Astra 驱动、$100/$200/$500 定价等细节未获一手验证，引用需谨慎
2. **rednote-hilab/dots.ocr（已更名 dots.mocr）**【gh api 一手】：MIT、1.7B VLM 文档解析模型，vLLM ≥0.11.0 官方集成，Elo 1124.7（超 PaddleOCR-VL/GLM-OCR，逊 Gemini 3 Pro）——作为 VE inbound 文档解析的**可选自托管后端**可行但需 GPU，是增量不是替代
3. 同名 agent 创业公司：未发现【负面证据】

**协议/技能互操作层**【gh api 实测计数】：
- MCP：GitHub topic:mcp-server 38,582 仓库；官方 registry 在线（modelcontextprotocol/servers ★91.5k）
- A2A：a2aproject/A2A ★26.3k，Apache-2.0，Linux Foundation 基金会项目（Google 捐赠）——「opaque agentic applications 互操作」
- Agent Skills：agentskills.io 官方规范站 + anthropics/skills ★182,953；**pi 内核原生实现 Agent Skills 规范**（badlogic/pi-mono docs/skills.md 原文）→ VE 经内核天然兼容该生态
- 通用 AI 员工生态位：Manus（云端 VM 全自主执行/交付产物/定时）、Genspark（产物交付工作台）、ChatGPT Agent（VM 内浏览器+终端+连接器）——VE 错位竞争点 = **IM 原生 + 私有知识库 + 自托管**

**方法局限（诚实标注）**：web-search MCP 余额耗尽（-429）、A 线 subagent 连接错误中断 → Grok bot / 钉钉 AI 助理 / Coze / ChatGPT Tasks 的**一手能力核验未完成**，2.1 节只能以【知识库级推断】口径给出，待联网恢复后补核。

## 3. 交叉验证：借鉴清单（每条已对照 VE 现状，剔除已有等价物）

### 3.0 已有等价物（外部建议不引入，沿现状）
| 外部做法 | VE 现状（证据） | 结论 |
| --- | --- | --- |
| LobsterAI imReplyGuard 空回复/思考泄漏兜底 | #83 退化回复门禁已拦（send 管线，PR #83） | 已有 |
| OpenClaw「memory 写入期 provenance」 | `src/knowledge/memory-scope.ts` 就是单一信任边界：owner 一律服务端派生、不信任模型自报 | 已有（方向一致，互为印证） |
| OpenClaw MCP 子进程 config-hash 单例 | `src/engine/tools/mcp.ts:80` 连接缓存按 server 配置刷新（runRefresh/nextCache） | 疑似已有，落地时核对 cache key 语义 |
| LobsterAI cronDeliveryTarget 投递目标解耦 | 推送目标绑定 + 0.2.92 起「改绑需确认」（scheduled-task-identity-model） | 已有 |
| dots 权限三级制 | RBAC viewer/operator/admin + 危险操作「确认」门 + 凭据出站门禁（#95） | 语义已有；差异见 3.2 |

### 3.1 借鉴清单（按优先级，全部落到文件）
**P1 高价值低成本（可立即排期）**
1. **渠道健康度状态卡**：`IMAdapter.status()` 返回 `{connected, startedAt, lastError, lastInboundAt, lastOutboundAt}`（LobsterAI 五字段实证）→ 改 `src/im/types.ts` + `src/im/adapters/dingtalk.ts` + SettingsPage 渠道卡。`lastInboundAt` 是排查「机器人没反应」的关键遥测。
2. **渠道能力声明**：`IMAdapter.metadata` = `{displayName, configSchema, capabilities{streaming, proactive, groupMention, media}}`（AstrBot `register_platform_adapter(config_metadata)` 思路）→ 同上三处；新渠道的设置表单由 schema 驱动而非 UI 硬编码。
3. **调度副作用幂等**：job run 生成 run-id 作为推送幂等键，防「调度超时但 losing run 仍在执行 → 结果双推」（`src/scheduler/scheduler-service.ts` runWithTimeout 注释明示 losing run 会继续跑；OpenClaw 官方自述 interrupted 副作用不保证 exactly once）→ `scheduler-service.ts` + `src/im/manager.ts` pushToConversation。

**P2 中等**
4. 技能工程化小补：SKILL.md `description` ≤160 字符 lint + 文件 watch 热加载（`src/engine/skills/skill-loader.ts`；现有 markSkillsChanged 手动刷新保留）
5. 权限单一真源回归：钉住「配置不可被硬编码审批覆盖」类回归（OpenClaw #58691 教训）；VE 已有 test:permissions，补覆盖面
6. 渠道扩展前置规则（若做飞书/企微）：按「metadata + status + 能力声明」模式走 IMAdapter；「不跨渠道翻译 sender id」写成白名单语义文档（OpenClaw access-groups）

**P3 产品决策/长期（见 §5 拍板项）**
7. `groupSessionScope` 群内按人会话隔离（LobsterAI `group|group_sender`）——涉及「单一员工服务团队」的产品语义，不是纯技术
8. A2A server 端点：VE 作为企业内「员工」被其他 agent 委派任务（a2aproject/A2A，★26.3k）
9. dots.mocr 自托管文档解析后端：以 MCP server 形式接入（不内建），补扫描件/复杂版面缺口（现 extractText 覆盖 Office 文档）

### 3.2 明确不借鉴（反面证据/定位冲突）
- **OpenClaw 30-adapter ChannelPlugin**：9 渠道 × 多云部署的产物，VE 单渠道起步抽象过度——B 线明确建议
- **外置网关进程**（LobsterAI 的 OpenClaw 运行时分离）：带来状态双写与同步补丁税（openclawCronRunHistorySync）；VE 进程内更简单，代价是需给 session-host 补「内核可重启+运行态可重建」
- **云电脑/VM 沙箱**（dots/Manus/ChatGPT Agent）：Gitee 100MiB 分发红线 + 自托管定位；桌面操控已有 computer_use
- **记忆向量库起步**：OpenClaw 自己引 LongMemEval 说明 file-first 更重要；VE KB 已有 sqlite-vec + scope 边界
- **agent 可写自身系统提示/红线**：OpenClaw #8776（soul-evil 静默劫持 + CVE 组合）是实证反例——VE 的「红线常驻不可被自定义规则关闭」+ verify:immutable 绊线是对的，守住

## 4. 生态全景图（学习向）

```
┌─────────────── 渠道层（平台验证身份）───────────────┐
│  钉钉 │ 飞书 │ 企微 │ Telegram │ Slack │ Discord │ X DM │ …
└───────┬────────────────────────────────────────────┘
        ▼
┌─────────── 网关/产品层（会话·权限·持久化·UI）──────────┐
│  VE(im/manager+RBAC) │ LobsterAI(Cowork) │ AstrBot │ OpenClaw │ Coze │ 钉钉AI助理
└───────┬────────────────────────────────────────────┘
        ▼
┌─────────── 内核/运行时层（推理循环·工具·压缩）─────────┐
│  VE: pi-agent-core Agent + AgentSession 壳(进程内)     │
│  OpenClaw: 自有 gateway │ LobsterAI: 外包 OpenClaw     │
│  dots: GPT 系云端常驻 │ Manus: 云端 VM                 │
└───────┬────────────────────────────────────────────┘
        ▼
┌─────────── 互操作层 ──────────────────────────────────┐
│  MCP（工具/数据，38k+ servers）│ Agent Skills/SKILL.md │
│  （pi 内核原生兼容 → VE 直接受益）│ A2A（agent↔agent）  │
└───────┬────────────────────────────────────────────┘
        ▼
┌─────────── 模型/凭据层 ───────────────────────────────┐
│  VE: resolveModel+credential-store+streamFn 会话亲和   │
│  Goose: ACP 复用订阅 │ 各家: API key / 订阅             │
└───────────────────────────────────────────────────────┘
```

能力矩阵（✓=有，±=部分，✗=无；VE 列为代码实测，他列为调研材料【事实/推断】见 §2）：

| 能力 | VE | OpenClaw | LobsterAI | AstrBot | dots(OpenAI) | Manus |
| --- | --- | --- | --- | --- | --- | --- |
| IM 渠道 | 1(钉钉)+echo | ~9 | 10 | 18 | X/ChatGPT 系 | Web 为主 |
| 群内权限分级 | ✓ RBAC 三级 | ✓ allowlist/accessGroups | ✓ dmPolicy | ± | ✓ 三级(动作维度) | ✗ |
| 定时任务 | ✓ cron+权限继承 | ✓ automations | ✓ | ✓ | ✓ Tasks | ✓ |
| 主动唤醒/心跳 | ✓ 心跳+观察点 | ✓(已废 heartbeat→job) | 经 OpenClaw | ± | ✓ 常驻 | ✓ |
| 自然语言建任务 | ✓ | ✓ | ✓ | ✗ | ✓ | ✓ |
| 知识库/记忆 | ✓ KB+向量+scope 记忆 | ✓ 五层 file-first | 经 OpenClaw | ✓ | ✓ 云端记忆 | ✓ |
| 技能生态 | ✓ builtin/user + SKILL.md(内核原生) | ✓ SKILL.md 事实标准 | ✓ 28+Kits | ✓ 插件 | ✗(闭源应用集成) | ✗ |
| 插件宿主/扩展运行时 | ✓(pi-session 档,对接未做) | ✓ | 外包 | ✓ | ✗ | ✗ |
| MCP | ✓ 连接器 | ✓ | ✓ | ✓ | 4000+ 应用(闭源) | ± |
| 沙箱执行 | ✗(受控本机) | ± | 外包 | ✗ | ✓ 云电脑 | ✓ VM |
| 自托管/开源 | ✓ | ✓ | ✓(壳开源) | ✓ | ✗ | ✗ |
| 自进化闭环(遥测→聚类→提案→prompt_lab) | **✓ 独有** | ✗ | ✗ | ✗ | ✗ | ✗ |
| 护栏绊线/出站门禁 | **✓ 独有** | ±(事后) | ✗ | ✗ | ✓(审批制) | ✗ |

## 5. 盲区与待拍板

**盲区（诚实标注）**
1. ~~2.1 商业 IM 员工一手核验~~ ✅ 2026-10-23 已补核（DeepSeek Search API，见 2.1 节）；本次调研同时沉淀了本地 `deepseek-websearch` MCP server（web_search/web_fetch，全会话可用）
2. dots（OpenAI）细节（模型名/定价/可用地区）仍为二手日媒交叉，openai.com 未直读成功；Grok Tasks 定时机制细节为二手。
3. Goose recipe/定时能力「未证实」（B 线标注）；OpenClaw 渠道文档清单读取被截断。

**待用户拍板**
1. P1 三项（渠道状态卡/能力声明/调度幂等）是否排期？→ 建议排期，2-3 个小 PR。
2. `groupSessionScope` 群内按人会话隔离：是否改变「群共享一个会话」的产品语义？
3. A2A server、dots.mocr 解析后端：进 roadmap 还是搁置？
4. 调度行为差异：VE 现状「启动后过期任务补跑一次」vs OpenClaw「重排不补跑」——维持现状还是对齐？

**状态**：Phase 3 完成。2.1 补核后本文档即闭环；本文档当前不含任何需要改代码的承诺，全部借鉴项均为候选，落地需另立 PR 走正常评审。
