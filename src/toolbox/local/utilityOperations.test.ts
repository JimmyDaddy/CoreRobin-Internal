import { describe, expect, it } from "vitest";
import { executeTextUtility, utilityExcerpt } from "./utilityOperations";

describe("finite text utility execution", () => {
  it("preserves large JSON numbers and reports duplicates using the existing parser", async () => {
    const result = await executeTextUtility({ operation: "json_format", input: '{"big":900719925474099312345,"x":1,"x":2}' });
    expect(result.output).toContain("900719925474099312345");
    expect(result.fields.duplicates).toEqual(["x"]);
    expect(result.fields.output).toBe(result.output);
  });
  it("uses the strict URL, UTF-8 and time conversions", async () => {
    await expect(executeTextUtility({ operation: "url_decode", input: "%xx" })).rejects.toMatchObject({ code: "invalid_percent_encoding" });
    const encoded = await executeTextUtility({ operation: "base64url_encode", input: "你好 🚀" });
    const decoded = await executeTextUtility({ operation: "base64url_decode", input: encoded.output });
    expect(decoded.output).toBe("你好 🚀");
    await expect(executeTextUtility({ operation: "time_seconds", input: "2026-02-30T00:00:00Z" })).rejects.toMatchObject({ code: "invalid_iso" });
    const time = await executeTextUtility({ operation: "time_seconds", input: "0" });
    expect(JSON.parse(time.output).utc).toBe("1970-01-01T00:00:00.000Z");
  });
  it("returns actual hashes, UUIDs and color formats without any IO input", async () => {
    expect((await executeTextUtility({ operation: "text_sha256", input: "abc" })).output).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    const ids = (await executeTextUtility({ operation: "uuid_v4", input: "", count: 2 })).output.split("\n");
    expect(new Set(ids).size).toBe(2);
    expect(ids.every((id) => /^[0-9a-f-]{14}4[0-9a-f-]{21}$/.test(id))).toBe(true);
    expect((await executeTextUtility({ operation: "color", input: "#ff0000" })).output.toLowerCase()).toContain("#ff0000");
  });
  it("rejects oversized input and bounds serialized excerpts including escapes", async () => {
    await expect(executeTextUtility({ operation: "json_format", input: "界".repeat(2000) })).rejects.toMatchObject({ code: "input_too_large" });
    const result = utilityExcerpt("\u0001".repeat(4096));
    expect(new TextEncoder().encode(JSON.stringify(result.output)).length).toBeLessThanOrEqual(5000);
    expect(result.truncated).toBe(true);
  });
});
