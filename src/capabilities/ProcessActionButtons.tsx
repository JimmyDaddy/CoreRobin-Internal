import { CircleStop, LoaderCircle, OctagonX } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { ProcessAction } from "../types";

export function ProcessActionButtons({ onAction, requestCloseEnabled, forceKillEnabled, busy = false, requestCloseReason, forceKillReason }: {
  onAction: (action: ProcessAction) => void;
  requestCloseEnabled: boolean;
  forceKillEnabled: boolean;
  busy?: boolean;
  requestCloseReason?: string | null;
  forceKillReason?: string | null;
}) {
  const { t } = useTranslation("process");
  return <>
    <button type="button" className="button button--secondary process-action-button" disabled={!requestCloseEnabled || busy}
      aria-label={t("inspector.requestClose")} title={requestCloseReason ?? t("inspector.requestClose")}
      data-tooltip={requestCloseReason ?? t("inspector.requestClose")} onClick={() => onAction("request_close")}>
      {busy ? <LoaderCircle className="is-spinning" size={16} /> : <CircleStop size={16} />}
    </button>
    <button type="button" className="button button--danger-ghost process-action-button" disabled={!forceKillEnabled || busy}
      aria-label={t("inspector.forceKill")} title={forceKillReason ?? t("inspector.forceKill")}
      data-tooltip={forceKillReason ?? t("inspector.forceKill")} onClick={() => onAction("force_kill")}><OctagonX size={16} /></button>
  </>;
}
