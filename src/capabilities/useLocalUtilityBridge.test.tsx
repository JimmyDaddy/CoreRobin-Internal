/** @vitest-environment jsdom */
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useLocalUtilityBridge } from "./useLocalUtilityBridge";
import { clearSharedToolState, useSharedToolState } from "../toolbox/local/sharedToolState";
const native = vi.hoisted(() => ({ invoke: vi.fn(), listen: vi.fn(), event: undefined as undefined | ((event: { payload: string }) => void) }));
vi.mock("../api", () => ({ isDesktopRuntime: () => true }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: native.invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: native.listen }));
function useHost() {
  useLocalUtilityBridge();
  const [input, setInput] = useSharedToolState("json", "input", "");
  const [output] = useSharedToolState("json", "output", "");
  return { input, output, setInput };
}
beforeEach(() => { vi.clearAllMocks(); clearSharedToolState(); native.listen.mockImplementation(async (_name, callback) => { native.event = callback; return () => {}; }); });
afterEach(cleanup);

it("computes only supplied model text and publishes to the same fields after native acceptance", async () => {
  let accept!: () => void;
  native.invoke.mockImplementation(async (name) => {
    if (name === "ai_pending_utility_requests") return [];
    if (name === "ai_claim_utility_request") return { operation: "json_format", input: '{"big":900719925474099312345}' };
    if (name === "ai_complete_utility_request") return new Promise<void>((resolve) => { accept = resolve; });
  });
  const hook = renderHook(useHost);
  await waitFor(() => expect(native.invoke).toHaveBeenCalledWith("ai_pending_utility_requests"));
  act(() => { hook.result.current.setInput("Private previous local input"); native.event?.({ payload: "native-1" }); native.event?.({ payload: "native-1" }); });
  await waitFor(() => expect(accept).toBeTypeOf("function"));
  expect(hook.result.current.input).toBe("Private previous local input");
  expect(native.invoke.mock.calls.filter(([name]) => name === "ai_claim_utility_request")).toHaveLength(1);
  expect(JSON.stringify(native.invoke.mock.calls)).not.toContain("Private previous local input");
  await act(async () => accept());
  expect(hook.result.current.output).toContain("900719925474099312345");
  expect(hook.result.current.input).toBe('{"big":900719925474099312345}');
});

it.each(["clear", "edit", "reject"])("does not overwrite state after %s while completion is pending", async (change) => {
  let finish!: () => void; let reject!: (error: unknown) => void;
  native.invoke.mockImplementation(async (name) => {
    if (name === "ai_pending_utility_requests") return [];
    if (name === "ai_claim_utility_request") return { operation: "json_format", input: '{"old":true}' };
    if (name === "ai_complete_utility_request") return new Promise<void>((resolve, fail) => { finish = resolve; reject = fail; });
  });
  const hook = renderHook(useHost);
  await waitFor(() => expect(native.invoke).toHaveBeenCalledWith("ai_pending_utility_requests"));
  act(() => native.event?.({ payload: "native-2" }));
  await waitFor(() => expect(finish).toBeTypeOf("function"));
  await act(async () => {
    if (change === "clear") clearSharedToolState();
    if (change === "edit") hook.result.current.setInput("newer user edit");
    if (change === "reject") reject({ code: "cancelled" }); else finish();
  });
  expect(hook.result.current.output).toBe("");
  expect(hook.result.current.input).toBe(change === "edit" ? "newer user edit" : "");
});

it("preserves edits made while the native claim is still pending", async () => {
  let claim!: (args: unknown) => void;
  native.invoke.mockImplementation(async (name) => {
    if (name === "ai_pending_utility_requests") return [];
    if (name === "ai_claim_utility_request") return new Promise((resolve) => { claim = resolve; });
  });
  const hook = renderHook(useHost);
  await waitFor(() => expect(native.invoke).toHaveBeenCalledWith("ai_pending_utility_requests"));
  act(() => native.event?.({ payload: "native-3" }));
  act(() => hook.result.current.setInput("Edited while receiving the request"));
  await act(async () => claim({ operation: "json_format", input: '{"model":true}' }));
  await waitFor(() => expect(native.invoke).toHaveBeenCalledWith("ai_complete_utility_request", expect.anything()));
  expect(hook.result.current.input).toBe("Edited while receiving the request");
  expect(hook.result.current.output).toBe("");
});
