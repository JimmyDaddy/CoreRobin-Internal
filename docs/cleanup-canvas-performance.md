# 清理空间图 collected overlay 性能记录

## 实现

- collected 与 restricted 的斜线纹理由重复 stroke 循环改为透明 `CanvasPattern` tile。
- pattern 按 2D context、主题键、颜色、间距、线宽和 device pixel ratio 缓存；高 DPR tile 通过 pattern transform 保持逻辑间距。
- collected overlay 独立绘制到透明高 DPR layer；当 arc 几何、collected 集合、尺寸、主题和 DPR 未变化时，选择或 hover 重绘直接复用该 layer。
- 基础扇区、collected layer、changed/selected 状态分层绘制，颜色、边界和交互语义不变。

## 2026-07-15 首轮浏览器 profile

环境：macOS 26.3 (25D125)、Mac15,6、18 GiB RAM，本地 Vite 实际浏览器 Canvas 路径；fixture 为 640 个 arcs 且全部 collected。计数来自浏览器中对 Canvas 2D `stroke`、`fill`、`fillRect`、`drawImage` 的调用观测。

| 场景 | DPR / 背景 / motion | elapsed | stroke | drawImage |
| --- | --- | ---: | ---: | ---: |
| 初次绘制 | 1 / dark / normal | 10.3 ms | 1,282 | 1 |
| 仅选择变化 | 1 / dark / normal | 16.6 ms（含帧等待） | 641 | 1 |
| 240 ms focus 动画 | 1 / dark / normal | 308.3 ms（含 300 ms 等待） | 36,480 | 57 |
| 初次绘制 | 2 / light / normal | 13.2 ms | 1,282 | 1 |
| focus 变化 | 1 / dark / reduced | 16.6 ms（含帧等待） | 640 | 1 |

旧实现最坏情况下仅 collected hatch 就约有 `640 × 115 = 73,600` 次 stroke，尚未计入基础扇区和边界；新实现的初次绘制总 stroke 为 1,282，且选择变化不会重建 collected layer。动画仍会重画前后两组基础 arcs，但每帧只各合成一次缓存 layer，不再执行 hatch 内层循环。

另外用 16 个宽扇区分别检查了 DPR 1/2、深色/浅色背景和 reduce-motion 截图：斜线纹理、collected 红色边界、扇区底色及选中状态均可辨识，浏览器控制台无 warning/error。

elapsed 包含浏览器帧调度或显式动画等待，不能当作纯绘图 CPU 时间，也不足以自行确定 D10 的最终跨机器 p95 发布阈值。稳定的自动化门禁使用操作次数和 layer 复用断言，避免把机器负载差异写成易抖动的时间断言。
