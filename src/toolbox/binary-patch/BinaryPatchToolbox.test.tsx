/** @vitest-environment jsdom */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import i18n from "../../i18n";

const mocks = vi.hoisted(() => ({
  createObjectUrl: vi.fn(() => "blob:patch-plan"),
  planPatches: vi.fn(),
  createPatchCollection: vi.fn(),
  desktopRuntime: false,
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
  cancelToolboxJob: vi.fn(),
  cancelToolboxOutput: vi.fn(),
  exportToolboxOutput: vi.fn(),
  finishToolboxJob: vi.fn(),
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
  return { ...actual, createPatchCollection: mocks.createPatchCollection, generateVerifiedPatch: mocks.generateVerifiedPatch, planPatches: mocks.planPatches };
});

import { BinaryPatchToolbox } from "./BinaryPatchToolbox";

beforeEach(async () => {
  vi.clearAllMocks();
  mocks.desktopRuntime = false;
  await i18n.changeLanguage("zh-CN");
  vi.stubGlobal("URL", { createObjectURL: mocks.createObjectUrl, revokeObjectURL: vi.fn() });
  mocks.planPatches.mockResolvedValue({ results: [] });
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
  mocks.prepare.mockImplementation(async (_job, role) => [{ token: role === "input" ? "baseline" : "target", displayName: `${role}.bin` }]);
  mocks.readBound.mockImplementation(async (_job, token) => new Uint8Array(token.token === "baseline" ? [6] : [7]));
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
