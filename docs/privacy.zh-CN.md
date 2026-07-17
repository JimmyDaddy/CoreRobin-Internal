# CoreRobin 隐私说明

最后核对：CoreRobin 0.0.4（2026-07-17）

CoreRobin 是本机桌面应用。它读取这台电脑的资源状态、运行中的应用和你主动开始的空间扫描结果，用来在本机展示状态、诊断与清理复核。本文说明应用本身的数据边界；访问官网、GitHub Release 或提交 Issue 时，还会受到相应服务的隐私规则约束。

## 不会做什么

- CoreRobin 0.0.4 不包含产品遥测、崩溃上报 SDK 或账户同步服务。
- 监控、文件扫描、进程、连接、历史和偏好不会被 CoreRobin 上传到我们的服务器。
- 空间扫描不会读取文件内容，不会在扫描期间移动、修改或上传文件。
- CoreRobin 不会自动结束进程、卸载应用或删除文件。

## 会在本机处理和保存什么

- **实时状态**：CPU、内存、磁盘、网络、应用、进程、启动项和连接的本机快照，用于当前界面和诊断。
- **本机历史与操作记录**：当你开启历史时，资源趋势、持续问题和你确认的操作结果会保存在设备上。历史可保留 1、7 或 30 天，也可以关闭或随时清空。应用和启动项名称只有在你允许保存名称后才会跨重启保留；不保存命令行、文件路径、文件名或连接地址。
- **空间扫描结果**：扫描只读取名称、大小、时间、位置和文件类型等元数据。结果最多保留 7 天；超过 24 小时会被标记为较旧。永久删除前，CoreRobin 只会重新核对你放进清理篮的目标。
- **偏好**：语言、动态效果、通知、历史保留、后台启动和 Robin 伙伴偏好保存在本机，用于下次启动时恢复你的选择。

## 完全磁盘访问权限

macOS 会保护邮件、信息和其他应用数据等位置。开启“完全磁盘访问权限”后，CoreRobin 可以尽可能完整地读取系统磁盘的**元数据**，从而让空间地图少遗漏受保护的位置。

- 权限由 macOS 管理，可随时在“系统设置 → 隐私与安全性 → 完全磁盘访问权限”中关闭。
- 不授权时仍可选择“扫描可访问区域”；页面会把受保护或暂时无法读取的位置标出来。
- 该权限不会让扫描读取文件内容，也不会让应用在未确认时删除文件。

## 删除、清空与卸载

- “设置 → 关于与支持 → 清除全部本机数据”会清除 CoreRobin 的偏好、历史、提醒记录和保存的空间扫描结果。也可以只在“记录”页清空历史，或只在清理页清除扫描结果。
- 永久删除只处理你明确放进清理篮并再次确认的目标，文件不会进入废纸篓。
- 要停止后台监控，请从状态栏菜单选择“退出应用”，而不只是关闭主窗口；退出后可在活动监视器、任务管理器或系统监视器中确认没有 CoreRobin 进程。
- 完整卸载前，请先在设置中关闭“登录后启动”。macOS 用户还可以在“系统设置 → 隐私与安全性 → 完全磁盘访问权限”中关闭 CoreRobin；清除应用数据不会替你撤销系统权限。

### 完整卸载与本机数据位置

CoreRobin 的正式应用标识是 `com.corerobin.monitor`。正常情况下先使用应用内清除功能，再按操作系统方式移除应用即可。如果需要手动核对残留，请在**完全退出 CoreRobin 后**检查下列位置；不同系统或 WebView 版本可能只创建其中一部分。

| 平台 | CoreRobin 数据与 WebView 存储 | 登录启动残留 |
| --- | --- | --- |
| macOS | `~/Library/Application Support/com.corerobin.monitor/`（其中 `cleanup-scan-v3.json` 是原生扫描缓存）；WebView 或系统偏好残留可能包括 `~/Library/WebKit/com.corerobin.monitor/`、`~/Library/Caches/com.corerobin.monitor/` 和 `~/Library/Preferences/com.corerobin.monitor.plist` | `~/Library/LaunchAgents/core-robin.plist` |
| Windows | `%APPDATA%\com.corerobin.monitor\`（其中可能包含原生扫描缓存）；WebView2 与本机缓存可能包括 `%LOCALAPPDATA%\com.corerobin.monitor\` | 注册表 `HKEY_CURRENT_USER\Software\Microsoft\Windows\CurrentVersion\Run` 与 `…\Explorer\StartupApproved\Run` 中名为 `core-robin` 的值 |
| Linux | `${XDG_DATA_HOME:-~/.local/share}/com.corerobin.monitor/`（其中可能包含原生扫描缓存与 WebView 数据）；如设置了 `XDG_CACHE_HOME`，还可能存在对应缓存目录 | `${XDG_CONFIG_HOME:-~/.config}/autostart/core-robin.desktop` |

不要删除名称相近但不在上述标识下的其他应用目录。手动删除前如有疑问，可以先在公开 Issue 中只提供系统版本、CoreRobin 版本和**经过隐藏处理**的目录列表，不要上传目录内容。

## 官网、Issue 与安全报告

官网是静态 GitHub Pages 站点，不嵌入产品分析脚本。GitHub Release 用于分发安装包、校验表、SBOM 和 Sigstore 签名包。

公开 Issue 对任何人可见。请从“设置 → 关于与支持”复制版本和诊断摘要，提交前先预览，并移除用户名、文件路径、IP 地址、访问令牌、屏幕截图中的个人信息及其他不必要的数据。安全漏洞请使用 GitHub 的私密漏洞报告，而不是公开 Issue。

## 联系方式

- 一般问题与功能建议：[GitHub Issue 选择器](https://github.com/JimmyDaddy/corerobin-monitor/issues/new/choose)
- 安全漏洞：[私密漏洞报告](https://github.com/JimmyDaddy/corerobin-monitor/security/advisories/new)

如果产品的数据边界发生变化，我们会随对应版本更新本说明和公开 Release Notes。
