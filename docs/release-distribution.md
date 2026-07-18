# 公开分发与私有源码边界

CoreRobin 使用两个同级、互相独立的 GitHub 仓库：

- `JimmyDaddy/CoreRobin-Internal`：私有源码、测试和跨平台构建。
- `JimmyDaddy/corerobin-monitor`：公开官网、用户文档、Issue 与 Release 下载。

公开仓库不是当前仓库的 Git submodule。网站和文档可以独立更新，外部用户也不需要获得私有仓库权限；发布流程则通过受限凭据把构建结果从私有仓库推送到公开仓库。

## 日常 CI 与完整矩阵

Internal 的普通 pull request 和 `main` push 默认只运行 Ubuntu 上的前端质量门禁与 Rust 全量检查，避免每次源码变更都消耗私有仓库的 Windows 和 macOS hosted-runner 额度。Windows/macOS 桌面检查在以下任一条件下运行：

- 手动运行 `CI` workflow；
- pull request 带有 `ci:full` 标签；
- release tag 进入独立的 `Release` workflow。

涉及平台适配、安装包、签名、公证、文件系统安全或进程控制的变更，合并前必须通过手动完整矩阵或 `ci:full` 标签完成 Windows/macOS 复核。标签仅控制额外平台 job，不替代 Ubuntu 必跑门禁。CI 和 Release 使用按 Rust toolchain、Cargo manifests/lockfile 与运行平台隔离的依赖编译缓存；缓存只用于加速，不作为发布证据。

## Release 数据流

1. `vMAJOR.MINOR.PATCH` tag 必须指向私有仓库受信 `main` 历史中的 commit，且与应用版本一致。
2. macOS 默认在发布者的 Mac 上运行 `pnpm release:macos:local -- vMAJOR.MINOR.PATCH`。脚本只接受 clean worktree、受信 `origin/main` 上的当前 tag commit，使用登录钥匙串中的 Developer ID Application、`CoreRobin-Notary` 公证 profile 和本机 Tauri 更新私钥构建 Apple Silicon/Intel 包。最终 DMG 必须完成 Apple 公证与票据装订，并通过签名、Hardened Runtime、架构和 Gatekeeper 检查。脚本为六个 macOS 资产生成绑定 tag、commit、Team ID 与 SHA-256 的 `macos-local.json`，然后只把这些文件写入公开仓库的 draft。
3. tag push 触发的 Actions 默认只在 GitHub-hosted Linux/Windows runner 构建对应安装包；只读 import job 从公开 draft 取回本机 macOS 资产并校验 manifest。只有显式手动 dispatch 并选择 `macos_builder=github` 时，才会启用 GitHub-hosted macOS runner，并从受保护 Secrets 导入 Developer ID 与 App Store Connect API 凭据执行同等级签名、公证和校验。
4. package job 为 Apple Silicon、Intel Mac、Windows x64 和 Linux x64 汇总独立命名的更新包及 `.sig`，生成 Tauri `latest.json`，再生成 `SHA256SUMS` 和 SPDX SBOM。任一目标缺少更新包、签名，或本地 macOS manifest 与 tag commit 不一致都会停止发布。
5. sign job 使用 GitHub Actions OIDC 与 Sigstore/Cosign 为 `SHA256SUMS` 生成 `SHA256SUMS.sigstore.json`，随后在 job 内立即复核。
6. 受保护的 `release` environment 批准 staging job 后，流程使用 `PUBLIC_RELEASE_TOKEN` 更新 `JimmyDaddy/corerobin-monitor` 的同一 draft，补齐安装包、校验表、SBOM 和签名包。Release 说明从当前版本的 `CHANGELOG.md` 段落生成；此时不会改变 latest 或官网 manifest。
7. Apple Silicon Mac、Intel Mac、Windows x64 和 Linux x64 分别安装 draft 候选产物，并通过交互脚本生成带 artifact SHA-256 的真实设备 smoke JSON。
8. 手动运行 `Promote verified release`，提交四份 JSON。工作流重新验证 tag/commit、Sigstore、全部 staged asset 校验和及所有适用 smoke 项；通过后才公开 Release、设置 latest，并更新 `site/release-manifest.json` 触发 Pages。应用随后从公开 Release 的 `latest.json` 检查更新，并在下载后强制验证嵌入应用的更新公钥。

Internal 不再保留或构建官网副本。`corerobin-monitor/site` 是唯一官网源；Internal 只保留应用源码、截图源、用户文档源、发布脚本和公开内容同步 manifest。

Release 自动门禁与真实设备验证的边界、命令和证据格式见 [发布冒烟与性能门禁](release-smoke-and-performance.md)。自动门禁检查 production 四入口与安装包结构，但不宣称在无桌面会话的 GitHub runner 上完成真实 GUI、权限或传感器验证。

Tauri 更新签名用于防止应用内更新包被替换，Developer ID 与 Apple 公证负责 macOS 平台信任，Sigstore 则为跨平台校验表提供来源证明；三者是互补边界。Windows Authenticode 仍未配置，因此 Windows 首次安装仍不会显示已验证发布者。

## 默认发布顺序

发布 commit 合并到 `main` 并推送后，先在本机创建 tag，但不要立即推送 tag：

```bash
git tag vMAJOR.MINOR.PATCH
pnpm release:macos:local -- vMAJOR.MINOR.PATCH
git push origin vMAJOR.MINOR.PATCH
```

