# bs-diff-patch：Web 与工具层 SDK 的需求与执行 Prompt

状态更新（2026-08-31）：独立包 `bs-diff-patch-web@0.5.0` 已正式发布，当前消费入口为包根和 `/toolkit`，不是 `bs-diff-patch-web/web`。本文保留为历史需求与原始交接 Prompt，**不要再次按下文派发建包/发布入口任务**；实际独立包方案、已验证范围及桌面剩余工作以 [工具箱方案第 5.6 节](../toolbox-v1.md#56-已发布-sdk-的接入契约与剩余验收) 为准。

以下是发布前交给 bs-diff-patch worker 的原始任务输入，其中未提交工作区、0.4.0 基线和旧包增补入口的要求均属于当时上下文，不再描述当前状态。本文是内部交接材料，不要原样提交到上游公开仓库。

## 需求

让 Tauri 2 + Rust + React/TypeScript 桌面应用通过正式 npm 入口使用现有 Web/WASM 补丁引擎和纯工具层，不安装 React Native、不运行 Node sidecar。保持既有 RN API、补丁格式及 Node/CLI 能力，接续当前在建工作，补齐发布包边界、浏览器产物、类型、资源和消费者验证。

## 执行 Prompt

你负责在 `/Users/jimmydaddy/study/react-native-bs-diff-patch` 实施 Web/工具层 SDK 的正式消费支持。请直接完成代码、测试、文档和打包验证，不停留在方案或任务列表。

### 一、上下文与工作范围

- 下游是 Tauri 2 + Rust + React/TypeScript + Vite 的桌面工具箱。TS 调用 Worker/WASM，Rust 管理文件授权、读取/保存、临时产物和作业生命周期；不安装 RN，不运行 Node sidecar，也不从 Rust 直接调用 npm。
- 下游需要生成补丁、应用与验证、补丁头检查、完整性清单、节省计算、错误解释，以及多基线发布规划的底层能力。规划器中的逐基线还原验证、文件哈希、队列及导出由下游编排，不要求本任务新增 Tauri 插件或 Rust crate。
- 只修改本仓库 SDK、相关构建/打包/测试和通用文档。不要修改 CoreRobin 的代码、CSP、Rust 服务、UI 或发布配置，不复制其私有设计。
- 先读取本仓库当前协作约定并检查分支、HEAD、工作区和包版本。你不是独自工作，不得 reset、clean、自动 stash、覆盖或撤销其他人的改动。调研时分支为 `feat/verified-delta-pipeline`，HEAD 为 `8569caa42ac9f79163775f4748a8fae61936082d`；这是证据快照，不要求切换或回退。
- 该仓库当前有大量已修改和未跟踪内容，包括 toolkit、node、bin、action、发布规划器、进度桥接、流式补丁和转换器。先识别这些工作，复用并接续已有实现；不能认为未跟踪文件可删除，也不能把旧 HEAD 当作完整需求基线。不要替其他工作重新实现或大范围重构。
- 本任务不授权 npm 发布、打 tag、合并 PR 或部署官网；提交和推送仅按用户在你的任务中已有的明确授权执行。完成本地可验证、可评审的全部工作后再报告发布步骤，不因未获发布授权提前停止实现。

### 二、已经核实的现状，实施前只做定向复核

2026-08-31 正式 npm `react-native-bs-diff-patch@0.4.0` 与同版本号的本地工作区内容不同；实施时再次区分源码、待发布 tarball 和 registry 包。

1. 正式 0.4.0 通过包根的 browser 条件导出 Web API，具有 `diffBytes`、`patchBytes`、`inspectPatch`、`verifyPatch`；未公开 `/web` 子路径，也不包含本地新增的 `/toolkit`、`/node`、CLI。
2. React/RN peer 已为 optional；不必另造一个包才能避免安装 RN。正式 Web 字节 API 已在无 RN 的隔离 TypeScript/Vite/Chrome 环境通过真实 Worker/WASM 往返、输入不变、验证不匹配、取消和资源上限测试。
3. 当前工作区已有 `/toolkit`、Node/CLI、任务/进度等新实现。toolkit 是无外部 import 的纯 JS，已有类型和测试；manifest/bundle/候选选择/头解析等消费检查已经通过，不要重写这套逻辑。
4. `node/index.mjs` 与 `web/operations.mjs` 目前都加载 `web/bsdiffpatch.mjs`。构建脚本使用 `ENVIRONMENT=web,worker,node` 和 Node 文件系统支持，Vite 因生成文件的 Node 分支出现 externalized 警告。不能简单删去共享产物的 Node 能力，否则会损坏 Node/CLI。
5. 当前 WASM 内嵌在 single-file 生成模块中，并不是漏发独立 `.wasm` 文件。可以保留这种形式；关键是浏览器资源正确打包、运行且无 Node 运行时要求。
6. 目前 Tauri CSP 若只允许 `script-src 'self'` 会拦截 WASM。隔离测试添加针对 WASM 的权限后成功，但应用 CSP 未改、实际 Tauri WebView 未验收。这里只提供所需策略说明与测试证据，不修改下游配置，不建议普通 JS `unsafe-eval` 或 CDN 兜底。

优先检查以下绝对路径下的相关代码，避免无关重构：

- `/Users/jimmydaddy/study/react-native-bs-diff-patch/package.json`、`web/index.mjs`、`web/index.d.mts`、`web/operations.mjs`、`web/worker.mjs`。
- `/Users/jimmydaddy/study/react-native-bs-diff-patch/toolkit/`、`node/index.mjs`、`src/index.ts`、`src/index.web.ts`、`scripts/build-web-wasm.sh`。
- `/Users/jimmydaddy/study/react-native-bs-diff-patch/scripts/test-package-consumers.mjs`、`scripts/test-registry-consumers.mjs`、`scripts/test-toolkit.mjs`、`scripts/test-node-cli.mjs` 及相应 CI/发布流程。

### 三、必须完成的改动

1. 在现有包增加明确的 `/web` 公开入口，并将现有 `/toolkit` 纳入完整待发布产物。保留原根入口的 browser/react-native 选择及已有兼容路径。Web 入口必须配套 Web 类型，不能运行时走字节 API、声明却引导消费者调用 RN 文件路径 API。复用 `web/index.d.mts` 等现有声明，验证 exports 的实际解析。
2. 用同一份 C 源新增浏览器/Worker 专用构建，消除新 Web 路径对 Node 运行时分支的依赖；保留现有 Node 兼容产物及 Node/CLI 的加载路径。不要直接覆盖唯一共享产物。可抽取共享加载工厂，但不改变既有算法、格式和调用语义；不使用 alias、空模块、全局 polyfill 或 external 配置仅仅隐藏构建警告。
3. Worker/WASM 产物、入口和类型都进入 `files`/exports 与构建发布流程；生产 Vite 构建通过正式包名解析资源，断网可执行。若采用 single-file WASM，验证其正确运行即可，不必为形式拆出独立 wasm 文件。不得要求消费者访问仓库内部源码路径或 CDN。
4. 复用并补齐字节操作的 `signal`、`maxInputBytes`、`maxOutputBytes`、进度与任务 API，验证实际实现而非只补类型。文档明确取消完成、资源释放、错误、并发和输入缓冲区所有权；普通字节 API 不应静默修改或转移掉调用方输入。复用本地已有 `startDiffBytes`/`startPatchBytes` 等能力，避免新增含义重复的 API。
5. 资源限制在危险分配/解压前或过程中生效，检查负数、溢出、截断、声明输出大小及不前进的控制流。桌面额外预算通过可选参数传入，不全局收紧旧调用默认值。记录浏览器 WASM 实际内存上限和失败语义；输入大小上限不等于总内存上限。不得用 Promise 超时冒充中断。
6. toolkit 保持平台无关，补齐正式导出/类型/测试和文档：结构校验不读文件、不联网、不验签；`inspectPatchHeader.valid` 只说明头部；`selectPatch` 的真实候选选择规则不能写成未经实现的最小补丁保证；canonical/signing payload 不等于数字签名。
7. 补齐包内容/API contract、消费者与发布流程检查；为新增内容准备合适的新版本及说明，按仓库版本管理规则处理，不把修改后的本地 0.4.0 冒充 registry 0.4.0。此任务只准备可发布产物和流程，不自动发布。已存在或在建的 `/node`、CLI、Action 和转换器需要兼容保留，不要求本次扩大其功能。
8. 提供通用 Web/桌面 WebView 接入示例：明确 `/web` 与 `/toolkit` 用法、打包资源、字节输入输出、取消、资源限制、格式兼容及最小 CSP 要求。相关示例通过公开入口运行，不复制整站 UI，不把下游规划器或 Rust 文件服务移入 SDK。

### 四、兼容红线

- 保留旧 RN API、原生文件路径语义、根入口条件解析、已有错误码/默认参数/返回形状及 Node/CLI 能力；不借接入任务升级 RN 或重构无关原生代码。
- 下游本次消费 ENDSLEY/BSDIFF43 的生成与应用；BSDIFF40 只检查并解释不支持。保留仓库已有或在建的其他入口/转换能力，但不把它们误写成下游已支持，也不为满足此范围删除上游已有能力。
- 保证支持同格式的新旧版本补丁可交叉还原，Native/WASM 还原结果一致；不要求不同实现输出完全相同的补丁字节。
- 完整性清单和哈希不等于可信来源或签名；不能将未实际还原验证的产物标为已验证。
- 对兼容性有实际影响的安全修复单独报告理由和范围，不通过删测试、降标准或改宣传掩盖。

### 五、验收与交付

1. 在临时空目录正常安装待发布 tarball，通过正式 `/web`、`/toolkit` 导入；不安装 RN，不使用 `--legacy-peer-deps`、`--force`、workspace symlink、源码 alias、私有深路径或路径映射。检查依赖树、声明链和最终 bundle。若声明 CJS 支持，另验 `require`；否则准确声明支持的模块格式。
2. TypeScript 严格检查，`skipLibCheck: false`；Vite 生产构建后在真实浏览器中执行 Worker/WASM，不只断言函数存在。验资源 URL、生产加载与禁止外网访问，不能只跑 Node 或开发服务器。
3. 正确性覆盖生成→还原逐字节对比、输入未被修改/转移、可信预期值匹配/不匹配、错误基线、补丁头、空/边界输入、格式不支持、新旧版本及 Native/WASM 交叉还原。
4. 生命周期覆盖开始前取消、运行中取消、重复取消、取消后立即启动新任务、并发任务相互隔离、Worker 错误/终止和迟到消息。资源限制覆盖非法长度、输出超限与恶意压缩载荷；回归现有有效防护，不通过仅过滤测试输入绕过。
5. toolkit 覆盖 manifest/bundle 往返、未知/非法字段、候选规则、错误分类与头部边界；继续运行已有 Node/CLI、原生操作、Web、Metro/Expo 及相关网站检查，不能因为拆浏览器产物破坏已有消费者。
6. 使用仓库已有命令完成相关 lint/typecheck/test/build/pack；缺少平台环境时逐项记录具体原因，继续完成其他验证，不把未测列为通过。发布后 registry smoke 可以准备，但未发布必须标为待运行；不要虚报 npm 或 Tauri 实机通过。
7. 交付中文说明：变更文件与理由、与既有未提交工作的关系、最终版本与公开入口、最小消费示例、已执行命令与结果、Web/Node 产物映射、tarball 路径与完整性摘要、兼容性对照、剩余环境/发布步骤。至少产出能在空白项目安装并真实运算的待发布包，而非入口占位。

本任务完成的是上游 SDK 的可消费交付。下游的文件安全、逐基线规划流程、保存和真实 Tauri 平台验收仍由下游负责，两者不能互相代替。
