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
import { useTranslation } from "react-i18next";
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
  const { t } = useTranslation("toolbox");
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
      onError(reason instanceof Error ? reason.message : t("imageEditor.errors.operationFailed"));
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
      if (editor.listAssets().length + files.length > 4) throw new Error(t("imageEditor.errors.assetLimit"));
      for (const file of files) {
        const budget = await inspectImageBudget(marker, file);
        const asset = editor.registerAsset(file, { width: budget.info.width, height: budget.info.height });
        editor.addImageAsset(asset, { x: 64 + editor.listAssets().length * 18, y: 64 + editor.listAssets().length * 18 });
      }
      syncRecipe();
      onNotice(t("imageEditor.notices.assetsAdded", { count: files.length }));
      onError("");
    } catch (reason) {
      onError(reason instanceof Error ? reason.message : t("imageEditor.errors.addAssetFailed"));
    }
  };

  const importRecipe = () => runEdit(() => {
    const imported = editor.importRecipeJson(recipeText);
    setRecipeText(editor.exportRecipeJson());
    onNotice(t(imported.migrated ? "imageEditor.notices.recipeMigrated" : "imageEditor.notices.recipeValidated"));
  });

  const exportRecipe = async () => {
    try {
      const text = editor.exportRecipeJson();
      setRecipeText(text);
      const payload = recipeOutput(text);
      if (deliverOutput) {
        await deliverOutput(payload);
        onNotice(t("imageEditor.notices.handedToProvider"));
        return;
      }
      if (temporaryRecipeUrlRef.current) URL.revokeObjectURL(temporaryRecipeUrlRef.current);
      temporaryRecipeUrlRef.current = URL.createObjectURL(payload.blob);
      setTemporaryRecipeUrl(temporaryRecipeUrlRef.current);
      onNotice(t("imageEditor.notices.temporaryDownload"));
    } catch (reason) {
      onError(reason instanceof Error ? reason.message : t("imageEditor.errors.exportFailed"));
    }
  };

  const preview = () => {
    try {
      syncRecipe();
      onPreview(editor, desktopRuntime && nativeLogoRequested);
      setNativeLogoRequested(false);
    } catch (reason) {
      onError(reason instanceof Error ? reason.message : t("imageEditor.errors.previewFailed"));
    }
  };

  return <section className="image-editor" aria-label={t("imageEditor.ariaLabel")}>
    <div className="image-editor__heading"><Layers3 size={18} /><div><strong>{t("imageEditor.heading")}</strong><p>{t("imageEditor.description")}</p></div></div>
    <div className="image-editor__toolbar" aria-label={t("imageEditor.historyAria")}>
      <button className="button button--secondary" type="button" disabled={disabled || !state.canUndo} onClick={() => runEdit(() => editor.undo())}><Undo2 size={14} />{t("imageEditor.undo")}</button>
      <button className="button button--secondary" type="button" disabled={disabled || !state.canRedo} onClick={() => runEdit(() => editor.redo())}><Redo2 size={14} />{t("imageEditor.redo")}</button>
      <button className="button button--secondary" type="button" disabled={disabled || state.selectedLayerIds.length === 0} onClick={() => runEdit(() => editor.duplicateSelection())}><Copy size={14} />{t("imageEditor.duplicate")}</button>
      <button className="button button--secondary" type="button" disabled={disabled || state.selectedLayerIds.length < 2} onClick={() => runEdit(() => editor.groupSelection())}><Group size={14} />{t("imageEditor.group")}</button>
      <button className="button button--secondary" type="button" disabled={disabled || state.selectedLayerIds.length === 0} onClick={() => runEdit(() => editor.ungroupSelection())}><Ungroup size={14} />{t("imageEditor.ungroup")}</button>
      <button className="button button--secondary" type="button" disabled={disabled || state.recipe.layers.length === 0} onClick={() => runEdit(() => editor.selectAll())}>{t("imageEditor.selectAll")}</button>
    </div>

    <div className="image-editor__grid">
      <div className="image-editor__section">
        <h3>{t("imageEditor.layers")}</h3>
        <div className="image-editor__layers" role="list" aria-label={t("imageEditor.layerList")}>
          {state.recipe.layers.length === 0 ? <p className="toolbox-hint">{t("imageEditor.emptyLayers")}</p> : state.recipe.layers.map((layer, index) => {
            const selected = state.selectedLayerIds.includes(layer.id);
            return <div className={`image-editor__layer ${selected ? "is-selected" : ""}`} key={layer.id} role="listitem">
              <button className="image-editor__layer-select" type="button" aria-pressed={selected} disabled={disabled} onClick={(event) => runEdit(() => editor.select(layer.id, event.shiftKey || event.metaKey || event.ctrlKey ? "toggle" : "replace"))}>
                <span>{index + 1}. {layer.name ?? (layer.type === "text" ? layer.text.slice(0, 24) : t("imageEditor.localImage"))}</span><small>{layer.type === "text" ? t("imageEditor.textLayer") : t("imageEditor.asset")}</small>
              </button>
              <button className="icon-button" type="button" aria-label={layer.visible === false ? t("imageEditor.showLayer") : t("imageEditor.hideLayer")} disabled={disabled} onClick={() => runEdit(() => editor.controller.setLayerVisible(layer.id, layer.visible === false))}>{layer.visible === false ? <EyeOff size={14} /> : <Eye size={14} />}</button>
              <button className="icon-button" type="button" aria-label={layer.locked ? t("imageEditor.unlockLayer") : t("imageEditor.lockLayer")} disabled={disabled} onClick={() => runEdit(() => editor.controller.setLayerLocked(layer.id, !layer.locked))}>{layer.locked ? <Lock size={14} /> : <LockKeyholeOpen size={14} />}</button>
            </div>;
          })}
        </div>
        <div className="image-editor__row"><input className="toolbox-input" value={newText} maxLength={4096} onChange={(event) => setNewText(event.target.value)} placeholder={t("imageEditor.textPlaceholder")} disabled={disabled} /><button className="button button--secondary" type="button" disabled={disabled} onClick={() => runEdit(() => editor.addText(newText))}><Plus size={14} />{t("imageEditor.addText")}</button></div>
        {!desktopRuntime ? <label className="toolbox-file-pick button button--secondary"><Upload size={14} />{t("imageEditor.addAsset")}<input hidden type="file" accept="image/png,image/jpeg,image/webp" multiple disabled={disabled} onChange={(event) => void addBrowserAssets(Array.from(event.target.files ?? []))} /></label> : <label className="image-editor__native-asset"><input type="checkbox" checked={nativeLogoRequested} disabled={disabled} onChange={(event) => setNativeLogoRequested(event.target.checked)} />{t("imageEditor.nativeAsset")}</label>}
      </div>

      <div className="image-editor__section">
        <h3>{t("imageEditor.selectedLayer")}</h3>
        <div className="image-editor__toolbar">
          <button className="icon-button" type="button" aria-label={t("imageEditor.moveLeft")} disabled={disabled || !primaryLayer} onClick={() => runEdit(() => editor.moveSelection({ x: -8, y: 0 }))}><ArrowLeft size={15} /></button>
          <button className="icon-button" type="button" aria-label={t("imageEditor.moveUp")} disabled={disabled || !primaryLayer} onClick={() => runEdit(() => editor.moveSelection({ x: 0, y: -8 }))}><ArrowUp size={15} /></button>
          <button className="icon-button" type="button" aria-label={t("imageEditor.moveDown")} disabled={disabled || !primaryLayer} onClick={() => runEdit(() => editor.moveSelection({ x: 0, y: 8 }))}><ArrowDown size={15} /></button>
          <button className="icon-button" type="button" aria-label={t("imageEditor.moveRight")} disabled={disabled || !primaryLayer} onClick={() => runEdit(() => editor.moveSelection({ x: 8, y: 0 }))}><ArrowRight size={15} /></button>
          <button className="button button--secondary" type="button" disabled={disabled || !primaryLayer} onClick={() => runEdit(() => editor.reorderPrimary(-1))}>{t("imageEditor.lowerLayer")}</button>
          <button className="button button--secondary" type="button" disabled={disabled || !primaryLayer} onClick={() => runEdit(() => editor.reorderPrimary(1))}>{t("imageEditor.raiseLayer")}</button>
        </div>
        {primaryLayer?.type === "text" ? <label>{t("imageEditor.textContent")}<input className="toolbox-input" value={primaryText} disabled={disabled} onChange={(event) => runEdit(() => editor.updatePrimaryText(event.target.value))} /></label> : null}
        {primaryLayer ? <div className="image-editor__transform"><label><Move size={14} />{t("imageEditor.scale")}<input type="number" min="0.01" max="100" step="0.05" value={primaryScale} disabled={disabled} onChange={(event) => runEdit(() => editor.scalePrimary(Number(event.target.value)))} /></label><label><RotateCw size={14} />{t("imageEditor.rotation")}<input type="number" min="0" max="360" step="1" value={primaryRotation} disabled={disabled} onChange={(event) => runEdit(() => editor.rotatePrimary(Number(event.target.value)))} /></label></div> : <p className="toolbox-hint">{t("imageEditor.noSelection")}</p>}
        <div className="image-editor__toolbar"><button className="button button--secondary" type="button" disabled={disabled || state.selectedLayerIds.length === 0} onClick={() => runEdit(() => editor.setSelectionVisible(false))}><EyeOff size={14} />{t("imageEditor.hide")}</button><button className="button button--secondary" type="button" disabled={disabled || state.selectedLayerIds.length === 0} onClick={() => runEdit(() => editor.setSelectionVisible(true))}><Eye size={14} />{t("imageEditor.show")}</button><button className="button button--secondary" type="button" disabled={disabled || state.selectedLayerIds.length === 0} onClick={() => runEdit(() => editor.setSelectionLocked(true))}><Lock size={14} />{t("imageEditor.lock")}</button><button className="button button--secondary" type="button" disabled={disabled || state.selectedLayerIds.length === 0} onClick={() => runEdit(() => editor.setSelectionLocked(false))}><LockKeyholeOpen size={14} />{t("imageEditor.unlock")}</button></div>
        <div className="image-editor__alignment" aria-label={t("imageEditor.alignment")}><span>{t("imageEditor.alignmentHint")}</span>{([ ["left", AlignLeft], ["center", AlignHorizontalJustifyCenter], ["right", AlignRight], ["top", AlignCenter], ["middle", AlignVerticalJustifyCenter], ["bottom", AlignCenter] ] as const).map(([alignment, Icon]) => <button className="icon-button" type="button" key={alignment} title={alignment} aria-label={t("imageEditor.align", { direction: alignment })} disabled={disabled || state.selectedLayerIds.length < 2} onClick={() => runEdit(() => editor.alignSelection(alignment as EditorAlignment, PREVIEW_CANVAS))}><Icon size={14} /></button>)}</div>
      </div>
    </div>

    <div className="image-editor__section">
      <div className="image-editor__recipe-heading"><h3>{t("imageEditor.recipe")}</h3><span>{t("imageEditor.recipeHint")}</span></div>
      <textarea className="toolbox-input image-editor__recipe" value={recipeText} spellCheck={false} disabled={disabled} onChange={(event) => setRecipeText(event.target.value)} aria-label={t("imageEditor.recipeAria")} />
      <div className="image-editor__toolbar"><button className="button button--secondary" type="button" disabled={disabled} onClick={importRecipe}>{t("imageEditor.importRecipe")}</button><button className="button button--secondary" type="button" disabled={disabled} onClick={() => void navigator.clipboard?.writeText(recipeText).then(() => onNotice(t("imageEditor.copySuccess")), () => onError(t("imageEditor.copyFailure")))}><Copy size={14} />{t("imageEditor.copyJson")}</button><button className="button button--secondary" type="button" disabled={disabled} onClick={() => void exportRecipe()}><FileImage size={14} />{t("imageEditor.exportRecipe")}</button>{temporaryRecipeUrl ? <a className="button button--secondary" href={temporaryRecipeUrl} download="corerobin-recipe.json">{t("imageEditor.downloadRecipe")}</a> : null}<button className="button button--primary" type="button" disabled={disabled} onClick={preview}>{t("imageEditor.preview")}</button></div>
    </div>
  </section>;
}
