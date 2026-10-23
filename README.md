<div align="center">
  <img src="src-tauri/icons/128x128.png" alt="FocuSD Island logo" width="96" height="96">

  <h1>FocuSD Island</h1>

  <p>一款 Windows 桌面效率工具，在屏幕顶部集中管理待办、剪贴板、音乐、AI 状态、快捷翻译和消息提醒。</p>

  <p>
    <a href="https://github.com/flyl1u/fly-island/releases/latest">下载 Release</a>
    ·
    <a href="https://github.com/flyl1u/fly-island/issues">反馈 Issue</a>
  </p>

  <p>
    <img alt="Version" src="https://img.shields.io/badge/version-0.2.6-blue">
    <img alt="Platform" src="https://img.shields.io/badge/platform-Windows-0078D4">
    <img alt="Tauri" src="https://img.shields.io/badge/Tauri-2-24C8DB">
    <img alt="React" src="https://img.shields.io/badge/React-19-61DAFB">
  </p>
</div>

## 这是什么

一款 Windows 优先的灵动岛。集成微信、QQ、邮箱通知，剪贴板历史、快捷翻译、Codex状态灯、媒体控制、每日待办等功能

FocuSD 以轻量、无边框、始终置顶的悬浮岛形式运行，它会在需要时展开，用完后回到紧凑状态，减少为了获取一条信息而切换窗口的次数。

## 为什么做它

日常工作或学习过程中，我经常需要在某软件写下 Todo List，为了隔绝噪音，我会打开音乐软件并把音量调到合适的临界点，工作和学习又经常需要借助翻译网站，同时还会反复复制和粘贴代码，与此同时难以避免的是接收不同群聊、好友发送的消息

在这些界面之间来回切换，不仅会降低效率，也容易让人分心，因此我开始思考：能不能把这些高频功能集成到一个足够轻量的地方？

我想到了iPhone的灵动岛，它把消息通知、计时器、媒体控制等信息集中到一个小岛上，缩短了我们获取信息的路程。于是，FocuSD 诞生了。这个名字寓意 **Focu Study and DeepWork**，专注学习和深度工作，项目使用更轻量的 Tauri 架构开发

## 功能

FocuSD 想解决的核心问题，是工作和学习过程中频繁的窗口切换。

FocuSD 把分散在不同窗口中的高频操作放到一个可折叠、可展开的悬浮岛里：

- **图文剪贴板历史**：记录复制过的文本和图片，搜索内容或备注、收藏常用项、添加备注、删除记录，并一键复制回剪贴板。历史数量、图片记录和全局唤出快捷键均可设置。
- **QQ、微信与 QQ 邮箱**：在同一行品牌导航中切换 QQ、微信和邮箱，工具按钮共用顶部一行；QQ 通知和邮箱各保留最近 20 项，邮件支持在岛内打开正文并返回列表。
- **快捷翻译**：用全局快捷键打开独立翻译窗口，自动判断中英方向或手动指定；可从剪贴板填入原文并复制译文。
- **AI 状态灯**：通过 Codex 和 Claude Code 生命周期钩子显示任务运行、完成或需要关注的状态，可在设置中安装或修复钩子。
- **待办、每日笔记与归档**：管理当天任务、标记完成、设置当前任务；记录每日笔记并浏览历史归档。可选择自动结转未完成任务，将任务和笔记保存为 Markdown。
- **音乐与系统音频**：通过 Windows 媒体会话切换上一首、播放/暂停和下一首，并用动态波形显示音频活动。
- **外观与启动设置**：切换经典或液态玻璃外观、系统或像素字体，调整大小、透明度、颜色和顶部距离；保存最多 6 个自定义样式预设、控制标题显示和开机自启动。

待办、剪贴板和应用设置保存在本机。微信提醒只表示微信请求了任务栏关注，不读取聊天正文、发送人或准确未读数。QQ 通知只保留在本次运行的内存中；QQ 邮箱后台仅同步邮件头，正文按需读取且只保留在内存，不下载附件、不加载远程图片，也不会改变邮件已读状态。

## 使用说明

展开岛屿即可切换待办、音乐、剪贴板、设置和消息页面。默认使用液态玻璃外观，岛屿名称隐藏，任务文字为白色；设置中的样式预设可保存和恢复个性化布局。

### 功能设置

