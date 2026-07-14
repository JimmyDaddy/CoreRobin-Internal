# Pulse

Pulse 是一个面向桌面的 `htop` 风格资源管理器。它由 Tauri 2、React、TypeScript 和 Rust 构建，在保留实时采样与进程操作能力的同时，提供更直观的趋势、搜索和诊断界面。

界面支持简体中文与英文，可在右上角直接切换。

## 功能

### 系统概览

- 实时展示 CPU、内存、交换空间、磁盘和网络吞吐
- 展示整机 CPU / 内存与磁盘读写的最近 5 分钟趋势
- 支持暂停、继续和立即刷新，并丢弃乱序采样帧
- 速率类指标在首帧明确显示预热状态

### 进程浏览器

- 平铺与父子树两种视图，支持虚拟滚动、搜索和排序
- 展示进程 CPU、内存、磁盘 I/O、状态、用户和运行时长
- Inspector 提供路径、命令、父进程与最近 5 分钟资源趋势
- 支持请求结束和强制结束进程，并在执行前复核进程身份

### 存储浏览器

- 展示卷容量、已用比例、剩余空间与低空间告警
- 展示最近 5 分钟系统磁盘读写趋势和高 I/O 进程
- macOS 会合并显示属于同一 APFS 系统卷组的 `/` 与 Data 卷

### 网络浏览器

- 展示网络上下行趋势、本次启动累计流量和逐接口统计
- 以独立的低频采集展示 TCP / UDP 活动连接
- 支持按协议和状态筛选，展示本地地址、远端地址与连接汇总
- 在系统权限允许时展示连接所属进程，并可联动进程 Inspector

macOS 与 Linux 可能因系统权限只返回部分连接归属。

### 历史

- 以 5 分钟快照在本机保存整机 CPU、内存、磁盘和网络趋势
- 持续达到“偏高”阈值时记录 CPU、内存和最高卷占用告警，并在稳定回落后记录恢复事件
- 通过持续判定、恢复回差和冷却时间过滤短暂尖峰与重复告警；事件可按资源筛选
- 支持保留 1、7 或 30 天，并可随时停用写入或清除已保存记录
- 不保存进程名称、命令、用户、路径、文件名或连接地址，也不会上传或同步历史

### 设置

- 支持切换界面语言、系统采样间隔与活动连接刷新间隔
- 支持配置 CPU、内存和卷占用百分比的颜色与告警阈值
- 支持选择默认进程视图和历史保留期；偏好只保存在当前设备

## 安全与平台边界

进程操作不只依赖 PID。Pulse 会创建短期、单次使用的控制租约，并在执行前再次核对进程启动标识；标识不一致或租约过期时会拒绝操作。PID 0、PID 1 和 Pulse 自身默认受保护，强制结束还需要单独确认。

应用不会自动提权。macOS 的最终信号接口仍基于 PID，因此属于多重校验下的 best-effort 防护；Linux 使用 `pidfd`，Windows 复用同一进程 handle 完成校验和终止。

目前已在 macOS 完成真实窗口和原生应用构建验证。Linux 与 Windows 由 CI 编译对应平台分支，但仍需要持续补充目标系统上的运行时验证。

## 开发

需要准备：

- Node.js 22+
- pnpm 10.33（项目通过 `packageManager` 固定）
- Rust 1.95（项目通过 `rust-toolchain.toml` 固定）
- 当前平台所需的 [Tauri 系统依赖](https://v2.tauri.app/start/prerequisites/)

安装依赖并启动桌面应用：

```bash
corepack enable
pnpm install
pnpm dev
```

`pnpm dev` 会启动 Vite、Tauri 窗口和 Rust 后端。只调试浏览器界面与 mock 数据时可使用：

```bash
pnpm dev:web
```

构建桌面应用：

```bash
pnpm tauri build
```

## 验证

```bash
pnpm typecheck
pnpm test
pnpm build
cargo fmt --manifest-path src-tauri/Cargo.toml --check
cargo test --manifest-path src-tauri/Cargo.toml
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings
```

GitHub Actions 会在 pull request 和 `main` 分支推送时运行前端检查，并在 Linux、macOS 和 Windows 上编译 Rust/Tauri 目标；Linux 额外运行 Rust 测试、格式检查和 Clippy。

## 目录

- `src/`：React 界面、国际化、轮询状态与交互逻辑
- `src-tauri/src/monitor.rs`：系统资源与进程采样
- `src-tauri/src/network_connections.rs`：活动连接采集与解析
- `src-tauri/src/process_control.rs`：跨平台进程控制租约与执行
- `src-tauri/src/identity.rs`：跨平台进程启动标识读取
- `src-tauri/src/models.rs`：前后端数据契约
