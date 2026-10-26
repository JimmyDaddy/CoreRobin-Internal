/** @vitest-environment jsdom */
import { act, cleanup, fireEvent, render, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { layoutCleanupMap, type CleanupMapNode } from "../cleanupMap";
import { getMockCleanupScan } from "../mockData";
import { CleanupScanEffects, useCleanupScanMotion } from "./CleanupScanVisual";
import type { CleanupScanJobPhase } from "../types";

afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); });

describe("scan motion follows worker activity", () => {
  it("preserves worker activity until the worker pauses or the document hides", () => {
    vi.useFakeTimers();
    const props = { phase: "scanning" as CleanupScanJobPhase, entries: 100 };
    const hook = renderHook(({ phase }) => useCleanupScanMotion(phase), { initialProps: props });
    expect(hook.result.current).toBe(true);
    act(() => vi.advanceTimersByTime(6_500));
    expect(hook.result.current).toBe(true);
    hook.rerender({ ...props, entries: 101 });
    expect(hook.result.current).toBe(true);
    const visibility = vi.spyOn(document, "visibilityState", "get");
    visibility.mockReturnValue("hidden");
    fireEvent(document, new Event("visibilitychange"));
    expect(hook.result.current).toBe(false);
    visibility.mockReturnValue("visible");
    fireEvent(document, new Event("visibilitychange"));
    expect(hook.result.current).toBe(true);
    for (const phase of ["paused", "stalled", "cancelling", "completed", "failed", "cancelled"] as const) {
      hook.rerender({ ...props, phase });
      expect(hook.result.current).toBe(false);
    }
    hook.rerender({ ...props, phase: "finalizing" });
    expect(hook.result.current).toBe(true);
  });

  it("limits data bursts, ignores navigation and settles once on completion", () => {
    vi.useFakeTimers();
    const root = getMockCleanupScan().root as CleanupMapNode;
    const props = { arcs: layoutCleanupMap(root), phase: "scanning" as CleanupScanJobPhase, scanKey: "scan", focusKey: root.id, running: true };
    const view = render(<CleanupScanEffects {...props} arcs={[]} />);
    view.rerender(<CleanupScanEffects {...props} />);
    expect(view.container.querySelectorAll(".scan-fx-shine").length).toBeGreaterThan(0);
    expect(view.container.querySelectorAll(".scan-fx-shine").length).toBeLessThanOrEqual(5);
    view.rerender(<CleanupScanEffects {...props} focusKey="other-folder" />);
    expect(view.container.querySelector(".scan-fx-arrival")).toBeNull();
    view.rerender(<CleanupScanEffects {...props} phase="completed" running={false} />);
    expect(view.container.querySelector(".scan-fx-wave")).not.toBeNull();
    act(() => vi.advanceTimersByTime(1_400));
    expect(view.container.querySelector(".scan-fx-wave")).toBeNull();
    view.rerender(<CleanupScanEffects {...props} arcs={[...props.arcs]} phase="completed" running={false} />);
    expect(view.container.querySelector(".scan-fx-wave")).toBeNull();
    expect(view.container.querySelector(".scan-fx-seal")).not.toBeNull();
  });
});
