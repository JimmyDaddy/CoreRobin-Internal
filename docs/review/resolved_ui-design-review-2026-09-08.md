# UI 控件一致性走查与 AI Markdown 修复

## 范围

- 仓库：CoreRobin-Internal，本轮不修改公开站点、不提交、不发布。
- 按用户要求修复 AI 对话 Markdown；其他控件先做走查与归因，不在本轮批量改版。
- 主导航 12 页：900×900、1440×900；设置 6 个分区、AI 设置；能力目录 19 个业务表单与 36 个工具表单：1180×900；AI 主窗及 400×540 Robin 小窗。
- 所有上述页面/表单均实际加载、采集控件 computed style 和截图。人工核看主导航、设置、AI 主窗/小窗及代表性业务/工具表单；未把全部自动截图等同于逐个控件所有状态的人工验收。
- 证据在 `.local-dev/ui-audit-2026-09-08/`，每页有同名 PNG/JSON；Markdown 在 `.local-dev/ai-validation/markdown-main.png`、`markdown-robin.png`。
- 采用 code-review-workflow 的范围、问题、验证和覆盖缺口结构。技能指定的 `docs/dev/code_standards.md` 与报告模板在本仓库不存在；基准为现有 `Button.tsx`、`App.css`、`surface-base.css` 及实际页面。

## 总结

确有一致性缺陷，不只是主观审美差异。现有共享按钮和颜色变量已经形成基本设计语言，但缺少跨窗口统一的基础控件层与可执行的尺寸/响应式约束，后续模块自行覆盖样式。

- 已修复：AI 回复被当作纯文本，`###`、`**`、列表符号直接展示。
- 未发现本轮新增 P0/P1；发现 2 项 P2 布局问题，以及 4 项 P3 控件/视觉一致性问题，均留待后续实现。
- 浏览器用例通过只表示加载/交互成立；下述重叠问题不会被“页面没有横向滚动条”检测发现。

## 详细问题

### UI-01 / P2：设置页按视口断点布局，控件在实际内容宽度下互相挤压

证据：`src/components/SettingsExplorer.css:5`、`:11`、`:93`；`src/App.css:1025`。

界面设置使用两列，每列内部仍要求至少 `120px + 200px + gap + padding`，直到整个视口小于 760px 才改一列。900px 窗口扣除侧栏和卡片边距后明显不足，语言选择器侵入相邻控件，模式按钮文字溢出。分段按钮还继承 16px 字体，与通用按钮 11px 不一致。

复现：专业模式 → 设置 → 界面与语言，900px；截图 `nav-900-11-Settings.png` / `settings-900-0.png`。

建议：根据容器宽度切换双列/单列；内部 label/control 允许换行，统一分段按钮字号、最小高度与长文案处理。增加控件 bounding box 不相交断言，而不只检测 document 横向溢出。

### UI-02 / P2：进程工具栏不随容器宽度重排，控制项被遮挡

证据：`src/components/ProcessTable.tsx:463`；`src/App.css:2995`、`:3008`、`:3015`。

外层 toolbar 可以换行，但内层 `process-heading` 仍把标题和所有 view controls 放在单个不换行 flex 行内。900px 主界面保留右侧 inspector 后，工具栏溢出标题区域，搜索框与按钮相互覆盖，部分排序/重置操作不可见。

复现：专业模式 → Processes，900px；截图 `nav-900-2-Processes.png`。同一组件在较宽表单中较正常，证明是容器适配问题。

建议：标题与工具行分开；工具行允许 wrap，次要操作收进明确的更多菜单；搜索框独立占行。按主页面窄栏与弹窗两种宿主验证。

### UI-03 / P3：AI 的后代选择器覆盖共享按钮与业务表单输入框

证据：`src/styles/ai.css:7`、`:29`、`:39`、`:112`；对照 `src/App.css:518`、`:613`；`src/capabilities/CapabilityFormCard.tsx:29`。

AI 层重新设置所有后代 `.button` 的字号、padding、边框和底色。`dangerGhost` 在主页面有危险色底和边框，在 AI 宿主下退化为红字；`.ai-assistant input:not([type="checkbox"])` 还把嵌入进程表的透明搜索输入框改成有 padding、边框的独立输入框。弹出的业务表单仍在 AI DOM 后代中，showModal 不隔离 CSS。

