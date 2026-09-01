import { readToolboxInput } from "../client";
import type { ToolboxFileJobKey, ToolboxInputToken, ToolboxJob } from "../contracts";

const CHUNK_BYTES = 1024 * 1024;

export function fileJobKey(job: ToolboxJob): ToolboxFileJobKey {
  return { jobId: job.jobId, generation: job.generation, resetEpoch: job.resetEpoch };
}

export async function readBoundToolboxInput(
  job: ToolboxFileJobKey,
  input: ToolboxInputToken,
  signal: AbortSignal,
  maximumBytes: number,
): Promise<Uint8Array> {
  if (input.jobId !== job.jobId || input.generation !== job.generation || input.resetEpoch !== job.resetEpoch) {
    throw new Error("This file belongs to an earlier tool session.");
  }
  if (!Number.isSafeInteger(input.byteLength) || input.byteLength < 0 || input.byteLength > maximumBytes) {
    throw new Error("The selected file exceeds this tool's input budget.");
  }
  signal.throwIfAborted();
  const result = new Uint8Array(input.byteLength);
  // Even an empty input is read once so identity/cancellation is revalidated.
  let offset = 0;
  do {
    signal.throwIfAborted();
    const length = Math.min(CHUNK_BYTES, Math.max(1, input.byteLength - offset));
    const chunk = await readToolboxInput(job, input.token, offset, length);
    signal.throwIfAborted();
    const expected = Math.min(length, input.byteLength - offset);
    if (chunk.byteLength !== expected) throw new Error("The selected file changed or returned an invalid range.");
    result.set(new Uint8Array(chunk), offset);
    offset += chunk.byteLength;
  } while (offset < input.byteLength);
  return result;
}
