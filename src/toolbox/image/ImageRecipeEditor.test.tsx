/** @vitest-environment jsdom */

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WebMarkerInstance } from "@image-marker/web";

import i18n from "../../i18n";
import { buildRecipeCallCode, ImageRecipeEditor } from "./ImageRecipeEditor";
import { LOCAL_EDITOR_ASSET_KIND } from "./imageEditor";

let writeText: ReturnType<typeof vi.fn>;
let fetchRequest: ReturnType<typeof vi.fn>;

beforeEach(async () => {
  await i18n.changeLanguage("zh-CN");
  writeText = vi.fn().mockResolvedValue(undefined);
  fetchRequest = vi.fn();
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText },
  });
  vi.stubGlobal("fetch", fetchRequest);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function renderEditor() {
  const onPreview = vi.fn();
  const onError = vi.fn();
  const onNotice = vi.fn();
  render(
    <ImageRecipeEditor
      marker={{ getImageInfo: vi.fn() } as unknown as WebMarkerInstance}
      desktopRuntime={false}
      disabled={false}
      onPreview={onPreview}
      onError={onError}
      onNotice={onNotice}
    />,
  );
  return { onError, onNotice, onPreview };
}

describe("ImageRecipeEditor call-code copy", () => {
  it("generates an inert local-file-only SDK example from the Recipe JSON", () => {
    const code = buildRecipeCallCode(JSON.stringify({
      schemaVersion: 2,
      layers: [{
        id: "logo",
        type: "image",
        src: { kind: LOCAL_EDITOR_ASSET_KIND, id: "asset-1", name: "brand.png" },
      }],
      output: { saveFormat: "png" },
    }, null, 2));

    expect(code).toContain('import { createWebMarker } from "@image-marker/web";');
    expect(code).toContain('"asset-1", undefined');
    expect(code).toContain("CoreRobin has not run it or accessed the network.");
    expect(code).toContain("never substitute a URL");
    expect(code).not.toMatch(/\bfetch\s*\(/);
  });

  it("copies current Recipe call code without executing its preview or network work", async () => {
    const { onError, onNotice, onPreview } = renderEditor();
    fireEvent.click(screen.getByRole("button", { name: "添加文字" }));
    onError.mockClear();

    fireEvent.click(screen.getByRole("button", { name: "复制调用代码" }));

    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
    const code = writeText.mock.calls[0]?.[0] as string;
    expect(code).toContain('"text": "版权所有"');
    expect(code).toContain("applyRecipeToLocalImage");
    expect(onNotice).toHaveBeenCalledWith("Recipe 调用代码已复制；示例没有执行，也没有访问网络。");
    expect(onError).not.toHaveBeenCalled();
    expect(onPreview).not.toHaveBeenCalled();
    expect(fetchRequest).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "复制 JSON" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(2));
    expect(JSON.parse(writeText.mock.calls[1]?.[0] as string).layers[0].text).toBe("版权所有");
    expect(onNotice).toHaveBeenLastCalledWith("Recipe JSON 已复制；复制内容不会执行。");
  });

  it("reports clipboard failures through the localized call-code error", async () => {
    writeText.mockRejectedValueOnce(new Error("clipboard denied"));
    const { onError, onNotice, onPreview } = renderEditor();
    fireEvent.click(screen.getByRole("button", { name: "添加文字" }));

    fireEvent.click(screen.getByRole("button", { name: "复制调用代码" }));

    await waitFor(() => expect(onError).toHaveBeenCalledWith("无法复制 Recipe 调用代码。"));
    expect(onNotice).not.toHaveBeenCalled();
    expect(onPreview).not.toHaveBeenCalled();
  });
});
