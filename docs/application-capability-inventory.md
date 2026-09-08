# 应用能力卡片接入清单

状态：2026-09-08，清单中的 19 项业务能力和 36 项工具均已接入；验证范围与限制见文末。

依据：`src/appNavigation.ts` 的功能入口、对应组件实际调用、`src/api.ts` 的原生接口、`src/toolbox/registry.ts` 的 36 项工具以及 `src/toolbox/contracts.ts` 的任务／文件令牌协议。只登记真实实现；同一业务能力在日常模式、专业模式和 Robin 中不重复实现。

## 统一验收规则

每项按“业务结果类型 → 能力调用 → 可嵌入操作组件 → 原页面共用 → 对话卡片 → 共享结果更新 → 验证”推进。仅有跳转入口或漂亮卡片不算完成。

- `read`：读取已有数据，不擅自开启记录。
- `run`：有副作用边界的检查／计算任务，支持进度、取消和真实结果。
- `form`：需要用户参数、文件选择或素材；模型可以打开表单；文本计算可回填显式提供的输入和计算结果，其余参数由用户填写。执行条件仍由原生／固定本地模块校验。
- `confirm`：改动系统、启动项、进程或文件，先展示精确目标及影响，再显式确认。
- `secret`：凭据、隐形水印密钥等仅由用户在本地填写，不进入模型上下文和对话记录。
- 完成任务必须更新该功能原来的业务数据源。页面和卡片订阅同一份结果，不维护 AI 专用业务结果副本。
- 对话历史保留当时快照，操作使用当前身份、版本与租约；跨会话、过期、重启、取消、清除和重复请求都不能复用旧授权。
- 保留系统现有能力检测与禁用原因；不借卡片自动提权。键盘清洁、永久删除、原生卸载和敏感设置不得仅凭模型调用直接执行。

## 业务功能

| ID | 对应页面／现有模块 | 数据与可复用组件 | 卡片操作 | 状态 |
| --- | --- | --- | --- | --- |
| device.status | DailyHome / DeviceWellbeing / SamplerService | SystemSnapshot；指标／设备健康摘要 | read；刷新；查看睡眠阻止者 | 已接入；共用组件／浏览器展示通过；原生验证见文末 |
| device.gpu_energy | GpuEnergyPanel | GpuEnergySnapshot；采样能力／局限提示 | read/run；刷新 | 已接入；共用组件／浏览器展示通过；原生验证见文末 |
| processes.usage | ProcessTable / ProcessInspector | ProcessRow / ProcessDetail；指标与操作按钮 | read/run；排序、查看详情、刷新 | 已接入；共用组件／浏览器展示通过；原生验证见文末 |
| processes.control | ConfirmActionDialog / ProcessController | ProcessKey / ProcessControlLease / ProcessActionResult | confirm；请求关闭、强制结束；重启需保留原有检查 | 已接入；共用组件／浏览器展示通过；原生验证见文末 |
| network.quality | NetworkExplorer / useNetworkQualityMonitor | NetworkQualityResult；检查分项／质量摘要 | run；重新检查、展开失败原因 | 已接入；共用组件／浏览器展示通过；原生验证见文末 |
| network.connections | NetworkExplorer / ConnectionHistory | NetworkConnectionsSnapshot；连接列表／关联进程 | read/run；刷新、过滤、查看关联进程 | 已接入；共用组件／浏览器展示通过；原生验证见文末 |
| storage.volumes | StorageExplorer / StorageHealth | DiskSnapshot / StorageHealthSnapshot | read/run；卷详情、健康检查、磁盘工具 | 已接入；共用组件／浏览器展示通过；原生验证见文末 |
| storage.scan | CleanupAssistant / CleanupSpaceMap / CleanupScanJobManager | CleanupScan / 扫描索引；目录、列表、选择 | run；常用位置／用户选择范围扫描、取消、目录刷新 | 已接入；共用组件／浏览器展示通过；原生验证见文末 |
| storage.cleanup | CleanupDeleteDialog / CleanupDeleteController | CleanupDeleteLease / CleanupDeleteResult；项目摘要、选择、确认、进度 | confirm；移到废纸篓；永久删除不开放模型执行 | 已接入；共用组件／浏览器展示通过；原生验证见文末 |
| storage.quick_clean | QuickCleanupPage / QuickCleanCoordinator | QuickCleanCategorySummary / QuickCleanResult | run 分析；form 类别选择；confirm 清理；取消 | 已接入；共用组件／浏览器展示通过；原生验证见文末 |
| storage.file_insights | FileInsightsExplorer / useFileInsightsScan | FileInsightsScan；重复组、保留项、旧文件选择 | run 扫描；form 保留／删除选择；confirm 处理 | 已接入；共用组件／浏览器展示通过；原生验证见文末 |
| storage.eject | StorageExplorer / OccupancyTool | 原生卷身份与推出确认 | run 占用检查；confirm 推出 | 已接入；共用组件／浏览器展示通过；原生验证见文末 |
| applications.activity | ApplicationCenter / ApplicationImpactPanel | 应用分组、关联进程、活动历史 | read；筛选、查看占用／历史／关联项 | 已接入；共用组件／浏览器展示通过；原生验证见文末 |
| applications.manage | ApplicationUninstallAssistant | ApplicationInventorySnapshot / ApplicationUninstallPlan | run 扫描；form 选择应用及残留；confirm 卸载／清理 | 已接入；共用组件／浏览器展示通过；原生验证见文末 |
| startup.manage | StartupExplorer / StartupActionDialog / StartupController | StartupItemsSnapshot / StartupManagementLease / 验证回执 | read/run；confirm 启用／停用；刷新、撤销草案 | 已接入；共用组件／浏览器展示通过；原生验证见文末 |
| history.records | HistoryExplorer / DailyRecords / 本地历史库 | 资源、告警、应用影响、操作记录与覆盖范围 | read；时间范围、筛选、刷新 | 已接入；共用组件／浏览器展示通过；原生验证见文末 |
| history.export | HistoryExportPanel | HistoryExportSources / 导出预览 | form 时间与指标；用户确认应用名范围及保存位置 | 已接入；共用组件／浏览器展示通过；原生验证见文末 |
| diagnosis.incidents | SmartDiagnosis / DailyGuide / PersonalBaselinePanel | 原生采样与既有诊断、事件／基线 | read；查看证据、复查、选择原生处理 | 已接入；共用组件／浏览器展示通过；原生验证见文末 |
| settings.privacy | SettingsExplorer / SourceDataClearAction | 记录开关、保留范围、产品数据摘要 | form/confirm；展示与用户修改，不允许模型静默切换 | 已接入；共用组件／浏览器展示通过；原生验证见文末 |

