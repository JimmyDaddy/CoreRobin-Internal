# CoreRobin 文档索引

本目录是私有仓库内的技术与产品文档。面向最终用户的公开内容先在这里核对，再通过 `pnpm public:sync -- --output <公开仓库路径>` 导出到独立的 `corerobin-monitor` 仓库；不要把公开仓库作为 submodule 或脚本硬依赖。

## 面向用户的规范内容

- [中文使用指南](user-guide.zh-CN.md)
- [English user guide](user-guide.md)
- [中文隐私说明](privacy.zh-CN.md)
- [Privacy notice](privacy.md)
- [公开分发与私有源码边界](release-distribution.md)

## 工程与产品记录

- [日常问题生命周期](daily-incident-lifecycle.md)
- [国际化说明](i18n.md)
- [新手体验路线图](novice-experience-roadmap.md)（规划记录，实施时需重新核对）
- [监控、清理、Canvas 与 WebView 基准](monitor-benchmark.md)、[cleanup-benchmark.md](cleanup-benchmark.md)、[cleanup-canvas-performance.md](cleanup-canvas-performance.md)、[webview-bundle-performance.md](webview-bundle-performance.md)
- [品牌探索素材](brand/)

每次产品行为、权限边界、数据保留或发布方式变更时，先更新“面向用户的规范内容”，再导出公开文档并更新官网摘要。
