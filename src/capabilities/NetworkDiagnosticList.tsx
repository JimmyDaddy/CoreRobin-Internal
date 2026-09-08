import { CheckCircle2, CircleAlert, CircleHelp } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { NetworkQualityDiagnostic } from "../types";

export function NetworkDiagnosticList({ diagnostics }: { diagnostics: readonly NetworkQualityDiagnostic[] }) {
  const { t } = useTranslation("network");
  return <div className="network-quality__diagnostics" aria-label={t("quality.diagnostics.title")}>
    {diagnostics.map((diagnostic) => {
      const Icon = diagnostic.status === "passed" ? CheckCircle2 : diagnostic.status === "unavailable" ? CircleHelp : CircleAlert;
      return <div className={`is-${diagnostic.status}`} key={diagnostic.kind}>
        <Icon size={15} /><span>{t(`quality.diagnostics.stages.${diagnostic.kind}`)}</span>
        <small>{t(`quality.diagnostics.status.${diagnostic.status}`)}{diagnostic.latencyMs !== null ? ` · ${diagnostic.latencyMs.toFixed(0)} ms` : ""}</small>
      </div>;
    })}
  </div>;
}
