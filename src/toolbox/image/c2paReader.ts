import type { ManifestStore, Reader, Settings, StatusCodes, ValidationStatus } from "@contentauth/c2pa-web";

export const C2PA_READER_MAX_BYTES = 12 * 1024 * 1024;

const C2PA_READER_SETTINGS: Settings = {
  // A local desktop inspector must never fetch a trust list or certificate
  // service. Cryptographic parsing/validation is still reported separately;
  // trust remains unknown until CoreRobin has an explicitly approved offline
  // trust policy.
  verify: { verifyTrust: false, verifyAfterReading: true },
};

export type EmbeddedManifestParseStatus = "parsed" | "malformed" | "not_found" | "unsupported";
export type EmbeddedManifestValidationStatus = "valid" | "invalid" | "unknown";

export interface EmbeddedManifestInspection {
  format: string;
  source: "embedded-image";
  parse: {
    status: EmbeddedManifestParseStatus;
    manifests: number;
    activeManifest: string | null;
    claimGenerator: string | null;
  };
  validation: {
    status: EmbeddedManifestValidationStatus;
    state: string | null;
    codes: string[];
  };
  trust: {
    status: "unknown";
    reason: "offline_trust_policy_not_configured";
  };
  externalNetworkAccessed: false;
  manifestStore: ManifestStore | null;
  note: string;
}

type C2paModule = typeof import("@contentauth/c2pa-web");
type C2paRuntime = { module: C2paModule; wasmSrc: string };
let c2paRuntimePromise: Promise<C2paRuntime> | null = null;

/**
 * Load only the C2PA reader chunk when the inspector is actually run. The
 * WASM URL is emitted as an application asset by Vite; it is never a remote
 * URL and no trust material is configured here.
 */
async function loadC2paRuntime(): Promise<C2paRuntime> {
  c2paRuntimePromise ??= Promise.all([
    import("@contentauth/c2pa-web"),
    import("@contentauth/c2pa-web/resources/c2pa.wasm?url"),
  ]).then(([module, wasm]) => ({ module, wasmSrc: wasm.default })).catch((error: unknown) => {
    c2paRuntimePromise = null;
    throw error;
  });
  return c2paRuntimePromise;
}

export async function inspectEmbeddedC2pa(
  source: Blob,
  format: string,
  signal: AbortSignal,
): Promise<EmbeddedManifestInspection> {
  if (!(source instanceof Blob) || source.size > C2PA_READER_MAX_BYTES) {
    throw new Error("C2PA 图片输入必须是 12 MiB 以内的本地文件。");
  }
  if (signal.aborted) throw createC2paAbortError();

  const { module, wasmSrc } = await loadC2paRuntime();
  if (!module.isSupportedReaderFormat(format)) {
    return emptyInspection(format, "unsupported", "当前图片格式不在 C2PA reader 支持范围内。");
  }

  const sdk = await module.createC2pa({ wasmSrc, settings: C2PA_READER_SETTINGS });
  if (signal.aborted) {
    sdk.dispose();
    throw createC2paAbortError();
  }
  let disposed = false;
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    sdk.dispose();
  };
  const abort = () => dispose();
  signal.addEventListener("abort", abort, { once: true });

  try {
    if (signal.aborted) throw createC2paAbortError();
    let reader: Reader | null;
    try {
      reader = await abortable(signal, sdk.reader.fromBlob(format, source, C2PA_READER_SETTINGS));
    } catch (error) {
      if (signal.aborted) throw error;
      return emptyInspection(format, "malformed", `C2PA reader 无法解析该图片：${error instanceof Error ? error.message : "未知解析错误"}`);
    }
    if (!reader) return emptyInspection(format, "not_found", "图片内没有嵌入的 C2PA manifest。");

    try {
      const store = await abortable(signal, reader.manifestStore());
      return summarizeManifestStore(format, store);
    } finally {
      await reader.free();
    }
  } finally {
    signal.removeEventListener("abort", abort);
    dispose();
  }
}

