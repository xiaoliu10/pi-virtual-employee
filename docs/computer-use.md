# Cua 桌面控制

应用通过独立的 Cua Driver 进程和 stdio MCP 连接桌面。模型继续使用本应用配置的供应商，支持图片的模型可直接查看窗口截图，文本模型使用控件树。Cua 的原生库留在驱动目录，不加载到 Electron 进程中。

## 安装与启用

1. 在 **设置 → 通用 → Computer Use · 桌面控制** 点击「安装 Cua Driver」。Windows x64/arm64、Linux x64/arm64 支持自动下载，安装进度显示在此处。
2. 开启桌面控制，填写允许操作的应用，每行一个，保存设置。可填写应用显示名称、可执行文件名或应用 ID；匹配时忽略大小写。空列表拒绝所有应用，`*` 表示全部应用。
3. 点击「检测连接」，应显示驱动版本和已连接状态。
4. 在已登记管理员的 IM 单聊中，让员工列出桌面应用和窗口，再发出具体任务。应用内普通聊天不具备 IM 的管理员身份，不能调用桌面操作工具。

也可以先开启控制、保留空允许列表，让管理员通过 `list_apps` 查看本机应用名称，再将要操作的应用加入列表。列表尚未配置时只能发现应用，不能查看应用窗口内容或操作应用。

