import { Check, Copy, Eye, FolderOpen, LoaderCircle } from "lucide-react";
import { useEffect, useState } from "react";

import {
  previewPath,
  resolveUserPath,
  revealPath,
} from "../api";
import { useAppTranslation } from "../i18n/useAppTranslation";
import { normalizeCommandError } from "../utils";
import { Button } from "./Button";

interface PathActionsProps {
  path: string;
  compact?: boolean;
  className?: string;
}

type PathAction = "reveal" | "preview" | "copy";

export function PathActions({ path, compact = false, className }: PathActionsProps) {
  const { t } = useAppTranslation();
  const [running, setRunning] = useState<PathAction | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    setMessage(null);
    setRunning(null);
  }, [path]);

  const run = async (action: PathAction) => {
    if (running) return;
    setRunning(action);
    setMessage(null);
    try {
      if (action === "reveal") {
        await revealPath(path);
      } else if (action === "preview") {
        await previewPath(path);
      } else {
        const resolvedPath = await resolveUserPath(path);
        await navigator.clipboard.writeText(resolvedPath);
        setMessage(t("common:pathActions.copied"));
      }
    } catch (error) {
      const normalized = normalizeCommandError(error);
      setMessage(
        normalized.code === "path_unavailable"
          ? t("common:pathActions.errors.unavailable")
          : normalized.code === "home_directory_unavailable"
            ? t("common:pathActions.errors.homeUnavailable")
            : normalized.code === "path_not_absolute"
              ? t("common:pathActions.errors.unresolved")
              : t("common:pathActions.errors.openFailed"),
      );
    } finally {
      setRunning(null);
    }
  };

  const actionContent = (action: PathAction) => {
    if (running === action) return <LoaderCircle className="is-spinning" size={14} />;
    if (action === "reveal") return <FolderOpen size={14} />;
    if (action === "preview") return <Eye size={14} />;
    return message === t("common:pathActions.copied") ? <Check size={14} /> : <Copy size={14} />;
  };

  return (
    <div className={["path-actions", compact ? "is-compact" : null, className].filter(Boolean).join(" ")}>
      <div className="path-actions__buttons">
        {(["reveal", "preview", "copy"] as const).map((action) => (
          <Button
            key={action}
            variant="secondary"
            disabled={running !== null}
            title={t(`common:pathActions.${action}`)}
            aria-label={t(`common:pathActions.${action}`)}
            onClick={() => void run(action)}
          >
            {actionContent(action)}
            {compact ? null : t(`common:pathActions.${action}`)}
          </Button>
        ))}
      </div>
      {message ? <small className="path-actions__message" role="status">{message}</small> : null}
    </div>
  );
}
