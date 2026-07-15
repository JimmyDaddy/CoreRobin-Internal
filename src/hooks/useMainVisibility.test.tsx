/** @vitest-environment jsdom */

import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { listen } from "@tauri-apps/api/event";
import { useMainVisibility } from "./useMainVisibility";

vi.mock("../api", () => ({ isDesktopRuntime: () => true }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));

type VisibilityHandler = (event: { payload: boolean }) => void;

let visibilityState: DocumentVisibilityState;
let backendHandler: VisibilityHandler | null;

beforeEach(() => {
  visibilityState = "visible";
  backendHandler = null;
  vi.spyOn(document, "visibilityState", "get").mockImplementation(
    () => visibilityState,
  );
  vi.mocked(listen).mockReset().mockImplementation(async (_event, handler) => {
    backendHandler = handler as VisibilityHandler;
    return () => undefined;
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("main window visibility", () => {
  it("combines backend show/hide events with document visibility and ignores focus", async () => {
    const { result } = renderHook(() => useMainVisibility());
    await act(async () => Promise.resolve());
    expect(result.current).toBe(true);

    act(() => window.dispatchEvent(new Event("blur")));
    expect(result.current).toBe(true);

    visibilityState = "hidden";
    act(() => document.dispatchEvent(new Event("visibilitychange")));
    expect(result.current).toBe(false);

    visibilityState = "visible";
    act(() => document.dispatchEvent(new Event("visibilitychange")));
    expect(result.current).toBe(true);

    act(() => backendHandler?.({ payload: false }));
    expect(result.current).toBe(false);
    act(() => backendHandler?.({ payload: true }));
    expect(result.current).toBe(true);
  });
});
