import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { TOOLBOX_TOOL_IDS } from "../toolbox/contracts";
import { BUSINESS_FORM_IDS, isCapabilityFormId } from "./formCatalog";
it("keeps every model-advertised native form aligned with the actual frontend operation catalog", () => {
  const source = readFileSync(new URL("../../src-tauri/src/application_capability_catalog.rs", import.meta.url), "utf8");
  const ids = source.match(/pub const BUSINESS_FORM_IDS[\s\S]*?= &\[([\s\S]*?)\];/)![1].match(/"[^"]+"/g)!.map((id) => JSON.parse(id));
  expect(ids).toEqual([...BUSINESS_FORM_IDS]);
  const toolbox = readFileSync(new URL("../../src-tauri/src/toolbox_service.rs", import.meta.url), "utf8");
  const nativeToolIds = toolbox.match(/pub\(crate\) const TOOL_IDS[\s\S]*?= &\[([\s\S]*?)\];/)![1].match(/"[^"]+"/g)!.map((id) => JSON.parse(id));
  expect(nativeToolIds).toEqual([...TOOLBOX_TOOL_IDS]);
  for (const id of [...ids, "storage.quick_clean", ...nativeToolIds.map((id) => `toolbox.${id}`)]) expect(isCapabilityFormId(id)).toBe(true);
  expect(isCapabilityFormId("shell.run")).toBe(false);
});
