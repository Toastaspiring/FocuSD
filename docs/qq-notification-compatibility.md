# QQ 消息上岛：接入与通知修复

QQ 消息上岛首版使用 Windows 系统通知作为来源。只有同一台电脑上已经启动、登录的 QQ 实际产生系统通知，才有可供岛屿读取的消息。

已实现折叠预览、通知角标、最近通知页和打开 QQ。接入使用当前桌面安装方式，无需修改 QQ 客户端。

## 在岛屿中使用

1. 展开岛屿，点击右上角的消息气泡按钮进入「QQ 消息」。
2. 开启「接收 QQ 消息」，按 Windows 提示完成通知访问授权。
3. 保持 QQ 在本机登录并开启系统通知。开启监听后的新消息会在折叠岛上预览 5 秒；连续消息最多预览 10 秒，随后恢复待办。

展开编辑、边缘收起或托盘隐藏时只积累通知，不主动展开或抢焦点。点击角标查看最近通知，点击预览或列表项打开 QQ 主窗口。角标统计岛内通知数量，不代表 QQ 的实际未读数。

功能默认关闭，仅启用偏好写入 `focusd-island-qq-notifications-enabled`。通知内容最多保留 20 条，仅在内存中保存，退出清空。启动时已有的系统通知不会重放；清空岛内列表也不会清除 Windows 或 QQ 内的消息。

## 修复通知开关立即关闭

本机问题来自缺失的 Windows `QQ` 通知发送者记录。开始菜单和设置界面仍有 QQ 条目，但 `ToastNotifier.Setting` 返回 `0x80070490`，通知数据库没有 `QQ` 的桌面发送者记录。

检查状态（只读）：

```powershell
powershell -NoProfile -File scripts/repair-qq-notification-registration.ps1
```

如果状态不可查询，显式执行修复：

```powershell
powershell -NoProfile -File scripts/repair-qq-notification-registration.ps1 -Repair
```

脚本确认开始菜单中的 QQ 标识和腾讯签名，备份 QQ 通知设置，再用一条静默、明确标注「不是聊天消息」的本机测试通知初始化 Windows 发送者记录。结束后仅移除这一条测试通知。已有正常注册时直接返回，不做修改。

备份位于 `%LOCALAPPDATA%\FocuSD\diagnostics\`。脚本不重置系统通知数据库、不清除聊天记录、不修改 QQ 程序或安全设置，也不会把用户或组策略关闭的通知强制开启。

测试通知只用于验证和恢复系统通道，不证明 QQ 会发送真实聊天通知；岛屿监听器和下面的诊断工具都会忽略该测试通知。

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

工具以独立进程运行；其结果不能替代 Tauri 主程序对权限、打包兼容性和岛屿行为的验收。

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

## 本机验证记录（2026-10-18）

- QQ 资源版本为 `9.9.28-46494`，启动器文件版本为 `9.9.20.37625`，开始菜单应用标识为 `QQ`。
- 用户反馈 Windows 中的 QQ 通知开关开启后立即恢复关闭。
- 原生 Rust 探测进程的访问状态为 `allowed`，读取通知列表成功。
- 修复前查询 `QQ` 通知状态返回 `0x80070490`（找不到元素）。只补充显示名称和图标元数据无效，该尝试已回滚。
- 使用本机诊断通知初始化发送者记录后，Windows 通知数据库出现 `QQ` 的 `app:desktop` 记录，状态变为 `enabled`；测试通知已清除。
- 用户确认新的真实消息进入 Windows 通知中心，原生探测读到 1 条可读 QQ 通知。新监听模块的真实消息集成测试也已通过。
- 已检查的通知禁用策略项未发现设置，Windows 通知服务处于运行状态。

验证命令：

```powershell
node --test tests/qq-notification-timing.test.mjs
cargo test --manifest-path src-tauri/Cargo.toml --lib qq_notifications::tests
# 需要本机 QQ 有一条仍在通知中心的真实通知，或在测试的 60 秒内接收一条：
cargo test --manifest-path src-tauri/Cargo.toml --lib qq_notifications::tests::reads_a_real_qq_system_notification -- --ignored --exact
pnpm build
pnpm tauri build --no-bundle
```

前端后台渲染检查覆盖已连接的 20 条长文本通知、默认关闭和权限错误状态，确认列表可滚动且没有横向溢出。原生窗口隐藏、边缘收起、打开 QQ 及授权弹窗的完整桌面交互仍需手动检查；没有将静态界面检查描述为完整桌面验收。

## 参考

- [Microsoft：通知监听器](https://learn.microsoft.com/en-us/windows/apps/develop/notifications/app-notifications/notification-listener)
- [Microsoft：通知状态枚举](https://learn.microsoft.com/en-us/uwp/api/windows.ui.notifications.notificationsetting)
- [Microsoft：ToastNotifier.Setting](https://learn.microsoft.com/en-us/uwp/api/windows.ui.notifications.toastnotifier.setting)
