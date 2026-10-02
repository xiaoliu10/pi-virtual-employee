# AGENTS.md — AI 协作约定

面向在本仓库工作的 AI 编码代理（Copilot / Codex / Claude / pi 等）。

## PR 提交后的 Copilot review 跟进（必须遵守）

向本仓库提交 Pull Request 后，**必须跟进 GitHub Copilot code review 的结果**，处理完毕前不得进入下一步（合并、发版、开始下一个任务）：

1. **主动查看**：PR 创建后拉取 review 结果——
   ```bash
   gh pr view <N> --json reviews --jq '.reviews[]'
   gh api repos/xiaoliu10/pi-virtual-employee/pulls/<N>/comments --jq '.[] | {path, line, body}'
   ```
2. **逐条核实**：每条意见都要独立判断有效性，不允许沉默跳过——
   - 有效 → 立即修复并推送（提交信息注明对应意见）；若决定采用其他方案，在 PR 评论里说明理由。
   - 误报 → 在 PR 评论里给出具体的反驳依据（引用代码/测试证明不成立）。
3. **逐条回应**：处理完成后在 PR 里评论逐条说明处置结果，方便人工复核。
4. **完成判据**：所有意见「已修复」或「已回应」后，才允许合并 PR 或发版。

## 其他约定

- 改动一律走特性分支 + PR，不直接 push main；分支命名 `fix/...`、`feat/...`、`docs/...`，commit 用中文带 scope。
- 发布前跑全量门禁：`npm run test:all`、`npm run typecheck`、`npm run verify:immutable`。