- **QQ 和微信提醒**：首次默认开启。QQ 需要 Windows 通知访问权限，且 QQ 已登录并启用系统通知；微信需要电脑版保持登录并发出任务栏提醒。两个来源可分别在「设置 → 消息接收」或消息页面关闭。参见 [QQ 通知说明](docs/qq-notification-compatibility.md)和[微信提醒说明](docs/wechat-reminder-compatibility.md)。

- **QQ 邮箱**：在邮箱设置中开启 IMAP 并生成授权码，然后在消息页面填写 `@qq.com` 地址和授权码（不是 QQ 登录密码）。凭据保存在 Windows 凭据管理器。支持手动刷新、暂停接收和断开连接；首次同步不提醒历史邮件。详见 [QQ 邮箱接入说明](docs/qq-mail.md)。

- **快捷翻译**：默认按 `Alt+C` 打开翻译窗口。首次使用时配置 DeepSeek API 密钥，密钥保存在 Windows 凭据管理器。提交翻译时，原文会发送到 DeepSeek API；可选择自动识别、中译英或英译中。按 `Tab` 可填入最新剪贴板文本。

- **AI 状态灯**：在「设置 → AI Agent 状态灯」选择「安装/修复」，然后重启 Codex 或运行 Claude Code 的终端。Codex 首次使用钩子时按提示信任配置。详见 [AI Agent 状态灯说明](docs/agent-status-hooks.md)。

- **剪贴板历史**：可在设置中关闭记录、调整图片捕获和历史数量，并录制唤出快捷键。历史记录保存在本机应用数据目录。

### 技术栈

- Tauri 2：Windows 桌面应用外壳和原生能力
- React 19 + TypeScript：前端界面和交互
- Rust：窗口、快捷键、剪贴板、媒体和文件等桌面能力
- pnpm：依赖安装与项目脚本

## 开发与构建

### 从源码构建

需要 Windows 10/11、Node.js、pnpm、Rust、Visual Studio C++ Build Tools 和 WebView2 Runtime。

```powershell
git clone https://github.com/flyl1u/fly-island.git
cd fly-island
pnpm install
pnpm tauri dev
```

### 构建 Release

```powershell
pnpm tauri build
```

构建完成后，安装包位于：

- `src-tauri/target/release/bundle/nsis/fly-island_版本号_x64-setup.exe`
- `src-tauri/target/release/bundle/msi/fly-island_版本号_x64_en-US.msi`

