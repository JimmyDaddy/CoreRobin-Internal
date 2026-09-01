/** @vitest-environment jsdom */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import i18n from "../../i18n";

const mocks = vi.hoisted(() => ({
  createObjectUrl: vi.fn(() => "blob:patch-plan"),
  applyPatchAndVerify: vi.fn(),
  planPatches: vi.fn(),
  planPatchesFromSources: vi.fn(),
  createPatchCollection: vi.fn(),
  cancel: vi.fn(),
  desktopRuntime: false,
  finish: vi.fn(),
  generateVerifiedPatch: vi.fn(),
  prepare: vi.fn(),
  readBound: vi.fn(),
  register: vi.fn(),
  release: vi.fn(),
  revalidate: vi.fn(),
  start: vi.fn(),
}));

vi.mock("../../api", () => ({ isDesktopRuntime: () => mocks.desktopRuntime }));
vi.mock("../client", () => ({
  cancelToolboxJob: mocks.cancel,
  cancelToolboxOutput: vi.fn(),
  exportToolboxOutput: vi.fn(),
  finishToolboxJob: mocks.finish,
  newToolboxRequest: () => ({ requestId: "request" }),
  prepareToolboxInputs: mocks.prepare,
  registerToolboxOutput: mocks.register,
  releaseToolboxInputs: mocks.release,
  revalidateToolboxInputs: mocks.revalidate,
  startToolboxSession: mocks.start,
}));
vi.mock("../runtime/files", () => ({
  fileJobKey: (job: { jobId: string; generation: number; resetEpoch: number }) => ({ jobId: job.jobId, generation: job.generation, resetEpoch: job.resetEpoch }),
  readBoundToolboxInput: mocks.readBound,
}));
vi.mock("./binaryPatchTools", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./binaryPatchTools")>();
  return { ...actual, applyPatchAndVerify: mocks.applyPatchAndVerify, createPatchCollection: mocks.createPatchCollection, generateVerifiedPatch: mocks.generateVerifiedPatch, planPatches: mocks.planPatches, planPatchesFromSources: mocks.planPatchesFromSources };
});

import { BinaryPatchToolbox } from "./BinaryPatchToolbox";

