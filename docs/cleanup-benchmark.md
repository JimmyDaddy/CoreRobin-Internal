# 清理扫描 benchmark

这个 benchmark 只扫描命令行显式传入的目录。它不会默认使用用户主目录或系统盘，也不会作为 `cargo test`、`pnpm test` 或应用启动流程的一部分运行。

原有 `scan` / `cancel` 命令测量内存遍历器 `scan_filesystem`，不包含产品的 SQLite 建索引和结果交付。产品链路的测量使用下文的独立 worker benchmark，不能用这里的遍历耗时代替实际空间地图耗时。

## 固定 fixture

以下命令创建 100,000 个一字节文件、1,000 个分桶目录和一棵 128 层深目录。目标目录必须不存在或为空，工具不会清理或覆盖已有内容。

```bash
cargo run --manifest-path src-tauri/Cargo.toml --example cleanup-benchmark -- \
  create-fixture .local-dev/benchmarks/cleanup-fixture-100k 100000
```

运行扫描：

```bash
cargo run --manifest-path src-tauri/Cargo.toml --release --example cleanup-benchmark -- \
  scan .local-dev/benchmarks/cleanup-fixture-100k
```

运行取消延迟测试；下面的 `100` 表示扫描开始 100 ms 后请求取消：

```bash
cargo run --manifest-path src-tauri/Cargo.toml --release --example cleanup-benchmark -- \
  cancel .local-dev/benchmarks/cleanup-fixture-100k 100
```

输出为 JSON，包含 wall time、user/system CPU time、进程峰值 RSS、进程读取字节、扫描条目、不可读条目和发现的 allocated bytes。macOS 资源数据来自当前进程的 `proc_pid_rusage`/`getrusage`；其他平台暂以 `null` 明确表示不可用，不用估算值代替实测。

## 可复现协议

1. 固定机器、卷、供电模式和 Full Disk Access 状态；记录 OS、硬件、CoreRobin commit、DaisyDisk 版本及 fixture 条目数。
2. 冷态数据必须在重启后首次运行，不能把 `purge` 或手工删缓存冒充重启冷态。
3. 热态连续运行至少 3 次，记录原始 JSON，并以中位数比较。
4. 同时记录 `child_watchdog_*`、索引刷新取消测试和 `indexed_child_queries_stay_below_the_interaction_budget`，覆盖卡死 child、事务性刷新与无文件系统访问的目录查询；`file_detail_budget_never_truncates_the_directory_tree`、`large_flat_directories_keep_only_the_largest_visible_files` 约束文件明细预算不能截断目录树且聚合结果保持准确，`directory_refresh_preserves_unrelated_directory_details` 约束主动刷新只能替换目标子树，不能移除其他目录的导航详情。
5. 内部目录遍历取消目标为 2 秒内返回，外部 child 取消目标为 5 秒内返回；索引目录查询 P95 必须低于 150 ms。
6. 只有同机同 fixture 的基线和修复后数据都存在时，才判断“回退是否超过 10%”；没有基线时只记录当前值，不能宣称已满足相对阈值。

## 记录模板

| 项目 | 值 |
| --- | --- |
| 日期 / commit |  |
| macOS / 硬件 / 卷 |  |
| Full Disk Access |  |
| DaisyDisk 版本 |  |
| fixture 条目数 | 100000 + 128 层目录 |
| 冷态原始 JSON |  |
| 热态 1 / 2 / 3 原始 JSON |  |
| 热态耗时中位数 |  |
| 取消延迟 |  |
| child watchdog |  |
| 索引目录查询 P95 | < 150 ms（自动化测试断言） |
| 结论 / D9、D10 复核 |  |

## 2026-07-15 首轮记录

| 项目 | 值 |
| --- | --- |
| 源码状态 | `b6fdc2d` 之后的 WP-6 工作树 |
| 系统 / 硬件 | macOS 26.3 (25D125), Mac15,6, 18 GiB RAM |
| 卷 | `/dev/disk3s5`, APFS Data volume, 926 GiB |
| Full Disk Access | 固定仓库 fixture 不需要；未把该结果冒充系统盘结果 |
| DaisyDisk | 本机 4.24；本轮没有用 GUI 扫描该 fixture，未做竞品耗时声明 |
| fixture | 101,130 个实际扫描条目，0 个不可读条目，409,604,096 allocated bytes |
| 热态 1 | 315 ms wall；91 ms user；224 ms system；9,551,872 peak RSS；0 read bytes |
| 热态 2 | 272 ms wall；86 ms user；185 ms system；9,502,720 peak RSS；0 read bytes |
| 热态 3 | 256 ms wall；79 ms user；177 ms system；9,404,416 peak RSS；0 read bytes |
| 热态耗时中位数 | 272 ms |
| 100 ms 后取消 | 0 ms（毫秒粒度）；worker 返回 `cleanup_scan_cancelled` |
| child watchdog | deadline 与 4 MiB 输出上限自动化测试通过 |
| 索引目录查询 | 当时尚未建立原生目录索引；此项不适用于首轮记录 |

这组数据足以验证当时 10 万级 fixture 的可重复入口和取消门槛。它没有修复前同机基线、重启后冷态或 DaisyDisk 同 fixture 数据，因此不能据此宣称“相对修复前回退不超过 10%”或“达到竞品完整扫描速度”。现在的产品扫描另提供“常用位置快速扫描”，完整扫描仍保持精确遍历；扫描完成后的目录导航由 SQLite 索引查询覆盖，不再用 subtree 重扫指标衡量。