证据截图：`settings-900-4.png` 对照 `form-settings-privacy.png` 的 Clear category；`form-processes-control.png` 的嵌套搜索框。

建议：抽取主窗/Robin 都导入的基础控件 CSS；AI 只为自己的带类名输入框与尺寸变体设样式，禁止广泛覆写整个业务表单。表单以 portal 或明确的样式作用域边界隔离。

### UI-04 / P3：选择器与 checkbox 没有统一外观契约

证据：`src/App.css:949`、`:1475`；`src/styles/ai.css:112`；`src/toolbox/toolbox.css:51`、`:136`；`src/capabilities/ProcessTargetPicker.tsx:22`。

设置页选择器已有自定义箭头、`appearance:none` 与焦点描边；历史、AI 和工具页各写一套 native select，实测高度分别可见 34px、27px、36px，箭头和边距也不同。页面没有统一 color-scheme 声明，未选中原生 checkbox 在深色页仍是明亮白块。ProcessTargetPicker 甚至依赖宿主兜底样式。

证据截图：`nav-900-8-History.png`、`nav-900-10-AI-assistant.png`、`ai-settings-900.png`、`form-toolbox-base64.png`、`form-toolbox-qr-code.png`；JSON 中可查 appearance/height/font。

建议：保留原生 select 的键盘与辅助技术语义，封装统一的 Select/Checkbox 外观与 small/default 尺寸，统一 disabled/focus/invalid 状态。不应仅为外观手写可访问性不完整的下拉菜单。

### UI-05 / P3：能力卡片使用未定义 token，主次信息与警告颜色失效

证据：`src/capabilities/capabilities.css:4`、`:5`、`:8`、`:14`；`src/styles/surface-base.css:1`；`src/App.css:1`。

能力卡大量使用 `--muted`，源码没有对应定义；主窗虽然定义了 `--warning`，Robin 的 surface-base 没有这个别名。无 fallback 的 color 声明失效后会继承普通正文色，结果是时间戳/说明与正文层级混在一起，小窗的部分警告也不再使用预期警告色。

建议：以实际已有 `--text-muted` / `--amber` 等为准收敛命名；主窗与独立 WebView 从同一份 token 定义导入；加入 CSS var 未定义检查和窗口间 computed style 对比。

### UI-06 / P3：工具表单复用整页布局，造成悬空留白与过宽操作按钮

证据：`src/toolbox/toolbox.css:124`、`:130`；`src/capabilities/capabilities.css:41`；`src/toolbox/ToolOperation.tsx`。

工具详情整页用 164px 左边距给标题布局留空间；放入能力弹窗后标题已由弹窗 header 承担，表单仍保留该左边距，出现输入区域整体右移、左侧大块空白。部分简单转换按钮是 grid 的直接子项，被拉成整行，其他工具则是紧凑按钮，主操作尺寸并无一致规则。

证据截图：`form-toolbox-json.png`、`form-toolbox-color.png`、`form-toolbox-regex.png`、`form-toolbox-time.png`。

建议：区分 full-page / embedded 两个布局变体，表单不再继承整页标题 gutter；操作行使用统一布局，只有确需全宽时显式声明。

## 页面走查索引

| 页面 | 当前结论 |
| --- | --- |
| Overview | 共用设计语言正常；窄栏信息密度高，部分指标截断，不在本轮改布局 |
| Apps | 主操作/搜索/分段控件可见；继承字号与模块字号仍需统一 |
| Processes | UI-02，优先修复 |
| Storage | 主按钮正常；窄栏指标截断，应随容器调整 |
| Quick Cleanup | 功能按钮可见；次级入口与主按钮都使用强蓝，建议明确层级 |
| Disk Scan | 选择卡和操作视觉基本一致；未执行真实扫描/删除 |
| Network | 开关、原生 checkbox 与其他页面不同，归入 UI-04 |
| Startup | 控制项可见，未发现独立阻塞问题 |
| History | 保留周期 select 与设置页不同，归入 UI-04 |
| Toolbox | 工具入口加载正常；工具表单归入 UI-04/UI-06 |
| AI assistant | Markdown 已修；UI-03/UI-04/UI-05 留待收敛 |
| Settings | general 有 UI-01；其余分区主要是字体/控件变体分叉 |