也可以直接从 [GitHub Releases](https://github.com/flyl1u/fly-island/releases/latest) 下载 Windows x64 安装包。

## Star History

<a href="https://www.star-history.com/?repos=flyl1u%2Ffly-island&type=date&legend=top-left">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/chart?repos=flyl1u/fly-island&type=date&theme=dark&legend=top-left" />
    <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/chart?repos=flyl1u/fly-island&type=date&theme=light&legend=top-left" />
    <img alt="Star History Chart" src="https://api.star-history.com/chart?repos=flyl1u/fly-island&type=date&theme=light&legend=top-left" />
  </picture>
</a>

---

# English

## What is this?

FocuSD Island is a Windows desktop productivity app. Its floating island brings together tasks and daily notes, clipboard history, music controls, AI coding assistant status, quick translation, and message notifications.

It runs as a lightweight, borderless, always-on-top floating island. Expand it when you need information, then return to the compact state and keep working.

## Why I built this

During everyday work and study, I often write Todo Lists in Obsidian, open music to block out noise, use translation websites, and copy or paste code, passwords, and document snippets.

Switching between all those windows reduces efficiency and makes it easier to lose focus. I wanted to bring these frequent actions into one lightweight place.

Apple's Dynamic Island was an inspiration: it gathers delivery updates, timers, media controls, and other information into one small surface. FocuSD follows the same idea for focused study and deep work. The name stands for **Focu Study and DeepWork**, and the app is built with the lightweight Tauri framework.

## Features

FocuSD brings frequent actions from separate windows into one compact island:

- **Tasks, daily notes, and archives**: manage today's tasks, mark them complete, set the active task, write a daily note, and browse saved days as cards or a timeline. Optionally carry unfinished tasks forward and save a day as Markdown.
- **Text and image clipboard history**: search copied content and notes, favorite common items, add notes, remove entries, and copy an item back to the clipboard. Configure image capture, history size, and the global shortcut.
- **Music and system audio**: control the Windows media session with previous, play/pause, and next actions; a live waveform reflects audio activity.
- **AI status light**: lifecycle hooks show whether Codex or Claude Code is running, complete, or needs attention. Install or repair the hooks from Settings.
- **DeepSeek quick translation**: open a separate translation window with a global shortcut, auto-detect Chinese/English or choose a direction, paste the latest clipboard text, and copy the result.
- **QQ, WeChat, and QQ Mail**: switch between QQ, WeChat, and Mail from one row of brand tabs, with source actions alongside them. Review the latest 20 QQ notifications or emails, and open email bodies inside the island before returning to the list.
- **Island appearance and startup**: choose classic or liquid-glass styling and system or pixel fonts; adjust size, opacity, colors, and top spacing; save up to six custom style presets, hide the island title, or enable launch at startup.

Tasks, clipboard history, and app preferences stay on the device. WeChat reminders do not read chat text, sender names, or exact unread counts. QQ notifications stay in memory for the current run; QQ Mail syncs only headers in the background and reads bodies on demand into memory. It does not download attachments, load remote images, or change read status.

## Getting started

Expand the island to switch between tasks, music, clipboard, settings, and messages. The first-run appearance uses liquid glass, hides the island title, and displays task text in white.

### Feature setup

- **QQ and WeChat reminders** are enabled by default. QQ needs Windows notification access, and QQ must be signed in with system notifications enabled. WeChat must be running and issue a taskbar-attention request. Pause either source in **Settings → Message reception** or from the message panel. See the [QQ notification guide (Chinese)](docs/qq-notification-compatibility.md) and [WeChat reminder guide (Chinese)](docs/wechat-reminder-compatibility.md).

- **QQ Mail** connects from the message panel. Enable IMAP in QQ Mail settings, generate an authorization code, then enter your `@qq.com` address and that code (not your QQ login password). The code is stored in Windows Credential Manager. You can refresh, pause receiving, or disconnect to delete the code. Initial sync does not replay old mail. See the [QQ Mail setup guide (Chinese)](docs/qq-mail.md).

- **Quick translation** opens with **Alt+C** by default. Add a DeepSeek API key in the translator settings; it is stored in Windows Credential Manager. Text is sent to the DeepSeek API when you request a translation. Choose automatic detection or a direction, and press **Tab** in the input to paste the latest clipboard text.

- **AI status light**: open **Settings → AI Agent 状态灯** and choose **安装/修复**. Restart Codex and any terminal running Claude Code; trust the new Codex hooks when prompted. See the [AI Agent status guide (Chinese)](docs/agent-status-hooks.md).

- **Clipboard history** captures text and, when enabled, images. Search, favorite, annotate, and copy entries from the clipboard panel. Configure capture settings, history limit, and global shortcut in Settings.

### Tech stack

- Tauri 2 for the Windows desktop shell and native capabilities
- React 19 + TypeScript for the interface and interactions
- Rust for windows, shortcuts, clipboard, media, and file capabilities
- pnpm for dependency management and project scripts

## Development and build

### Build from source

You need Windows 10/11, Node.js, pnpm, Rust, Visual Studio C++ Build Tools, and WebView2 Runtime.

```powershell
git clone https://github.com/flyl1u/fly-island.git
cd fly-island
pnpm install
pnpm tauri dev
```

### Build a release

```powershell
pnpm tauri build
```

The generated installers are placed in:

- `src-tauri/target/release/bundle/nsis/fly-island_VERSION_x64-setup.exe`
- `src-tauri/target/release/bundle/msi/fly-island_VERSION_x64_en-US.msi`

You can also download the latest Windows x64 installers from [GitHub Releases](https://github.com/flyl1u/fly-island/releases/latest).

## Star History

<a href="https://www.star-history.com/?repos=flyl1u%2Ffly-island&type=date&legend=top-left">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/chart?repos=flyl1u/fly-island&type=date&theme=dark&legend=top-left" />
    <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/chart?repos=flyl1u/fly-island&type=date&theme=light&legend=top-left" />
    <img alt="Star History Chart" src="https://api.star-history.com/chart?repos=flyl1u/fly-island&type=date&theme=light&legend=top-left" />
  </picture>
</a>