自动安装固定使用 [Cua Driver 0.24.0](https://github.com/trycua/cua/releases/tag/cua-driver-rs-v0.24.0)，与接入时官方安装脚本的固定版本一致；上游将此组件版本标为预发布版。下载来自该版本的官方 GitHub Release，并验证代码中固定的 SHA-256，不执行远程安装脚本，也不跟随 nightly 或仓库全局 latest。

下载受 `computer.actionTimeoutSec` 限制；网络慢时可调大再重试。「停止并断开」也会取消下载。无法访问 GitHub 时，从上述发布页离线下载对应平台的压缩包，**完整解压并保留辅助程序和动态库**，然后在设置里选择 `cua-driver.exe` / `cua-driver` 的绝对路径。路径只能包含文件路径，不能附加命令参数。

macOS 请按 [Cua 官方安装说明](https://github.com/trycua/cua/blob/main/libs/cua-driver/README.md) 安装 CuaDriver.app，并在系统设置中授予该应用「辅助功能」与「屏幕录制」权限。应用会自动查找常见安装路径；也可指定应用包内的 `Contents/MacOS/cua-driver`。macOS 使用官方应用承载的桌面服务，以维持系统权限身份。

## 管理员对话配置

复用现有管理员白名单。**全部应用内的 Cua 设置均支持对话修改，无需打开设置页**，桌面能力关闭时也保留管理入口。开关通过 `manage_capabilities`，驱动管理通过 `manage_computer`，各项配置通过 `manage_settings` 提供；修改配置或安装驱动沿用现有规则，要求管理员在当前消息明确说「确认」。例如：

- 「确认，安装 Cua Driver。」安装在后台进行，可继续查询安装状态。
- 「确认，开启桌面控制，只允许 notepad.exe。」
- 「确认，把 Cua 驱动路径设为 C:\\Tools\\Cua\\cua-driver.exe。」
- 「确认，允许桌面前台操作。」
- 「确认，允许管理员定时任务操作桌面。」
- 「确认，把桌面连接等待改为 90 秒。」
- 「确认，把桌面动作超时改为 600 秒，任务总时限设为 0。」
- 「查看桌面连接状态。」
- 「停止并断开桌面控制。」
- 「确认，关闭 Computer Use。」

例如开启能力的工具参数为：

```json
{"action":"set","capability":"computer","enabled":true}
```

修改前台操作权限的 `manage_settings` 参数为：

```json
{"action":"set","path":"computer.allowForeground","value":true}
```

应用内开关不会代替操作系统授权。macOS 的辅助功能、屏幕录制权限仍需要用户在系统设置中授予 CuaDriver.app。

配置保存在 SQLite，导入导出配置时一并保留。修改桌面配置会断开当前桌面连接并停止当前任务，新任务使用新配置；无需重启应用。

| 配置项 | 默认值 | 含义 |
| --- | --- | --- |
| `computer.enabled` | `false` | 开放桌面操作工具 |
| `computer.driverPath` | `""` | 空值自动查找托管安装、常见目录及 PATH；非空时仅使用指定文件 |
| `computer.allowedApps` | `[]` | 允许操作的应用标识，空数组拒绝全部，`["*"]` 允许全部 |
| `computer.allowForeground` | `false` | 允许动作显式请求切换到前台 |
| `computer.allowScheduled` | `false` | 允许原创建者仍为管理员的定时任务使用桌面 |
| `computer.connectTimeoutSec` | `30` | MCP 握手和工具发现的单次等待，单位秒，最小 1 |
| `computer.actionTimeoutSec` | `120` | 每次 MCP 请求、会话排队及驱动下载的等待上限，单位秒，最小 1 |
| `computer.sessionTimeoutSec` | `0` | 一轮桌面任务总时限，含模型思考与动作间隔；0 表示不限时 |

正数超时最大为 2,147,483 秒，避免 Node 定时器溢出。单次调用中的应用权限检查和动作请求各自受动作超时约束，因此整个工具调用可能超过一个动作超时时间。模型请求的总超时与工具步数仍由 `general.requestTimeoutMin`、`general.maxToolSteps` 单独控制。

## 工具与执行流程

`manage_computer` 提供 `status`、`install`、`connect`、`disconnect`、`tools`。查询参数时可指定 `tool`，例如：

```json
{"action":"tools","tool":"click"}
```

`computer_use` 提供应用和窗口发现、启动应用、窗口状态、点击、双击、右击、输入、按键、组合键、滚动、拖拽以及设置控件值。`arguments` 使用当前平台 Cua 的原生参数，以驱动实际返回的 schema 为准。

```json
{"action":"list_apps"}
```

拿到应用和窗口的真实 ID 后，先观察，再操作，再观察验证。以下 ID 仅为示例，使用时必须替换为工具返回值：

```json
{"action":"get_window_state","arguments":{"pid":123,"window_id":456}}
```

点击优先使用观察结果中的 `element_token`，或 `element_index` 与匹配的 `snapshot_id`；图像坐标相对于窗口截图。每次输入都会使本地观察记录失效，下次输入前必须重新读取窗口。截图会传给支持图片的模型，也会保存到应用下载目录，供已有的 `send_image` 工具发送。

输入默认使用后台模式。Cua 返回 `background_unavailable` 时，只有开启 `allowForeground` 才能显式请求 `delivery_mode: "foreground"`。`set_value` 直接使用平台辅助功能接口，无需传 `delivery_mode`。工具不会自动替用户切换到前台重试。

只暴露窗口范围内的桌面工具，调用前验证管理员身份和应用允许列表。全局桌面输入、剪贴板、驱动配置、任意文件输出路径及 Cua 的其他工具不透传。启动应用只能选择 Cua 已发现且获准的应用，不接受额外命令参数。

## 会话、取消与平台边界

- 同一桌面的不同对话按顺序执行。一轮任务持有自己的 Cua 会话，直至该轮结束；同一对话内并发调用也会串行化。
- 动作之间保留连接，不受原有 `run_command` 同步超时影响。每次 MCP 等待显式传入可配置超时，没有沿用 SDK 默认的 60 秒。
- 停止、超时或配置变更会断开本应用的驱动连接，本轮不能自动重新操作。下一条消息可开始新任务；应先观察窗口，确认上一动作是否已经生效，避免重复提交。
- 应用退出或更新时清理连接；重启不续接旧桌面会话。活动桌面任务、连接及下载计入忙碌状态，自动更新会等待。
- Windows 需要已登录且可交互的桌面会话；后台模式支持范围取决于控件和应用。锁屏、最小化窗口、权限级别不同或 Windows 服务的 Session 0 可能无法截图或操作。Linux 需要可用的图形会话，具体能力以该平台的驱动工具列表为准。
- 定时任务默认不可操作桌面。开启后仍逐次检查原创建者的管理员身份，定时任务本身不能修改配置或安装驱动。

## 开发验证

```bash
npm run test:computer
npm run test:shell
npm run typecheck
npm run build
```

桌面测试使用隔离的 MCP 子进程，覆盖权限、参数兼容、截图传递、会话串行、取消、超时和配置迁移，不操作开发机上的真实应用。接入时另以官方 macOS 0.24.0 二进制验证了 MCP 握手和工具发现，并校验了官方 Windows x64 包的 SHA-256 与辅助文件结构。Windows 真实桌面操作仍需在目标机器上验证。
