/** @vitest-environment jsdom */

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ToolboxPanel } from "./ToolboxPanel";

const modules = vi.hoisted(() => {
  let releaseImage: () => void = () => undefined;
  const imageReady = new Promise<void>((resolve) => { releaseImage = resolve; });
  return { imageLoaded: vi.fn(), patchLoaded: vi.fn(), imageReady, releaseImage };
});

vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: () => "正在加载" }) }));
vi.mock("./image/ImageToolbox", async () => {
  modules.imageLoaded();
  await modules.imageReady;
  return { ImageToolbox: ({ toolId }: { toolId: string }) => <div data-testid="image-tool">{toolId}</div> };
});
vi.mock("./binary-patch/BinaryPatchToolbox", () => {
  modules.patchLoaded();
  return { BinaryPatchToolbox: ({ toolId }: { toolId: string }) => <div data-testid="patch-tool">{toolId}</div> };
});

afterEach(cleanup);

it("loads image and patch modules only on demand while retaining the page navigation", async () => {
  render(<ToolboxPanel />);
  expect(modules.imageLoaded).not.toHaveBeenCalled();
  expect(modules.patchLoaded).not.toHaveBeenCalled();

  fireEvent.click(screen.getByText("图片水印").closest("button")!);
  expect(screen.getByRole("status").textContent).toBe("正在加载");
  expect(screen.getByRole("button", { name: "返回工具箱" })).toBeTruthy();
  await act(async () => { modules.releaseImage(); });
  expect((await screen.findByTestId("image-tool")).textContent).toBe("image-watermark");
  expect(modules.imageLoaded).toHaveBeenCalledOnce();
  expect(modules.patchLoaded).not.toHaveBeenCalled();

  fireEvent.click(screen.getByRole("button", { name: "返回工具箱" }));
  fireEvent.click(screen.getByText("生成补丁").closest("button")!);
  expect((await screen.findByTestId("patch-tool")).textContent).toBe("binary-patch-create");
  expect(modules.patchLoaded).toHaveBeenCalledOnce();
});
