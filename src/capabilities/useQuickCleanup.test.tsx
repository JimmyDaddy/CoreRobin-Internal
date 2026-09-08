/** @vitest-environment jsdom */
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useQuickCleanup, type QuickCleanSnapshot } from "./useQuickCleanup";

const api = vi.hoisted(() => ({ getQuickCleanupState: vi.fn(), analyzeQuickCleanup: vi.fn(), runQuickCleanup: vi.fn(), cancelQuickCleanup: vi.fn() }));
const events = vi.hoisted(() => new Set<(id: string) => void>());
vi.mock("../api", () => ({ ...api, isDesktopRuntime: () => true }));
vi.mock("./api", () => ({ subscribeApplicationCapabilities: async (fn: (id: string) => void) => { events.add(fn); return () => events.delete(fn); } }));
let view: QuickCleanSnapshot;
const summaries: QuickCleanSnapshot["summaries"] = [{ category: "logs", byteSize: 10, itemCount: 1, skippedCount: 0, available: true }];
const emit = () => { for (const callback of events) callback("quick_clean"); };
beforeEach(() => {
  vi.clearAllMocks(); events.clear();
  view = { revision: 1, phase: "idle", summaries: [], progress: null, result: null, error: null, cancelled: false };
  api.getQuickCleanupState.mockImplementation(async () => structuredClone(view));
});
afterEach(cleanup);

it("adopts AI analysis in both operation instances and preserves the user's category selection", async () => {
  const first = renderHook(useQuickCleanup); const second = renderHook(useQuickCleanup);
  await waitFor(() => expect(api.getQuickCleanupState).toHaveBeenCalledTimes(2));
  await act(async () => { view = { ...view, revision: 2, phase: "selection", summaries }; emit(); });
  expect(first.result.current.summaries).toEqual(summaries);
  expect(second.result.current.selected.has("logs")).toBe(true);
  act(() => first.result.current.toggleCategory("logs"));
  await act(async () => { view = { ...view, revision: 3 }; emit(); });
  expect(first.result.current.selected.has("logs")).toBe(false);
  expect(api.analyzeQuickCleanup).not.toHaveBeenCalled();
  expect(api.runQuickCleanup).not.toHaveBeenCalled();
});

it("rejects a late old snapshot and a cancelled worker after privacy clearing", async () => {
  let finish!: (items: typeof summaries) => void;
  let oldReply!: (snapshot: QuickCleanSnapshot) => void;
  api.analyzeQuickCleanup.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
  const hook = renderHook(useQuickCleanup);
  await waitFor(() => expect(api.getQuickCleanupState).toHaveBeenCalled());
  let work!: Promise<void>;
  act(() => { work = hook.result.current.analyze(); });
  api.getQuickCleanupState.mockImplementationOnce(() => new Promise((resolve) => { oldReply = resolve; }));
  act(emit);
  await act(async () => { view = { ...view, revision: 6 }; emit(); });
  await act(async () => { oldReply({ ...view, revision: 4, phase: "selection", summaries }); });
  await act(async () => { finish(summaries); await work; });
  expect(hook.result.current.phase).toBe("idle");
  expect(hook.result.current.summaries).toEqual([]);
  expect(hook.result.current.error).toBeNull();
});

it("recovers from a rejected start without leaving an optimistic busy state", async () => {
  api.analyzeQuickCleanup.mockRejectedValue({ code: "privacy_clear_in_progress", message: "Source clearing is active" });
  const hook = renderHook(useQuickCleanup);
  await waitFor(() => expect(api.getQuickCleanupState).toHaveBeenCalled());
  await act(async () => hook.result.current.analyze());
  expect(hook.result.current.phase).toBe("idle");
  expect(hook.result.current.error).toBe("Source clearing is active");
});
