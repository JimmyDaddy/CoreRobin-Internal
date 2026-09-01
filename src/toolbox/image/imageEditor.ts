import {
  migrateWatermarkRecipe,
  safeValidateWatermarkRecipe,
  type WatermarkRecipeDefinition,
  type WatermarkRecipeDocument,
} from "@image-marker/web";
import {
  ImageMarkerEditorController,
  type EditorAlignment,
  type EditorLayerBounds,
  type EditorPoint,
  type EditorSelectionMode,
  type EditorSize,
  type EditorState,
} from "@image-marker/web/headless";
import i18n from "../../i18n";

export const IMAGE_RECIPE_MAX_BYTES = 64 * 1024;
export const LOCAL_EDITOR_ASSET_KIND = "corerobin-local-image-asset";
const EDITOR_BOOTSTRAP_LAYER_ID = "corerobin-editor-bootstrap";

const editorErrorMessages = {
  textEmpty: () => i18n.t("toolbox:imageEditor.errors.textEmpty"),
  textTooLong: () => i18n.t("toolbox:imageEditor.errors.textTooLong"),
  noLayers: () => i18n.t("toolbox:imageEditor.errors.noLayers"),
  groupRequiresTwo: () => i18n.t("toolbox:imageEditor.errors.groupRequiresTwo"),
  alignRequiresTwo: () => i18n.t("toolbox:imageEditor.errors.alignRequiresTwo"),
  noSelection: () => i18n.t("toolbox:imageEditor.errors.noSelection"),
  assetUnavailable: () => i18n.t("toolbox:imageEditor.errors.assetUnavailable"),
  recipeTooLarge: () => i18n.t("toolbox:imageEditor.errors.recipeTooLarge"),
  recipeJsonInvalid: () => i18n.t("toolbox:imageEditor.errors.recipeJsonInvalid"),
  recipeValidationFailed: (message: string) => i18n.t("toolbox:imageEditor.errors.recipeValidationFailed", { message }),
  exportAssetUnavailable: () => i18n.t("toolbox:imageEditor.errors.exportAssetUnavailable"),
  externalAssetForbidden: () => i18n.t("toolbox:imageEditor.errors.externalAssetForbidden"),
  assetReselectionRequired: (name: string) => i18n.t("toolbox:imageEditor.errors.assetReselectionRequired", { name }),
  localAssetRequired: () => i18n.t("toolbox:imageEditor.errors.localAssetRequired"),
  localAssetTooLarge: () => i18n.t("toolbox:imageEditor.errors.localAssetTooLarge"),
  localAssetUnsupported: () => i18n.t("toolbox:imageEditor.errors.localAssetUnsupported"),
} as const;

export interface LocalEditorAsset {
  id: string;
  name: string;
  file: File;
  width?: number;
  height?: number;
}

interface PersistedLocalEditorAsset {
  kind: typeof LOCAL_EDITOR_ASSET_KIND;
  id: string;
  name: string;
}

export interface ImportedEditorRecipe {
  recipe: WatermarkRecipeDefinition;
  migrated: boolean;
}

/**
 * A page-memory editor session backed by the SDK's real headless controller.
 * It deliberately serializes local image layers as opaque asset references:
 * importing a Recipe never fetches a URL or resurrects a file path.
 */
export class LocalImageEditor {
  readonly controller: ImageMarkerEditorController;
  private readonly assets = new Map<string, LocalEditorAsset>();
  private assetSequence = 0;

  constructor(document?: WatermarkRecipeDocument) {
    this.controller = new ImageMarkerEditorController({ document: document ?? editorBootstrapRecipe(), historyLimit: 100 });
  }

  dispose(): void {
    this.controller.dispose();
    this.assets.clear();
  }

  getState(): EditorState {
    const state = this.controller.getState();
    const selectedLayerIds = state.selectedLayerIds.filter((id) => id !== EDITOR_BOOTSTRAP_LAYER_ID);
    return {
      ...state,
      recipe: { ...state.recipe, layers: state.recipe.layers.filter((layer) => layer.id !== EDITOR_BOOTSTRAP_LAYER_ID) },
      selectedLayerIds,
      selectedLayerId: selectedLayerIds[selectedLayerIds.length - 1],
    };
  }

  subscribe(listener: (state: EditorState) => void): () => void {
    return this.controller.subscribe(() => listener(this.getState()));
  }

  listAssets(): readonly LocalEditorAsset[] {
    return [...this.assets.values()].map((asset) => ({ ...asset }));
  }

  registerAsset(file: File, dimensions?: EditorSize): LocalEditorAsset {
    assertLocalEditorFile(file);
    const id = `asset-${++this.assetSequence}`;
    const asset: LocalEditorAsset = {
      id,
      name: safeAssetName(file.name),
      file,
      width: dimensions?.width,
      height: dimensions?.height,
    };
    this.assets.set(id, asset);
    return asset;
  }