能力表单遍历范围来自 `BUSINESS_FORM_IDS` 与 `TOOLBOX_TOOL_IDS`，不是人工维护的子集：

- 业务 19 项：进程占用/控制、网络质量/连接、设备状态/GPU 能耗、存储扫描/清理/卷/推出/文件洞察/快速清理、应用活动/管理、启动项、历史记录/导出、诊断事件、隐私设置。
- 系统与网络工具 8 项：keep-awake、process-watch、file-occupancy、volume-occupancy、keyboard-cleaning、schedules、network-addresses、ifconfig-parser。
- 文本与开发工具 11 项：json、url、base64、uuid、text-sha256、file-sha256、time、regex、color、color-picker、qr-code。
- 图片/证明工具 11 项：image-editor、image-watermark、image-batch-watermark、image-recipe、confidential-watermark、invisible-watermark-write、invisible-watermark-check、recipient-tracking、robustness-lab、integrity-manifest、c2pa-inspector。
- 文件/补丁工具 6 项：binary-patch-create、binary-patch-apply、binary-patch-inspector、patch-planner、transfer-savings、patch-errors。

## Markdown 修复执行记录

- 新增 `AiMarkdown.tsx` / CSS；仅渲染 assistant 文本，用户输入仍按原文显示。
- 使用 [Marked lexer](https://github.com/markedjs/marked/blob/master/docs/USING_PRO.md) 生成 token，再映射为受限 React 元素；不使用原始 HTML 注入。
- 支持标题、粗体/斜体/删除线、嵌套列表、只读任务列表、引用、分隔线、行内/围栏代码、GFM 表格、实体与流式未闭合语法。
- 原始 HTML 显示为文本；模型图片只显示替代文字，链接仅显示不可导航文字，不触发下载、外部请求或原生操作。
- 长代码/表格局部滚动；渲染器及 CSS 懒加载，不放宽各窗口首屏预算。总包体成本记录于 `docs/webview-bundle-performance.md`。

## 已执行验证

- 全量 Vitest：162 个文件 / 857 个测试通过；lint、typecheck、production build 与 WebView bundle gate 均通过。
- AI 浏览器回归 12 项通过，含主窗/Robin Markdown、无模型图片请求、长行不撑宽页面、草稿/预览/IME/确认流程。
- 主导航与设置逐页走查 2 项通过；55 个能力表单遍历及 JSON 跨入口状态保留 2 项通过。
- 控件本轮只诊断，没有将 UI-01～UI-06 标记为已修复。

## 测试覆盖缺口

- 浏览器 demo/模拟 AI 回执，不是系统副作用、真实模型、macOS WebKit 或 Windows/Linux 原生控件菜单验收。
- 自动采集覆盖各页初始态；隐藏高级选项、所有错误/空态、每种语言、放大字号和所有滚动区内容未穷尽。
- 当前截图走查用于产生证据，并非新建的统一设计规范门禁。下一轮应增加 token 完整性、嵌入宿主样式隔离、控件不相交和键盘焦点测试。

## 建议实施顺序

1. 先修 UI-01/UI-02，保证现有窄窗口可用。
2. 抽取共享 token 与 Button/Select/Checkbox/SegmentedControl 基础层；主窗和 Robin 同源导入。
3. 收紧 AI 选择器作用域，添加工具表单 embedded 布局，统一按钮主次层级。
4. 最后逐页替换并重新执行相同宽度、长文案、焦点/禁用态截图验收，不整站另起一套风格。

## 复核结论（2026-09-09）

用户后续授权“走查的问题一一修复掉”。UI-01～UI-06 全部认可并实施；上文为修复前记录，保留不改写。本轮仍只修改 Internal 工作区，不提交、不发布、不操作真实清理功能。

## 修复执行记录（2026-09-09）

| 条目 | 状态 | 实施与验证 |
| --- | --- | --- |
| UI-01 | 已完成 | `SettingsExplorer.css` 按内容宽度自动分列，内部标签/控件允许换行；`App.css` 统一分段控件字号。900px 英文、德文、中文大字号及 1440px 英文均通过边界/不相交断言。 |
| UI-02 | 已完成 | `App.css` 中进程搜索独立占行，标题和控制组允许换行，保留全部 7 个现有操作；相同宽度/语言组合验证控件可见、不互相遮挡。 |
| UI-03 | 已完成 | `CapabilityFormCard.tsx` 使用 body portal；AI 输入仅由 `.ai-input` 管理，删除宿主广泛覆盖。验证透明进程搜索、危险按钮底色、关闭弹窗后焦点恢复。 |
| UI-04 | 已完成 | 新建 `Select.tsx` 和 `styles/controls.css`，迁移产品 native select，统一默认 36px/紧凑 30px、箭头、焦点与禁用态；深色原生 checkbox 保留键盘语义，明确排除 switch，避免双滑块。单元测试覆盖 ref、原生校验及 disabled，浏览器验证焦点、键盘 checkbox 和独立 switch 外观。 |
| UI-05 | 已完成 | 主窗/Robin 共用 `styles/tokens.css`；能力卡片使用已定义的 `--text-muted` / `--amber`。静态契约测试检查能力样式 token，浏览器比较两窗口实际颜色。 |
| UI-06 | 已完成 | 弹窗 body 明确 embedded 布局，去除整页 gutter，工具按钮默认紧凑对齐。验证 JSON 表单无左侧留白且按钮不铺满；快速清理次级入口同步使用 secondary 层级。 |

共享控件契约记录在 `docs/ui-controls.md`。基础控件样式通过公共组件/入口导入并去重，不在各窗口复制一套。全 CSS 实测 503,769 字节，Robin 首屏 CSS 16,436 字节（gzip 4,623）；预算调整与测量依据记录在 `docs/webview-bundle-performance.md`。

### 已完成验证

- `pnpm verify:web-bundle`、`pnpm typecheck`、`pnpm lint`、`pnpm test` 全部通过；Vitest 为 164 文件 / 862 测试。
- `CORE_ROBIN_PLAYWRIGHT_CHANNEL=chrome pnpm test:visual tests/visual/ui-controls.visual.spec.ts tests/visual/ui-audit.visual.spec.ts tests/visual/ai.visual.spec.ts tests/visual/capabilities.visual.spec.ts`：23/23 通过，覆盖新增 7 项控件契约、12 项 AI 回归、主导航/设置走查，以及全部 55 个能力表单与 JSON 跨入口状态保留。
- 修复后 PNG/JSON 采集在 `.local-dev/ui-audit-2026-09-08-fixed/`；人工核看设置、进程、隐私表单、JSON 表单等代表性结果。此前走查目录曾在复跑时重新生成，不应将其视为不可变的修复前截图档案。
- `git diff --check` 通过；没有修改既有截图基线。

### 独立的旧截图验收限制

`CORE_ROBIN_PLAYWRIGHT_CHANNEL=chrome pnpm test:visual tests/visual/app.visual.spec.ts`：19/24 通过，5 项截图断言未通过。2 项扫描范围截图高度为 447px、基线 442px；3 项清理动画存在文字/描边/按钮区域像素差异。动画交互、减少动画和清理回执流程均通过。

只读对照实验中，在当前页面覆盖 `HEAD:src/App.css` 前后，900px 扫描区域高度均为 446.140625px（截图取整 447px）；这只能排除该共享样式文件变化是高度差异的直接解释，不等于完整旧版本复跑。动画差异也不能仅凭截图一律归因于平台：共享按钮尺寸本轮有意统一，字体与渲染环境亦可能影响结果。当前 macOS Chrome 并非已复核的基线生成环境，Docker 只读探测未响应，已结束探测客户端，未更改 Docker 状态。

因此六项报告修复及强制质量门禁已完成，但全套像素基线尚未通过，仍需在基线生成环境复核这 5 项后决定是否更新；未通过放宽阈值或覆盖 PNG 消除差异。真实模型、系统副作用及各平台原生下拉菜单不在本次浏览器验收范围内。