export function summarizeManifestStore(format: string, store: ManifestStore): EmbeddedManifestInspection {
  const manifests = store.manifests && typeof store.manifests === "object" ? Object.keys(store.manifests).length : 0;
  const activeManifest = typeof store.active_manifest === "string" ? store.active_manifest : null;
  const active = activeManifest && store.manifests ? store.manifests[activeManifest] : undefined;
  const validation = collectValidation(store);
  return {
    format,
    source: "embedded-image",
    parse: {
      status: "parsed",
      manifests,
      activeManifest,
      claimGenerator: typeof active?.claim_generator === "string" ? active.claim_generator : null,
    },
    validation,
    trust: { status: "unknown", reason: "offline_trust_policy_not_configured" },
    externalNetworkAccessed: false,
    manifestStore: store,
    note: validation.status === "invalid"
      ? "已读取图片内嵌 manifest；C2PA 校验报告包含失败项。解析、校验和信任状态分开显示，未联网，信任状态为 unknown。"
      : validation.status === "valid"
        ? "已读取图片内嵌 manifest 并完成本地结构/密码学校验。未联网或加载信任材料，信任状态为 unknown。"
        : "已读取图片内嵌 manifest，但 SDK 没有给出完整校验状态。未联网或加载信任材料，信任状态为 unknown。",
  };
}

export function createC2paAbortError(): Error {
  const error = new Error("C2PA manifest 检查已停止。");
  error.name = "AbortError";
  return error;
}

function emptyInspection(format: string, status: EmbeddedManifestParseStatus, note: string): EmbeddedManifestInspection {
  return {
    format,
    source: "embedded-image",
    parse: { status, manifests: 0, activeManifest: null, claimGenerator: null },
    validation: { status: "unknown", state: null, codes: [] },
    trust: { status: "unknown", reason: "offline_trust_policy_not_configured" },
    externalNetworkAccessed: false,
    manifestStore: null,
    note,
  };
}

function collectValidation(store: ManifestStore): EmbeddedManifestInspection["validation"] {
  const codes: string[] = [];
  let hasFailure = false;
  let hasSuccess = false;
  const addStatus = (status: ValidationStatus, bucket: "success" | "informational" | "failure") => {
    if (typeof status.code === "string" && !codes.includes(status.code)) codes.push(status.code);
    if (bucket === "failure" || status.success === false) hasFailure = true;
    if (bucket === "success" || status.success === true) hasSuccess = true;
  };
  const addCodes = (groups: StatusCodes | null | undefined) => {
    for (const status of groups?.success ?? []) addStatus(status, "success");
    for (const status of groups?.informational ?? []) addStatus(status, "informational");
    for (const status of groups?.failure ?? []) addStatus(status, "failure");
  };
  for (const status of store.validation_status ?? []) addStatus(status, status.success === false ? "failure" : "informational");
  addCodes(store.validation_results?.activeManifest);
  for (const delta of store.validation_results?.ingredientDeltas ?? []) addCodes(delta.validationDeltas);
  const state = typeof store.validation_state === "string" ? store.validation_state : null;
  return {
    status: state === "Invalid" || hasFailure ? "invalid" : state === "Valid" || state === "Trusted" || hasSuccess ? "valid" : "unknown",
    state,
    codes,
  };
}

function abortable<Result>(signal: AbortSignal, promise: Promise<Result>): Promise<Result> {
  if (signal.aborted) return Promise.reject(createC2paAbortError());
  return new Promise<Result>((resolve, reject) => {
    let settled = false;
    const cleanup = () => signal.removeEventListener("abort", abort);
    const abort = () => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(createC2paAbortError());
    };
    signal.addEventListener("abort", abort, { once: true });
    promise.then(
      (value) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(value);
      },
      (error: unknown) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(error);
      },
    );
  });
}