## 产品 worker 链路：2026-10-26

### 实现与边界

- 准备、扫描和整理分别检查实际工作进展。SQLite VM 的工作通知与独立进程心跳分开；准备/整理连续 120 秒没有工作、worker 连续 30 秒没有回应会产生明确失败与私有诊断。watchdog 自身经历休眠后重新开始观察，避免把休眠时间当作卡死。目录恢复最多 32 次。
- 旧索引删除、硬链接恢复记录回收、旧代际退休和压缩在结果交付后执行。替换或取消任务只写入轻量退休标记，避免在桌面进程内同步清理大型 SQLite 索引；下一次空闲 worker 维护负责回收。
- 新完整扫描使用持久目录队列，在目录边界累计最多 64 个目录或约 100 ms 后提交一次。节点、待处理队列、硬链接身份、聚合值与统计计数在同一事务中提交；恢复只重做未提交的目录批次。单个超大平铺目录仍需完成该目录的枚举，这是当前断点粒度的边界。
- 已提交批次可以读取一致的只读 WAL 快照；部分地图不会进入历史增长统计，也不能取得索引删除授权。扫描期间保留地图；失败优先恢复上一份完整地图。前端每两秒最多读取一次新增进度，地图在完成后丢弃预览分支缓存。
- 目录刷新复用目录队列，在暂存代际完成后原子替换指定子树；其他目录仍使用原来的索引。快速扫描保留既有 SSD 最多 4 个、其他磁盘 1 个的并发策略，恢复时复用同任务已完成分片，并核对分片对应的目标路径及硬链接身份。不同扫描任务不复用未经验证的旧文件树；当前没有增加自动文件系统监听式增量扫描。
- 索引压力按有效页计算，空闲页单独用于维护。运行中的硬链接恢复身份一直保留到提交完成，不再因数据库物理大小偏大而反复删除；热点 SQL 复用预编译语句，已读取的文件元数据用于大文件统计。

### 命令

```bash
cargo build --manifest-path src-tauri/Cargo.toml --locked --bin core-robin --example cleanup-benchmark
# 默认 1000 个分桶目录；也可明确传入目录数测试目录密集场景。
src-tauri/target/debug/examples/cleanup-benchmark create-fixture FIXTURE_ROOT 100000 1000
node scripts/benchmark-cleanup-worker.mjs src-tauri/target/debug/core-robin FIXTURE_ROOT
```

`FIXTURE_ROOT` 必须不存在或为空；工具不会清理既有内容。worker benchmark 在独立临时目录创建请求、索引和结果，退出后删除这些临时数据，保留用户显式指定的 fixture。它不访问应用正式索引。Windows 使用相应 `.exe` 路径。

测量从子进程启动开始，记录首条进度、首个已提交检查点、最终结果文件交付、进程结束和最长无实际工作间隔。`firstCheckpointMs` 代表后端可查询已提交目录的时刻，不等于浏览器绘制完成；浏览器交互由 `cleanup-progressive.visual.spec.ts` 独立覆盖。

### 同机热态记录

macOS 26.3 (25D125)，Mac15,6，18 GiB RAM，APFS。基线为 `dadefdb`，优化后为 `4464e89`；两者均用 Rust 1.95.0、同一锁文件依赖和默认 debug profile 构建。先完成 fixture 创建和编译，再交替执行三组；每次使用全新临时索引。以下是本机观测，不是 release 包速度承诺，也不是重启后的冷态基准。

| 10 万文件、1000 个分桶目录 | 基线 | 优化后 |
| --- | --- | --- |
| 最终结果，第 1 次 | 6219.95 ms | 3924.46 ms |
| 最终结果，第 2 次 | 4485.62 ms | 4143.08 ms |
| 最终结果，第 3 次 | 4623.28 ms | 3909.69 ms |
| 最终结果中位数 | 4623.28 ms | 3924.46 ms |
| 首个已提交检查点中位数 | 无渐进结果 | 119.20 ms |
| 最终索引文件 | 14,946,304 bytes | 14,696,448 bytes |
| allocated bytes | 409,604,096 | 409,604,096 |
| 不可读条目 | 0 | 0 |

该 fixture 最终结果中位数缩短约 15.1%。优化后新增根目录枚举统计，因此条目数为 101,130，基线为 100,129；差异是根目录下的 1000 个分桶目录及 `deep`，两者文件数和 allocated bytes 相同。

目录密集 fixture 使用 100,000 个分桶目录，每目录一个文件，另有相同的 128 层目录。单次补充观测：基线最终结果 30,093.96 ms，优化后 27,260.51 ms；首个检查点 6861.25 ms；索引分别为 54,771,712 和 44,695,552 bytes。allocated bytes 都为 409,604,096、不可读条目为 0。这组只有一次，不用于中位数或普遍性能结论。

本轮没有重扫用户 907 万条目的系统盘，也未做冷态、低空间故障注入或其他硬件性能承诺。已覆盖目录批次取消/恢复、只读预览、硬链接去重、分片恢复、目标子树刷新、失败回退，以及真实子进程检查点先于最终结果交付。
