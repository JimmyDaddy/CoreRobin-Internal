import { describe, expect, it } from "vitest";

import { LocalImageEditor, parseLocalEditorRecipe } from "./imageEditor";

function localLogo(name = "logo.png"): File {
  return new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], name, { type: "image/png" });
}

describe("local image editor interactions", () => {
  it("drives real SDK selection, transforms, grouping, alignment, stacking, visibility, locking and history", () => {
    const editor = new LocalImageEditor();
    const first = editor.addText("第一层", { x: 20, y: 30 });
    const second = editor.addText("第二层", { x: 180, y: 90 });
    const asset = editor.registerAsset(localLogo(), { width: 120, height: 80 });
    const image = editor.addImageAsset(asset, { x: 320, y: 120 });

    editor.select(first);
    editor.select(second, "add");
    editor.moveSelection({ x: 16, y: -8 });
    editor.alignSelection("left", { width: 800, height: 600 });
    expect(editor.getState().selectedLayerIds).toEqual([first, second]);
    expect(editor.getState().recipe.layers.find((layer) => layer.id === first)?.position?.X).toBe(0);
    expect(editor.getState().recipe.layers.find((layer) => layer.id === second)?.position?.X).toBe(0);

    const copies = editor.duplicateSelection();
    expect(copies).toHaveLength(2);
    expect(editor.groupSelection()).toBeTruthy();
    editor.moveSelection({ x: 12, y: 4 });
    expect(editor.ungroupSelection()).toEqual(["group"]);
    expect(editor.getState().recipe.layers.filter((layer) => copies.includes(layer.id)).every((layer) => !layer.groupId)).toBe(true);

    editor.select(image);
    editor.scalePrimary(0.5);
    editor.rotatePrimary(45);
    editor.reorderPrimary(-2);
    editor.setSelectionVisible(false);
    editor.setSelectionLocked(true);
    const imageLayer = editor.getState().recipe.layers.find((layer) => layer.id === image);
    expect(imageLayer).toMatchObject({ type: "image", scale: 0.5, rotate: 45, visible: false, locked: true });
    expect(() => editor.moveSelection({ x: 1, y: 1 })).toThrow("locked");
    expect(editor.undo()).toBe(true);
    expect(editor.getState().recipe.layers.find((layer) => layer.id === image)?.locked).not.toBe(true);
    expect(editor.redo()).toBe(true);
    expect(editor.getState().recipe.layers.find((layer) => layer.id === image)?.locked).toBe(true);
    editor.dispose();
  });

  it("migrates v1, serializes only opaque local asset references, and rejects external or missing resources", () => {
    const editor = new LocalImageEditor();
    const asset = editor.registerAsset(localLogo("brand.webp"));
    editor.addImageAsset(asset);
    const exported = editor.exportRecipeJson();
    const serialized = JSON.parse(exported) as { layers: Array<{ src?: unknown }> };
    expect(serialized.layers[0]?.src).toMatchObject({ kind: "corerobin-local-image-asset", id: asset.id, name: "brand.webp" });
    expect(exported).not.toContain("data:image");

    const restored = new LocalImageEditor();
    restored.registerAsset(localLogo("brand.webp"));
    expect(restored.importRecipeJson(exported).migrated).toBe(false);
    expect(restored.getState().recipe.layers[0]?.type).toBe("image");

    const legacy = JSON.stringify({ schemaVersion: 1, watermarks: [{ type: "text", text: "旧配方" }], saveFormat: "png" });
    expect(editor.importRecipeJson(legacy).migrated).toBe(true);

    const remote = JSON.stringify({ schemaVersion: 2, layers: [{ id: "remote", type: "image", src: "https://example.invalid/logo.png" }], output: { saveFormat: "png" } });
    expect(() => parseLocalEditorRecipe(remote, new Map())).toThrow("拒绝 URL");
    expect(() => new LocalImageEditor().importRecipeJson(exported)).toThrow("重新选择");
    editor.dispose();
    restored.dispose();
  });
});
