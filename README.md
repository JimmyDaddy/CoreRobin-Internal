# Pulse

Pulse 是一个面向桌面的电脑资源管理器：保留 `htop` 的实时性与进程操作能力，同时提供更适合图形界面的趋势、搜索、诊断和安全确认体验。

当前版本已经打通第一条可用链路：Rust 后端读取真实系统数据，Tauri 将其暴露给 React 界面，用户可以查看资源总览、筛选进程、打开进程详情，并在身份复核后请求或强制结束进程。

## 当前能力

- 每秒采样 CPU、内存、交换空间、磁盘吞吐和网络吞吐
- 展示 CPU / 内存最近 5 分钟的进程内历史趋势
- 按 CPU、内存、磁盘 I/O 或名称排序，支持名称、PID、用户搜索
- 按需读取进程路径、命令、父进程、用户、状态和运行时长
- 支持暂停、继续和立即刷新；丢弃乱序采样帧
- 请求结束进程（macOS / Linux 使用 `SIGTERM`）或强制结束进程
- 针对首帧速率指标显示“预热中”，避免把尚未采样的数据显示成 0

存储、网络详情、持久化历史和设置入口暂时保留为后续迭代。

## 安全边界

进程操作不会只依赖 PID。界面选择进程时记录 PID 与启动时间；执行操作前，Rust 后端会重新读取操作系统提供的高精度进程启动标识。标识不一致时拒绝执行，从而降低 PID 被复用后误杀新进程的风险。

此外：

- PID 0、PID 1 和 Pulse 自身默认受保护
- 强制结束需要二次确认，并明确展示目标进程
- 不自动提权；权限不足时返回结构化错误
- 系统采样与进程操作都在后台线程执行，不阻塞界面线程

## 技术栈

- Tauri 2
- Rust 1.95（由项目根目录的 `rust-toolchain.toml` 固定）
- React 19、TypeScript、Vite
- `sysinfo` 0.39.6
- Vitest

## 开发

建议用 `rustup` 管理 Rust。它相当于 Rust 生态中的 `nvm`，可以安装多个工具链，并通过目录级配置自动切换版本。本项目进入目录后会自动选择 Rust 1.95：

```bash
rustup show active-toolchain
```

准备环境：

```bash
pnpm install
pnpm tauri dev
```

如果本机尚未安装固定版本，`rustup` 会根据 `rust-toolchain.toml` 自动下载；macOS 还需要 Xcode Command Line Tools。

常用检查：

```bash
pnpm typecheck
pnpm test
pnpm build
cargo fmt --manifest-path src-tauri/Cargo.toml --check
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings
cargo test --manifest-path src-tauri/Cargo.toml
```

构建桌面应用：

```bash
pnpm tauri build
```

## 目录

- `src/`：界面、轮询状态、进程表格与交互
- `src-tauri/src/monitor.rs`：资源采样与进程操作
- `src-tauri/src/identity.rs`：跨平台进程启动标识读取
- `src-tauri/src/models.rs`：前后端数据契约

## 当前平台状态

macOS 已完成真实窗口和原生应用构建验证。Linux / Windows 已保留对应的进程身份实现与条件编译分支，但还需要在目标系统上完成运行时验证。GPU、温度、风扇和电池指标尚未接入。
