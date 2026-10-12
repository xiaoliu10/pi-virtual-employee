# CDP 接管真实浏览器过 WAF/滑块 调研与设计

> 真实意图 / 2026-10-10 / 状态：草案待拍板
> 现场问题：Nova 提交 CRM 工单时滑块验证被 WAF 拦截（自动化被识别），只能转人工。用户问：走 CDP 协议、打开真实浏览器，能模拟吗？有工具吗？

## 1. 现状与接入点

### 1.1 数据流（现状）
```
模型 → browser_* 工具(src/engine/tools/browser.ts)
     → BrowserService(src/browser/browser-service.ts:13  import { chromium } from "playwright")
     → chromium.launchPersistentContext(profilePath, { headless })   // browser-service.ts:211
     → Playwright 自带 Chromium（非系统真 Chrome；headless 默认 true, config-store.ts:448）
```
- 持久化 profile：**登录态/cookie 已跨重启保留**（browser-service.ts:204-210）——这是过验证码后「只人工过一次」的基础，已有。
- `browser.headless` 配置项已存在（管理设置可切 headed）——但内核仍是 Playwright bundled Chromium。
- VE 另有 **Cua Driver 真实桌面控制**（computer.ts，OS 级鼠标键盘，Windows/Linux）——现场机是有真实桌面的 Windows，OS 级真实输入事件可用。
- 测试耦合：`scripts/test-browser-canvas.mjs:23` 直连真实 playwright（其余 41 套件不耦合 playwright）。

### 1.2 被拦的三层原因（外部材料 + 推断）
| 层 | 内容 | 来源 |
|---|---|---|
| ① 环境指纹 | bundled Chromium + headless：UA 带 Headless、navigator.webdriver、canvas/WebGL/插件/字体特征 | rebrowser-bot-detector（rebrowser/rebrowser-patches README） |
| ② CDP 协议痕迹 | Playwright/Puppeteer 默认对每帧发 `Runtime.enable`，页面几行 JS 即可探测——**Cloudflare/DataDome 等所有主流反爬都在用** | rebrowser README + DataDome 博客 how-new-headless-chrome-the-cdp-signal |
| ③ 行为轨迹 | 滑块拖动轨迹分析（匀速/无抖动/瞬间完成）+ 鼠标事件特征 | DataDome 博客 + 推断（业界共识） |

**结论：换浏览器/协议只能解决 ①②；③（滑块本身）不存在稳定的纯自动化方案，是猫鼠游戏。**

## 2. 外部调研（一手材料）

### 2.1 工具生态（Node 优先，VE 是 Electron/Node）
| 工具 | 语言 | 原理 | 对本项目的适配判断 |
|---|---|---|---|
| **patchright**（npm `patchright@1.63.0`） | Node/Python | Playwright fork，补丁版：无 Runtime.enable 泄漏、stealth 默认化 | **首选**。drop-in：API 同 Playwright，版本 ≥ 我们现用 1.62.1，只改 import + 依赖 |
| **rebrowser-patches**（`npx rebrowser-patches patch --packageName playwright-core`） | Node CLI | 原位 patch 已安装的 playwright-core（addBinding/alwaysIsolated 两模式） | 备选：保留 playwright 1.62 最新 API、零新增体积；**坑：npm install 会覆盖补丁，必须 postinstall 钩子重打**；官方完整测试版本 1.52 |
| rebrowser-playwright（npm drop-in） | Node | 补丁打好发布成包 | 版本落后（1.52 vs 1.62），不如上两者 |
| DrissionPage（g1879/DrissionPage） | Python | 自研内核直连 CDP 控制**真实本机 Chrome**，「不基于 webdriver、无需驱动」 | 国内 WAF 场景打磨最久、接管真实浏览器最自然；但跨语言（shell 调脚本、截图/结果回流自己接），只作逃生舱 |
| puppeteer-extra-stealth / undetected-chromedriver | Node/Python | 注入式补丁 | 已老化，rebrowser 明言 JS 注入本身可被探测（Proxy/definePropertyChanged），不引入 |
| Camoufox | Python | 补丁 Firefox | 换内核成本高，不匹配现架构 |

