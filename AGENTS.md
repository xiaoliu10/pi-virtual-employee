# AGENTS.md — AI 协作约定

面向在本仓库工作的 AI 编码代理（Copilot / Codex / Claude / pi 等）。

## PR 提交后的 Copilot review 跟进（必须遵守）

向本仓库提交 Pull Request 后，**必须跟进 GitHub Copilot code review 的结果**，处理完毕前不得进入下一步（合并、发版、开始下一个任务）：

1. **主动查看，并等 review 完成**：Copilot review 是**异步**提交的——PR 刚创建时查询结果为空属正常，**空结果不等于没有意见**。等待几分钟（或推送新提交后）至少复查一次，确认 review 已产出再判定。拉取时用 `--paginate` 取全量（`gh api` 默认只返回第一页 30 条，超出会漏）——
   ```bash
   gh pr view <N> --json reviews --jq '.reviews[]'
   gh api --paginate repos/xiaoliu10/pi-virtual-employee/pulls/<N>/comments --jq '.[] | {path, line, body}'
   ```
2. **逐条核实**：每条意见都要独立判断有效性，不允许沉默跳过——
   - 有效 → 立即修复并推送（提交信息注明对应意见）；若决定采用其他方案，在 PR 评论里说明理由。
   - 误报 → 在 PR 评论里给出具体的反驳依据（引用代码/测试证明不成立）。
3. **逐条回应**：处理完成后在 PR 里评论逐条说明处置结果，方便人工复核。
4. **完成判据**：确认 review 已产出（非空/已终态），且所有意见「已修复」或「已回应」后，才允许合并 PR 或发版。

## 写代码：拉子代理做 code-review（通用约束）

凡是写代码的改动（新增/修改业务逻辑、修 bug、补测试、改接口或配置结构——**不是**纯文档/注释/格式微调），在提 PR 前**先拉一个独立的子代理做 code-review**，不让写代码的同一个上下文自我背书：

- **范围**：重点查 bug、竞态、边界、安全/凭据泄露、错误处理、API 误用、漏测试、不可变区域/契约被破坏、与现有约定冲突。
- **做法**：把待审 diff（或变更的文件列表 + 关键代码）交给一个**干净的上下文**（pi 用 `subagent` 工具委派，例如 `code-reviewer`；其他环境用对应的独立审查 agent）。子代理不该持有写代码时的假设，要让它只看代码本身下判断。
- **闭环**：子代理提出的有效意见必须修复或明确回应（采用其他方案要说明理由），处理完才提 PR；提 PR 后再走上面的 Copilot review 流程，两道审查互补不替代。
- **轻量场景豁免**：纯文档/README/发布说明/AGENTS.md 这类无逻辑改动的，可跳过子代理 code-review，直接走 Copilot review。

## 其他约定

- 改动一律走特性分支 + PR，不直接 push main；分支命名 `fix/...`、`feat/...`、`docs/...`，commit 用中文带 scope。
- 发布前跑全量门禁：`npm run test:all`、`npm run typecheck`、`npm run verify:immutable`。
