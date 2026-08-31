import { zipSync } from "fflate";

interface ZipItem { name: string; bytes: ArrayBuffer; }

self.onmessage = (event: MessageEvent<{ items: ZipItem[] }>) => {
  try {
    const files = Object.fromEntries(event.data.items.map((item) => [item.name, new Uint8Array(item.bytes)]));
    const zip = zipSync(files, { level: 0 });
    const workerScope = self as unknown as { postMessage(message: unknown, transfer: Transferable[]): void };
    workerScope.postMessage({ ok: true, bytes: zip.buffer }, [zip.buffer]);
  } catch (error) {
    self.postMessage({ ok: false, error: error instanceof Error ? error.message : "ZIP 生成失败。" });
  }
};
