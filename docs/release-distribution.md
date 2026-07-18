# 公开分发与私有源码边界

CoreRobin 使用两个同级、互相独立的 GitHub 仓库：

- `JimmyDaddy/CoreRobin-Internal`：私有源码、测试和跨平台构建。
- `JimmyDaddy/corerobin-monitor`：公开官网、用户文档、Issue 与 Release 下载。

公开仓库不是当前仓库的 Git submodule。网站和文档可以独立更新，外部用户也不需要获得私有仓库权限；发布流程则通过受限凭据把构建结果从私有仓库推送到公开仓库。

## Release 数据流

1. `vMAJOR.MINOR.PATCH` tag 必须指向私有仓库受信 `main` 历史中的 commit，且与应用版本一致。
2. verify/build job 以只读权限测试源码并构建各平台安装包。所有平台只在 build job 内通过 `TAURI_SIGNING_PRIVATE_KEY` 与 `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` 生成 Tauri 更新签名；macOS 步骤另外从受保护 Secrets 导入 Developer ID Application `.p12`，在 runner 临时目录还原 App Store Connect Team API 私钥，由 Tauri 为应用启用 Hardened Runtime、对应用与 DMG 执行 Developer ID 签名，并完成 DMG 的 Apple 公证与票据装订。Apple 凭据不进入 verify、package、sign 或 publish job。
3. package job 为 Apple Silicon、Intel Mac、Windows x64 和 Linux x64 汇总独立命名的更新包及 `.sig`，生成 Tauri `latest.json`，再生成 `SHA256SUMS` 和 SPDX SBOM。任一目标缺少更新包或签名都会停止发布。
4. sign job 使用 GitHub Actions OIDC 与 Sigstore/Cosign 为 `SHA256SUMS` 生成 `SHA256SUMS.sigstore.json`，随后在 job 内立即复核。
5. 受保护的 `release` environment 批准 staging job 后，流程使用 `PUBLIC_RELEASE_TOKEN` 把安装包、校验表、SBOM 和签名包写入 `JimmyDaddy/corerobin-monitor` 的 draft。Release 说明从当前版本的 `CHANGELOG.md` 段落生成；此时不会改变 latest 或官网 manifest。
6. Apple Silicon Mac、Intel Mac、Windows x64 和 Linux x64 分别安装 draft 候选产物，并通过交互脚本生成带 artifact SHA-256 的真实设备 smoke JSON。
7. 手动运行 `Promote verified release`，提交四份 JSON。工作流重新验证 tag/commit、Sigstore、全部 staged asset 校验和及所有适用 smoke 项；通过后才公开 Release、设置 latest，并更新 `site/release-manifest.json` 触发 Pages。应用随后从公开 Release 的 `latest.json` 检查更新，并在下载后强制验证嵌入应用的更新公钥。

Internal 不再保留或构建官网副本。`corerobin-monitor/site` 是唯一官网源；Internal 只保留应用源码、截图源、用户文档源、发布脚本和公开内容同步 manifest。

Release 自动门禁与真实设备验证的边界、命令和证据格式见 [发布冒烟与性能门禁](release-smoke-and-performance.md)。自动门禁检查 production 四入口与安装包结构，但不宣称在无桌面会话的 GitHub runner 上完成真实 GUI、权限或传感器验证。

Tauri 更新签名用于防止应用内更新包被替换，Developer ID 与 Apple 公证负责 macOS 平台信任，Sigstore 则为跨平台校验表提供来源证明；三者是互补边界。Windows Authenticode 仍未配置，因此 Windows 首次安装仍不会显示已验证发布者。

## 一次性 GitHub 配置

在 GitHub 创建 fine-grained personal access token：

- Resource owner：`JimmyDaddy`
- Repository access：Only select repositories → `corerobin-monitor`
- Repository permissions：Contents → Read and write
- Expiration：按维护周期设置并在到期前轮换

将令牌保存为 `CoreRobin-Internal` 仓库的 Actions secret `PUBLIC_RELEASE_TOKEN`。将 Tauri 更新私钥和密码分别保存为 `TAURI_SIGNING_PRIVATE_KEY` 与 `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`；仓库只保留可公开的更新公钥。

macOS 签名和公证还需要在同一私有仓库配置以下 Actions secrets：

- `APPLE_CERTIFICATE`：包含私钥的 Developer ID Application `.p12` 的单行 Base64；
- `APPLE_CERTIFICATE_PASSWORD`：导出 `.p12` 时设置的密码；
- `APPLE_API_PRIVATE_KEY_BASE64`：App Store Connect Team API `.p8` 私钥的单行 Base64；
- `APPLE_API_KEY`：Team API Key ID；
- `APPLE_API_ISSUER`：App Store Connect Issuer ID；
- `APPLE_TEAM_ID`：证书所属 Apple Developer Team ID。

公证必须使用 App Store Connect Team API Key，不能使用不支持 `notarytool` 的 Individual API Key。API Key 使用满足公证所需的最低角色，`.p8` 只能下载一次，应保留加密备份；workflow 只把它还原到当前 macOS runner 的临时目录。不要把 `.p12`、`.p8`、密码、Base64 内容或令牌写进源码、workflow 文件、公开仓库、Issue 或聊天记录。

`release` environment 应继续启用部署分支/tag 规则和人工批准。令牌失效时，构建与签名仍会完成，但 publish job 会明确失败，不会回退到向私有仓库发布。

## 回滚与故障处理

- 公网 Release 已发布后不覆盖同名正式版本；需要修复时发布新的补丁版本。
- publish job 只允许覆盖尚未公开的 draft release 资产，避免重跑静默替换用户已下载的文件。
- 若公开仓库暂时不可用，保留 workflow artifact，修复凭据或仓库状态后重跑 draft staging job。
- 若 macOS 构建在签名或公证阶段失败，先查看该 matrix job 的 `codesign`/`notarytool` 日志并核对证书、Team ID、API Key ID 与 Issuer ID；不得回退为 ad-hoc 包继续发布。
- 若 Release 已公开但 manifest 更新失败，使用同样四份证据重跑 promotion；它会再次完整验证证据与资产，只补做 manifest 更新。
- 若怀疑令牌泄露，立即撤销令牌、轮换 `PUBLIC_RELEASE_TOKEN`，再检查公开仓库的 Release 审计记录。
- 官网由公开仓库的 Pages workflow 部署；私有仓库不再部署 GitHub Pages。
