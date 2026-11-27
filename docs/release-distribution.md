# 公开分发与私有源码边界

CoreRobin 使用两个同级、互相独立的 GitHub 仓库：

- `JimmyDaddy/CoreRobin-Internal`：私有源码、测试和跨平台构建。
- `JimmyDaddy/corerobin-monitor`：公开官网、用户文档、Issue 与 Release 下载。

公开仓库不是当前仓库的 Git submodule。网站和文档可以独立更新，外部用户也不需要获得私有仓库权限；发布流程则通过受限凭据把构建结果从私有仓库推送到公开仓库。

## 日常 CI 与完整矩阵

Internal 的普通 pull request 和 `main` push 默认只运行 Ubuntu 上的前端质量门禁与 Rust 全量检查，避免每次源码变更都消耗私有仓库的 Windows 和 macOS hosted-runner 额度。Windows/macOS 桌面检查在以下任一条件下运行：

- 手动运行 `CI` workflow；
- pull request 带有 `ci:full` 标签；
- 触发 `Release` workflow。

涉及平台适配、安装包、签名、公证、文件系统安全或进程控制的变更，合并前应通过手动完整矩阵或 `ci:full` 标签完成 Windows/macOS 复核。

## 精简后的单条 Release 数据流

发版全程收敛在单一工作流 `.github/workflows/release.yml` 中，只需要 **1 次触发 + 1 次审批**，约 15~25 分钟完成上线：

1. **版本与用户更新日志准备**：
   ```bash
   pnpm release:prepare MAJOR.MINOR.PATCH
   # 补充 release-notes/vMAJOR.MINOR.PATCH.json 的中英文标题与产品条目
   # 将同一组中文产品条目镜像到 CHANGELOG.md 的 MAJOR.MINOR.PATCH 小节
   pnpm release:preflight
   ```
   合并到 `main` 后，直接在 GitHub Actions 手动运行 `Release`（默认自动读取 `main` 上 `package.json` 的版本），或推送 `vMAJOR.MINOR.PATCH` tag 触发。
2. **源码与质量校验（`verify`）**：验证 `main` 受信源码、四个版本源、`release-notes/vMAJOR.MINOR.PATCH.json`、`CHANGELOG.md`、前端构建/合约与 Rust `fmt`/`test`/`clippy`。
3. **四平台并行构建与同步公证（`build` + `build_macos_github`）**：
   - Linux x64（`.deb` + `.AppImage` + `.sig`）与 Windows x64（`.exe` + `.sig` + `.msi`）完成构建、Tauri updater 签名与包结构检查。
   - macOS Apple Silicon 与 Intel 分别完成 Developer ID + Hardened Runtime 签名，直接通过 `xcrun notarytool submit --wait --timeout 25m` 同步完成 Apple 公证，随后 `xcrun stapler staple` 装订并通过 Gatekeeper / 架构校验。
   - 若某平台构建或公证失败，流程会直接停止，不会创建废 tag，也不会污染公开仓库。
4. **打包与来源签名（`package` + `sign`）**：汇总四平台资产，生成 `latest.json`、`SHA256SUMS` 和 SPDX SBOM；独立的 `sign` job 使用 GitHub Actions OIDC 与 Sigstore/Cosign 签署 `SHA256SUMS.sigstore.json`。
5. **一次审批正式上线（`publish`，受保护 `release` environment）**：
   - 审批通过后复验 `SHA256SUMS` 与 Sigstore 签名；
   - 通过 `scripts/ensure-stable-release-tag.sh` 在精确 commit 上幂等创建不可变 `vMAJOR.MINOR.PATCH` tag；
   - 使用 `PUBLIC_RELEASE_TOKEN` 在公开仓库 `JimmyDaddy/corerobin-monitor` 创建 Release 并核对完整资产清单；
   - 当 `publish_mode=latest`（默认）时，自动公开设为 `Latest` 并更新公开仓库 `site/release-manifest.json` 触发官网部署；若需要发布前先下载安装包实测，触发时选择 `publish_mode=draft` 即可停在 Draft 状态。

发布者的 Mac 仍可作为显式备用 builder：先在对应 commit 运行 `pnpm release:macos:local -- vMAJOR.MINOR.PATCH` 上传本地已公证 macOS 资产至公开仓库 draft，再手动触发 `Release` 并选择 `macos_builder=local`。

Internal 不再保留或构建官网副本。`corerobin-monitor/site` 是唯一官网源；Internal 只保留应用源码、截图源、用户文档源、发布脚本和公开内容同步 manifest。

Tauri 更新签名用于防止应用内更新包被替换，Developer ID 与 Apple 公证负责 macOS 平台信任，Sigstore 则为跨平台校验表提供来源证明；三者是互补边界。Windows Authenticode 仍未配置，因此 Windows 首次安装仍不会显示已验证发布者。

## 一次性 GitHub 配置

- **公开仓库凭据**：
  - `PUBLIC_RELEASE_TOKEN`（保存在受保护 `release` environment secret）：对 `JimmyDaddy/corerobin-monitor` 具备 `Contents: Read and write`，仅在 `publish` job 审批后用于发布 Release 与更新 `site/release-manifest.json`。
  - `PUBLIC_RELEASE_READ_TOKEN`（可选，保存在 repository secret）：仅在显式使用 `macos_builder=local` 时供 `import_macos_local` 读取尚未公开的 draft。
- **Tauri 更新签名**：`TAURI_SIGNING_PRIVATE_KEY` 与 `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`（仅暴露给隔离的构建 job）。
- **Apple 签名与公证**：`APPLE_CERTIFICATE`、`APPLE_CERTIFICATE_PASSWORD`、`APPLE_API_PRIVATE_KEY_BASE64`、`APPLE_API_KEY`、`APPLE_API_ISSUER`、`APPLE_TEAM_ID`（仅暴露给 macOS 构建 job，使用 App Store Connect Team API Key）。

不要把 `.p12`、`.p8`、密码、Base64 内容或令牌写进源码、workflow 文件、公开仓库、Issue 或聊天记录。

## 回滚与故障处理

- 公网 Release 已发布后不覆盖同名正式版本；需要修复时发布新的补丁版本。
- `publish` job 只允许覆盖尚未公开的 draft release 资产，避免重跑静默替换用户已下载的文件。
- 若 Apple 公证偶发超时，直接重跑失败的 macOS job 即可，不会留下半成品公开页面或失效 tag。
- 官网由公开仓库的 Pages workflow 部署；私有仓库不再部署 GitHub Pages。
