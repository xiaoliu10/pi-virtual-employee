<!-- 2026-09-29 10:32:48 [01a0c793] -->

## pi-virtual-employee 开源维护方式（2026-09-29 起，用户明确要求）

- 该项目（github.com/xiaoliu10/pi-virtual-employee）已开源，**按开源项目方式维护**：改动一律走特性分支 + PR（`gh pr create --base main`），不再直接 push main。
- 分支命名：`fix/...`、`feat/...`；commit 用中文、带 scope（如 `fix(engine): ...`），沿用仓库现有风格。
- 双远端：`origin` = Gitee（发自动更新 feed），`github` = GitHub（开源主仓）。PR 走 GitHub。
- 发版惯例：docs/releases/vX.Y.Z.md 发布说明 → package.json 版本号单独提交（提交信息就是版本号）→ `npm run package:win` + `package:mac` → `npm run release`（需本地先建 vX.Y.Z 附注标签，脚本只 push 不创建）。
