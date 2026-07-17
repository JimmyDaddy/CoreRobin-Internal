# 公开分发与私有源码边界

CoreRobin 使用两个同级、互相独立的 GitHub 仓库：

- `JimmyDaddy/CoreRobin-Internal`：私有源码、测试和跨平台构建。
- `JimmyDaddy/corerobin-monitor`：公开官网、用户文档、Issue 与 Release 下载。

公开仓库不是当前仓库的 Git submodule。网站和文档可以独立更新，外部用户也不需要获得私有仓库权限；发布流程则通过受限凭据把构建结果从私有仓库推送到公开仓库。

## Release 数据流

1. `vMAJOR.MINOR.PATCH` tag 必须指向私有仓库受信 `main` 历史中的 commit，且与应用版本一致。
2. verify/build job 以只读权限测试源码并构建各平台安装包。
3. package job 生成 `SHA256SUMS` 和 SPDX SBOM。
4. sign job 使用 GitHub Actions OIDC 与 Sigstore/Cosign 为 `SHA256SUMS` 生成 `SHA256SUMS.sigstore.json`，随后在 job 内立即复核。
5. 受保护的 `release` environment 批准 staging job 后，流程使用 `PUBLIC_RELEASE_TOKEN` 把安装包、校验表、SBOM 和签名包写入 `JimmyDaddy/corerobin-monitor` 的 draft。Release 说明从当前版本的 `CHANGELOG.md` 段落生成；此时不会改变 latest 或官网 manifest。
6. Apple Silicon Mac、Intel Mac、Windows x64 和 Linux x64 分别安装 draft 候选产物，并通过交互脚本生成带 artifact SHA-256 的真实设备 smoke JSON。
7. 手动运行 `Promote verified release`，提交四份 JSON。工作流重新验证 tag/commit、Sigstore、全部 staged asset 校验和及所有适用 smoke 项；通过后才公开 Release、设置 latest，并更新 `site/release-manifest.json` 触发 Pages。

Internal 不再保留或构建官网副本。`corerobin-monitor/site` 是唯一官网源；Internal 只保留应用源码、截图源、用户文档源、发布脚本和公开内容同步 manifest。

Release 自动门禁与真实设备验证的边界、命令和证据格式见 [发布冒烟与性能门禁](release-smoke-and-performance.md)。自动门禁检查 production 四入口与安装包结构，但不宣称在无桌面会话的 GitHub runner 上完成真实 GUI、权限或传感器验证。

这组材料可以证明校验表来自指定的 GitHub Actions workflow，并检查下载文件是否与校验表一致；它不能代替 Developer ID、Apple 公证或 Windows Authenticode 等平台签名。

## 一次性 GitHub 配置

在 GitHub 创建 fine-grained personal access token：

- Resource owner：`JimmyDaddy`
- Repository access：Only select repositories → `corerobin-monitor`
- Repository permissions：Contents → Read and write
- Expiration：按维护周期设置并在到期前轮换

将令牌保存为 `CoreRobin-Internal` 仓库的 Actions secret `PUBLIC_RELEASE_TOKEN`。不要把令牌写进源码、workflow 文件、Issue 或聊天记录。

`release` environment 应继续启用部署分支/tag 规则和人工批准。令牌失效时，构建与签名仍会完成，但 publish job 会明确失败，不会回退到向私有仓库发布。

## 回滚与故障处理

- 公网 Release 已发布后不覆盖同名正式版本；需要修复时发布新的补丁版本。
- publish job 只允许覆盖尚未公开的 draft release 资产，避免重跑静默替换用户已下载的文件。
- 若公开仓库暂时不可用，保留 workflow artifact，修复凭据或仓库状态后重跑 draft staging job。
- 若 Release 已公开但 manifest 更新失败，使用同样四份证据重跑 promotion；它会再次完整验证证据与资产，只补做 manifest 更新。
- 若怀疑令牌泄露，立即撤销令牌、轮换 `PUBLIC_RELEASE_TOKEN`，再检查公开仓库的 Release 审计记录。
- 官网由公开仓库的 Pages workflow 部署；私有仓库不再部署 GitHub Pages。
