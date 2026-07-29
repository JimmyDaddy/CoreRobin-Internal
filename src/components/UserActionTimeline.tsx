import {
  CheckCircle2,
  CircleStop,
  Clock3,
  ExternalLink,
  Download,
  HardDriveUpload,
  LoaderCircle,
  Power,
  PackageX,
  RefreshCw,
  Rocket,
  RotateCw,
  Trash2,
  TriangleAlert,
  XCircle,
} from "lucide-react";

import { useAppTranslation } from "../i18n/useAppTranslation";
import type {
  UserActionKind,
  UserActionRecord,
} from "../userActionHistory";
import { formatBytes } from "../utils";
import { Button } from "./Button";

interface UserActionTimelineProps {
  records: readonly UserActionRecord[];
  storedCount?: number;
  limit?: number;
  compact?: boolean;
  onOpenAction?: (kind: UserActionKind) => void;
  onClearSaved?: () => void;
}

const ACTION_ICONS = {
  process_close: Power,
  process_restart: RotateCw,
  process_force_quit: XCircle,
  cleanup_delete: Trash2,
  startup_disable: CircleStop,
  startup_enable: Rocket,
  application_uninstall: PackageX,
  volume_eject: HardDriveUpload,
  application_update: Download,
} satisfies Record<UserActionKind, typeof Power>;

export function UserActionTimeline({
  records,
  storedCount,
  limit = 12,
  compact = false,
  onOpenAction,
  onClearSaved,
}: UserActionTimelineProps) {
  const { t, i18n } = useAppTranslation();
  const visible = records.slice(0, limit);

  return (
    <section className={`user-action-history${compact ? " is-compact" : ""}`} aria-labelledby="user-action-history-title">
      <header className="user-action-history__header">
        <div>
          <span className="eyebrow">{t("history:actions.eyebrow")}</span>
          <h3 id="user-action-history-title"><RefreshCw size={16} />{t("history:actions.title")}</h3>
          <p>{t("history:actions.description")}</p>
        </div>
        <span>{t("history:actions.count", { count: records.length })}</span>
      </header>

      {visible.length > 0 ? (
        <div className="user-action-history__list">
          {visible.map((record) => {
            const Icon = ACTION_ICONS[record.kind];
            const StatusIcon = actionStatusIcon(record);
            return (
              <article className={`user-action-record is-${record.status}`} key={record.id}>
                <span className="user-action-record__icon"><Icon size={17} /></span>
                <div className="user-action-record__main">
                  <small>{t(`history:actions.kind.${record.kind}`)}</small>
                  <strong>{record.targetName ?? t(`history:actions.target.${actionTargetKind(record.kind)}`)}</strong>
                  {record.kind === "cleanup_delete" &&
                  record.status !== "running" &&
                  record.affectedBytes !== null ? (
                    <span>
                      {t("history:actions.cleanupResult", {
                        count: record.targetCount ?? 0,
                        size: formatBytes(record.affectedBytes ?? 0),
                      })}
                      {(record.failedCount ?? 0) > 0
                        ? ` · ${t("history:actions.cleanupFailed", { count: record.failedCount ?? 0 })}`
                        : ""}
                    </span>
                  ) : null}
                </div>
                <div className="user-action-record__result">
                  <span className={`is-${record.status}`}>
                    <StatusIcon className={record.status === "running" ? "is-spinning" : undefined} size={13} />
                    {t(`history:actions.status.${record.status}`)}
                  </span>
                  <small>{t(`history:actions.verification.${record.verification}`)}</small>
                </div>
                <time dateTime={new Date(record.startedAtMs).toISOString()}>
                  <Clock3 size={11} />
                  {new Date(record.startedAtMs).toLocaleTimeString(i18n.resolvedLanguage, {
                    hour: "2-digit",
                    minute: "2-digit",
                  })}
                </time>
                {onOpenAction && record.status !== "running" ? (
                  <Button variant="plain" onClick={() => onOpenAction(record.kind)}>
                    {record.status === "failed"
                    || record.status === "partial"
                    || record.status === "interrupted"
                      ? t("history:actions.retry")
                      : t("history:actions.open")}
                    {record.status === "failed"
                    || record.status === "partial"
                    || record.status === "interrupted"
                      ? <RefreshCw size={12} />
                      : <ExternalLink size={12} />}
                  </Button>
                ) : null}
              </article>
            );
          })}
        </div>
      ) : (
        <div className="user-action-history__empty">
          <CheckCircle2 size={20} />
          <div><strong>{t("history:actions.emptyTitle")}</strong><span>{t("history:actions.emptyDescription")}</span></div>
        </div>
      )}

      {storedCount !== undefined ? (
        <footer>
          <span>{t("history:actions.saved", { count: storedCount })}</span>
          {onClearSaved && storedCount > 0 ? (
            <Button variant="dangerGhost" onClick={onClearSaved}>
              <Trash2 size={12} />{t("history:actions.clear")}
            </Button>
          ) : null}
        </footer>
      ) : null}
    </section>
  );
}

function actionStatusIcon(record: UserActionRecord) {
  if (record.status === "running") return LoaderCircle;
  if (record.status === "succeeded") return CheckCircle2;
  if (record.status === "cancelled" || record.status === "interrupted") return CircleStop;
  if (record.status === "partial") return TriangleAlert;
  return XCircle;
}

function actionTargetKind(kind: UserActionKind): "application" | "files" | "startup" {
  if (kind === "cleanup_delete") return "files";
  if (kind === "startup_disable" || kind === "startup_enable") return "startup";
  return "application";
}
