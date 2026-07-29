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
5. Apple 分别完成两个 submission 后调用外部 webhook relay；Preview job 发布成功后也向 relay 发送 `preview_ready`。relay 使用 Durable Object 按 tag 与源 run ID 聚合 `aarch64`、`x64` 与 Preview 三个信号，只在三者都到达后向 Internal 发送一次 `apple-notarization-complete` repository dispatch，唤醒 `Finalize macOS release`。GitHub dispatch 暂时失败时，relay 会以 1 分钟起步、最长 1 小时的指数退避自动重试。Internal 的 `Reconcile Apple notarization` 还会每 30 分钟寻找已成功发布 Preview、尚未生成稳定 Release 且没有 Finalize 在途的版本；它在短时 macOS runner 中核对两个 Apple submission，全部 `Accepted` 后补发同一个幂等 dispatch。Finalize 会短暂等待源 Release workflow 完成，以覆盖 Preview 创建与 workflow 状态落盘之间的秒级窗口。
6. Finalize 先验证源 run 确实是该 tag/commit 的成功 `Release` workflow，且对应 Preview 已公开；随后用一个短时 GitHub-hosted macOS runner 下载两个原始 macOS artifact，重新调用 `notarytool info`。只有两个 submission 都为 `Accepted` 才会对原始 DMG 执行 staple，并通过签名、Hardened Runtime、架构、票据和 Gatekeeper 检查。`In Progress` 或 `Invalid` 都不会进入正式打包。
7. Finalize package job 从原始 run 取回 Linux/Windows 安装包与显式保留的 Tauri 分离签名，并与已装订的 macOS 资产汇总。`createUpdaterArtifacts: true` 使用当前 Tauri v2 的未压缩 updater 格式：Linux 为 `.AppImage` + `.sig`，Windows 为 NSIS `.exe` + `.sig`。对于尚未显式保留签名的旧源 run，隔离恢复 job 只下载并重新签署原始 updater 文件，不重建应用。Finalize 随后生成 `latest.json`、`SHA256SUMS` 和 SPDX SBOM。受信 `main` 提供可修复的最终打包工具，发行说明仍从受验证的 tag 源码读取。sign job 使用 GitHub Actions OIDC 与 Sigstore/Cosign 签署校验表。
8. 受保护的 `release` environment 批准 staging job 后，Finalize 使用 `PUBLIC_RELEASE_TOKEN` 创建或更新独立的正式 `vMAJOR.MINOR.PATCH` draft。staging 会先解析 draft 的 release ID，再按 ID 重新读取公开 Release，核对 draft 状态和完整资产清单；不能依赖尚未公开 tag 的 REST tag 查询。终态 job 还会要求解析、公证、打包、签名与发布全部达到预期结果。任何必需 job 被意外跳过都会让 workflow 明确失败，不能以绿色状态结束。此时仍不会改变 latest 或官网 manifest，也不会覆盖已经公开的 Preview 资产。
9. 默认由 Apple Silicon Mac、Intel Mac、Windows x64 和 Linux x64 分别安装正式 draft 候选产物，并通过交互脚本生成带 artifact SHA-256 的真实设备 smoke JSON。最后手动运行 `Promote verified release`；它重新验证 tag/commit、Sigstore、全部 staged asset 与发布授权，并在公开 Release 前检查 `release-notes/vMAJOR.MINOR.PATCH.json` 中的中英文官网更新日志。验证通过后才公开正式 Release、设置 latest，并以一次 `site/release-manifest.json` 更新同时同步下载数据和官网版本历史。网站从这份结构化历史构建时间线，其他语言在翻译尚未补齐时回退英文，不再依赖发布后手工修改 HTML。当四平台设备不可得、维护者已经完成部分平台验收并明确接受其余平台风险时，可以选择 `maintainer-attestation`：必须列出已测平台、逐项列出未验证平台、填写原因，并再次通过受保护 `release` environment 审批。该放行记录会保存在 Actions artifact 和 Job Summary 中，不能伪装成四平台 smoke。应用随后从公开 Release 的 `latest.json` 检查更新，并强制验证嵌入应用的更新公钥。

