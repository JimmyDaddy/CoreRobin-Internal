# 发布冒烟与性能门禁

CoreRobin 的发布验证分成自动门禁和真实设备验证。CI 不具备可代表真实桌面会话、系统权限弹窗、状态栏位置或传感器硬件的环境，因此不得把构建成功或静态入口检查称为“真实 GUI 启动通过”。

## 自动门禁

`pnpm release:gate:static` 在本地和 CI 中执行：

1. production Vite 构建必须包含 `index.html`、`splash.html`、`tray.html` 和 `companion.html`；
2. 四个入口只能引用构建后的资源，且必须与 Tauri 的 main、splashscreen、tray、companion 窗口映射一致；
3. 初始 JS/CSS 与全部 production chunks 不能超过 `scripts/web-bundle-budgets.json` 的字节预算；
4. 主题、语言 storage 同步代码必须覆盖三个辅助入口；
5. Rust 与 TypeScript 的健康状态 schema/event 必须一致，只有 main 能发布，tray/companion 只能读取；
6. 既有运行时测试继续验证 retained state、失败重连、较新 revision 选择与三个前端的展示行为；
7. fake-timer 性能契约验证隐藏态降频、暂停停止采样等稳定行为，不使用容易受 runner 抖动影响的 wall-clock 阈值。

Release 构建还会检查安装包，而不会启动 GUI：

- macOS：DMG 可挂载且只有一个 `.app`，bundle identifier/版本/可执行文件和架构正确，应用与 DMG 使用预期 Team ID 的 Developer ID Application 签名，应用启用 Hardened Runtime 与安全时间戳，DMG 具有有效 Apple 公证票据，并同时通过 Gatekeeper 的打开与执行评估；
- Linux：DEB 可解包、desktop entry 与 ELF x64 可执行文件正确，AppImage 可提取且包含 AppRun 与 ELF x64 主程序；
- Windows：MSI/NSIS 归档可读取，MSI 能静默管理解包，主程序 PE machine 为 x64。

这些步骤能拦截空包、错误架构、旧 bundle identifier、损坏归档和入口遗漏，但不能证明窗口、权限或系统集成在真实桌面上可用。

## 真实设备 smoke

候选 Release 发布前，默认在每个受支持平台至少使用一台真实设备安装候选产物。macOS 的 Apple Silicon 和 Intel 产物分别验证；Windows/Linux 在保持“早期预览”期间各验证一台 x64 设备。

```bash
pnpm release:smoke:device -- \
  --tag v0.1.0 \
  --artifact /path/to/CoreRobin_0.1.0_aarch64.dmg \
  --app /Applications/CoreRobin.app
```

脚本会启动已安装应用，并要求人工逐项确认主窗口、状态栏面板、Robin 双击恢复主窗口、健康状态同步、主题/语言同步、后台行为、今日回顾、应用卸载能力边界、可移除卷推出、权限两条路径以及退出/重启。更新闭环必须另行安装上一稳定版，通过当前正式更新通道完成“非阻塞提示 → 立即更新/明天提醒/按版本跳过 → 下载并验证 → 安装 → 应用内重启”，并确认跳过某一版本不会屏蔽之后的新版本，偏好与允许保留的本机历史也没有丢失；候选版本本身仍由安装包 SHA-256 绑定。macOS 会复核 Bundle 与关联数据计划的取消路径；Windows/Linux 必须使用专门的验收应用检查系统清单、本地化名称与图标、计划取消、提权取消、完成卸载和重新枚举。任何平台都不能用读取失败或空清单冒充“没有安装应用”。证据默认写入 `.local-dev/release-smoke/`，包含 commit、系统、架构、候选安装包 SHA-256 和每一步结果。任何 `failed` 或 `not-verified` 都不能标记为发布通过。跨平台卸载的实现边界与实机矩阵见[跨平台应用卸载设计](cross-platform-application-uninstall.md)。

CI 只运行 `pnpm release:smoke:device -- --dry-run` 验证清单可解析；这不是实际设备验证。

## 从 draft 提升为正式 Release

tag 触发的 `release.yml` 默认导入本机已签名、公证并预先上传到 draft 的 macOS 资产，同时在 GitHub Actions 构建 Windows/Linux；完整流程仍只创建或更新公开 draft，绝不会直接设置 `--draft=false`
或 `--latest`，也不会提前更新官网下载 manifest。候选产物必须完成以下四条真实设备记录：

| 证据 | 设备 | 候选产物 |
| --- | --- | --- |
| macOS Apple Silicon | 一台 arm64 Mac | `aarch64.dmg` |
| macOS Intel | 一台 x64 Mac | `x64.dmg` |
| Windows x64 | 一台 x64 Windows 设备 | EXE 或 MSI |
| Linux x64 | 一台 x64 Linux 设备 | AppImage 或 DEB |

draft 不会出现在公开 Releases 页面。每台验证机器使用具有该 draft 读取权限的 GitHub CLI
下载候选产物，例如：