  addText(text: string, point: EditorPoint = { x: 64, y: 64 }): string {
    const value = text.trim();
    if (!value) throw new Error(editorErrorMessages.textEmpty());
    if (new TextEncoder().encode(value).byteLength > 4096) throw new Error(editorErrorMessages.textTooLong());
    this.removeBootstrapLayer();
    return this.controller.addLayer({
      type: "text",
      name: value.slice(0, 48),
      text: value,
      alpha: 0.9,
      position: { X: point.x, Y: point.y },
      style: { color: "#ffffff", fontSize: 28, shadowStyle: { dx: 1, dy: 1, radius: 2, color: "#00000088" } },
    });
  }

  addImageAsset(asset: LocalEditorAsset, point: EditorPoint = { x: 64, y: 64 }): string {
    this.requireAsset(asset.id);
    this.removeBootstrapLayer();
    return this.controller.addLayer({
      type: "image",
      name: asset.name,
      src: asset.file,
      alpha: 1,
      scale: 1,
      rotate: 0,
      position: { X: point.x, Y: point.y },
    });
  }

  importRecipeJson(source: string): ImportedEditorRecipe {
    const imported = parseLocalEditorRecipe(source, this.assets);
    this.controller.importRecipe(imported.recipe);
    return imported;
  }

  exportRecipe(): WatermarkRecipeDefinition {
    const recipe = this.controller.exportRecipe();
    const layers = recipe.layers.filter((layer) => layer.id !== EDITOR_BOOTSTRAP_LAYER_ID);
    if (layers.length === 0) throw new Error(editorErrorMessages.noLayers());
    return { ...recipe, layers };
  }

  exportRecipeJson(): string {
    return JSON.stringify(serializeLocalEditorRecipe(this.exportRecipe(), this.assets), null, 2);
  }

  select(id: string | undefined, mode: EditorSelectionMode = "replace"): void {
    this.controller.selectLayer(id, mode);
  }

  selectAll(): void {
    this.controller.selectAll();
  }

  duplicateSelection(): string[] {
    return this.controller.duplicateLayers();
  }

  groupSelection(): string {
    const selected = this.getState().selectedLayerIds;
    if (selected.length < 2) throw new Error(editorErrorMessages.groupRequiresTwo());
    return this.controller.groupLayers();
  }

  ungroupSelection(): string[] {
    return this.controller.ungroupLayers();
  }

  moveSelection(delta: EditorPoint): void {
    this.controller.nudgeSelection(delta);
  }

  scalePrimary(scale: number): void {
    const id = this.requirePrimaryLayer();
    this.controller.scaleLayer(id, scale);
  }

  rotatePrimary(degrees: number): void {
    const id = this.requirePrimaryLayer();
    this.controller.rotateLayer(id, degrees);
  }

  alignSelection(alignment: EditorAlignment, canvas: EditorSize): void {
    const bounds = editorLayerBounds(this.getState(), canvas, this.assets);
    if (bounds.length < 2) throw new Error(editorErrorMessages.alignRequiresTwo());
    this.controller.alignLayers(alignment, bounds, canvas);
  }

  reorderPrimary(offset: number): void {
    const state = this.getState();
    const id = this.requirePrimaryLayer();
    const index = state.recipe.layers.findIndex((layer) => layer.id === id);
    this.controller.reorderLayer(id, index + offset);
  }

  setSelectionVisible(visible: boolean): void {
    for (const id of this.getState().selectedLayerIds) this.controller.setLayerVisible(id, visible);
  }

  setSelectionLocked(locked: boolean): void {
    for (const id of this.getState().selectedLayerIds) this.controller.setLayerLocked(id, locked);
  }

  updatePrimaryText(text: string): void {
    const id = this.requirePrimaryLayer();
    const value = text.trim();
    if (!value) throw new Error(editorErrorMessages.textEmpty());
    if (new TextEncoder().encode(value).byteLength > 4096) throw new Error(editorErrorMessages.textTooLong());
    this.controller.updateTextLayer(id, { text: value, name: value.slice(0, 48) });
  }

  undo(): boolean {
    return this.controller.undo();
  }

  redo(): boolean {
    return this.controller.redo();
  }

  private requirePrimaryLayer(): string {
    const id = this.getState().selectedLayerId;
    if (!id) throw new Error(editorErrorMessages.noSelection());
    return id;
  }

  private requireAsset(id: string): LocalEditorAsset {
    const asset = this.assets.get(id);
    if (!asset) throw new Error(editorErrorMessages.assetUnavailable());
    return asset;
  }

  private removeBootstrapLayer(): void {
    if (this.controller.getState().recipe.layers.some((layer) => layer.id === EDITOR_BOOTSTRAP_LAYER_ID)) {
      this.controller.removeLayer(EDITOR_BOOTSTRAP_LAYER_ID);
    }
  }
}

function editorBootstrapRecipe(): WatermarkRecipeDefinition {
  return {
    schemaVersion: 2,
    layers: [{
      id: EDITOR_BOOTSTRAP_LAYER_ID,
      type: "text",
      name: "internal editor bootstrap",
      text: "internal editor bootstrap",
      visible: false,
      position: { X: 0, Y: 0 },
      style: { fontSize: 1 },
    }],
    output: { saveFormat: "png", maxSize: 2048, quality: 92 },
  };
}