发布者的 Mac 仍可作为显式备用 builder。`pnpm release:macos:local -- vMAJOR.MINOR.PATCH` 保持原有的同步公证、装订、验证和 `macos-local.json` 交接逻辑，但它不会消耗 GitHub macOS runner 时间；该路径不会发布 Preview，也不经过异步 Finalize。

Internal 不再保留或构建官网副本。`corerobin-monitor/site` 是唯一官网源；Internal 只保留应用源码、截图源、用户文档源、发布脚本和公开内容同步 manifest。

Release 自动门禁与真实设备验证的边界、命令和证据格式见 [发布冒烟与性能门禁](release-smoke-and-performance.md)。自动门禁检查 production 四入口与安装包结构，但不宣称在无桌面会话的 GitHub runner 上完成真实 GUI、权限或传感器验证。

Tauri 更新签名用于防止应用内更新包被替换，Developer ID 与 Apple 公证负责 macOS 平台信任，Sigstore 则为跨平台校验表提供来源证明；三者是互补边界。Windows Authenticode 仍未配置，因此 Windows 首次安装仍不会显示已验证发布者。

## 默认发布顺序

准备新版本时，先使用统一命令更新四个版本源，补充 CHANGELOG，并运行发布前门禁：

```bash
pnpm release:prepare MAJOR.MINOR.PATCH
# 补充 CHANGELOG.md 的 MAJOR.MINOR.PATCH 小节
# 补充 release-notes/vMAJOR.MINOR.PATCH.json 的中英文标题与条目
pnpm release:preflight
```

`release:prepare` 会创建对应官网更新日志模板；如果文件已经存在则保持原内容。该门禁也在普通 PR/main CI 中运行，会在 tag 创建前检查 `package.json`、`src-tauri/Cargo.toml`、`src-tauri/Cargo.lock`、`src-tauri/tauri.conf.json`、CHANGELOG 与中英文官网更新日志。发布 commit 合并到 `main` 并推送后，不再手工创建稳定 tag；先启动无 tag 的四平台候选门禁：

```bash
gh workflow run release-candidate.yml \
  --repo JimmyDaddy/CoreRobin-Internal \
  --ref main \
  -f version=MAJOR.MINOR.PATCH
```

候选门禁会在受信 `main` 的同一 commit 上运行完整前端/Rust 门禁，真实打包 Linux、Windows、Apple Silicon Mac 与 Intel Mac，验证 Tauri updater 签名、Developer ID、Hardened Runtime、安装包结构和架构。四个平台全部成功后，受保护的 `release` environment 请求批准；只有批准后才创建不可变的 `vMAJOR.MINOR.PATCH` tag，并以该 tag 自动启动 `Release`。候选失败不会创建任何 tag。候选产物只保留三天用于诊断，不作为正式发布资产；正式 Release 仍从同一 tag commit 独立重建并生成完整来源证明。

紧急情况下仍可手工创建 tag，但这会绕过候选门禁，并重新承担失败 tag 无法安全复用的风险。

tag push 启动 `Release`：所有平台完成构建后发布 `vMAJOR.MINOR.PATCH-preview.1`，macOS runner 在提交公证并上传原始 artifact 后已经释放。记录该次 `Release` run ID；Apple webhook relay 会携带 tag/run ID 唤醒 Finalize。

Webhook 丢失或 relay dispatch 失败时，在两个 submission 都已 `Accepted` 后手动运行：

```bash
gh workflow run finalize-release.yml \
  --repo JimmyDaddy/CoreRobin-Internal \
  --ref main \
  -f tag=vMAJOR.MINOR.PATCH \
  -f source_run_id=RELEASE_RUN_ID
```

