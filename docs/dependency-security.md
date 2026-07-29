# 依赖安全决策

## RUSTSEC-2024-0429 / GHSA-wrw7-89jp-8q8g

截至 2026-07-29，该告警来自 Linux Tauri/GTK3 依赖链：

```text
CoreRobin → Tauri 2.11.5 → gtk 0.18.2 / webkit2gtk 2.0.2 → glib ^0.18
```

该问题位于 `glib::VariantStrIter` 的迭代器实现，优化构建可能因错误的不可变 out-pointer 引发未定义行为。CoreRobin 没有直接调用这个 API，但 Linux GUI 运行时仍会链接受影响 crate，因此不能把它标为误报。

官方安全公告把 `glib >= 0.20.0` 列为修复版本。然而 Tauri v2 的 Linux 后端使用已归档的 GTK3 Rust bindings，固定依赖 `glib ^0.18`；直接加入 `glib 0.20` 只会并存第二个版本，并不能替换有问题的链。Tauri v3 的 GTK4 迁移也不适合作为修复版本的无关大升级。

CoreRobin 当前采用经过审计的定向回补：

- `src-tauri/vendor/glib` 以 crates.io 的 `glib 0.18.5` 为基线，作为本项目的 `0.18.6` 本地补丁版本；
- 只逐字回补 [gtk-rs-core PR #2009](https://github.com/gtk-rs/gtk-rs-core/pull/2009) 的两行修复：将 out-pointer 声明为可变，并传入 `&mut p`；
- 来源提交固定为 `ea720152f28e293ef4362ee844ee5cc499f32d2a`，并记录在 vendored crate 的 `COREROBIN-SECURITY-BACKPORT.md`；
- `scripts/dependency-security.test.mjs` 验证补丁路径、版本、关键代码和来源提交，防止依赖更新时静默退回有漏洞的代码。

上游发布仍由以下事项跟踪：

- [gtk-rs-core issue #2010](https://github.com/gtk-rs/gtk-rs-core/issues/2010) 跟踪发布 `glib 0.18.6`；
- [Tauri/wry issue #1769](https://github.com/tauri-apps/wry/issues/1769) 跟踪 Tauri Linux 链。

这不是 `cargo audit` ignore，也没有从可变 branch 拉取源码。锁文件和 `[patch.crates-io]` 会让 Linux GTK 链实际链接本地修复版本。上游发布包含同一修复的兼容版本后，应删除 vendored crate，恢复 crates.io 并运行：

```bash
cargo update --manifest-path src-tauri/Cargo.toml -p glib
cargo tree --manifest-path src-tauri/Cargo.toml --target all -i glib@0.18.6
```

合并前必须通过 Ubuntu Rust 检查和 Linux 打包结构验证；Linux x64 实机 smoke 仍属于发布验收。Dependabot 告警是否自动关闭还取决于 GitHub 对 path override 的识别结果，不能用关闭告警代替对实际依赖源码的验证。
