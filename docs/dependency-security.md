# 依赖安全决策

## RUSTSEC-2024-0429 / GHSA-wrw7-89jp-8q8g

截至 2026-07-28，Internal 的 `glib 0.18.5` 告警只存在于 Linux Tauri/GTK3 依赖链：

```text
CoreRobin → Tauri 2.11.5 → gtk 0.18.2 / webkit2gtk 2.0.2 → glib 0.18.5
```

该问题位于 `glib::VariantStrIter` 的迭代器实现，优化构建可能因错误的不可变 out-pointer 引发未定义行为。CoreRobin 没有直接调用这个 API，但 Linux GUI 运行时仍会链接受影响 crate，因此不能把它标为误报。

官方安全公告把 `glib >= 0.20.0` 列为修复版本。然而 Tauri v2 的 Linux 后端使用已归档的 GTK3 Rust bindings，固定依赖 `glib ^0.18`；直接加入 `glib 0.20` 只会并存第二个版本，并不能替换有问题的链。Tauri v3 的 GTK4 迁移也不适合作为修复版本的无关大升级。

上游正在处理兼容回补：

- [gtk-rs-core PR #2009](https://github.com/gtk-rs/gtk-rs-core/pull/2009) 将已验证修复逐字回补到 `0.18` 分支；
- [gtk-rs-core issue #2010](https://github.com/gtk-rs/gtk-rs-core/issues/2010) 跟踪发布 `glib 0.18.6`；
- [Tauri/wry issue #1769](https://github.com/tauri-apps/wry/issues/1769) 跟踪 Tauri Linux 链。

当前决策是不引入未合并 fork、不伪造 crate 版本，也不在代码中静默忽略告警。`0.18.6` 正式发布后应立即运行：

```bash
cargo update --manifest-path src-tauri/Cargo.toml -p glib --precise 0.18.6
cargo tree --manifest-path src-tauri/Cargo.toml --target all -i glib@0.18.6
```

随后必须通过 Ubuntu Rust 检查、Linux 打包结构验证和 Linux x64 实机 smoke，并确认 Dependabot 告警关闭。如果上游拒绝发布 0.18.6，再单独评审带固定 commit、来源校验和最小 diff 的 vendored backport；不得在普通功能 PR 中临时拉取可变 branch。
