# 清理扫描 benchmark

这个 benchmark 只扫描命令行显式传入的目录。它不会默认使用用户主目录或系统盘，也不会作为 `cargo test`、`pnpm test` 或应用启动流程的一部分运行。

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
4. 同时记录 `child_watchdog_*`、索引刷新取消测试和 `indexed_child_queries_stay_below_the_interaction_budget`，覆盖卡死 child、事务性刷新与无文件系统访问的目录查询；`node_budget_preserves_totals_without_persisting_the_whole_tree`、`large_flat_directories_keep_only_the_largest_visible_files` 约束超大目录的索引容量与聚合结果准确性，`directory_refresh_reclaims_unrelated_details_as_a_loadable_summary` 约束按需载入只能替换工作集且被折叠目录仍可再次展开。
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
