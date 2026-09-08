# UI 基础控件约定

本文件记录现有实现的共享约束，不新增一套视觉风格。

- 色彩、表面与尺寸 token 统一在 `src/styles/tokens.css`；主窗口和独立 surface 都引用它。不得使用没有定义且没有 fallback 的 CSS 变量。
- 按钮复用 `Button.tsx` / `.button` 变体，视觉定义只放在 `src/styles/controls.css`。普通按钮高度 36px、字号 12px；紧凑图标或列表操作可明确使用小尺寸。主要提交使用 primary，导航/取消使用 secondary，危险操作保持 danger/dangerGhost 语义。
- 选择器统一使用 `Select.tsx`，保留原生 select 的 label、name、required、disabled、键盘和 option 行为。default 高度 36px，compact 高度 30px；不允许业务页重置整组 select 的背景、箭头、字号与焦点样式。
- checkbox 使用共享 CSS；`role="switch"` 属于另一种既有交互，不套用 checkbox 方框/勾选图案。禁用、焦点、indeterminate 与 forced-colors 状态不能丢失。
- 业务表单不得依赖 `.ai-assistant input`、`.ai-assistant .button` 等宿主后代样式。AI 自身文本输入明确使用 `.ai-input`；业务弹窗 portal 到 body，继续通过 React context 接收应用能力，不能因此绕过原生操作确认。
- 嵌入工具表单标记 `data-layout="embedded"`，不继承整页标题的左侧 gutter。一般提交按钮不自动撑满 grid，操作行允许换行。
- 响应式按实际容器宽度而不是仅按窗口宽度判断；设置行、进程工具栏要验证子控件不相交、不超出父面板，不能只断言页面没有横向滚动条。

回归入口：`scripts/ui-controls-contracts.test.mjs`、`src/components/Select.test.tsx`、
`tests/visual/ui-controls.visual.spec.ts`。浏览器用例覆盖 900/1440px、英文/德文/中文大字号、
主窗/Robin、表单隔离、颜色、键盘和关闭后的焦点回退。新增控件应补充对应状态验证。
