/** @vitest-environment jsdom */
import { act, cleanup, fireEvent, renderHook } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { useCleanupMotionAllowed } from "./CleanupScanVisual";

afterEach(() => {
  cleanup();
  delete document.documentElement.dataset.reduceMotion;
  vi.restoreAllMocks();
});

it("updates immediately for visibility and both system and application motion preferences", async () => {
  const media = new EventTarget();
  let reduced = false;
  Object.defineProperty(media, "matches", { get: () => reduced });
  vi.stubGlobal("matchMedia", () => media);
  const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
  const hook = renderHook(useCleanupMotionAllowed);
  expect(hook.result.current).toBe(true);
  visibility.mockReturnValue("hidden");
  fireEvent(document, new Event("visibilitychange"));
  expect(hook.result.current).toBe(false);
  visibility.mockReturnValue("visible");
  fireEvent(document, new Event("visibilitychange"));
  expect(hook.result.current).toBe(true);
  act(() => { reduced = true; media.dispatchEvent(new Event("change")); });
  expect(hook.result.current).toBe(false);
  act(() => { reduced = false; media.dispatchEvent(new Event("change")); });
  expect(hook.result.current).toBe(true);
  await act(async () => { document.documentElement.dataset.reduceMotion = "true"; });
  expect(hook.result.current).toBe(false);
  await act(async () => { delete document.documentElement.dataset.reduceMotion; });
  expect(hook.result.current).toBe(true);
  hook.unmount();
  vi.unstubAllGlobals();
});