export function parseLocalEditorRecipe(source: string, assets: ReadonlyMap<string, LocalEditorAsset>): ImportedEditorRecipe {
  if (new TextEncoder().encode(source).byteLength > IMAGE_RECIPE_MAX_BYTES) throw new Error(editorErrorMessages.recipeTooLarge());
  let value: unknown;
  try {
    value = JSON.parse(source);
  } catch {
    throw new Error(editorErrorMessages.recipeJsonInvalid());
  }
  const legacy = Boolean(value && typeof value === "object" && (value as { schemaVersion?: unknown }).schemaVersion === 1);
  const migrated = migrateWatermarkRecipe(value as WatermarkRecipeDocument);
  const validated = safeValidateWatermarkRecipe(migrated);
  if (!validated.success) throw new Error(editorErrorMessages.recipeValidationFailed(validated.error.message));
  return { recipe: hydrateLocalEditorAssets(validated.value, assets), migrated: legacy };
}

export function serializeLocalEditorRecipe(recipe: WatermarkRecipeDefinition, assets: ReadonlyMap<string, LocalEditorAsset>): WatermarkRecipeDefinition {
  const sourceToAsset = new Map<File, LocalEditorAsset>();
  for (const asset of assets.values()) sourceToAsset.set(asset.file, asset);
  return {
    ...recipe,
    layers: recipe.layers.map((layer) => {
      if (layer.type !== "image") return { ...layer, style: layer.style ? { ...layer.style } : layer.style };
      const asset = sourceToAsset.get(layer.src as File);
      if (!asset) throw new Error(editorErrorMessages.exportAssetUnavailable());
      return { ...layer, src: localAssetReference(asset) };
    }),
    output: { ...recipe.output },
  } as WatermarkRecipeDefinition;
}

export function hydrateLocalEditorAssets(recipe: WatermarkRecipeDefinition, assets: ReadonlyMap<string, LocalEditorAsset>): WatermarkRecipeDefinition {
  return {
    ...recipe,
    layers: recipe.layers.map((layer) => {
      if (layer.type !== "image") return { ...layer, style: layer.style ? { ...layer.style } : layer.style };
      if (layer.src instanceof Blob) return { ...layer };
      if (!isPersistedLocalAsset(layer.src)) {
        throw new Error(editorErrorMessages.externalAssetForbidden());
      }
      const asset = assets.get(layer.src.id);
      if (!asset) throw new Error(editorErrorMessages.assetReselectionRequired(layer.src.name));
      return { ...layer, src: asset.file };
    }),
    output: { ...recipe.output },
  } as WatermarkRecipeDefinition;
}

export function editorLayerBounds(state: EditorState, canvas: EditorSize, assets: ReadonlyMap<string, LocalEditorAsset>): EditorLayerBounds[] {
  const selected = new Set(state.selectedLayerIds);
  return state.recipe.layers.flatMap((layer) => {
    if (!selected.has(layer.id)) return [];
    const point = layer.position ?? {};
    const x = numericMeasure(point.X);
    const y = numericMeasure(point.Y);
    if (layer.type === "text") {
      const fontSize = Math.max(8, Number(layer.style?.fontSize ?? 28));
      return [{ id: layer.id, x, y, width: Math.min(canvas.width, Math.max(fontSize, layer.text.length * fontSize * 0.62)), height: fontSize * 1.25 }];
    }
    const asset = [...assets.values()].find((candidate) => candidate.file === layer.src);
    const scale = Math.max(0.01, Number(layer.scale ?? 1));
    const width = Math.min(canvas.width, Math.max(24, Math.min(asset?.width ?? 160, canvas.width * 0.6) * scale));
    const height = Math.min(canvas.height, Math.max(24, Math.min(asset?.height ?? 120, canvas.height * 0.6) * scale));
    return [{ id: layer.id, x, y, width, height }];
  });
}

function assertLocalEditorFile(file: File): void {
  if (!file || !(file instanceof Blob)) throw new Error(editorErrorMessages.localAssetRequired());
  if (file.size > 12 * 1024 * 1024) throw new Error(editorErrorMessages.localAssetTooLarge());
  if (!new Set(["image/png", "image/jpeg", "image/webp"]).has(file.type)) throw new Error(editorErrorMessages.localAssetUnsupported());
}

function localAssetReference(asset: LocalEditorAsset): PersistedLocalEditorAsset {
  return { kind: LOCAL_EDITOR_ASSET_KIND, id: asset.id, name: asset.name };
}

function isPersistedLocalAsset(value: unknown): value is PersistedLocalEditorAsset {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return record.kind === LOCAL_EDITOR_ASSET_KIND && typeof record.id === "string" && typeof record.name === "string";
}

function numericMeasure(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && !value.trim().endsWith("%")) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return 0;
}

function safeAssetName(value: string): string {
  return value.trim().slice(0, 120) || "local-image";
}