## 工具箱逐项清单

工具箱已经有共享的 session/job/generation/resetEpoch 和文件 input/output token 协议，必须复用，不能为对话另建一套文件路径或输出缓存。纯文本工具复用现有固定计算函数；交互组件从 ToolContent 等页面布局中提取，页面与卡片使用同一个实现。

| ID | 能力 | 复用实现 | 调用／操作边界 | 状态 |
| --- | --- | --- | --- | --- |
| toolbox.keep-awake | 限时保活 | KeepAwakeTool / PowerService | form 有界期限；run 启动／停止／验证释放 | 已接入；共用组件／浏览器展示通过；原生验证见文末 |
| toolbox.process-watch | 进程退出提醒 | ProcessWatchTool / ProcessWatchService | form 原生进程身份与期限；run 启动／取消 | 已接入；共用组件／浏览器展示通过；原生验证见文末 |
| toolbox.file-occupancy | 文件使用者 | OccupancyTool / 原生占用检查 | form 用户选文件／卷；run 检查／取消；推出需 confirm | 已接入；共用组件／浏览器展示通过；原生验证见文末 |
| toolbox.volume-occupancy | 外盘使用者 | OccupancyTool / 原生占用检查 | form 用户选文件／卷；run 检查／取消；推出需 confirm | 已接入；共用组件／浏览器展示通过；原生验证见文末 |
| toolbox.keyboard-cleaning | 键盘清洁 | KeyboardCleaningTool / 受限 helper | form 用户明确启动与期限；run 紧急停止；不得由模型自动锁键盘 | 已接入；共用组件／浏览器展示通过；原生验证见文末 |
| toolbox.schedules | 定时任务 | ScheduleTool / ToolboxScheduler | read 规则；form 预览；confirm 创建／修改／删除；仅提醒与限时保活 | 已接入；共用组件／浏览器展示通过；原生验证见文末 |
| toolbox.network-addresses | 本机地址 | NetworkAddressesTool | read/run 地址刷新；敏感地址默认不发送模型 | 已接入；共用组件／浏览器展示通过；原生验证见文末 |
| toolbox.ifconfig-parser | ifconfig 解析 | NetworkAddressesTool / networkTools | form 用户粘贴；run 本地解析 | 已接入；共用组件／浏览器展示通过；原生验证见文末 |
| toolbox.json | JSON | ToolContent / local 固定函数 | form 输入与参数；run 本地计算／复制；导出需用户保存 | 已接入；共用组件／浏览器展示通过；原生验证见文末 |
| toolbox.url | URL | ToolContent / local 固定函数 | form 输入与参数；run 本地计算／复制；导出需用户保存 | 已接入；共用组件／浏览器展示通过；原生验证见文末 |
| toolbox.base64 | Base64 | ToolContent / local 固定函数 | form 输入与参数；run 本地计算／复制；导出需用户保存 | 已接入；共用组件／浏览器展示通过；原生验证见文末 |
| toolbox.time | 时间转换 | ToolContent / local 固定函数 | form 输入与参数；run 本地计算／复制；导出需用户保存 | 已接入；共用组件／浏览器展示通过；原生验证见文末 |
| toolbox.uuid | UUID v4 | ToolContent / local 固定函数 | form 输入与参数；run 本地计算／复制；导出需用户保存 | 已接入；共用组件／浏览器展示通过；原生验证见文末 |
| toolbox.qr-code | 二维码 | ToolContent / local 固定函数 | form 输入与参数；run 本地计算／复制；导出需用户保存 | 已接入；共用组件／浏览器展示通过；原生验证见文末 |
| toolbox.text-sha256 | 文本 SHA-256 | ToolContent / local 固定函数 | form 输入与参数；run 本地计算／复制；导出需用户保存 | 已接入；共用组件／浏览器展示通过；原生验证见文末 |
| toolbox.file-sha256 | 文件 SHA-256 | FileHashTool / FileHashManager | form 用户选择文件 token；run 计算／取消；不发送文件内容 | 已接入；共用组件／浏览器展示通过；原生验证见文末 |
| toolbox.regex | 正则诊断 | RegexTool / regexTools / 隔离 worker | form 表达式／文本；run 有界计算／取消 | 已接入；共用组件／浏览器展示通过；原生验证见文末 |
| toolbox.color | 颜色转换 | ToolContent / local 固定函数 | form 输入与参数；run 本地计算／复制；导出需用户保存 | 已接入；共用组件／浏览器展示通过；原生验证见文末 |
| toolbox.color-picker | 视觉取色 | ColorPickerTool / colorTools | form 本地编辑；run 转换／复制 | 已接入；共用组件／浏览器展示通过；原生验证见文末 |
| toolbox.image-watermark | 图片水印 | ImageToolbox / imageExecution / imageInputs | form 用户选图／参数；run 预览与验证；form 保存 | 已接入；共用组件／浏览器展示通过；原生验证见文末 |
| toolbox.image-batch-watermark | 批量水印 | ImageToolbox / imageExecution / imageInputs | form 用户选图／参数；run 预览与验证；form 保存 | 已接入；共用组件／浏览器展示通过；原生验证见文末 |
| toolbox.confidential-watermark | 保密水印 | ImageToolbox / imageExecution / imageInputs | form 用户选图／参数；run 预览与验证；form 保存 | 已接入；共用组件／浏览器展示通过；原生验证见文末 |
| toolbox.image-recipe | Recipe 构建器 | ImageToolbox / imageExecution / imageInputs | form 用户选图／参数；run 预览与验证；form 保存 | 已接入；共用组件／浏览器展示通过；原生验证见文末 |
| toolbox.image-editor | 图层编辑器 | ImageToolbox / imageExecution / imageInputs | form 用户选图／参数；run 预览与验证；form 保存 | 已接入；共用组件／浏览器展示通过；原生验证见文末 |
| toolbox.invisible-watermark-write | 隐形水印写入 | ImageToolbox / imageExecution / imageInputs | form 用户选图／参数；run 预览与验证；form 保存；secret 本地密钥 | 已接入；共用组件／浏览器展示通过；原生验证见文末 |
| toolbox.invisible-watermark-check | 隐形水印检测 | ImageToolbox / imageExecution / imageInputs | form 用户选图／参数；run 预览与验证；form 保存；secret 本地密钥 | 已接入；共用组件／浏览器展示通过；原生验证见文末 |
| toolbox.recipient-tracking | 收件人追踪包 | ImageToolbox / imageExecution / imageInputs | form 用户选图／参数；run 预览与验证；form 保存；secret 本地密钥 | 已接入；共用组件／浏览器展示通过；原生验证见文末 |
| toolbox.robustness-lab | 稳健性实验室 | ImageToolbox / imageExecution / imageInputs | form 用户选图／参数；run 预览与验证；form 保存；secret 本地密钥 | 已接入；共用组件／浏览器展示通过；原生验证见文末 |
| toolbox.c2pa-inspector | C2PA 检查器 | ImageToolbox / imageExecution / imageInputs | form 用户选图／参数；run 预览与验证；form 保存 | 已接入；共用组件／浏览器展示通过；原生验证见文末 |
| toolbox.binary-patch-create | 生成补丁 | BinaryPatchToolbox / binaryPatchTools | form 文件 token；run 验证；form 保存新产物，不覆盖源文件 | 已接入；共用组件／浏览器展示通过；原生验证见文末 |
| toolbox.binary-patch-apply | 应用与验证 | BinaryPatchToolbox / binaryPatchTools | form 文件 token；run 验证；form 保存新产物，不覆盖源文件 | 已接入；共用组件／浏览器展示通过；原生验证见文末 |
| toolbox.binary-patch-inspector | 补丁检查器 | BinaryPatchToolbox / binaryPatchTools | form 文件 token；run 验证；form 保存新产物，不覆盖源文件 | 已接入；共用组件／浏览器展示通过；原生验证见文末 |
| toolbox.integrity-manifest | 完整性清单 | BinaryPatchToolbox / binaryPatchTools | form 文件 token；run 验证；form 保存新产物，不覆盖源文件 | 已接入；共用组件／浏览器展示通过；原生验证见文末 |
| toolbox.transfer-savings | 传输节省 | BinaryPatchToolbox / binaryPatchTools | form 输入；run 本地计算／解释 | 已接入；共用组件／浏览器展示通过；原生验证见文末 |
| toolbox.patch-errors | 错误码解释 | BinaryPatchToolbox / binaryPatchTools | form 输入；run 本地计算／解释 | 已接入；共用组件／浏览器展示通过；原生验证见文末 |
| toolbox.patch-planner | 发布规划器 | BinaryPatchToolbox / binaryPatchTools | form 文件 token；run 验证；form 保存新产物，不覆盖源文件 | 已接入；共用组件／浏览器展示通过；原生验证见文末 |