beforeEach(async () => {
  vi.clearAllMocks();
  mocks.desktopRuntime = false;
  await i18n.changeLanguage("zh-CN");
  vi.stubGlobal("URL", { createObjectURL: mocks.createObjectUrl, revokeObjectURL: vi.fn() });
  mocks.planPatches.mockResolvedValue({ results: [] });
  mocks.planPatchesFromSources.mockResolvedValue({ results: [] });
  mocks.createPatchCollection.mockResolvedValue({
    bytes: new Uint8Array([80, 75]),
    filename: "corerobin-patch-collection.zip",
    plan: {
      version: 1,
      format: "react-native-bs-diff-patch/verified-bundle-v1",
      target: { bytes: 1, sha256: "a".repeat(64) },
      full: { bytes: 1, sha256: "a".repeat(64) },
      patches: [],
    },
  });
  mocks.start.mockResolvedValue({ jobId: "job", sessionId: "session", generation: 1, resetEpoch: 3, status: "running", outputExpiresAtMs: null, outputToken: null, terminalReason: null, error: null });
  mocks.cancel.mockResolvedValue({ jobId: "job", sessionId: "session", generation: 1, resetEpoch: 3, status: "cancelled", outputExpiresAtMs: null, outputToken: null, terminalReason: "cancelled", error: null });
  mocks.finish.mockResolvedValue({ jobId: "job", sessionId: "session", generation: 1, resetEpoch: 3, status: "failed", outputExpiresAtMs: null, outputToken: null, terminalReason: "failed", error: null });
  mocks.prepare.mockImplementation(async (_job, role) => [{ token: role, displayName: `${role}.bin` }]);
  mocks.readBound.mockImplementation(async (_job, token) => new Uint8Array(token.token === "input" ? [6] : token.token === "patch" ? [8] : [7]));
  mocks.applyPatchAndVerify.mockResolvedValue({ output: new Uint8Array([7]), verification: { verified: true }, byteExact: true });
  mocks.generateVerifiedPatch.mockResolvedValue({ patch: new Uint8Array([80, 75]), verification: { verified: true }, baselineSha256: "a".repeat(64), targetSha256: "b".repeat(64) });
  mocks.revalidate.mockResolvedValue(undefined);
  mocks.release.mockResolvedValue(undefined);
  mocks.register.mockResolvedValue({ jobId: "job", sessionId: "session", generation: 1, resetEpoch: 3, status: "output_ready", outputExpiresAtMs: 99, outputToken: { token: "output", jobId: "job", generation: 1, resetEpoch: 3, byteLength: 2, expiresAtMs: 99, validation: "verified" }, terminalReason: null, error: null });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it("turns a browser release plan into a downloadable formal patch collection", async () => {
  const target = new File([new Uint8Array([7])], "target.bin", { type: "application/octet-stream" });
  const baseline = new File([new Uint8Array([6])], "baseline.bin", { type: "application/octet-stream" });
  const view = render(<BinaryPatchToolbox toolId="patch-planner" />);
  const inputs = view.container.querySelectorAll<HTMLInputElement>('input[type="file"]');
  fireEvent.change(inputs[0], { target: { files: [target] } });
  fireEvent.change(inputs[1], { target: { files: [baseline] } });

  fireEvent.click(screen.getByRole("button", { name: "逐基线规划" }));

  const download = await screen.findByRole("link", { name: "下载计划/补丁集合预览（非正式导出）" });
  await waitFor(() => expect(mocks.createPatchCollection).toHaveBeenCalledOnce());
  expect(mocks.planPatches).toHaveBeenCalledWith(new Uint8Array([7]), [{ name: "baseline.bin", data: new Uint8Array([6]) }], 0.8, expect.any(AbortSignal));
  expect(mocks.createPatchCollection).toHaveBeenCalledWith({ name: "target.bin", data: new Uint8Array([7]) }, { results: [] });
  expect(download.getAttribute("download")).toBe("corerobin-patch-collection.zip");
  expect(download.getAttribute("href")).toBe("blob:patch-plan");
});

it("renders only the actual offset-aligned binary changes from selected inputs", async () => {
  const baseline = new File([new Uint8Array([0x01, 0x02])], "baseline.bin", { type: "application/octet-stream" });
  const target = new File([new Uint8Array([0x01, 0x03, 0x04])], "target.bin", { type: "application/octet-stream" });
  const view = render(<BinaryPatchToolbox toolId="binary-patch-create" />);
  const inputs = view.container.querySelectorAll<HTMLInputElement>('input[type="file"]');
  fireEvent.change(inputs[0], { target: { files: [baseline] } });
  fireEvent.change(inputs[1], { target: { files: [target] } });

  fireEvent.click(screen.getByRole("button", { name: "生成并验证补丁" }));

  expect(await screen.findAllByText("0x00000000")).toHaveLength(2);
  expect(screen.getByText("01 02")).toBeTruthy();
  expect(screen.getByText("01 03 04")).toBeTruthy();
});

it("keeps desktop patch output on the native TTL and atomic-save path", async () => {
  mocks.desktopRuntime = true;
  render(<BinaryPatchToolbox toolId="binary-patch-create" />);

  fireEvent.click(screen.getByRole("button", { name: "生成并验证补丁" }));

  expect(await screen.findByRole("button", { name: "正式另存结果" })).toBeTruthy();
  expect(screen.queryByRole("link", { name: /下载预览副本/ })).toBeNull();
  expect(mocks.createObjectUrl).not.toHaveBeenCalled();
  expect(mocks.register).toHaveBeenCalledWith(expect.objectContaining({
    bytes: new Uint8Array([80, 75]),
    jobId: "job",
    validation: "verified",
  }));
  expect(mocks.prepare.mock.calls.map(([, role]) => role)).toEqual(["input", "target"]);
});

it("keeps desktop patch planning lazy across native baseline tokens", async () => {
  mocks.desktopRuntime = true;
  mocks.planPatchesFromSources.mockImplementation(async (_target, sources) => {
    expect(sources).toHaveLength(1);
    await expect(sources[0].load(new AbortController().signal)).resolves.toEqual(new Uint8Array([6]));
    return { results: [] };
  });
  render(<BinaryPatchToolbox toolId="patch-planner" />);

  fireEvent.click(screen.getByRole("button", { name: "逐基线规划" }));

  await screen.findByRole("button", { name: "正式另存结果" });
  expect(mocks.planPatchesFromSources).toHaveBeenCalledOnce();
  expect(mocks.planPatches).not.toHaveBeenCalled();
  expect(mocks.readBound.mock.calls.map(([, token]) => token.token)).toEqual(["target", "input"]);
});

it("marks an integrity manifest verified only after a byte-exact replay", async () => {
  mocks.desktopRuntime = true;
  render(<BinaryPatchToolbox toolId="integrity-manifest" />);

  fireEvent.click(screen.getByRole("button", { name: "生成完整性清单" }));

  await screen.findByRole("button", { name: "正式另存结果" });
  expect(mocks.applyPatchAndVerify).toHaveBeenCalledWith(new Uint8Array([6]), new Uint8Array([8]), new Uint8Array([7]), expect.any(AbortSignal));
  expect(mocks.prepare.mock.calls.map(([, role]) => role)).toEqual(["input", "target", "patch"]);
  expect(mocks.register).toHaveBeenCalledWith(expect.objectContaining({ validation: "verified" }));
  expect(screen.getByText(/replay_byte_exact/)).toBeTruthy();
});

it("keeps an integrity manifest unverified when replay cannot prove it", async () => {
  mocks.desktopRuntime = true;
  mocks.applyPatchAndVerify.mockRejectedValue(Object.assign(new Error("Patch replay failed."), { code: "EVERIFICATION" }));
  render(<BinaryPatchToolbox toolId="integrity-manifest" />);

  fireEvent.click(screen.getByRole("button", { name: "生成完整性清单" }));

  await screen.findByRole("button", { name: "正式另存结果" });
  expect(mocks.register).toHaveBeenCalledWith(expect.objectContaining({ validation: "unverified" }));
  expect(screen.getByText(/EVERIFICATION/)).toBeTruthy();
});

it("does not report a second input release after a terminal native failure already released ownership", async () => {
  mocks.desktopRuntime = true;
  mocks.generateVerifiedPatch.mockRejectedValueOnce(new Error("patch failed"));
  render(<BinaryPatchToolbox toolId="binary-patch-create" />);

  fireEvent.click(screen.getByRole("button", { name: "生成并验证补丁" }));

  await waitFor(() => expect(mocks.finish).toHaveBeenCalledOnce());
  expect(mocks.release).not.toHaveBeenCalled();
  expect(screen.getByRole("alert").textContent).not.toContain("输入资源释放未确认");
});

it("keeps native cleanup as stopping until cancellation is confirmed", async () => {
  mocks.desktopRuntime = true;
  mocks.generateVerifiedPatch.mockImplementation(() => new Promise(() => undefined));
  mocks.cancel.mockResolvedValueOnce({ jobId: "job", sessionId: "session", generation: 1, resetEpoch: 3, status: "stopping", outputExpiresAtMs: null, outputToken: null, terminalReason: "release_unconfirmed", error: null });
  render(<BinaryPatchToolbox toolId="binary-patch-create" />);

  fireEvent.click(screen.getByRole("button", { name: "生成并验证补丁" }));
  await waitFor(() => expect(mocks.generateVerifiedPatch).toHaveBeenCalledOnce());
  fireEvent.click(screen.getByRole("button", { name: "停止" }));

  expect((await screen.findByRole("alert")).textContent).toContain("原生任务生命周期未确认");
  expect((screen.getByRole("button", { name: "生成并验证补丁" }) as HTMLButtonElement).disabled).toBe(true);
  expect(screen.queryByText(/"state": "cancelled"/)).toBeNull();

  mocks.cancel.mockResolvedValueOnce({ jobId: "job", sessionId: "session", generation: 1, resetEpoch: 3, status: "cancelled", outputExpiresAtMs: null, outputToken: null, terminalReason: "cancelled", error: null });
  fireEvent.click(screen.getByRole("button", { name: "停止" }));

  await waitFor(() => expect((screen.getByRole("button", { name: "生成并验证补丁" }) as HTMLButtonElement).disabled).toBe(false));
  expect(screen.getByRole("alert").textContent).toContain("任务已取消");
});

it("does not present a deadline with unconfirmed native release as cancelled", async () => {
  mocks.desktopRuntime = true;
  mocks.generateVerifiedPatch.mockRejectedValueOnce(Object.assign(new Error("deadline"), { code: "EDEADLINE" }));
  mocks.finish.mockResolvedValueOnce({ jobId: "job", sessionId: "session", generation: 1, resetEpoch: 3, status: "stopping", outputExpiresAtMs: null, outputToken: null, terminalReason: "release_unconfirmed", error: null });
  render(<BinaryPatchToolbox toolId="binary-patch-create" />);

  fireEvent.click(screen.getByRole("button", { name: "生成并验证补丁" }));

  expect((await screen.findByRole("alert")).textContent).toContain("原生任务生命周期未确认");
  expect(mocks.cancel).not.toHaveBeenCalled();
  expect(screen.queryByText(/"state": "cancelled"/)).toBeNull();

  mocks.cancel.mockResolvedValueOnce({ jobId: "job", sessionId: "session", generation: 1, resetEpoch: 3, status: "cancelled", outputExpiresAtMs: null, outputToken: null, terminalReason: "cancelled", error: null });
  fireEvent.click(screen.getByRole("button", { name: "停止" }));

  await waitFor(() => expect(screen.queryAllByText(/deadline_exceeded/).length).toBeGreaterThan(0));
  expect(screen.getByRole("alert").textContent).toContain("补丁工具执行失败");
});

it("rejects an oversized web baseline before reading it", async () => {
  const readBytes = vi.fn();
  const oversized = { name: "too-large-baseline.bin", size: 16 * 1024 * 1024 + 1, arrayBuffer: readBytes } as unknown as File;
  const target = new File([new Uint8Array([7])], "target.bin", { type: "application/octet-stream" });
  const view = render(<BinaryPatchToolbox toolId="binary-patch-create" />);
  const inputs = view.container.querySelectorAll<HTMLInputElement>('input[type="file"]');
  fireEvent.change(inputs[0], { target: { files: [oversized] } });
  fireEvent.change(inputs[1], { target: { files: [target] } });

  fireEvent.click(screen.getByRole("button", { name: "生成并验证补丁" }));

  await waitFor(() => expect(screen.getByRole("alert")).toBeTruthy());
  expect(readBytes).not.toHaveBeenCalled();
});

it("rejects an oversized web target before reading it", async () => {
  const readBytes = vi.fn();
  const baseline = new File([new Uint8Array([6])], "baseline.bin", { type: "application/octet-stream" });
  const patch = new File([new Uint8Array([8])], "patch.bin", { type: "application/octet-stream" });
  const oversized = { name: "too-large-target.bin", size: 16 * 1024 * 1024 + 1, arrayBuffer: readBytes } as unknown as File;
  const view = render(<BinaryPatchToolbox toolId="integrity-manifest" />);
  const inputs = view.container.querySelectorAll<HTMLInputElement>('input[type="file"]');
  fireEvent.change(inputs[0], { target: { files: [baseline] } });
  fireEvent.change(inputs[1], { target: { files: [patch] } });
  fireEvent.change(inputs[2], { target: { files: [oversized] } });

  fireEvent.click(screen.getByRole("button", { name: "生成完整性清单" }));

  await waitFor(() => expect(screen.getByRole("alert")).toBeTruthy());
  expect(readBytes).not.toHaveBeenCalled();
});
