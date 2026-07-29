const MAX_BODY_BYTES = 64 * 1024;
const RELEASE_STATE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const DISPATCH_RETRY_BASE_MS = 60 * 1000;
const DISPATCH_RETRY_MAX_MS = 60 * 60 * 1000;
const GITHUB_API_VERSION = "2022-11-28";

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/healthz") {
      return json({ ok: true, service: "corerobin-notary-webhook-relay" });
    }
    if (request.method !== "POST") return new Response("Method Not Allowed", { status: 405 });
    if (!validSecret(env.WEBHOOK_PATH_SECRET)) {
      return new Response("Relay is not configured", { status: 503 });
    }
    const expectedPath = `/apple-notary/${env.WEBHOOK_PATH_SECRET}`;
    if (!constantTimeEqual(url.pathname, expectedPath)) return new Response("Not Found", { status: 404 });

    if (await requestBodyExceedsLimit(request)) {
      return new Response("Payload Too Large", { status: 413 });
    }

    const callback = {
      tag: url.searchParams.get("tag") ?? "",
      runId: url.searchParams.get("run_id") ?? "",
      arch: url.searchParams.get("arch") ?? "",
      signal: url.searchParams.get("signal") ?? "",
    };
    if (!/^v\d+\.\d+\.\d+$/.test(callback.tag)) return new Response("Invalid tag", { status: 400 });
    if (!/^\d+$/.test(callback.runId)) return new Response("Invalid run_id", { status: 400 });
    if (!validReleaseSignal(callback)) {
      return new Response("Invalid release signal", { status: 400 });
    }

    const id = env.RELEASE_COORDINATOR.idFromName(`${callback.tag}:${callback.runId}`);
    const coordinator = env.RELEASE_COORDINATOR.get(id);
    return coordinator.fetch("https://release-coordinator.internal/callback", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(callback),
    });
  },
};

export class ReleaseCoordinator {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
  }

  async fetch(request) {
    if (request.method !== "POST") return new Response("Method Not Allowed", { status: 405 });
    const callback = await request.json();
    validateCallback(callback);

    const now = Date.now();
    const state = await this.ctx.storage.get("release") ?? {
      tag: callback.tag,
      runId: callback.runId,
      arches: {},
      previewReady: false,
      dispatching: false,
      dispatched: false,
      retryCount: 0,
      lastDispatchError: null,
      expiresAt: now + RELEASE_STATE_TTL_MS,
    };
    state.retryCount ??= 0;
    state.lastDispatchError ??= null;
    state.expiresAt = Math.max(state.expiresAt ?? 0, now + RELEASE_STATE_TTL_MS);
    if (state.tag !== callback.tag || state.runId !== callback.runId) {
      return new Response("Release coordinator identity mismatch", { status: 409 });
    }

    if (callback.signal === "preview_ready") {
      state.previewReady = true;
    } else {
      state.arches[callback.arch] = true;
    }
    await this.ctx.storage.put("release", state);
    await this.ctx.storage.setAlarm(state.expiresAt);

    const ready = releaseReady(state);
    if (!ready) {
      return json({ accepted: true, ready: false, dispatched: false }, 202);
    }
    if (state.dispatched) {
      return json({ accepted: true, ready: true, dispatched: true, duplicate: true });
    }
    if (state.dispatching) {
      return json({ accepted: true, ready: true, dispatching: true, dispatched: false }, 202);
    }

    const dispatched = await this.dispatchWhenReady(state);
    return dispatched
      ? json({ accepted: true, ready: true, dispatched: true })
      : json({
          accepted: true,
          ready: true,
          dispatched: false,
          retrying: true,
          retryCount: state.retryCount,
        }, 202);
  }

  async alarm() {
    const state = await this.ctx.storage.get("release");
    if (!state) return;
    const now = Date.now();
    if ((state.expiresAt ?? 0) <= now) {
      await this.ctx.storage.deleteAll();
      return;
    }
    if (state.dispatched || !releaseReady(state)) {
      await this.ctx.storage.setAlarm(state.expiresAt);
      return;
    }

    state.dispatching = false;
    await this.ctx.storage.put("release", state);
    await this.dispatchWhenReady(state);
  }

  async dispatchWhenReady(state) {
    state.dispatching = true;
    await this.ctx.storage.put("release", state);
    try {
      await dispatchGitHub(this.env, state);
    } catch (error) {
      state.dispatching = false;
      state.retryCount = (state.retryCount ?? 0) + 1;
      state.lastDispatchError = error instanceof Error
        ? error.message.slice(0, 500)
        : String(error).slice(0, 500);
      await this.ctx.storage.put("release", state);
      if ((state.expiresAt ?? 0) <= Date.now()) {
        await this.ctx.storage.deleteAll();
        return false;
      }
      await this.ctx.storage.setAlarm(
        Date.now() + dispatchRetryDelay(state.retryCount),
      );
      return false;
    }
    state.dispatching = false;
    state.dispatched = true;
    state.retryCount = 0;
    state.lastDispatchError = null;
    await this.ctx.storage.put("release", state);
    await this.ctx.storage.setAlarm(state.expiresAt);
    return true;
  }
}

