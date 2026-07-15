# StatusOrbit

StatusOrbit 是一款桌面端电脑状态和空间管理工具。它把 CPU、内存、磁盘、网络和正在运行的应用放在一起，帮助用户看懂电脑为什么变慢、空间被什么占用，以及哪些项目需要处理。

日常使用可以留在简单模式，只看状态和最忙的应用；需要 PID、进程树、命令行或连接详情时，再切换到专业模式。

项目使用 Tauri 2、React、TypeScript 和 Rust 构建。

界面支持简体中文与英文，可在右上角直接切换。

- [产品网站](https://jimmydaddy.github.io/StatusOrbit/)
- [下载最新版本](https://github.com/JimmyDaddy/StatusOrbit/releases/latest)
- [中文使用指南](docs/user-guide.zh-CN.md)
- [English user guide](docs/user-guide.md)

## 下载与安装

前往 [GitHub Releases](https://github.com/JimmyDaddy/StatusOrbit/releases/latest) 下载适合当前系统的安装包。

- macOS 已完成真实设备验证；当前安装包尚未经过 Apple 公证，第一次打开时可能需要在“系统设置 → 隐私与安全性”中确认打开。
- Windows 与 Linux 安装包由对应系统的 GitHub Actions 构建，目前作为早期预览版本提供。
- `0.0.1` 是 StatusOrbit 的首个公开版本。遇到问题时，请在仓库的 Issues 中附上系统版本和复现步骤。

## 功能

### 概览

- “智能诊断”先告诉用户电脑是否正常，再显示可能变慢的原因、原始证据和相关应用
- 只有 CPU、内存、磁盘或网络问题持续一段时间时才提示，短暂波动不会被当成故障
- 把同一应用的相关进程合在一起，方便看出哪个应用最忙
- 实时展示 CPU、内存、交换空间、磁盘和网络吞吐
- 展示整机 CPU / 内存与磁盘读写的最近 5 分钟趋势
- 支持暂停、继续和立即刷新
- 刚启动时，网络和磁盘速度会显示“预热”，下一次刷新后出现正常数据

### 应用

- 平铺与父子树两种视图，支持虚拟滚动、搜索和排序
- 展示进程 CPU、内存、磁盘 I/O、状态、用户和运行时长
- 详情面板提供位置、启动命令、父进程与最近 5 分钟的资源变化
- 支持请求结束和强制结束进程；真正执行前会再次确认目标没有变化

### 存储

- 展示卷容量、已用比例、剩余空间与低空间告警
- 展示最近 5 分钟系统磁盘读写趋势和高 I/O 进程
- macOS 会合并显示属于同一 APFS 系统卷组的 `/` 与 Data 卷

### 清理

- 在独立页面扫描下载内容、废纸篓、常见缓存、开发缓存和隐藏文件夹，直到完成或用户主动停止
- 扫描时持续显示正在检查的位置、项目数量、找到的空间和已经用掉的时间
- 用可点击的扇形图显示空间去向；扇区越大，占用越多，可以进入文件夹继续查看
- 按住扇区并拖进清理篮，只会收集待处理项目，不会立即删除
- 扫描结果在本机保留 7 天；进入某个文件夹时只检查当前这一层是否变化，不会一直监听整个磁盘
- macOS 可以列出系统能够确认长期未打开的应用，但不会猜测未知使用时间，也不会自动卸载
- 永久删除前会再次显示名称、位置、大小和文件变化，并明确提示文件不会进入废纸篓
- 删除成功后，扇形图和清理篮会立即更新；失败的项目会保留并说明原因
- 扫描只读取文件名称、大小等信息，不读取文件内容，也不会沿着链接进入其他位置

### 网络

- 展示当前上传和下载速度、本次启动后的累计流量，以及每个网络接口的使用情况
- 低频刷新 TCP / UDP 活动连接，避免连接列表影响日常监控性能
- 支持按协议和状态筛选，并显示本地地址与远端地址
- 系统允许时显示连接所属应用，并可直接打开对应进程的详情

macOS 与 Linux 可能因系统权限只返回部分连接归属。

### 历史

- 每 5 分钟在本机保存一次 CPU、内存、磁盘和网络的整体状态
- 问题持续一段时间时记录提醒，恢复正常后也会留下记录
- 短暂尖峰和重复提醒会被过滤，事件可以按资源类型筛选
- 支持保留 1、7 或 30 天，并可随时停用写入或清除已保存记录
- 默认不保存应用名称；用户可以单独开启这一项，但命令行、用户、路径、文件名和连接地址仍不会写入历史
- 所有历史只留在当前设备，不会上传或同步

### 设置

- 支持切换界面语言、系统采样间隔与活动连接刷新间隔
- 支持配置 CPU、内存和卷占用百分比的颜色与告警阈值
- 支持选择默认进程视图和历史保留期；偏好只保存在当前设备
- 桌面提醒只针对持续问题，同一问题不会反复弹出，并设有每日数量上限；CPU、内存和磁盘提醒可以分别关闭

## 安全保护与平台限制

StatusOrbit 不会自动结束进程或删除文件。只有用户主动选择并确认后才会继续；如果进程已经退出，或文件在扫描后发生变化，应用会取消操作。

系统关键进程和 StatusOrbit 自身默认受保护。永久删除只允许处理用户主目录内的普通文件和文件夹，主目录、废纸篓本身、链接、特殊文件和其他磁盘都会被拒绝。

应用不会自动申请更高权限。macOS、Linux 和 Windows 会使用各自可用的系统接口，在操作前尽量确认目标仍然正确；系统无法安全确认时，操作会停止。

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

本地预览产品网站或只构建 GitHub Pages 静态文件：

```bash
pnpm site:dev
pnpm site:build
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
- `src/diagnosis.ts`：纯函数智能诊断规则与应用归因
- `src/cleanupMap.ts`：空间扇形图布局与下钻模型
- `src-tauri/src/cleanup.rs`：文件扫描、应用盘点、进度/取消、空间层级聚合与受保护的永久删除操作
- `src-tauri/src/monitor.rs`：系统资源与进程采样
- `src-tauri/src/network_connections.rs`：活动连接采集与解析
- `src-tauri/src/process_control.rs`：跨平台进程控制租约与执行
- `src-tauri/src/identity.rs`：跨平台进程启动标识读取
- `src-tauri/src/models.rs`：前后端数据契约
- `site/`：产品网站与网页版中英文使用指南
- `docs/user-guide.zh-CN.md`、`docs/user-guide.md`：仓库内中英文用户指南
- `scripts/build-site.mjs`：静态网站构建、品牌资产复制与本地链接校验
