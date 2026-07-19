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
2. tag push 默认在 GitHub-hosted runner 并行构建 Linux、Windows、Apple Silicon Mac 和 Intel Mac。macOS job 导入 Developer ID、App Store Connect API 与 Tauri 更新签名凭据，生成已签名的 DMG/updater；它只调用一次 `notarytool submit`，保存 submission ID 后立即结束，不在 runner 内轮询 Apple。
3. 每个 macOS job 上传预装订 DMG、updater、签名和私有 `notarization-state.json`。状态文件绑定 tag、commit、源 workflow run ID、架构、Team ID、submission ID 与三份资产 SHA-256；Finalize 必须先复核该文件，不能只相信 webhook payload。
4. Linux、Windows 与两个 macOS build 全部成功后，Preview job 只挑选可手动安装的文件，在公开仓库发布独立的 `vMAJOR.MINOR.PATCH-preview.1` prerelease。macOS 文件名带有 `unnotarized-preview`，Preview 不含 updater 压缩包、`.sig`、`latest.json`，不会更新 `site/release-manifest.json`，也不会被标记为 latest。
5. Apple 分别完成两个 submission 后调用外部 webhook relay；relay 使用 Durable Object 按 tag 与源 run ID 聚合 `aarch64`、`x64` 回调，只在两个架构都到达后向 Internal 发送一次 `apple-notarization-complete` repository dispatch，唤醒 `Finalize macOS release`。如果 relay 回调丢失，可以用同一 tag 与源 run ID 手动 dispatch。
6. Finalize 先验证源 run 确实是该 tag/commit 的成功 `Release` workflow，且对应 Preview 已公开；随后用一个短时 GitHub-hosted macOS runner 下载两个原始 macOS artifact，重新调用 `notarytool info`。只有两个 submission 都为 `Accepted` 才会对原始 DMG 执行 staple，并通过签名、Hardened Runtime、架构、票据和 Gatekeeper 检查。`In Progress` 或 `Invalid` 都不会进入正式打包。
7. Finalize package job 从原始 run 取回 Linux/Windows 资产，并与已装订的 macOS 资产汇总，生成 Tauri `latest.json`、`SHA256SUMS` 和 SPDX SBOM。sign job使用 GitHub Actions OIDC 与 Sigstore/Cosign 签署校验表。
8. 受保护的 `release` environment 批准 staging job 后，Finalize 使用 `PUBLIC_RELEASE_TOKEN` 创建或更新独立的正式 `vMAJOR.MINOR.PATCH` draft。此时仍不会改变 latest 或官网 manifest，也不会覆盖已经公开的 Preview 资产。
9. Apple Silicon Mac、Intel Mac、Windows x64 和 Linux x64 分别安装正式 draft 候选产物，并通过交互脚本生成带 artifact SHA-256 的真实设备 smoke JSON。最后手动运行 `Promote verified release`；它重新验证 tag/commit、Sigstore、全部 staged asset 与 smoke 证据，才公开正式 Release、设置 latest，并更新 `site/release-manifest.json`。应用随后从公开 Release 的 `latest.json` 检查更新，并强制验证嵌入应用的更新公钥。

发布者的 Mac 仍可作为显式备用 builder。`pnpm release:macos:local -- vMAJOR.MINOR.PATCH` 保持原有的同步公证、装订、验证和 `macos-local.json` 交接逻辑，但它不会消耗 GitHub macOS runner 时间；该路径不会发布 Preview，也不经过异步 Finalize。

Internal 不再保留或构建官网副本。`corerobin-monitor/site` 是唯一官网源；Internal 只保留应用源码、截图源、用户文档源、发布脚本和公开内容同步 manifest。

Release 自动门禁与真实设备验证的边界、命令和证据格式见 [发布冒烟与性能门禁](release-smoke-and-performance.md)。自动门禁检查 production 四入口与安装包结构，但不宣称在无桌面会话的 GitHub runner 上完成真实 GUI、权限或传感器验证。

