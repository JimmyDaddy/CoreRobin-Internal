import { unzipSync } from "fflate";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type ZipWorkerRequest = {
  type: "start";
  maxOutputFiles?: number;
} | {
  type: "append";
  id: number;
  inputBytes: number;
  item: { name: string; bytes: ArrayBuffer };
} | {
  type: "finish";
};

interface FakeWorkerScope {
  onmessage: ((event: MessageEvent<ZipWorkerRequest>) => void) | null;
  postMessage: ReturnType<typeof vi.fn>;
}

let workerScope: FakeWorkerScope;

beforeEach(async () => {
  vi.resetModules();
  workerScope = {
    onmessage: null,
    postMessage: vi.fn(),
  };
  vi.stubGlobal("self", workerScope);
  await import("./zip.worker");
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function send(message: ZipWorkerRequest): void {
  workerScope.onmessage?.({ data: message } as MessageEvent<ZipWorkerRequest>);
}

function replies(): Array<{ type: string; [key: string]: unknown }> {
  return workerScope.postMessage.mock.calls.map(([message]) => message as { type: string; [key: string]: unknown });
}

describe("streaming ZIP worker", () => {
  it("accepts one transferred item at a time and returns an ordered ZIP Blob", async () => {
    const first = new Uint8Array([1, 2, 3, 4]);
    const second = new Uint8Array([5, 6]);
    send({ type: "start", maxOutputFiles: 20 });
    send({ type: "append", id: 1, inputBytes: 10, item: { name: "01-first.png", bytes: first.buffer } });
    send({ type: "append", id: 2, inputBytes: 10, item: { name: "02-second.png", bytes: second.buffer } });
    send({ type: "finish" });

    expect(replies().filter((reply) => reply.type === "appended")).toEqual([
      { type: "appended", id: 1 },
      { type: "appended", id: 2 },
    ]);
    const complete = replies().find((reply) => reply.type === "complete");
    expect(complete?.blob).toBeInstanceOf(Blob);
    const archive = unzipSync(new Uint8Array(await (complete?.blob as Blob).arrayBuffer()));
    expect(Object.keys(archive)).toEqual(["01-first.png", "02-second.png"]);
    expect([...archive["01-first.png"]!]).toEqual([1, 2, 3, 4]);
    expect([...archive["02-second.png"]!]).toEqual([5, 6]);
  });

  it("keeps the 30-file recipient ceiling and rejects the next append without building a ZIP", () => {
    send({ type: "start", maxOutputFiles: 30 });
    for (let id = 1; id <= 30; id += 1) {
      send({ type: "append", id, inputBytes: 0, item: { name: `delivery-${id}.png`, bytes: new ArrayBuffer(0) } });
    }
    send({ type: "append", id: 31, inputBytes: 0, item: { name: "delivery-31.png", bytes: new ArrayBuffer(0) } });

    expect(replies().filter((reply) => reply.type === "appended")).toHaveLength(30);
    const messages = replies();
    expect(messages[messages.length - 1]).toMatchObject({ type: "error", error: "批量 ZIP 输出文件数超过允许上限。" });
    expect(replies().some((reply) => reply.type === "complete")).toBe(false);
  });

  it("rejects an input budget overrun before accepting the output item", () => {
    send({ type: "start", maxOutputFiles: 20 });
    send({
      type: "append",
      id: 1,
      inputBytes: 80 * 1024 * 1024 + 1,
      item: { name: "too-large.png", bytes: new ArrayBuffer(1) },
    });

    expect(replies()).toEqual([{ type: "error", error: "批量输入总大小不能超过 80 MiB。" }]);
  });
});
