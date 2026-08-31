import { describe, expect, it, vi } from "vitest";
import type { ToolboxInputToken } from "../contracts";

const { readBound } = vi.hoisted(() => ({ readBound: vi.fn() }));
vi.mock("../runtime/files", () => ({ readBoundToolboxInput: readBound }));

import { createNativeImageInputs, imageMimeType, IMAGE_INPUT_MAX_BYTES } from "./imageInputs";

const job = { jobId: "image-job", generation: 3, resetEpoch: 9 };
const token: ToolboxInputToken = {
  ...job,
  token: "opaque-input-token",
  sessionId: "session",
  role: "input",
  displayName: "local-image.png",
  byteLength: 8,
};

const marker = {
  getImageInfo: vi.fn().mockResolvedValue({ width: 1, height: 1 }),
};

describe("image native input transport", () => {
  it("materializes one opaque input through the bounded W02 reader without a path", async () => {
    readBound.mockReset().mockResolvedValue(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0]));
    const inputs = createNativeImageInputs(
      marker as unknown as Parameters<typeof createNativeImageInputs>[0],
      job,
      [token],
      new AbortController().signal,
    );

    const file = await inputs.read(0);

    expect(readBound).toHaveBeenCalledWith(job, token, expect.any(AbortSignal), IMAGE_INPUT_MAX_BYTES);
    expect(file).toMatchObject({ name: "local-image.png", type: "image/png", size: 8 });
    expect(marker.getImageInfo).toHaveBeenCalledWith(file);
  });

  it("derives only an image MIME type from bytes or a display name", () => {
    expect(imageMimeType(new Uint8Array([0xff, 0xd8, 0xff]), "not-a-path")).toBe("image/jpeg");
    expect(imageMimeType(new Uint8Array(), "photo.webp")).toBe("image/webp");
    expect(imageMimeType(new Uint8Array(), "untrusted.bin")).toBe("application/octet-stream");
  });
});
