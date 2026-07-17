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

- macOS：DMG 可挂载、只有一个 `.app`、bundle identifier/版本/可执行文件正确、ad-hoc 签名完整、架构匹配；
- Linux：DEB 可解包、desktop entry 与 ELF x64 可执行文件正确，AppImage 可提取且包含 AppRun 与 ELF x64 主程序；
- Windows：MSI/NSIS 归档可读取，MSI 能静默管理解包，主程序 PE machine 为 x64。

这些步骤能拦截空包、错误架构、旧 bundle identifier、损坏归档和入口遗漏，但不能证明窗口、权限或系统集成在真实桌面上可用。

## 真实设备 smoke

候选 Release 发布前，在每个受支持平台至少使用一台真实设备安装候选产物。macOS 的 Apple Silicon 和 Intel 产物必须分别验证；Windows/Linux 在保持“早期预览”期间至少各验证一台 x64 设备。

```bash
pnpm release:smoke:device -- \
  --tag v0.0.4 \
  --artifact /path/to/CoreRobin_0.0.4_aarch64.dmg \
  --app /Applications/CoreRobin.app
```

脚本会启动已安装应用，并要求人工逐项确认主窗口、状态栏面板、Robin、健康状态同步、主题/语言同步、后台行为、权限两条路径以及退出/重启。证据默认写入 `.local-dev/release-smoke/`，包含 commit、系统、架构、候选安装包 SHA-256 和每一步结果。任何 `failed` 或 `not-verified` 都不能标记为发布通过。

CI 只运行 `pnpm release:smoke:device -- --dry-run` 验证清单可解析；这不是实际设备验证。

## 从 draft 提升为正式 Release

tag 触发的 `release.yml` 只在公开仓库创建或更新 draft，绝不会直接设置 `--draft=false`
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
gh release download v0.0.4 \
  --repo JimmyDaddy/corerobin-monitor \
  --pattern 'CoreRobin_0.0.4_aarch64.dmg'
```

安装后运行上面的命令。不能使用开发构建或另一个 commit 生成证据。脚本输出 JSON 后，在 Internal 仓库 Actions 中手动运行
`Promote verified release`，填写 tag，并把四份完整 JSON 分别粘贴到对应输入框。

提升工作流会重新检出 tag 并校验版本/可信 main 祖先关系，下载 draft 的实际资产，然后验证：

- JSON schema、tag、Internal commit、bundle identifier、平台和架构；
- 被测安装包 SHA-256 同时匹配 JSON、draft 的 `SHA256SUMS` 和实际下载文件；
- Sigstore bundle 必须证明 `SHA256SUMS` 来自该 tag 的 Internal release workflow，且校验表中的每个 staged asset 都必须匹配；
- 每个平台的公共检查全部为 `passed`；
- macOS 两条权限检查均为 `passed`，Windows/Linux 对应项必须为 `not-applicable`。

全部通过后工作流才将 draft 发布为 latest，并更新公开站点下载 manifest。工作流在“已发布
但 manifest 更新失败”的恢复重跑中仍会重新验证四份证据，而不会把已发布状态当成验证结果。

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