```bash
gh release download v0.1.0 \
  --repo JimmyDaddy/corerobin-monitor \
  --pattern 'CoreRobin_0.1.0_aarch64.dmg'
```

安装后运行上面的命令。不能使用开发构建或另一个 commit 生成证据。脚本输出 JSON 后，在 Internal 仓库 Actions 中手动运行
`Promote verified release`，选择默认的 `device-evidence`，填写 tag，并把四份完整 JSON 分别粘贴到对应输入框。

提升工作流会重新检出 tag 并校验版本/可信 main 祖先关系，下载 draft 的实际资产，然后验证：

- JSON schema、tag、Internal commit、bundle identifier、平台和架构；
- 被测安装包 SHA-256 同时匹配 JSON、draft 的 `SHA256SUMS` 和实际下载文件；
- Sigstore bundle 必须证明 `SHA256SUMS` 来自该 tag 的 Internal release workflow，且校验表中的每个 staged asset 都必须匹配；
- 每个平台的公共检查全部为 `passed`；
- macOS 两条权限检查均为 `passed`，Windows/Linux 对应项必须为 `not-applicable`。

全部通过后工作流才将 draft 发布为 latest，并更新公开站点下载 manifest。工作流在“已发布
但 manifest 更新失败”的恢复重跑中仍会重新验证四份证据，而不会把已发布状态当成验证结果。

### 维护者风险确认

四个平台的真实设备暂时不可得时，发布维护者可以选择 `maintainer-attestation`，但这不是伪造或省略验收记录。工作流仍会验证可信 tag/commit、正式 draft、Sigstore 来源和 `SHA256SUMS` 中的全部资产，并要求：

- `maintainer_tested_platforms` 使用逗号列出实际完成验收的平台 ID，可用值为 `macos-arm64`、`macos-x64`、`windows-x64`、`linux-x64`；
- `maintainer_attestation` 必须严格写成 `I ACCEPT UNVERIFIED PLATFORM RISK FOR vMAJOR.MINOR.PATCH: 未验证平台ID列表`，列表按上述固定顺序排列；
- `maintainer_note` 至少 20 个字符，说明为何本次接受未验证平台风险；
- 四份 smoke JSON 必须保持为空，并再次通过受保护 `release` environment 人工审批。

例如只完成 Apple Silicon 验收时，确认文本为：

```text
I ACCEPT UNVERIFIED PLATFORM RISK FOR v0.1.9: macos-x64,windows-x64,linux-x64
```

工作流会把 tag、commit、触发者、run ID、已测/未测平台、确认文本和原因写入保留 90 天的内部 Actions artifact 与 Job Summary。该模式只改变真实设备证据要求，不会降低签名、公证、哈希、来源和正式资产校验。

## 性能基线

WebView 的自动性能预算只使用产物字节数和稳定的调度行为，不使用 CI 冷启动耗时或采样 wall time 作为硬门槛。需要调整预算时，应在 PR 中说明新增资源、当前测量值和新上限，不能只为让 CI 通过而放宽。

后端采样基线使用固定格式保存三次原始结果：

```bash
pnpm performance:baseline -- --runs 3 --iterations 20 --spacing 250
```

结果默认写入 `.local-dev/performance/`，记录 commit、机器、CPU、内存、命令参数和三轮原始 JSON。它用于与同一台机器的前一版本比较，不设跨机器绝对耗时阈值。

发布候选仍需在固定真实 Mac 上用 Instruments 验证隐藏态 CPU、唤醒和 Energy Impact，并记录：

- 机器型号、macOS 版本、电源模式和候选 artifact SHA-256；
- 前台稳定 5 分钟、隐藏后台 10 分钟、恢复前台 2 分钟；
- 是否停止隐藏态进程/网络明细刷新；
- tray/companion 是否持续获得低频健康摘要；
- 与同机上一版本相比是否出现可解释的明显回归。

冷启动只记录同机候选与上一版本的三次观测以及启动阶段截图/日志，不在共享 runner 上设置毫秒阈值。整机能耗或冷启动证据缺失时，发布检查表必须明确标记为“未验证”，不能由微基准替代。

仓库提供三场景的可复现采样工具。先启动候选版本并找到 CoreRobin 主进程 PID，再预先授权系统 `powermetrics`：

```bash
sudo -v
pnpm performance:energy -- --pid CORE_ROBIN_PID
```

脚本依次采集前台 5 分钟、隐藏窗口 10 分钟和状态栏面板 2 分钟，保存每秒 CPU、interrupt/package-idle wakeups、常驻内存与 Energy Impact 的统计摘要，并保留原始 NUL 分隔 plist。管理员密码只由 `sudo` 处理，脚本使用 `sudo -n`，CoreRobin 不接收或保存密码。短时验证脚本本身时可以用 `--durations 2,2,2`，但短时结果不能作为发布基线。