## 实施批次与完成证据

1. **共用基础及现有五类检查**：先完成业务结果／版本通知，原生目标绑定的直接卡片操作，指标、进程、网络、磁盘、历史卡片。验证 AI 扫描后已挂载的磁盘页立即更新、页面操作使旧卡片过期。
2. **业务管理卡片**：快速清理、文件洞察、应用活动／管理、启动项、卷与推出、连接详情、诊断与历史导出。逐项提取可嵌入组件，不复制整页或业务执行逻辑。
3. **系统工具卡片**：本机地址、占用诊断、保活、进程提醒、定时任务、键盘清洁。保留前置输入、系统能力与明确操作限制。
4. **文本工具卡片**：复用本地固定函数与 worker，提供可编辑输入和真实结果。模型可调用可安全序列化的纯计算能力，文件和秘密仍由用户在本地提供。
5. **图片与补丁卡片**：复用文件 token、任务状态、取消、输出验证和保存流程；复杂编辑用同一组件的展开模式，不假装小窗能容纳完整编辑器。
6. **一致性与验收**：登记每项自动化和原生 UI 证据；未覆盖的平台／能力明确保留待验收，不将目录条目或跳转按钮计作完成。

当前实现与验证（2026-09-08）：

- 19 项业务能力和 36 项工具共用现有操作组件和原业务控制器，不复制 AI 专用执行器。55 项表单均通过浏览器打开验证；这项验证不代表每项系统副作用已在每个平台执行。
- 五类检查已显示可读结果；进程与磁盘卡片可直接刷新、选择真实目标、请求原生确认，不需要再次调用模型。原生测试覆盖目标绑定、过期、取消、重复确认、清除及保存失败。
- 快速清理共用原生分析、任务状态、取消和结果。模型仅可分析；清理由用户选类别并确认永久删除风险。隐私清除和晚到结果的并发测试通过。
- 8 类文本工具、15 种有限操作可以由模型调用固定本地函数。完整结果回填原工具状态，会话只保留有界片段。用户在请求领取、计算或回执期间的新编辑，以及清除数据操作，都阻止旧结果覆盖。
- 二维码文本、视觉取色和 ifconfig 的本地输入／结果也共用状态；Wi-Fi 密码及其二维码不保留。文件、图片和补丁工具继续使用既有 session/job/output token，选择文件、密钥及保存均由用户在本机完成，不自动发给模型。
- 全量前端 839 项通过；全量原生 508 项通过、7 项环境相关测试跳过；类型、ESLint、Clippy 和十语言检查通过。主窗口和小窗完整浏览器回归 12 项通过，含 55 表单、JSON 回写与延迟加载后的确认可见性。
- 全部入口首屏预算与 CSS 总预算保持不变；完整按需 JavaScript 的功能增量、最终体积和总预算调整见设计文档。

