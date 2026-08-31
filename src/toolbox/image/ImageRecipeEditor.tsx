import {
  AlignCenter,
  AlignHorizontalJustifyCenter,
  AlignLeft,
  AlignRight,
  AlignVerticalJustifyCenter,
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  Copy,
  Eye,
  EyeOff,
  FileImage,
  Group,
  Layers3,
  Lock,
  LockKeyholeOpen,
  Move,
  Plus,
  Redo2,
  RotateCw,
  Undo2,
  Ungroup,
  Upload,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { WebMarkerInstance } from "@image-marker/web";
import type { EditorAlignment, EditorSize, EditorState } from "@image-marker/web/headless";

import { LocalImageEditor } from "./imageEditor";
import { recipeOutput, type ImageOutputDelivery } from "./imageOutput";
import { inspectImageBudget } from "./imageTools";

const PREVIEW_CANVAS: EditorSize = { width: 1024, height: 768 };

interface ImageRecipeEditorProps {
  marker: WebMarkerInstance;
  desktopRuntime: boolean;
  disabled: boolean;
  onPreview: (editor: LocalImageEditor, requestNativeLogo: boolean) => void;
  onError: (message: string) => void;
  onNotice: (message: string) => void;
  deliverOutput?: ImageOutputDelivery;
}

/** Real SDK-controller surface; it contains no demo background or remote asset source. */
export function ImageRecipeEditor({ marker, desktopRuntime, disabled, onPreview, onError, onNotice, deliverOutput }: ImageRecipeEditorProps) {
  const editor = useMemo(() => new LocalImageEditor(), []);
  const [state, setState] = useState<EditorState>(() => editor.getState());
  const [recipeText, setRecipeText] = useState("");
  const [newText, setNewText] = useState("版权所有");
  const [nativeLogoRequested, setNativeLogoRequested] = useState(false);
  const [temporaryRecipeUrl, setTemporaryRecipeUrl] = useState("");
  const temporaryRecipeUrlRef = useRef("");

  const syncRecipe = () => setRecipeText(editor.exportRecipeJson());
  const runEdit = (action: () => void) => {
    try {
      action();
      syncRecipe();
      onError("");
    } catch (reason) {
      onError(reason instanceof Error ? reason.message : "编辑操作失败。");
    }
  };

  useEffect(() => editor.subscribe(setState), [editor]);
  useEffect(() => () => {
    editor.dispose();
    if (temporaryRecipeUrlRef.current) URL.revokeObjectURL(temporaryRecipeUrlRef.current);
  }, [editor]);

  const primaryLayer = state.recipe.layers.find((layer) => layer.id === state.selectedLayerId);
  const primaryText = primaryLayer?.type === "text" ? primaryLayer.text : "";
  const primaryScale = primaryLayer?.type === "image" ? primaryLayer.scale ?? 1 : 1;
  const primaryRotation = primaryLayer?.type === "image" ? primaryLayer.rotate ?? 0 : primaryLayer?.type === "text" ? primaryLayer.style?.rotate ?? 0 : 0;

  const addBrowserAssets = async (files: File[]) => {
    try {
      if (editor.listAssets().length + files.length > 4) throw new Error("当前编辑会话最多添加 4 个本地图片素材。");
      for (const file of files) {
        const budget = await inspectImageBudget(marker, file);
        const asset = editor.registerAsset(file, { width: budget.info.width, height: budget.info.height });
        editor.addImageAsset(asset, { x: 64 + editor.listAssets().length * 18, y: 64 + editor.listAssets().length * 18 });
      }
      syncRecipe();
      onNotice(`${files.length} 个本地素材已加入当前图层；它们不会进入 Recipe JSON。`);
      onError("");
    } catch (reason) {
      onError(reason instanceof Error ? reason.message : "无法添加本地素材。");
    }
  };

  const importRecipe = () => runEdit(() => {
    const imported = editor.importRecipeJson(recipeText);
    setRecipeText(editor.exportRecipeJson());
    onNotice(imported.migrated ? "Recipe v1 已迁移为 v2，并完成本地资源校验。" : "Recipe v2 已校验；仅允许当前会话的本地素材引用。");
  });

  const exportRecipe = async () => {
    try {
      const text = editor.exportRecipeJson();
      setRecipeText(text);
      const payload = recipeOutput(text);
      if (deliverOutput) {
        await deliverOutput(payload);
        onNotice("Recipe JSON 已交给原生输出 provider；请按其 TTL/另存流程完成导出。");
        return;
      }
      if (temporaryRecipeUrlRef.current) URL.revokeObjectURL(temporaryRecipeUrlRef.current);
      temporaryRecipeUrlRef.current = URL.createObjectURL(payload.blob);
      setTemporaryRecipeUrl(temporaryRecipeUrlRef.current);
      onNotice("已生成浏览器临时 Recipe 下载；这不是正式 TTL/原子另存导出。");
    } catch (reason) {
      onError(reason instanceof Error ? reason.message : "无法导出 Recipe。");
    }
  };

  const preview = () => {
    try {
      syncRecipe();
      onPreview(editor, desktopRuntime && nativeLogoRequested);
      setNativeLogoRequested(false);
    } catch (reason) {
      onError(reason instanceof Error ? reason.message : "无法准备 Recipe 预览。");
    }
  };

  return <section className="image-editor" aria-label="图片图层编辑器">
    <div className="image-editor__heading"><Layers3 size={18} /><div><strong>可操作图层编辑器</strong><p>图层状态由同一个隔离 marker 的 headless editor controller 管理。Recipe 只保存文字、变换和本地素材引用，不保存路径或远程 URL。</p></div></div>
    <div className="image-editor__toolbar" aria-label="编辑历史和图层操作">
      <button className="button button--secondary" type="button" disabled={disabled || !state.canUndo} onClick={() => runEdit(() => editor.undo())}><Undo2 size={14} />撤销</button>
      <button className="button button--secondary" type="button" disabled={disabled || !state.canRedo} onClick={() => runEdit(() => editor.redo())}><Redo2 size={14} />重做</button>
      <button className="button button--secondary" type="button" disabled={disabled || state.selectedLayerIds.length === 0} onClick={() => runEdit(() => editor.duplicateSelection())}><Copy size={14} />复制</button>
      <button className="button button--secondary" type="button" disabled={disabled || state.selectedLayerIds.length < 2} onClick={() => runEdit(() => editor.groupSelection())}><Group size={14} />分组</button>
      <button className="button button--secondary" type="button" disabled={disabled || state.selectedLayerIds.length === 0} onClick={() => runEdit(() => editor.ungroupSelection())}><Ungroup size={14} />取消分组</button>
      <button className="button button--secondary" type="button" disabled={disabled || state.recipe.layers.length === 0} onClick={() => runEdit(() => editor.selectAll())}>全选图层</button>
    </div>

    <div className="image-editor__grid">
      <div className="image-editor__section">
        <h3>图层</h3>
        <div className="image-editor__layers" role="list" aria-label="图层列表">
          {state.recipe.layers.length === 0 ? <p className="toolbox-hint">尚无图层。添加文字或本地素材后即可选择和编辑。</p> : state.recipe.layers.map((layer, index) => {
            const selected = state.selectedLayerIds.includes(layer.id);
            return <div className={`image-editor__layer ${selected ? "is-selected" : ""}`} key={layer.id} role="listitem">
              <button className="image-editor__layer-select" type="button" aria-pressed={selected} disabled={disabled} onClick={(event) => runEdit(() => editor.select(layer.id, event.shiftKey || event.metaKey || event.ctrlKey ? "toggle" : "replace"))}>
                <span>{index + 1}. {layer.name ?? (layer.type === "text" ? layer.text.slice(0, 24) : "本地图片")}</span><small>{layer.type === "text" ? "文字" : "素材"}</small>
              </button>
              <button className="icon-button" type="button" aria-label={layer.visible === false ? "显示图层" : "隐藏图层"} disabled={disabled} onClick={() => runEdit(() => editor.controller.setLayerVisible(layer.id, layer.visible === false))}>{layer.visible === false ? <EyeOff size={14} /> : <Eye size={14} />}</button>
              <button className="icon-button" type="button" aria-label={layer.locked ? "解锁图层" : "锁定图层"} disabled={disabled} onClick={() => runEdit(() => editor.controller.setLayerLocked(layer.id, !layer.locked))}>{layer.locked ? <Lock size={14} /> : <LockKeyholeOpen size={14} />}</button>
            </div>;
          })}
        </div>
        <div className="image-editor__row"><input className="toolbox-input" value={newText} maxLength={4096} onChange={(event) => setNewText(event.target.value)} placeholder="输入文字图层" disabled={disabled} /><button className="button button--secondary" type="button" disabled={disabled} onClick={() => runEdit(() => editor.addText(newText))}><Plus size={14} />添加文字</button></div>
        {!desktopRuntime ? <label className="toolbox-file-pick button button--secondary"><Upload size={14} />添加本地素材<input hidden type="file" accept="image/png,image/jpeg,image/webp" multiple disabled={disabled} onChange={(event) => void addBrowserAssets(Array.from(event.target.files ?? []))} /></label> : <label className="image-editor__native-asset"><input type="checkbox" checked={nativeLogoRequested} disabled={disabled} onChange={(event) => setNativeLogoRequested(event.target.checked)} />下次预览时从原生选择器选择一个本地 Logo 素材</label>}
      </div>

      <div className="image-editor__section">
        <h3>选中图层</h3>
        <div className="image-editor__toolbar">
          <button className="icon-button" type="button" aria-label="向左移动" disabled={disabled || !primaryLayer} onClick={() => runEdit(() => editor.moveSelection({ x: -8, y: 0 }))}><ArrowLeft size={15} /></button>
          <button className="icon-button" type="button" aria-label="向上移动" disabled={disabled || !primaryLayer} onClick={() => runEdit(() => editor.moveSelection({ x: 0, y: -8 }))}><ArrowUp size={15} /></button>
          <button className="icon-button" type="button" aria-label="向下移动" disabled={disabled || !primaryLayer} onClick={() => runEdit(() => editor.moveSelection({ x: 0, y: 8 }))}><ArrowDown size={15} /></button>
          <button className="icon-button" type="button" aria-label="向右移动" disabled={disabled || !primaryLayer} onClick={() => runEdit(() => editor.moveSelection({ x: 8, y: 0 }))}><ArrowRight size={15} /></button>
          <button className="button button--secondary" type="button" disabled={disabled || !primaryLayer} onClick={() => runEdit(() => editor.reorderPrimary(-1))}>下移层级</button>
          <button className="button button--secondary" type="button" disabled={disabled || !primaryLayer} onClick={() => runEdit(() => editor.reorderPrimary(1))}>上移层级</button>
        </div>
        {primaryLayer?.type === "text" ? <label>文字内容<input className="toolbox-input" value={primaryText} disabled={disabled} onChange={(event) => runEdit(() => editor.updatePrimaryText(event.target.value))} /></label> : null}
        {primaryLayer ? <div className="image-editor__transform"><label><Move size={14} />缩放<input type="number" min="0.01" max="100" step="0.05" value={primaryScale} disabled={disabled} onChange={(event) => runEdit(() => editor.scalePrimary(Number(event.target.value)))} /></label><label><RotateCw size={14} />旋转<input type="number" min="0" max="360" step="1" value={primaryRotation} disabled={disabled} onChange={(event) => runEdit(() => editor.rotatePrimary(Number(event.target.value)))} /></label></div> : <p className="toolbox-hint">选择单个图层后，可移动、缩放、旋转和调整层级。</p>}
        <div className="image-editor__toolbar"><button className="button button--secondary" type="button" disabled={disabled || state.selectedLayerIds.length === 0} onClick={() => runEdit(() => editor.setSelectionVisible(false))}><EyeOff size={14} />隐藏</button><button className="button button--secondary" type="button" disabled={disabled || state.selectedLayerIds.length === 0} onClick={() => runEdit(() => editor.setSelectionVisible(true))}><Eye size={14} />显示</button><button className="button button--secondary" type="button" disabled={disabled || state.selectedLayerIds.length === 0} onClick={() => runEdit(() => editor.setSelectionLocked(true))}><Lock size={14} />锁定</button><button className="button button--secondary" type="button" disabled={disabled || state.selectedLayerIds.length === 0} onClick={() => runEdit(() => editor.setSelectionLocked(false))}><LockKeyholeOpen size={14} />解锁</button></div>
        <div className="image-editor__alignment" aria-label="对齐选中图层"><span>对齐（至少两个图层）</span>{([ ["left", AlignLeft], ["center", AlignHorizontalJustifyCenter], ["right", AlignRight], ["top", AlignCenter], ["middle", AlignVerticalJustifyCenter], ["bottom", AlignCenter] ] as const).map(([alignment, Icon]) => <button className="icon-button" type="button" key={alignment} title={alignment} aria-label={`对齐 ${alignment}`} disabled={disabled || state.selectedLayerIds.length < 2} onClick={() => runEdit(() => editor.alignSelection(alignment as EditorAlignment, PREVIEW_CANVAS))}><Icon size={14} /></button>)}</div>
      </div>
    </div>

    <div className="image-editor__section">
      <div className="image-editor__recipe-heading"><h3>Recipe JSON</h3><span>64 KiB 上限 · v1 自动迁移至 v2 · 禁止 URL / data URL / 路径</span></div>
      <textarea className="toolbox-input image-editor__recipe" value={recipeText} spellCheck={false} disabled={disabled} onChange={(event) => setRecipeText(event.target.value)} aria-label="Recipe JSON 编辑器" />
      <div className="image-editor__toolbar"><button className="button button--secondary" type="button" disabled={disabled} onClick={importRecipe}>校验并导入</button><button className="button button--secondary" type="button" disabled={disabled} onClick={() => void navigator.clipboard?.writeText(recipeText).then(() => onNotice("Recipe JSON 已复制；复制内容不会执行。"), () => onError("无法复制 Recipe JSON。"))}><Copy size={14} />复制 JSON</button><button className="button button--secondary" type="button" disabled={disabled} onClick={() => void exportRecipe()}><FileImage size={14} />生成 Recipe 交付</button>{temporaryRecipeUrl ? <a className="button button--secondary" href={temporaryRecipeUrl} download="corerobin-recipe.json">下载临时 JSON（非正式导出）</a> : null}<button className="button button--primary" type="button" disabled={disabled} onClick={preview}>校验并预览</button></div>
    </div>
  </section>;
}