Tauri 更新签名用于防止应用内更新包被替换，Developer ID 与 Apple 公证负责 macOS 平台信任，Sigstore 则为跨平台校验表提供来源证明；三者是互补边界。Windows Authenticode 仍未配置，因此 Windows 首次安装仍不会显示已验证发布者。

## 默认发布顺序

发布 commit 合并到 `main` 并推送后，创建并推送 tag：

```bash
git tag vMAJOR.MINOR.PATCH
git push origin vMAJOR.MINOR.PATCH
```

tag push 启动 `Release`：所有平台完成构建后发布 `vMAJOR.MINOR.PATCH-preview.1`，macOS runner 在提交公证并上传原始 artifact 后已经释放。记录该次 `Release` run ID；Apple webhook relay 会携带 tag/run ID 唤醒 Finalize。

Webhook 丢失或 relay dispatch 失败时，在两个 submission 都已 `Accepted` 后手动运行：

```bash
gh workflow run finalize-release.yml \
  --repo JimmyDaddy/CoreRobin-Internal \
  --ref main \
  -f tag=vMAJOR.MINOR.PATCH \
  -f source_run_id=RELEASE_RUN_ID
```

Finalize 的 `--ref` 必须是受保护的 `main`，工作流内部会重新 checkout 和验证 release tag；这也将异步 Finalize 的 Sigstore identity 固定为 `finalize-release.yml@refs/heads/main`。源 `Release` run 必须已经成功结束，且公开 Preview 必须存在。

明确改用发布者 Mac 时，先在未推送的 tag 上运行本地脚本；推送 tag 后取消自动 hosted run，再对同一远端 tag 手动运行 `Release` 并选择 `macos_builder=local`。本地脚本的 `--no-upload` 仍可用于仅验证构建。

## Apple webhook relay 契约

`notarytool` 不能带 GitHub token 直接调用 repository dispatch，因此使用 `infra/notary-webhook-relay` 中的 Cloudflare Worker 与 SQLite Durable Object 作为极小的外部 HTTPS relay。部署、密钥配置和健康检查命令见该目录的 README。将带有随机 secret path 的完整回调基础 URL配置为 Internal repository Actions secret `APPLE_NOTARY_WEBHOOK_URL`；workflow 会追加以下 query 参数：

- `tag=vMAJOR.MINOR.PATCH`
- `run_id=RELEASE_RUN_ID`
- `arch=aarch64|x64`

relay 收到 Apple 请求后，不负责判断是否 `Accepted`；它按 tag/run ID 串行聚合两个架构、抑制并发重复请求，只向 GitHub 发送一次唤醒事件：

```json
{
  "event_type": "apple-notarization-complete",
  "client_payload": {
    "tag": "vMAJOR.MINOR.PATCH",
    "run_id": "RELEASE_RUN_ID"
  }
}
```

目标 API 是 `POST /repos/JimmyDaddy/CoreRobin-Internal/dispatches`。relay 使用只选择 Internal 仓库、仅授予 `Contents: write` 的 fine-grained token；该 token 只保存在 Cloudflare Worker secret，不能写入 GitHub Actions secret、公开仓库或日志。随机 path secret 也只保存在 Cloudflare，完整 URL 仅存入 Internal Actions secret。relay 限制请求方法和 64 KiB 请求体，校验 tag/run ID/arch，并让聚合状态在 30 天后过期。即使 relay 被伪造调用，Finalize 仍会独立验证源 workflow、Preview、state SHA、Team ID 和 Apple 的实时状态，因此 webhook 本身不具备正式发布权限。

## 一次性 GitHub 配置

在 GitHub 创建两个 fine-grained personal access token，避免默认 import job 接触发布写权限：