本地脚本会先把已签名、公证、校验过的 macOS 资产上传到公开 draft。随后 tag push 启动 Actions：Linux/Windows 由 GitHub 构建，macOS import job 只读取 draft、验证 `macos-local.json` 的 commit 与 SHA-256，再进入统一 package/sign/publish 链路。若只想验证本机构建而不上传，追加 `--no-upload`。

明确需要改用 GitHub-hosted macOS runner 时，先确保 tag 已推送，再取消或等待该 tag 自动触发的默认 local run，并手动运行：

```bash
gh workflow run release.yml \
  --repo JimmyDaddy/CoreRobin-Internal \
  --ref vMAJOR.MINOR.PATCH \
  -f macos_builder=github
```

`--ref` 必须是 release tag，不能选择 `main`，否则可信 tag 校验会失败。GitHub 官方说明 `workflow_dispatch` 的 `GITHUB_REF/GITHUB_SHA` 来自 dispatch 指定的 branch 或 tag；固定到 tag 也使后续 Sigstore identity 继续绑定 `refs/tags/vMAJOR.MINOR.PATCH`。

## 一次性 GitHub 配置

在 GitHub 创建两个 fine-grained personal access token，避免默认 import job 接触发布写权限：

- Resource owner：`JimmyDaddy`
- Repository access：Only select repositories → `corerobin-monitor`
- `PUBLIC_RELEASE_READ_TOKEN`：Repository permissions → Contents → Read-only，只供 local macOS import job 读取 draft；
- `PUBLIC_RELEASE_TOKEN`：Repository permissions → Contents → Read and write，只供受保护 publish/promotion job 写入 Release；
- Expiration：按维护周期设置并在到期前轮换

将只读令牌保存为 `CoreRobin-Internal` 的 repository Actions secret `PUBLIC_RELEASE_READ_TOKEN`；将写令牌继续保存为受保护 `release` environment 的 secret `PUBLIC_RELEASE_TOKEN`。本机 `gh` 登录身份仍需要公开仓库 Release 写权限，以便创建 draft 和上传本机 macOS 资产。将 Tauri 更新私钥和密码分别保存为 `TAURI_SIGNING_PRIVATE_KEY` 与 `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`，供 Linux/Windows 和显式 GitHub macOS fallback 使用；仓库只保留可公开的更新公钥。

显式选择 GitHub-hosted macOS fallback 时，还需要在同一私有仓库配置以下 Actions secrets：

- `APPLE_CERTIFICATE`：包含私钥的 Developer ID Application `.p12` 的单行 Base64；
- `APPLE_CERTIFICATE_PASSWORD`：导出 `.p12` 时设置的密码；
- `APPLE_API_PRIVATE_KEY_BASE64`：App Store Connect Team API `.p8` 私钥的单行 Base64；
- `APPLE_API_KEY`：Team API Key ID；
- `APPLE_API_ISSUER`：App Store Connect Issuer ID；
- `APPLE_TEAM_ID`：证书所属 Apple Developer Team ID。

公证必须使用 App Store Connect Team API Key，不能使用不支持 `notarytool` 的 Individual API Key。API Key 使用满足公证所需的最低角色，`.p8` 只能下载一次，应保留加密备份；workflow 只把它还原到当前 macOS runner 的临时目录。不要把 `.p12`、`.p8`、密码、Base64 内容或令牌写进源码、workflow 文件、公开仓库、Issue 或聊天记录。

默认本地路径不读取上述 Apple Actions secrets。它要求本机已具备：

- `security find-identity -v -p codesigning` 可找到有效的 `Developer ID Application`；
- `xcrun notarytool history --keychain-profile CoreRobin-Notary` 可访问已保存的 App Store Connect Team API 凭据；
- `~/.tauri/corerobin-updater.key` 存在，密码保存在当前用户钥匙串的 `CoreRobin Tauri Updater` generic password 中；
- `gh auth status` 对 `JimmyDaddy/corerobin-monitor` 具有 Release 写权限。

这些路径和钥匙串 service 名称可分别用 `TAURI_SIGNING_PRIVATE_KEY_PATH`、`COREROBIN_NOTARY_PROFILE` 与 `COREROBIN_UPDATER_PASSWORD_SERVICE` 覆盖。脚本不会把私钥或密码复制到发布目录。

`release` environment 应继续启用部署分支/tag 规则和人工批准。令牌失效时，构建与签名仍会完成，但 publish job 会明确失败，不会回退到向私有仓库发布。

## 回滚与故障处理

- 公网 Release 已发布后不覆盖同名正式版本；需要修复时发布新的补丁版本。
- publish job 只允许覆盖尚未公开的 draft release 资产，避免重跑静默替换用户已下载的文件。
- 若公开仓库暂时不可用，保留 workflow artifact，修复凭据或仓库状态后重跑 draft staging job。
- 若本地 macOS 构建失败，先检查登录钥匙串授权、`CoreRobin-Notary` profile、更新私钥密码与 Apple 公证结果；不得跳过本地 manifest 校验或回退为 ad-hoc 包继续发布。若显式 GitHub fallback 失败，再检查该 matrix job 的 `codesign`/`notarytool` 日志及对应 Secrets。
- 若 Release 已公开但 manifest 更新失败，使用同样四份证据重跑 promotion；它会再次完整验证证据与资产，只补做 manifest 更新。
- 若怀疑令牌泄露，立即撤销对应令牌、轮换 `PUBLIC_RELEASE_READ_TOKEN`/`PUBLIC_RELEASE_TOKEN`，再检查公开仓库的 Release 审计记录。
- 官网由公开仓库的 Pages workflow 部署；私有仓库不再部署 GitHub Pages。