Finalize 的 `--ref` 必须是受保护的 `main`，工作流内部会重新 checkout 和验证 release tag；发行资产与发行说明固定到该 tag，最终打包脚本固定到触发时的受信 `main`，因此可以修复打包逻辑而无需移动不可变 tag。这也将异步 Finalize 的 Sigstore identity 固定为 `finalize-release.yml@refs/heads/main`。源 `Release` run 必须已经成功结束，且公开 Preview 必须存在。

明确改用发布者 Mac 时，先在未推送的 tag 上运行本地脚本；推送 tag 后取消自动 hosted run，再对同一远端 tag 手动运行 `Release` 并选择 `macos_builder=local`。本地脚本的 `--no-upload` 仍可用于仅验证构建。

## Apple webhook relay 契约

`notarytool` 不能带 GitHub token 直接调用 repository dispatch，因此使用 `infra/notary-webhook-relay` 中的 Cloudflare Worker 与 SQLite Durable Object 作为极小的外部 HTTPS relay。部署、密钥配置和健康检查命令见该目录的 README。将带有随机 secret path 的完整回调基础 URL 配置为 Internal repository Actions secret `APPLE_NOTARY_WEBHOOK_URL`；workflow 会追加以下 query 参数：

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

目标 API 是 `POST /repos/JimmyDaddy/CoreRobin-Internal/dispatches`。relay 使用只选择 Internal 仓库、仅授予 `Contents: write` 的 fine-grained token；该 token 只保存在 Cloudflare Worker secret，不能写入 GitHub Actions secret、公开仓库或日志。随机 path secret 也只保存在 Cloudflare，完整 URL 仅存入 Internal Actions secret。relay 限制请求方法和 64 KiB 请求体，校验 tag/run ID/arch，失败 dispatch 保持待处理并由 alarm 重试，聚合状态在 30 天后过期。即使 relay 或定时核对流程被伪造调用，Finalize 仍会独立验证源 workflow、Preview、state SHA、Team ID 和 Apple 的实时状态，因此这些唤醒信号本身不具备正式发布权限。

## 一次性 GitHub 配置

在 GitHub 创建两个 fine-grained personal access token，避免默认 import job 接触发布写权限：

- Resource owner：`JimmyDaddy`
- Repository access：Only select repositories → `corerobin-monitor`
- `PUBLIC_RELEASE_READ_TOKEN`：Repository permissions → Contents → Read-only，只供 local macOS import job 读取 draft，以及 Finalize 校验公开 Preview；
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
- Apple webhook 先后触发两次是正常情况。relay 会在 Durable Object 中等待两个架构，不会因首个回调提前启动 Finalize；重复回调也不会重复 dispatch。Webhook 缺失和 GitHub dispatch 暂时失败通常会由 relay alarm 或定时核对自动恢复。只有补偿 workflow 本身持续失败时，才需要使用同一 tag 与源 run ID 手动运行 Finalize。
- 若源 artifact 超过 30 天 retention 仍未完成公证，不得从 Preview 下载后直接当作可信输入；发布新的补丁版本并重新构建、提交。
- 若本地 macOS 构建失败，先检查登录钥匙串授权、`CoreRobin-Notary` profile、更新私钥密码与 Apple 公证结果；不得跳过本地 manifest 校验或回退为 ad-hoc 包继续发布。若默认 GitHub 构建失败，再检查该 matrix job 的 `codesign`/`notarytool` 日志及对应 Secrets。
- 若 Release 已公开但 manifest 更新失败，使用原来的四份证据或同一份维护者风险确认重跑 promotion；它会再次完整验证发布授权与资产，只补做 manifest 更新。
- 若怀疑令牌泄露，立即撤销对应令牌、轮换 `PUBLIC_RELEASE_READ_TOKEN`/`PUBLIC_RELEASE_TOKEN`，再检查公开仓库的 Release 审计记录。
- 官网由公开仓库的 Pages workflow 部署；私有仓库不再部署 GitHub Pages。