function releaseReady(state) {
  return state.arches.aarch64 === true
    && state.arches.x64 === true
    && state.previewReady === true;
}

function dispatchRetryDelay(retryCount) {
  return Math.min(
    DISPATCH_RETRY_MAX_MS,
    DISPATCH_RETRY_BASE_MS * (2 ** Math.max(0, retryCount - 1)),
  );
}

export async function dispatchGitHub(env, state) {
  if (!env.GITHUB_DISPATCH_TOKEN) throw new Error("GITHUB_DISPATCH_TOKEN is not configured.");
  const owner = env.GITHUB_OWNER ?? "JimmyDaddy";
  const repository = env.GITHUB_REPOSITORY ?? "CoreRobin-Internal";
  const response = await fetch(`https://api.github.com/repos/${owner}/${repository}/dispatches`, {
    method: "POST",
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${env.GITHUB_DISPATCH_TOKEN}`,
      "content-type": "application/json",
      "user-agent": "CoreRobin-Notary-Webhook-Relay",
      "x-github-api-version": GITHUB_API_VERSION,
    },
    body: JSON.stringify({
      event_type: "apple-notarization-complete",
      client_payload: {
        tag: state.tag,
        run_id: state.runId,
      },
    }),
  });
  if (response.status !== 204) {
    const detail = (await response.text()).slice(0, 500);
    throw new Error(`GitHub repository dispatch failed (${response.status}): ${detail}`);
  }
}

function validateCallback(callback) {
  if (!callback || !/^v\d+\.\d+\.\d+$/.test(callback.tag ?? "")) {
    throw new Error("Invalid release callback tag.");
  }
  if (!/^\d+$/.test(callback.runId ?? "")) throw new Error("Invalid release callback run ID.");
  if (!validReleaseSignal(callback)) throw new Error("Invalid release callback signal.");
}

function validReleaseSignal(callback) {
  const signal = callback.signal ?? "";
  const arch = callback.arch ?? "";
  const isNotarization = signal === ""
    && new Set(["aarch64", "x64"]).has(arch);
  const isPreviewReady = signal === "preview_ready" && arch === "";
  return isNotarization || isPreviewReady;
}

function validSecret(value) {
  return typeof value === "string" && value.length >= 32 && /^[A-Za-z0-9_-]+$/.test(value);
}

function constantTimeEqual(left, right) {
  const length = Math.max(left.length, right.length);
  let difference = left.length ^ right.length;
  for (let index = 0; index < length; index += 1) {
    difference |= (left.charCodeAt(index) || 0) ^ (right.charCodeAt(index) || 0);
  }
  return difference === 0;
}

async function requestBodyExceedsLimit(request) {
  const contentLength = request.headers.get("content-length");
  if (contentLength && /^\d+$/.test(contentLength) && Number(contentLength) > MAX_BODY_BYTES) {
    return true;
  }
  if (!request.body) return false;

  const reader = request.body.getReader();
  let receivedBytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) return false;
    receivedBytes += value.byteLength;
    if (receivedBytes > MAX_BODY_BYTES) {
      await reader.cancel();
      return true;
    }
  }
}

function json(value, status = 200) {
  return new Response(`${JSON.stringify(value)}\n`, {
    status,
    headers: {
      "cache-control": "no-store",
      "content-type": "application/json; charset=utf-8",
    },
  });
}
