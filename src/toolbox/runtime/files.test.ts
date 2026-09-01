import { describe, expect, it, vi } from "vitest";
import { readBoundToolboxInput } from "./files";
import type { ToolboxInputToken } from "../contracts";

const { read } = vi.hoisted(() => ({ read: vi.fn() }));
vi.mock("../client", () => ({ readToolboxInput: read }));

const job = { jobId: "job", generation: 4, resetEpoch: 2 };
const token: ToolboxInputToken = { ...job, token: "opaque", sessionId: "session", role: "input", displayName: "file", byteLength: 3 };

describe("bound toolbox input transport", () => {
  it("rejects oversized and stale inputs before allocation or IO", async () => {
    read.mockClear();
    const signal = new AbortController().signal;
    await expect(readBoundToolboxInput(job, token, signal, 2)).rejects.toThrow(/budget/);
    await expect(readBoundToolboxInput({ ...job, resetEpoch: 3 }, token, signal, 3)).rejects.toThrow(/earlier/);
    expect(read).not.toHaveBeenCalled();
  });

  it("reads serial 1 MiB chunks and validates the final short range", async () => {
    const size = 1024 * 1024 + 3;
    read.mockReset().mockResolvedValueOnce(new ArrayBuffer(1024 * 1024)).mockResolvedValueOnce(new Uint8Array([1, 2, 3]).buffer);
    const bytes = await readBoundToolboxInput(job, { ...token, byteLength: size }, new AbortController().signal, size);
    expect(bytes.slice(-3)).toEqual(new Uint8Array([1, 2, 3]));
    expect(read).toHaveBeenNthCalledWith(2, job, "opaque", 1024 * 1024, 3);
  });

  it("drops late IO results after abort and rejects truncated native replies", async () => {
    const controller = new AbortController();
    read.mockReset().mockImplementationOnce(async () => { controller.abort(); return new ArrayBuffer(3); });
    await expect(readBoundToolboxInput(job, token, controller.signal, 3)).rejects.toMatchObject({ name: "AbortError" });
    read.mockResolvedValueOnce(new ArrayBuffer(2));
    await expect(readBoundToolboxInput(job, token, new AbortController().signal, 3)).rejects.toThrow(/invalid range/);
  });

  it("revalidates even zero byte files through the native read boundary", async () => {
    read.mockReset().mockResolvedValueOnce(new ArrayBuffer(0));
    expect(await readBoundToolboxInput(job, { ...token, byteLength: 0 }, new AbortController().signal, 3)).toEqual(new Uint8Array(0));
    expect(read).toHaveBeenCalledWith(job, "opaque", 0, 1);
  });
});
