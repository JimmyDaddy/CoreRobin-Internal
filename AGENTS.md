# CoreRobin 仓库协作约定

本文件约束在本仓库工作的自动化研发代理。开始修改前先确认任务属于哪个仓库，并保持私有源码与公开分发边界。

## 两个仓库的职责

- `JimmyDaddy/CoreRobin-Internal`（本仓库，private）是产品源码、测试、构建配置、发布工作流和内部技术文档的唯一可信来源。
- `JimmyDaddy/corerobin-monitor`（public）只承载官网、面向用户的公开文档、Issue 和可下载的 GitHub Release。
- 两个仓库是同级独立仓库，不使用 Git submodule，也不要把公开仓库嵌入本仓库历史。
- 本机可能把公开仓库检出在相邻目录 `../corerobin-monitor`；这是开发便利约定，不应写入脚本成为硬依赖。

## 跨仓库同步规则

- 产品行为、应用内文案、截图源和发布配置先在 Internal 修改并验证。
- 官网、公开截图或用户文档发生变化时，再把必要的公开内容同步到 `corerobin-monitor`，并在两个仓库分别提交。
- 公开仓库的 README 可以针对最终用户精简，不要求与 Internal README 逐字一致。
- 不得向公开仓库复制应用源码、私有设计记录、密钥、令牌、内部 workflow 配置或其他仅限研发的信息。
- 只涉及源码或内部工程的任务不要修改公开仓库；只涉及公开站点或 Issue 的任务不要反向改动 Internal。

## 发布规则

- 应用版本必须同时更新 `package.json`、`src-tauri/Cargo.toml`、`src-tauri/tauri.conf.json` 和 `src-tauri/Cargo.lock`。
- Release tag 使用 `vMAJOR.MINOR.PATCH`，只能从 Internal 的受信 `main` 提交创建，且必须与上述版本完全一致。
- `.github/workflows/release.yml` 在 Internal 完成验证、跨平台构建、校验和、SBOM 与 Sigstore 签名，再把安装包发布到 `JimmyDaddy/corerobin-monitor`。
- 面向用户的二进制 Release 只在公开仓库发布；不要在 Internal 手工上传一份重复安装包。
- 发布或跨仓库同步前后都要检查两个仓库的 `git status`、远端地址和实际 GitHub Actions 结果。

## 面向用户的更新日志

- `CHANGELOG.md` 的版本小节、`release-notes/vMAJOR.MINOR.PATCH.json`、公开 GitHub Release 与官网版本记录都是面向最终用户的产品说明。
- 更新日志只允许包含用户能够感知的功能新增、体验改进和功能缺陷修复，并直接说明“用户现在可以做什么”或“什么问题已被修复”。
- 不得写入依赖升级、CI/工作流、公证与签名管线、webhook、Finalize、代码重构、测试、构建缓存、开发工具、安全扫描治理或文档同步等研发过程；这些内容应留在 commit、PR、内部文档或安全公告中。
- 安全修复只有在改变用户可感知的产品风险或行为时才进入更新日志，且使用结果导向的用户语言，不披露内部依赖处置过程。
- 生成或审核版本说明时，必须逐条执行“用户是否能在应用里观察或使用这项变化”的检查；答案为否的条目必须删除。

更详细的权限与数据流说明见 `docs/release-distribution.md`。
