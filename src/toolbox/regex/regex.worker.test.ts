import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

interface WorkerResponse {
  ok: boolean;
  code?: string;
  value?: { matches: Array<{ index: number }>; replacement: string };
}

interface TestWorkerScope {
  onmessage: ((event: MessageEvent<{ pattern: string; flags: string; text: string; replacement: string }>) => void) | null;
  postMessage: (response: WorkerResponse) => void;
}

let workerScope: TestWorkerScope;
let responses: WorkerResponse[];

beforeAll(async () => {
  workerScope = {
    onmessage: null,
    postMessage: (response) => { responses.push(response); },
  };
  vi.stubGlobal("self", workerScope);
  await import("./regex.worker");
});

afterAll(() => {
  vi.unstubAllGlobals();
});

beforeEach(() => {
  responses = [];
});

function runWorker(pattern: string, flags = "", text = "", replacement = ""): WorkerResponse {
  workerScope.onmessage?.({ data: { pattern, flags, text, replacement } } as MessageEvent);
  expect(responses).toHaveLength(1);
  return responses[0]!;
}

describe("regex worker", () => {
  it("advances Unicode zero-length matches by code point", () => {
    const response = runWorker("(?=.)", "gu", "A😀B");
    expect(response).toMatchObject({ ok: true });
    expect(response.value?.matches.map((match) => match.index)).toEqual([0, 1, 3]);
  });

  it("fails explicitly instead of truncating an oversized AST", () => {
    expect(runWorker("a".repeat(2_000))).toMatchObject({ ok: false, code: "regex_ast_too_large" });
  });

  it("fails explicitly instead of truncating an over-deep AST", () => {
    const pattern = `${"(".repeat(65)}a${")".repeat(65)}`;
    expect(runWorker(pattern)).toMatchObject({ ok: false, code: "regex_ast_too_deep" });
  });
});
