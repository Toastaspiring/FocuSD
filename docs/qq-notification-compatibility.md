# QQ 通知接入的前置验证

QQ 消息上岛首版使用 Windows 系统通知作为来源。只有同一台电脑上已经启动、登录的 QQ 实际产生系统通知，才有可供岛屿读取的消息。

目前仅提供原生诊断工具，尚未接入岛屿界面。按首版约定，真实通知链路验证通过后才继续开发预览、角标和最近通知页；验证未通过时保留现有安装方式。

## 运行诊断

在仓库根目录执行，只检查当前状态：

```powershell
cargo run --manifest-path src-tauri/Cargo.toml --example qq_notification_probe -- --watch-seconds 0
```

监听 30 秒，在此期间接收一条新 QQ 消息，并检查它是否出现在 Windows 通知中心：

```powershell
cargo run --manifest-path src-tauri/Cargo.toml --example qq_notification_probe -- --watch-seconds 30
```

工具使用与应用相同版本的 Rust `windows` 依赖。它仅读取 Windows 通知 API，不申请权限、不修改系统设置，也不发送或清除通知。输出只包含状态和计数，聊天文本只用于在内存中判断是否可读，不输出或保存。

工具以独立进程运行；其结果不能替代未来 Tauri 主程序对权限、打包兼容性和岛屿行为的验收。

## 如何判断结果

- `access`：当前诊断进程访问系统通知的状态。`allowed` 才能继续读取；`denied` 或 `unspecified` 表示访问条件未满足。
- `qqNotificationSetting`：Windows API 对应用标识 `QQ` 返回的通知状态或错误。`enabled` 仅表示这项检查没有发现禁止显示通知的状态，不能证明 QQ 正在产生系统通知。
- `baselineQQNotifications`：开始监听时已有的 QQ 通知数量，工具不会把它们算作新消息。
- `newReadableQQNotifications`：监听期间新出现且有可读文本的 QQ 通知数量。
- `metadataErrors`、`textErrors`：通知元数据或文本解析失败的次数。它们表示诊断结果可能不完整，不能据此断言“没有消息”。

探测可执行文件的退出码（`cargo run` 遇到非零子程序退出码时会报告命令失败）：

| 退出码 | 含义 |
| --- | --- |
| `0` | 本次监听捕获到了有可读文本的新 QQ 系统通知 |
| `1` | 参数或 Windows API 调用失败，查看输出的错误信息 |
| `2` | 尚未验证通过，或通知访问条件未满足 |

`--watch-seconds 0` 只检查当前状态，不验证新消息，因此返回 `2`。一次没有捕获到消息不等于该 QQ 版本永久不兼容。应用标识来自本机安装的 QQ（开始菜单 AppID 为 `QQ`）；其他安装方式需要重新核实标识。

## 通知开关立即恢复关闭时

先检查 Windows 全局通知、QQ 内部提醒、通知服务和通知相关策略。仅凭设置界面的 QQ 条目或一个注册表值，不能确认 QQ 具有可用的系统通知来源。

如果无法让真实消息进入通知中心，当前系统通知方案保持未验证状态，停止岛屿展示接入。读取 QQ 自带浮窗、客户端注入和第三方消息桥接不在首版范围内。

## 本机验证记录（2026-10-18）

- QQ `9.9.20.37625` 已在运行，开始菜单应用标识为 `QQ`。
- 用户反馈 Windows 中的 QQ 通知开关开启后立即恢复关闭。
- 原生 Rust 探测进程的访问状态为 `allowed`，读取通知列表成功。
- 查询 `QQ` 通知状态时返回 `0x80070490`（找不到元素），初始列表和随后 30 秒观察中均没有 QQ 通知，元数据解析错误数为 `0`。该观察没有确认期间是否实际收到一条新聊天消息。
- 已检查的通知禁用策略项未发现设置，Windows 通知服务处于运行状态。

结论：当前 QQ 安装的系统通知来源尚未验证通过，首版停在前置探测阶段。上述结果没有确定通知开关异常的根因，也不能推断所有 QQ 版本都不支持系统通知。

## 参考

- [Microsoft：通知监听器](https://learn.microsoft.com/en-us/windows/apps/develop/notifications/app-notifications/notification-listener)
- [Microsoft：通知状态枚举](https://learn.microsoft.com/en-us/uwp/api/windows.ui.notifications.notificationsetting)
- [Microsoft：ToastNotifier.Setting](https://learn.microsoft.com/en-us/uwp/api/windows.ui.notifications.toastnotifier.setting)