源码、内部方案及验证均只留在 Internal；不改版本、不提交、不发布。Windows/Linux 的原生 UI 和全部平台副作用未实机验收；破坏性自动化仅使用合成目标／测试目录，不移动用户文件或结束用户进程。

## 原生 UI 验收状态

2026-09-08，独立 `CoreRobin AI Test` 使用本机 `llama3.2:latest`，最终构建重启后完成以下抽样验证，未改动实际发布应用：

- 既有五条持久会话恢复正常。全部测试使用临时会话；结束后删除本次临时会话并恢复原有会话。持久会话与八条已保存运行记录的完整内容哈希在验收前后相同。
- 模型调用固定 JSON 工具计算非空数组，原生步骤为“已完成”，卡片显示真实计算回执；打开操作区后可继续使用该输入和结果。此前一轮 `[8,true,null]` 同时在原工具箱显示；最终包以 `[9,true,null]` 再次完成模型、原生桥接、计算与卡片表单回路。
- 在最终卡片操作区手动编辑 `{"n":7}` 并格式化，原工具箱随后显示相同输入和结果，证明两处共用状态。原生手输时智能引号会破坏 JSON 的问题已通过关闭代码输入的自动纠正修复，并在最终包实测通过。
- 设备检查显示独立于模型文字的可读指标卡片。点击“重新检查”生成新的原生采样结果，回执标明“用户直接操作 · 未调用模型”，未发送草稿完整保留。
- `settings.privacy` 操作卡成功打开原有记录开关与实际数据摘要；在操作区内打开分类数据清除确认并取消，外层表单仍可用，没有清除数据。
- 失败案例保留：小模型曾生成多余参数和无效 JSON，原生层分别以 `invalid_tool_arguments`、`invalid_json` 拒绝。独立的 Ollama 流式请求也复现了模型改写输入；新增分片与 IPC 回归确认正常 JSON 文本、中文及转义字符不被传输层改写。没有自动修正模型参数、放宽校验或把模型手写结果计作工具成功。
- 模型解释仍可能误读原生数值与单位；可读结果卡以实际业务回执为准。模型能力不足时可能不调用工具或提交错误参数，应用不能保证任意模型完成任务。

自动化范围：全量前端 839 项、全量原生 508 项（另有 7 项按环境定义跳过）、主窗口／小窗浏览器 12 项通过；最后的 JSON 输入属性调整另复跑相关前端 28 项、类型构建与 ESLint。全部首屏、CSS 与总 JavaScript 预算通过，Clippy `-D warnings` 和十语言检查通过。

这属于本机 macOS 的原生抽样验收，不表示 55 项系统副作用均已实机执行，也不覆盖 Windows/Linux 原生 UI、所有输入法、多屏与长期能耗。进程修改与文件处理仍依赖原生确认及现有控制器；破坏性验证只使用合成目标或测试目录，不操作用户文件与进程。

证据保存在忽略目录 `.local-dev/ai-validation/capability-*`。源码、方案和验证只留在 Internal；未改版本、提交、推送或发布。
