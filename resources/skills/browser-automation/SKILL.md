---
name: browser-automation
description: 用内置浏览器（browser_navigate/click/type/read/evaluate 等）操作网页、登录、填表、抓数据时必读。覆盖受控组件填不进、点击不生效、元素定位不到、远程桌面是画布不是 DOM、中文输入丢字等高频坑。遇到「填了但提交为空 / 点了没反应 / 找不到元素 / 输入框没反应」先读这里。
---
# 浏览器自动化踩坑手册

核心原则：**优先相信工具的默认行为，不要自己在 browser_evaluate 里重造输入/点击。**
内置工具已经把下面大多数坑在实现层规避了；自己写 JS 操作 DOM 反而会把这些坑重新踩一遍。

## 1. 填了字但提交是空的（受控组件）

**现象**：`browser_type` 后截图看框里有字，但点登录/提交，服务端收到空值，或前端校验报"请输入"。

**根因**：React/Vue 的受控输入框，其值由框架 state 管理，state 只在**真实输入事件**（keydown/keypress/input）时更新。
直接给 DOM 赋值（`el.value = x`、Playwright 的 `fill()`）不触发这些事件，于是「框里有字、state 是空」。

**规则**：
- 默认就用 `browser_type`——它已改为逐键真实输入（`pressSequentially`），受控组件认。
- **不要**在 `browser_evaluate` 里写 `el.value=...; el.dispatchEvent(...)` 手工模拟——极易漏事件（React 还要求用原生 setter），这是重复踩坑的主要来源。
- 工具返回的 `valueLength` 必须等于你传入的字符数；`ok:false` 或长度不符 = 没填进去，改用 `browser_type_text`（先 click 聚焦再逐键），不要假装成功继续往下走。

## 2. 点了按钮没反应

按这个顺序排查，不要盲点：
1. 截图确认点的是不是真按钮（可能被透明遮罩/iframe 盖住）。
2. 选择器是否唯一命中——多个匹配时点到的可能不是目标。
3. 等待：点击后页面异步加载，先 `browser_read`/截图确认状态变化，再进行下一步。
4. 远程桌面/Canvas 类页面里的"按钮"不是 DOM（见第 4 节），selector 点击天然无效。

## 3. 元素定位不到

- SPA 内容是异步渲染的：导航后先 `browser_read` 或等一下再定位，不要在同一步立刻点。
- 优先用稳定属性：`id`、`name`、`data-testid`；避免用自动生成的 class（带 hash，会变）。
- 动态列表用结构性选择器（nth-of-type 等）而非绝对下标。
- iframe 内的元素要先确认上下文。

## 4. Canvas / 远程桌面不是 DOM

堡垒机 web 终端、H5 远程桌面、网页游戏等是**画在 canvas 上的像素**，没有可点的 DOM 元素。
- 用 `browser_click_at`（按截图坐标点）、`browser_type_text`（坐标点中 + 逐键）、`browser_paste_text`。
- 中文不要逐键发（没有中文扫描码会丢字），用 `browser_paste_text`。
- 操作后必须截图核对，因为没有 DOM 状态可读。

## 5. 登录类流程的人机配合

- 短信验证码、密码、图形验证码这类**凭据由用户自己在机器上输入**，不要让用户把验证码贴进聊天（会长期留存在对话记录里）。需要配合时，请用户在浏览器窗口里自己操作那一步。
- "获取验证码"按钮点完，明确告诉用户在等短信，不要反复点。
- 登录态保持依赖 cookie/storage；需要复用就走浏览器自带的持久化上下文，不要导出凭据。

## 6. 抓数据优先读 DOM，少用截图猜

- `browser_read` 能拿到文本就不要靠截图 OCR。
- 必须 evaluate 时只做**读取**（querySelector 取文本/属性），不要用它做输入和点击（回到第 1、2 节）。

## 反面清单

- ❌ evaluate 里 `el.value = x` 给受控组件赋值
- ❌ fill 完不核对 valueLength 就当成功
- ❌ 让用户把短信验证码发到聊天里
- ❌ 在 canvas 远程桌面里用 CSS selector 点击
- ❌ 导航后同一拍立刻定位元素（不等渲染）
- ❌ 中文用逐键 type 输入（会丢字，用 paste）
