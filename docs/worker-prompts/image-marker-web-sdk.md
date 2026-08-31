# image-marker：独立 Web SDK 的需求与执行 Prompt

状态更新（2026-08-31）：`@image-marker/web@0.1.0` 已正式发布，公开入口和基本消费者运行已核实。本文保留为历史需求与原始交接 Prompt，**不要再次按下文派发新增 Web 包的任务**；当前接入契约、已验证范围及桌面剩余工作以 [工具箱方案第 5.6 节](../toolbox-v1.md#56-已发布-sdk-的接入契约与剩余验收) 为准。

以下是发布前交给 image-marker worker 的原始任务输入，其中“待发布”“拟新增”和基线版本均属于当时上下文。本文是内部交接材料，不要原样提交到上游公开仓库。

## 需求

让现有图片处理与编辑器逻辑能够被 Tauri 2 + Rust + React/TypeScript 桌面应用正常消费，不安装 React Native、不运行 Node sidecar，同时保持原项目的 RN、Web、Node、CLI 和官网现有功能兼容。采用新增独立 Web 包、共享源码的方式，不重写算法，不要求旧用户迁移包名或调用代码。

## 执行 Prompt

你负责在 `/Users/jimmydaddy/study/react-native-image-marker-bug-fix` 实施独立 Web SDK。请直接完成代码、测试、文档和打包验证，不停留在方案或任务列表。

### 一、上下文与工作范围

- 下游是 Tauri 2 + Rust + React/TypeScript + Vite 的桌面工具箱。TS 调用浏览器图片能力，Rust 管理文件授权和任务生命周期；不会安装 RN，也不运行 Node sidecar。
- 下游需要现有文字/Logo 水印、批处理、保密预设、Recipe、可用图层编辑、隐形 locator 写入/检测、收件人追踪及稳健性实验的底层能力。C2PA 使用独立库按需接入，不要求本次新增签名产品。
- 本任务只负责上游 SDK、共享实现、公开示例、构建发布接线和兼容测试。不要修改 CoreRobin 的代码、CSP、Rust 服务、UI、文件保存窗口或工具箱任务编排，不把其私有设计复制到本仓库。
- 先读取本仓库当前协作约定并检查分支、HEAD、工作区和包版本。你不是独自工作，不得 reset、clean、自动 stash、覆盖或撤销其他人的改动。调研时工作区干净，HEAD 为 `719ec86a2de33c70956650c70cc194f58cc8e5d1`；这是证据快照，不是要求你切回该提交。
- 本任务不授权 npm 发布、打 tag、合并 PR 或部署官网；提交和推送仅按用户在你的任务中已有的明确授权执行。先完成全部可本地验证、可评审的工作，不能因为尚无发布授权就提前停止实现。

### 二、已经核实的现状，实施前只做定向复核

2026-08-31 核实的正式包为 core `react-native-image-marker@2.1.1`、editor `react-native-image-marker-editor@0.3.0`、`@image-marker/recipe@0.1.0`、Node/CLI 各 `0.1.0`。后续可能变化，以你执行时的真实源码和发布产物为准。

1. core 根入口在标准浏览器条件下已经选择 Web 实现，`/web` 也可用；Metro 通过原生入口选择 RN 实现。不要错误地把 core 根入口一概视为 RN-only。
2. editor 的 `/core-adapter` 可独立在无 RN 的 Vite/Chrome 环境渲染预览；它不必然加载 RN UI。真正的问题是 editor 根入口同时导出 RN 组件，哪怕只导入 controller，也可能在构建解析时要求 `react-native`。
3. editor 尚无公开 `/headless`；官网直接引用内部 controller。core/editor 均声明必选 React/RN peer。此前无 RN 运行测试刻意绕开了 peer 安装，不能证明正常安装不拉入 RN。
4. controller 从旧 core 导入 `migrateWatermarkRecipe`；core wrapper 还做快照规范化和渲染参数校验，不能直接换成 recipe 包同名函数并假定语义相同。editor 类型文件也引用旧 core。
5. 浏览器引擎使用 `Image` 和 DOM Canvas；隐形检测已有独立 Worker，不等于整个图片引擎可直接放入普通 Worker。File/Blob 输入、Recipe 的 Blob 输出已经存在，不要重复新增。
6. 已用正式 tarball 在隔离 Vite/TypeScript/Chrome 消费者验证文字/Logo 水印、Recipe 往返、Blob 输出、两图批处理、隐形 locator 往返和 adapter 预览。这不是新包干净安装、全部官网功能或实际 Tauri WebView 的验收结果。

优先检查以下绝对路径下的相关代码，避免无关重构：

- `/Users/jimmydaddy/study/react-native-image-marker-bug-fix/src/marker.ts`、`src/marker.native.ts`、`src/recipe.ts`、`src/web/`。
- `/Users/jimmydaddy/study/react-native-image-marker-bug-fix/packages/editor/src/`、`packages/editor/package.json`、`packages/editor/tsconfig.module.json`、`packages/editor/api-contract.json`。
- `/Users/jimmydaddy/study/react-native-image-marker-bug-fix/scripts/verify-package-consumer.mjs`、`scripts/build-invisible-worker.mjs`、`scripts/release-target.mjs`、`scripts/size-budgets.json`、`.github/workflows/npm-publish.yml`。

### 三、必须完成的改动

1. 新增独立包，拟名 `@image-marker/web`，放在本仓库合适的 workspace 中。若名称存在实际冲突，说明证据并使用符合现有命名规则的替代名，不因此更改旧包。公开入口至少覆盖：
   - 根入口：现有 Web Marker、枚举/类型、Recipe 渲染、可见/隐形水印和检测。
   - `/headless`：controller、图层操作、几何/投影、预设及类型，不导出 RN UI 或 Hook。
   - `/editor-adapter`：绑定 Web 引擎的预览/导出适配器。
   - 可供构建工具解析的 Worker 资源入口，资源随包分发，不依赖 CDN 或消费者猜内部目录。
2. 从同一份权威源码构建新旧包。新包运行时和类型声明不得反向依赖旧 core/editor，不得传递要求 React/RN、Node 原生模块或 sharp；可以依赖已有的平台无关 recipe 包。不要复制后维护两套算法，不使用消费端 alias、私有深路径或 sibling 仓库路径绕过包边界。
3. 提取共享逻辑时保留 controller 的迁移、规范化及校验语义。适配器采用共享实现加独立包装：旧包装仍用原 Marker，新包装用 Web Marker。不得将旧 RN adapter 强制切到 Canvas。新包声明文件自包含，不继承 RN ambient types，不改变公共枚举、已有参数、默认值和返回结构。
4. 为新入口提供明确的执行/资源适配契约，补齐可选的取消、按实例资源释放与执行能力声明；复用已存在的对应能力。保留旧 DOM/RN 默认行为。区分可协作取消阶段与需要宿主终止的同步计算，禁止用 Promise 超时或忽略结果冒充真正停止。实现并测试宿主可注入的执行/资源边界和清理行为；不要用空接口或 TODO 当作完成。Tauri 隔离单元本身由下游实现，不要求本任务搭建桌面应用。
5. 本地 File/Blob 输入和 Blob 输出作为正式 API 场景验证。桌面只允许本地素材是调用方策略，不全局禁止旧 Web API 的远端 URL。元信息读取优先直接读文件字节，不以放开联网解决 `fetch(dataURL)` 受 CSP 限制的问题。
6. 给新包补齐 `files/exports/types`、build/prepack、包体预算、API contract、版本与 tag/channel 路由、发布构建依赖和 registry consumer 流程。旧包现有 exports/peers/API contract 保留。发布后验证脚本可以准备好，但未发布就必须标为“待发布后运行”。
7. 将相关官网 Web 示例改用可公开消费的入口，保持页面功能和 URL；构建验证不能依赖源码深路径。新增通用 Web SDK 接入文档和最小消费示例，写明 Worker、Canvas、取消、资源来源与 C2PA 的边界，不宣称已通过 Tauri 三平台验证。

### 四、兼容红线

- 旧包名、现有入口、peer 声明、Metro 原生选择、默认 DOM 路径、RN 组件、Node/CLI 调用方式不变。不以“将旧 RN peer 改 optional”替代独立新包。
- 不顺手升级 RN、重写 Android/iOS 原生代码或更换原生工具链；保留 Android 16 KB 对齐及现有验证门禁。
- Recipe 和 locator 既有数据继续可读，迁移校验及错误语义不被共享提取削弱。安全缺陷如需改变旧行为，单独报告具体证据和影响，不能悄悄宣称完全兼容。
- 不复制整站，不把 C2PA、ZIP 或桌面批处理逻辑强塞进所有用户的核心依赖。

### 五、验收与交付

请扩展有价值的现有测试，并增加真实外部消费者测试：

1. 新建临时空目录，正常安装新包及其依赖的待发布 tarball；不使用 `--legacy-peer-deps`、`--force`、workspace symlink、alias、paths 或私有 import。检查依赖树、声明链和 bundle 不包含 RN/旧包依赖。开发仓库自身安装 RN 不影响这个隔离测试。
2. TypeScript 严格检查，`skipLibCheck: false`；通过 Vite 生产构建并运行实际浏览器测试。若声明支持 CJS，另测 `require`，不能以 ESM 成功推断 CJS 可用。
3. 覆盖文字/Logo 水印、方向/透明度、File/Blob、Recipe 校验迁移、图层编辑与撤销重做、adapter 预览/导出、隐形 locator 往返；固定素材和字体，对同环境像素/语义做合理断言，不强求不同编码器文件字节一致。
4. 验证 Worker 资源在生产构建后离线可加载，取消前/中/后、重复取消、dispose、并发实例和迟到结果不污染其他任务；如某阶段只能由宿主强制终止，明确报告并验证契约，不伪造已停止。
5. 保留并运行相关旧 API、RN/Metro/Expo、官网、Node/CLI 回归；现有平台矩阵内的原生验证不得被新 Web 测试替代。无法运行的环境逐项标明原因，继续完成其他工作，不把未测列为通过。
6. 交付中文说明：变更文件与理由、最终包名/版本/入口、最小安装和使用示例、已执行命令与结果、产物路径与完整性摘要、兼容性对照、未运行检查及真实原因、发布前/后的剩余步骤。新包至少达到可打包、可在空白项目消费的状态；不只提交入口占位。

本任务完成的是上游 SDK 的可消费交付。下游的真实 Tauri 平台验收仍由下游负责，两者不能互相代替。
