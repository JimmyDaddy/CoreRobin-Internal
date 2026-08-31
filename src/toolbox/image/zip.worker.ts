import { zipSync } from "fflate";

interface ZipItem { name: string; bytes: ArrayBuffer; }
interface ZipRequest { items: ZipItem[]; inputBytes: number; maxOutputFiles?: number; }

const MAX_FILES = 20;
const MAX_RECIPIENT_FILES = 30;
const MAX_INPUT_BYTES = 80 * 1024 * 1024;
const MAX_EXPORT_BYTES = 512 * 1024 * 1024;

function assertZipBudget(items: readonly ZipItem[], inputBytes: number, maxOutputFiles: number): void {
  if (!Number.isSafeInteger(inputBytes) || inputBytes < 0 || inputBytes > MAX_INPUT_BYTES) {
    throw new Error("批量输入总大小不能超过 80 MiB。");
  }
  if (![MAX_FILES, MAX_RECIPIENT_FILES].includes(maxOutputFiles) || items.length > maxOutputFiles) throw new Error("批量 ZIP 输出文件数超过允许上限。");
  let total = 0;
  for (const item of items) {
    total += item.bytes.byteLength;
    if (!Number.isSafeInteger(total) || total > MAX_EXPORT_BYTES) {
      throw new Error("批量 ZIP 累计输出不能超过 512 MiB。");
    }
  }
}

self.onmessage = (event: MessageEvent<ZipRequest>) => {
  try {
    const { items, inputBytes, maxOutputFiles = MAX_FILES } = event.data;
    assertZipBudget(items, inputBytes, maxOutputFiles);
    const files = Object.fromEntries(items.map((item) => [item.name, new Uint8Array(item.bytes)]));
    const zip = zipSync(files, { level: 0 });
    if (zip.byteLength > MAX_EXPORT_BYTES) throw new Error("批量 ZIP 累计输出不能超过 512 MiB。");
    const workerScope = self as unknown as { postMessage(message: unknown, transfer: Transferable[]): void };
    workerScope.postMessage({ ok: true, bytes: zip.buffer }, [zip.buffer]);
  } catch (error) {
    self.postMessage({ ok: false, error: error instanceof Error ? error.message : "ZIP 生成失败。" });
  }
};
