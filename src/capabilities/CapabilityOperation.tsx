import { Suspense } from "react";
import { useTranslation } from "react-i18next";
import { ToolOperation, ToolCapabilityNotice, UnavailableTool } from "../toolbox/ToolOperation";
import { getToolDefinition, toolboxToolTranslationKey } from "../toolbox/registry";
import { useToolboxCapabilities } from "../toolbox/useToolboxCapabilities";
import type { ToolId } from "../toolbox/contracts";
import { QuickCleanupOperation } from "./QuickCleanupOperation";
import { isBusinessFormId, type CapabilityFormId } from "./formCatalog";
import { BusinessCapabilityOperation } from "./ApplicationCapabilityProvider";

/** Shared operation components only; no page navigation or second executors. */
export function CapabilityOperation({ capabilityId, onExit }: { capabilityId: CapabilityFormId; onExit: () => void }) {
  if (isBusinessFormId(capabilityId)) return <BusinessCapabilityOperation id={capabilityId} onExit={onExit} />;
  if (capabilityId === "storage.quick_clean") return <QuickCleanupOperation />;
  return <ToolboxOperationHost toolId={capabilityId.slice(8) as ToolId} />;
}
function ToolboxOperationHost({ toolId }: { toolId: ToolId }) {
  const { t } = useTranslation("toolbox");
  const native = useToolboxCapabilities();
  const tool = getToolDefinition(toolId, native, (id, field) => t(toolboxToolTranslationKey(id, field)));
  return <div className="toolbox-tool-page">
    <p className="toolbox-hint">{tool.description}</p>
    {tool.capability.state === "unavailable" ? <UnavailableTool tool={tool} /> : <>
      <ToolCapabilityNotice capability={tool.capability} />
      <Suspense fallback={<p role="status">{t("loading")}</p>}><ToolOperation toolId={tool.id} capability={tool.capability} /></Suspense>
    </>}
  </div>;
}
