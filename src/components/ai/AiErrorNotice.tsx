import { useTranslation } from "react-i18next";
import type { AiError } from "../../ai/types";
import { useEffect, useRef, type ReactNode } from "react";

export function AiErrorNotice({
  error,
  children,
  context,
}: {
  error: AiError;
  children?: ReactNode;
  context?: "tool";
}) {
  const { t, i18n } = useTranslation("ai");
  const notice = useRef<HTMLDivElement>(null);
  useEffect(() => {
    notice.current?.scrollIntoView?.({ block: "nearest" });
  }, [error.code, error.message]);
  const code = error.code;
  const title =
    code === "capability_target_expired" ? i18n.t("capabilities:expired") :
    context === "tool" || /^(tool_|task_|scan_|target_|action_|confirmation_|capability_|invalid_tool|unknown_tool|unsupported_tool|device_context)/.test(code)
      ? t("taskError")
      : code === "privacy_clear_in_progress"
      ? t("privacyClearing")
      : code.includes("draft")
        ? t("draftConflict")
        : /storage|disk/.test(code)
          ? t("storageError")
          : code.includes("credential")
            ? t("missingCredential")
            : /busy|in_progress/.test(code)
              ? t("busy")
              : /invalid|config|model_required|disabled|local_only/.test(code)
                ? t("settingsError")
                : t("connectionError");
  return (
    <div ref={notice} className="ai-error" role="alert">
      <p>{title}</p>
      <details>
        <summary>{t("errorDetails")}</summary>
        <code>{code}</code>
        <p>{error.message}</p>
      </details>
      {children}
    </div>
  );
}