### 2.2 关键事实（原文摘录）
- rebrowser README：「Out of the box Puppeteer and Playwright come with some significant leaks … you're just a big red flag for any major website」；「This technique is used by all major anti-bot software such as Cloudflare, DataDome」。
- rebrowser README 诚实声明：「this fix alone won't make your browser bulletproof … proxies, proper user-agent and fingerprints (canvas, WebGL)」。
- patchright npm 1.63.0 = patched playwright（description 与 playwright 一致，API 兼容）。
- DrissionPage README：「不基于 webdriver；无需为不同版本的浏览器下载不同的驱动」。

### 2.3 对本项目的适配判断（外部做法 → 接入点）
- patchright → `browser-service.ts:13` 换 import；`launch()`（:211）加 `channel: "chrome"` 用系统真 Chrome（检测不到则回落 bundled chromium）；`config-store.ts` browser 配置加 `channel` 字段。
- headed 运行 → 现场 Windows 有真实桌面，`browser.headless=false` 即「打开真实浏览器」，无需任何新能力。
- 人工过滑块 → 复用 persistent profile（登录态已在 :204 设计里持久化）+ IM/通知提醒在场人工拖一次。
- OS 级轨迹 → 复用 Cua driver（computer.ts）真实鼠标事件拖滑块，比 CDP 合成事件更真。

## 3. 方案对比与推荐

| | 方案 A：patchright + 真 Chrome + headed | 方案 B：rebrowser-patches 原位补丁 | 方案 C：DrissionPage 外挂脚本 |
|---|---|---|---|
| 改动面 | 1 依赖 + 1 import + launch 参数 + 配置字段 | postinstall 钩子 + launch 参数 + 配置字段 | shell 脚本 + Python 环境运维 + 结果回流 |
| 解决层 | ①+② | ②（① 需另配 channel/headed） | ①+②（其内核自带） |
| 风险 | 包体积 +（patchright 含 core，约与 playwright-core 相当；**注意 96M 安装包限额，需实测**） | 补丁随上游升级可能失效，需 CI 守护 | 双技术栈，现场机要装 Python |
| 与 browser_* 工具体系 | 完全兼容 | 完全兼容 | 脱节，逃生舱用 |

**推荐：A 为主路线，B 为体积超限时的替代；C 不进主设计。** 为什么不用更简单的替代（仅切 `channel:"chrome"` + headed 不换内核）：能治 ① 但治不了 ②（Runtime.enable 泄漏仍在），对 DataDome/云盾类等于没修。

## 4. 详细设计（方案 A，待拍板后排期）

- 依赖：`patchright`（alias 或直接依赖，弃用 playwright 直连）；`npm rm playwright && npm i patchright` 后**必须复跑 typecheck + test-browser-canvas**（esbuild external 改名的教训）。
- `browser-service.ts`：import 换 patchright；launch 加 `channel: cfg.browser.channel ?? "chrome"`（真 Chrome 缺失回落 chromium）；UA/语言跟随系统。
- `config-store.ts`：browser 配置加 `channel?: "chrome"|"chromium"`；现场机建议 `headless:false`（真实桌面带来的自然指纹收益远大于无人值守时的屏幕占用，可加「最小化窗口」选项）。
- prompt/工具文案（不依赖新版本也能先上）：browser 工具 description 加统一行为——**遇滑块/验证码：提醒现场人工过一次，过完会话自动保留，绝不反复重试触发风控**（Nova 这次的行为是对的，应固化为内置规则）。
- 分阶段：① 无代码版（现场把 browser.headless 关掉 + 装 Chrome + prompt 固化「人工过一次」话术）→ ② patchright 切换（一个 PR：依赖+import+channel 配置+门禁）→ ③ 观察效果再议 Cua 拖滑块自动化（不承诺）。
- 测试策略：test-browser-canvas 真启动改用 patchright 驱动；其余套件不受影响。
- 风险与回滚：channel 找不到 Chrome → 回落 chromium；patchright 行为异常 → git revert 依赖切换即可。

## 5. 盲区与待拍板
1. **安装包体积**：patchright 增量需实测（96M→Gitee 100M 限额紧）；超限则走方案 B。
2. **目标 WAF 是哪家**（云盾/瑞数/极验？）未确认——决定验证严格度与 ② 修完是否够。
3. **是否接受 headed 常驻**：真实桌面挂一个可见 Chrome 的运维接受度需现场拍板。
4. patchright 与 Playwright 1.63 的 API 细节差异（page.pause 不可用等）需在切换 PR 里过一遍我们用到的 API 面。
