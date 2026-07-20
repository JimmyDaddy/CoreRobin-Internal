import { afterEach, describe, expect, it, vi } from "vitest";

import relay, {
  ReleaseCoordinator,
} from "../infra/notary-webhook-relay/src/index.mjs";

const PATH_SECRET = "a".repeat(64);

describe("Cloudflare Apple notarization relay", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("rejects unauthenticated and malformed public callbacks", async () => {
    const env = relayEnvironment();
    const missingSecret = await relay.fetch(new Request(
      "https://relay.example/apple-notary/wrong?tag=v1.2.3&run_id=123&arch=aarch64",
      { method: "POST", body: "{}" },
    ), env);
    expect(missingSecret.status).toBe(404);

    const badArch = await relay.fetch(new Request(
      `https://relay.example/apple-notary/${PATH_SECRET}?tag=v1.2.3&run_id=123&arch=universal`,
      { method: "POST", body: "{}" },
    ), env);
    expect(badArch.status).toBe(400);

    const mixedSignal = await relay.fetch(new Request(
      `https://relay.example/apple-notary/${PATH_SECRET}?tag=v1.2.3&run_id=123&arch=x64&signal=preview_ready`,
      { method: "POST", body: "{}" },
    ), env);
    expect(mixedSignal.status).toBe(400);
  });

  it("rejects an oversized callback without buffering an unbounded body", async () => {
    const response = await relay.fetch(new Request(
      `https://relay.example/apple-notary/${PATH_SECRET}?tag=v1.2.3&run_id=123&arch=aarch64`,
      { method: "POST", body: "x".repeat((64 * 1024) + 1) },
    ), relayEnvironment());

    expect(response.status).toBe(413);
  });

  it("waits for both architectures and Preview when Apple finishes first", async () => {
    const storage = new FakeStorage();
    const githubFetch = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", githubFetch);
    const coordinator = new ReleaseCoordinator({ storage }, {
      GITHUB_DISPATCH_TOKEN: "github-token",
      GITHUB_OWNER: "JimmyDaddy",
      GITHUB_REPOSITORY: "CoreRobin-Internal",
    });

    const first = await coordinator.fetch(callbackRequest("aarch64"));
    expect(first.status).toBe(202);
    expect(await first.json()).toMatchObject({ ready: false, dispatched: false });
    expect(githubFetch).not.toHaveBeenCalled();

    const second = await coordinator.fetch(callbackRequest("x64"));
    expect(second.status).toBe(202);
    expect(await second.json()).toMatchObject({ ready: false, dispatched: false });
    expect(githubFetch).not.toHaveBeenCalled();

    const preview = await coordinator.fetch(previewReadyRequest());
    expect(preview.status).toBe(200);
    expect(await preview.json()).toMatchObject({ ready: true, dispatched: true });
    expect(githubFetch).toHaveBeenCalledTimes(1);

    const duplicate = await coordinator.fetch(callbackRequest("x64"));
    expect(await duplicate.json()).toMatchObject({ duplicate: true });
    expect(githubFetch).toHaveBeenCalledTimes(1);

    const [, options] = githubFetch.mock.calls[0];
    expect(JSON.parse(options.body)).toEqual({
      event_type: "apple-notarization-complete",
      client_payload: { tag: "v1.2.3", run_id: "123" },
    });
    expect(options.headers.authorization).toBe("Bearer github-token");
  });

  it("waits for both architectures when Preview finishes first", async () => {
    const storage = new FakeStorage();
    const githubFetch = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", githubFetch);
    const coordinator = new ReleaseCoordinator({ storage }, {
      GITHUB_DISPATCH_TOKEN: "github-token",
    });

    expect((await coordinator.fetch(previewReadyRequest())).status).toBe(202);
    expect((await coordinator.fetch(callbackRequest("x64"))).status).toBe(202);
    const finalSignal = await coordinator.fetch(callbackRequest("aarch64"));

    expect(finalSignal.status).toBe(200);
    expect(await finalSignal.json()).toMatchObject({ ready: true, dispatched: true });
    expect(githubFetch).toHaveBeenCalledTimes(1);
  });

  it("does not dispatch twice while the GitHub request is still in flight", async () => {
    const storage = new FakeStorage({
      release: {
        tag: "v1.2.3",
        runId: "123",
        arches: { aarch64: true },
        previewReady: true,
        dispatching: false,
        dispatched: false,
      },
    });
    let finishDispatch;
    const githubFetch = vi.fn(() => new Promise((resolve) => {
      finishDispatch = () => resolve(new Response(null, { status: 204 }));
    }));
    vi.stubGlobal("fetch", githubFetch);
    const coordinator = new ReleaseCoordinator({ storage }, {
      GITHUB_DISPATCH_TOKEN: "github-token",
    });

    const first = coordinator.fetch(callbackRequest("x64"));
    await vi.waitFor(() => expect(githubFetch).toHaveBeenCalledTimes(1));
    const concurrent = await coordinator.fetch(callbackRequest("x64"));
    expect(concurrent.status).toBe(202);
    expect(await concurrent.json()).toMatchObject({ dispatching: true, dispatched: false });
    expect(githubFetch).toHaveBeenCalledTimes(1);

    finishDispatch();
    await expect(first).resolves.toHaveProperty("status", 200);
  });

  it("does not mark a release dispatched when GitHub rejects the request", async () => {
    const storage = new FakeStorage({
      release: {
        tag: "v1.2.3",
        runId: "123",
        arches: { aarch64: true },
        previewReady: true,
        dispatching: false,
        dispatched: false,
      },
    });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("forbidden", { status: 403 })));
    const coordinator = new ReleaseCoordinator({ storage }, {
      GITHUB_DISPATCH_TOKEN: "github-token",
    });

    await expect(coordinator.fetch(callbackRequest("x64"))).rejects.toThrow("GitHub repository dispatch failed");
    expect((await storage.get("release")).dispatched).toBe(false);
  });
});

function relayEnvironment() {
  return {
    WEBHOOK_PATH_SECRET: PATH_SECRET,
    RELEASE_COORDINATOR: {
      idFromName: (name) => name,
      get: () => ({ fetch: () => new Response(null, { status: 202 }) }),
    },
  };
}

function callbackRequest(arch) {
  return new Request("https://release-coordinator.internal/callback", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ tag: "v1.2.3", runId: "123", arch }),
  });
}

function previewReadyRequest() {
  return new Request("https://release-coordinator.internal/callback", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ tag: "v1.2.3", runId: "123", arch: "", signal: "preview_ready" }),
  });
}

class FakeStorage {
  constructor(entries = {}) {
    this.entries = new Map(Object.entries(entries));
    this.alarm = null;
  }

  async get(key) {
    return structuredClone(this.entries.get(key));
  }

  async put(key, value) {
    this.entries.set(key, structuredClone(value));
  }

  async setAlarm(timestamp) {
    this.alarm = timestamp;
  }

  async deleteAll() {
    this.entries.clear();
  }
}
