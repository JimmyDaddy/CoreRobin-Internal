/** @vitest-environment jsdom */
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ToolboxJob } from "../contracts";

const mocks = vi.hoisted(() => ({ start: vi.fn(), prepare: vi.fn(), cancel: vi.fn(), finish: vi.fn(), hash: vi.fn() }));
vi.mock("../../api", () => ({ isDesktopRuntime: () => true, hashToolboxFile: mocks.hash }));
vi.mock("../client", () => ({
  newToolboxRequest: () => ({ requestId: "request" }),
  startToolboxSession: mocks.start,
  prepareToolboxInputs: mocks.prepare,
  finishToolboxJob: mocks.finish,
  cancelToolboxJob: mocks.cancel,
}));
import { FileHashTool } from "./FileHashTool";

const job: ToolboxJob = { jobId: "job", sessionId: "session", generation: 1, resetEpoch: 3, status: "running", outputExpiresAtMs: null, terminalReason: null, error: null };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.start.mockResolvedValue(job);
  mocks.prepare.mockResolvedValue([{ token: "opaque-input", displayName: "fixture.bin" }]);
  mocks.hash.mockResolvedValue({ digest: "abc123", generation: 1, resetEpoch: 3 });
  mocks.finish.mockResolvedValue({ ...job, status: "completed" });
  mocks.cancel.mockResolvedValue({ ...job, status: "cancelled" });
});
afterEach(cleanup);

it("hashes an opaque native selection and publishes only after native completion", async () => {
  render(<FileHashTool />);
  fireEvent.click(screen.getByRole("button", { name: "选择文件并计算" }));
  expect(await screen.findByText("abc123")).toBeTruthy();
  expect(mocks.hash).toHaveBeenCalledWith({ requestId: "request", job: { jobId: "job", generation: 1, resetEpoch: 3 }, token: "opaque-input" }, expect.any(Function));
  expect(mocks.finish).toHaveBeenCalledWith(expect.objectContaining({ jobId: "job", succeeded: true }));
});

it("cancels a start acknowledgement that arrives after leaving the page", async () => {
  let resolve!: (value: ToolboxJob) => void;
  mocks.start.mockReturnValue(new Promise<ToolboxJob>((done) => { resolve = done; }));
  const view = render(<FileHashTool />);
  fireEvent.click(screen.getByRole("button", { name: "选择文件并计算" }));
  view.unmount();
  await act(async () => { resolve(job); });
  expect(mocks.prepare).not.toHaveBeenCalled();
  expect(mocks.cancel).toHaveBeenCalledWith(expect.objectContaining({ jobId: "job" }));
});

it("keeps stopping visible and rejects a late successful digest", async () => {
  let resolve!: (value: { digest: string }) => void;
  mocks.hash.mockReturnValue(new Promise((done) => { resolve = done; }));
  render(<FileHashTool />);
  fireEvent.click(screen.getByRole("button", { name: "选择文件并计算" }));
  await waitFor(() => expect(mocks.hash).toHaveBeenCalledOnce());
  fireEvent.click(screen.getByRole("button", { name: "停止" }));
  expect(screen.getByRole("button", { name: "正在停止…" })).toBeTruthy();
  await act(async () => { resolve({ digest: "late-digest" }); });
  expect(screen.queryByText("late-digest")).toBeNull();
  expect(mocks.finish).not.toHaveBeenCalled();
});

it("retains the stop action when native resource release is unconfirmed", async () => {
  mocks.hash.mockRejectedValue(new Error("read failed"));
  mocks.cancel.mockResolvedValue({ ...job, status: "stopping" });
  render(<FileHashTool />);
  fireEvent.click(screen.getByRole("button", { name: "选择文件并计算" }));
  expect(await screen.findByRole("button", { name: "正在停止…" })).toBeTruthy();
  mocks.cancel.mockResolvedValue({ ...job, status: "cancelled" });
  fireEvent.click(screen.getByRole("button", { name: "正在停止…" }));
  await waitFor(() => expect(screen.queryByRole("button", { name: "正在停止…" })).toBeNull());
});