- Resource owner：`JimmyDaddy`
- Repository access：Only select repositories → `corerobin-monitor`
- `PUBLIC_RELEASE_READ_TOKEN`：Repository permissions → Contents → Read-only，只供 local macOS import job 读取 draft；
- `PUBLIC_RELEASE_TOKEN`：Repository permissions → Contents → Read and write，只供受保护 publish/promotion job 写入 Release；
- Expiration：按维护周期设置并在到期前轮换

将只读令牌保存为 `CoreRobin-Internal` 的 repository Actions secret `PUBLIC_RELEASE_READ_TOKEN`；将写令牌继续保存为受保护 `release` environment 的 secret `PUBLIC_RELEASE_TOKEN`。本机 `gh` 登录身份仍需要公开仓库 Release 写权限，以便创建 draft 和上传本机 macOS 资产。将 Tauri 更新私钥和密码分别保存为 `TAURI_SIGNING_PRIVATE_KEY` 与 `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`，供 Linux/Windows 和显式 GitHub macOS fallback 使用；仓库只保留可公开的更新公钥。

默认 GitHub-hosted macOS 构建需要在同一私有仓库配置以下 Actions secrets：

- `APPLE_CERTIFICATE`：包含私钥的 Developer ID Application `.p12` 的单行 Base64；
- `APPLE_CERTIFICATE_PASSWORD`：导出 `.p12` 时设置的密码；
- `APPLE_API_PRIVATE_KEY_BASE64`：App Store Connect Team API `.p8` 私钥的单行 Base64；
- `APPLE_API_KEY`：Team API Key ID；
- `APPLE_API_ISSUER`：App Store Connect Issuer ID；
- `APPLE_TEAM_ID`：证书所属 Apple Developer Team ID。
- `APPLE_NOTARY_WEBHOOK_URL`：Apple 完成公证时调用的外部 relay 完整 secret-path URL；该值已由部署者配置时，workflow 才会向 `notarytool submit` 传入 `--webhook`，否则使用手动 Finalize。

公证必须使用 App Store Connect Team API Key，不能使用不支持 `notarytool` 的 Individual API Key。API Key 使用满足公证所需的最低角色，`.p8` 只能下载一次，应保留加密备份；workflow 只把它还原到当前 macOS runner 的临时目录。不要把 `.p12`、`.p8`、密码、Base64 内容或令牌写进源码、workflow 文件、公开仓库、Issue 或聊天记录。

显式本地备用路径不读取上述 Apple Actions secrets。它要求本机已具备：

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
- Preview 已公开后不得覆盖同名 Preview 资产；候选内容变化时发布新的补丁版本，或显式扩展 workflow 使用新的 Preview 序号。
- Apple webhook 先后触发两次是正常情况。relay 会在 Durable Object 中等待两个架构，不会因首个回调提前启动 Finalize；重复回调也不会重复 dispatch。若第二个回调在 30 天内始终未到达，或 GitHub dispatch 失败，在全部 `Accepted` 后手动运行 Finalize。
- 若源 artifact 超过 30 天 retention 仍未完成公证，不得从 Preview 下载后直接当作可信输入；发布新的补丁版本并重新构建、提交。
- 若本地 macOS 构建失败，先检查登录钥匙串授权、`CoreRobin-Notary` profile、更新私钥密码与 Apple 公证结果；不得跳过本地 manifest 校验或回退为 ad-hoc 包继续发布。若默认 GitHub 构建失败，再检查该 matrix job 的 `codesign`/`notarytool` 日志及对应 Secrets。
- 若 Release 已公开但 manifest 更新失败，使用同样四份证据重跑 promotion；它会再次完整验证证据与资产，只补做 manifest 更新。
- 若怀疑令牌泄露，立即撤销对应令牌、轮换 `PUBLIC_RELEASE_READ_TOKEN`/`PUBLIC_RELEASE_TOKEN`，再检查公开仓库的 Release 审计记录。
- 官网由公开仓库的 Pages workflow 部署；私有仓库不再部署 GitHub Pages。
