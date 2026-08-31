# WebView 资源拆分验证

记录日期：2026-07-15  
基线提交：`1dce0ba`  
测试环境：Apple Silicon macOS、Chrome headless、Vite 7.3.6、production build

## 构建产物

基线只有一个 HTML 入口。每个辅助 WebView 都先加载约 364.32 KB 的公共 JS、214.69 KB 的公共 CSS 和 286.53 KB 的 1254×1254 品牌图，再动态加载 surface 组件。

拆分后，各入口的初始静态依赖如下。大小为 Vite 输出的压缩前文件大小，重复 import 只计一次；动态路由 chunk 不计入初始入口。

| surface | 初始 JS | CSS | 品牌图 | 说明 |
| --- | ---: | ---: | ---: | --- |
| main | 约 497.75 KB | 195.63 KB | 286.53 KB | 保留完整应用、完整翻译与主品牌图 |
| splash | 约 7.52 KB | 5.44 KB | 30.91 KB | 原生 DOM 入口，不加载 React、主翻译或主 CSS |
| tray | 约 221.30 KB | 5.38 KB | 11.86 KB | 只加载 React 运行时、托盘翻译与样式 |
| companion | 约 223.05 KB | 13.01 KB | 无 | 只加载 React 运行时、伙伴翻译与样式 |

全部 JS 产物由 675,426 bytes 增至 677,484 bytes（+0.3%）；全部 CSS 产物由 214,691 bytes 增至 219,455 bytes（+2.2%）。增加部分来自三个可独立加载的辅助样式基线；拆分的验收依据是辅助 WebView 的实际资源和内存下降，而不是只把主入口文件改小。

## 行为 smoke

分别独立打开 `index.html`、`splash.html`、`tray.html` 和 `companion.html`，写入英文、large 界面比例和 reduce-motion 设置后重新加载：

- 四个入口的 `lang` 均为 `en`；
- 四个入口的 `data-interface-scale` 均为 `large`；
- 四个入口的 `data-reduce-motion` 均为 `true`；
- splash、tray、companion 均显示各自英文文案；
- 四个入口均未产生 page error。

## JS heap 快照

每个 surface 使用独立浏览器 context，production build 加载完成后触发 GC，再通过 Chrome Performance metrics 读取 `JSHeapUsedSize`。该数据只反映 JS heap，不包含 WebView 原生开销、CSS 内存和图片解码内存。

| surface | 基线 | 拆分后 | 变化 |
| --- | ---: | ---: | ---: |
| main | 1.94 MiB | 1.92 MiB | -1% |
| splash | 1.67 MiB | 0.75 MiB | -55% |
| tray | 1.89 MiB | 1.73 MiB | -8% |
| companion | 1.75 MiB | 1.38 MiB | -21% |

此外，三个辅助 WebView 不再加载 1254×1254 主品牌图；该图完全解码时每个 WebView 约需 6 MiB RGBA 像素内存。splash 改用 256×256 图，tray 改用 128×128 图，companion 不加载位图。

以上快照用于发现回归，不作为跨机器的绝对内存承诺。

## 持续门禁

当前 production 构建不再依赖手工抄录上述历史数字。`pnpm verify:web-bundle` 会从
`dist/.vite/manifest.json` 递归计算四个入口的初始 JS/CSS 原始与 gzip 字节数，同时检查
Tauri 窗口到 HTML 的映射。预算保存在 `scripts/web-bundle-budgets.json`，CI 和 Release
都会执行；动态 chunks 的原始字节总量也有独立上限。

2026-07-28 的数据可信度迭代加入隐私中心分类回执、文件洞察增量复核和网络质量
1/24 小时聚合历史后，全部 production JS chunks 为 1,902,019 bytes。总量预算从
1,900,000 调整为 1,920,000 bytes；20 KB 增量覆盖这些可按需加载的行为与多语言文案，
四个入口各自的初始加载预算没有放宽。

2026-07-28 的历史归因与处理闭环迭代增加应用级聚合历史、启动影响回执、网络事件、
扫描目标、磁盘健康、引导式反馈和 Windows/Linux 原生卸载。全部 production chunks
实测为 2,021,710 bytes JS 与 338,425 bytes CSS，总量预算对应调整为 2,040,000 与
345,000 bytes。新增网络、历史、启动和存储样式已拆为按页面加载的 CSS chunks，主入口
CSS gzip 仍保持在原有 40,000 bytes 上限内；四个入口的初始加载预算均未放宽。

2026-08-29 的磁盘扫描结果交互迭代增加空间图悬浮摘要、响应式选中态、结果列表下钻、
可回收分类筛选和折叠式扫描设置。全部 production chunks 实测为 2,406,568 bytes JS 与
400,209 bytes CSS，总量预算对应调整为 2,420,000 与 405,000 bytes；四个入口各自的
初始加载预算保持不变。

2026-08-31 的扫描列表与清理篮反馈迭代增加文件抛入/碎片消散 SVG/CSS 动画、结算回执、
实际可用空间变化与十种语言文案。全部 production chunks 实测约为 2,431 KB JS 与
419 KB CSS；总量预算对应调整为 2,450,000 与 425,000 bytes，四个入口的初始加载预算
不变。没有新增动画依赖；视觉预览夹具不进入生产构建，减少动态效果时不运行处理与结算动画。

这些字节预算用于拦截确定性的资源膨胀。真实 WebView 原生内存、冷启动和整机能耗仍按
[发布冒烟与性能门禁](release-smoke-and-performance.md) 在固定设备保存证据，不能用 CI
wall-clock 数字替代。
