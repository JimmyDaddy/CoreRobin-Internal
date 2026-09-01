import { Zip, ZipPassThrough } from "fflate";

interface ZipItem { name: string; bytes: ArrayBuffer; }
type ZipRequest = {
  type: "start";
  maxOutputFiles?: number;
} | {
  type: "append";
  id: number;
  inputBytes: number;
  item: ZipItem;
} | {
  type: "finish";
};

const MAX_FILES = 20;
const MAX_RECIPIENT_FILES = 30;
const MAX_INPUT_BYTES = 80 * 1024 * 1024;
const MAX_EXPORT_BYTES = 512 * 1024 * 1024;

type ZipWorkerErrorCode =
  | "zip_input_budget_exceeded"
  | "zip_output_file_limit_exceeded"
  | "zip_output_budget_exceeded"
  | "zip_append_after_finish"
  | "zip_input_bytes_regressed"
  | "zip_finish_already_started"
  | "zip_not_initialized"
  | "zip_failed";

class ZipWorkerError extends Error {
  constructor(readonly code: ZipWorkerErrorCode) {
    super(code);
  }
}

interface ActiveZip {
  archive: Zip;
  chunks: BlobPart[];
  maxOutputFiles: number;
  inputBytes: number;
  outputFiles: number;
  sourceBytes: number;
  archiveBytes: number;
  finishing: boolean;
  failed: boolean;
}

let activeZip: ActiveZip | null = null;

function assertInputBudget(inputBytes: number): void {
  if (!Number.isSafeInteger(inputBytes) || inputBytes < 0 || inputBytes > MAX_INPUT_BYTES) {
    throw new ZipWorkerError("zip_input_budget_exceeded");
  }
}

function assertOutputFileBudget(outputFiles: number, maxOutputFiles: number): void {
  if (![MAX_FILES, MAX_RECIPIENT_FILES].includes(maxOutputFiles) || outputFiles > maxOutputFiles) {
    throw new ZipWorkerError("zip_output_file_limit_exceeded");
  }
}

function postError(error: unknown): void {
  self.postMessage({ type: "error", code: error instanceof ZipWorkerError ? error.code : "zip_failed" });
}

function fail(job: ActiveZip, error: unknown): void {
  if (job.failed) return;
  job.failed = true;
  job.chunks.length = 0;
  job.archive.terminate();
  if (activeZip === job) activeZip = null;
  postError(error);
}

function startZip(maxOutputFiles = MAX_FILES): void {
  assertOutputFileBudget(0, maxOutputFiles);
  activeZip?.archive.terminate();
  const job: ActiveZip = {
    archive: null as unknown as Zip,
    chunks: [] as BlobPart[],
    maxOutputFiles,
    inputBytes: 0,
    outputFiles: 0,
    sourceBytes: 0,
    archiveBytes: 0,
    finishing: false,
    failed: false,
  };
  job.archive = new Zip((error, chunk, final) => {
    if (error) {
      fail(job, error);
      return;
    }
    if (job.failed || !chunk) return;
    const nextBytes = job.archiveBytes + chunk.byteLength;
    if (!Number.isSafeInteger(nextBytes) || nextBytes > MAX_EXPORT_BYTES) {
      fail(job, new ZipWorkerError("zip_output_budget_exceeded"));
      return;
    }
    job.archiveBytes = nextBytes;
    job.chunks.push(chunk as unknown as BlobPart);
    if (final) {
      job.finishing = true;
      const blob = new Blob(job.chunks, { type: "application/zip" });
      job.chunks.length = 0;
      if (activeZip === job) activeZip = null;
      self.postMessage({ type: "complete", blob });
    }
  });
  activeZip = job;
}

function appendZipItem(job: ActiveZip, id: number, inputBytes: number, item: ZipItem): void {
  if (job.finishing) throw new ZipWorkerError("zip_append_after_finish");
  assertInputBudget(inputBytes);
  if (inputBytes < job.inputBytes) throw new ZipWorkerError("zip_input_bytes_regressed");
  assertOutputFileBudget(job.outputFiles + 1, job.maxOutputFiles);
  const nextSourceBytes = job.sourceBytes + item.bytes.byteLength;
  if (!Number.isSafeInteger(nextSourceBytes) || nextSourceBytes > MAX_EXPORT_BYTES) {
    throw new ZipWorkerError("zip_output_budget_exceeded");
  }
  job.inputBytes = inputBytes;
  job.outputFiles += 1;
  job.sourceBytes = nextSourceBytes;
  const entry = new ZipPassThrough(item.name);
  job.archive.add(entry);
  entry.push(new Uint8Array(item.bytes), true);
  if (!job.failed) self.postMessage({ type: "appended", id });
}

function finishZip(job: ActiveZip): void {
  if (job.finishing) throw new ZipWorkerError("zip_finish_already_started");
  job.finishing = true;
  job.archive.end();
}

self.onmessage = (event: MessageEvent<ZipRequest>) => {
  try {
    const message = event.data;
    if (message.type === "start") {
      startZip(message.maxOutputFiles);
      return;
    }
    if (!activeZip) throw new ZipWorkerError("zip_not_initialized");
    if (message.type === "append") {
      appendZipItem(activeZip, message.id, message.inputBytes, message.item);
      return;
    }
    finishZip(activeZip);
  } catch (error) {
    if (activeZip) fail(activeZip, error);
    else postError(error);
  }
};
