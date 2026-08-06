import { useCallback, useEffect, useState } from "react";
import {
  AlertTriangle,
  ChevronDown,
  ChevronRight,
  Ghost,
  RefreshCw,
  ShieldCheck,
  Skull,
  UserX,
  X,
} from "lucide-react";

import { killOrphanProcesses, scanOrphanProcesses } from "../api";
import { useAppTranslation } from "../i18n/useAppTranslation";
import type {
  OrphanKillReport,
  OrphanKillStatus,
  OrphanProcess,
} from "../types";
import { formatBytes, normalizeCommandError } from "../utils";
import "./OrphanProcessCard.css";

function killStatusLabel(status: OrphanKillStatus, t: ReturnType<typeof useAppTranslation>["t"]) {
  switch (status) {
    case "killed":
      return t("process:orphan.status.killed");
    case "force_killed":
      return t("process:orphan.status.forceKilled");
    case "survived":
      return t("process:orphan.status.survived");
    case "failed":
      return t("process:orphan.status.failed");
    case "skipped":
      return t("process:orphan.status.skipped");
  }
}

export function OrphanProcessCard() {
  const { t } = useAppTranslation();
  const [orphans, setOrphans] = useState<OrphanProcess[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [detailPid, setDetailPid] = useState<number | null>(null);
  const [busyPids, setBusyPids] = useState<ReadonlySet<number>>(new Set());
  const [confirmAll, setConfirmAll] = useState(false);
  const [report, setReport] = useState<OrphanKillReport | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setOrphans(await scanOrphanProcesses());
    } catch (caughtError) {
      setError(normalizeCommandError(caughtError).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const totalMemory =
    orphans?.reduce((total, orphan) => total + orphan.memoryBytes, 0) ?? 0;
  const count = orphans?.length ?? 0;

  const runKill = useCallback(
    async (targets: OrphanProcess[], force: boolean) => {
      setBusyPids(new Set(targets.map((orphan) => orphan.pid)));
      setError(null);
      try {
        const outcome = await killOrphanProcesses({
          targets: targets.map((orphan) => ({
            pid: orphan.pid,
            expectedStartTime: orphan.startTime,
          })),
          force,
        });
        setReport(outcome);
        await refresh();
      } catch (caughtError) {
        setError(normalizeCommandError(caughtError).message);
      } finally {
        setBusyPids(new Set());
        setConfirmAll(false);
      }
    },
    [refresh],
  );

  const killAll = useCallback(() => {
    if (!orphans || orphans.length === 0) return;
    void runKill(orphans, true);
  }, [orphans, runKill]);

  const killOne = useCallback(
    (orphan: OrphanProcess, force: boolean) => {
      void runKill([orphan], force);
    },
    [runKill],
  );

  const closeReport = useCallback(() => {
    setReport(null);
  }, []);

  if (count === 0 && !loading && !expanded) {
    return null;
  }

  return (
    <section className={`panel orphan-card${count > 0 ? " has-orphans" : ""}`} aria-labelledby="orphan-card-title">
      <header className="orphan-card__header">
        <span className="orphan-card__icon" aria-hidden="true">
          <Ghost size={18} />
        </span>
        <div>
          <span className="eyebrow">{t("process:orphan.kicker")}</span>
          <h3 id="orphan-card-title">{t("process:orphan.title")}</h3>
          <p>
            {count > 0
              ? t("process:orphan.summary", {
                  count,
                  size: formatBytes(totalMemory),
                })
              : t("process:orphan.none")}
          </p>
        </div>
        <div className="orphan-card__actions">
          <button
            className="button button--secondary"
            type="button"
            disabled={loading}
            onClick={() => void refresh()}
            title={t("process:orphan.refresh")}
          >
            <RefreshCw className={loading ? "is-spinning" : undefined} size={14} />
          </button>
          {count > 0 ? (
            <button
              className="button button--secondary"
              type="button"
              aria-expanded={expanded}
              onClick={() => {
                setExpanded((current) => !current);
                setDetailPid(null);
              }}
            >
              {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
              {t(expanded ? "process:orphan.collapse" : "process:orphan.view")}
            </button>
          ) : null}
        </div>
      </header>

      {expanded && orphans && orphans.length > 0 ? (
        <div className="orphan-card__body">
          <ul className="orphan-card__list">
            {orphans.map((orphan) => {
              const busy = busyPids.has(orphan.pid);
              const detailOpen = detailPid === orphan.pid;
              const orphanOutcome = report?.outcomes.find(
                (outcome) => outcome.pid === orphan.pid,
              );
              return (
                <li key={orphan.pid}>
                  <div className="orphan-card__row">
                    <span className={`orphan-card__reason is-${orphan.orphanReason}`} title={t(`process:orphan.reason.${orphan.orphanReason}`)}>
                      {orphan.orphanReason === "parent_exited" ? <Skull size={12} /> : <UserX size={12} />}
                    </span>
                    <span className="orphan-card__name">{orphan.name}</span>
                    <span className="orphan-card__pid">PID {orphan.pid}</span>
                    <span className="orphan-card__memory">{formatBytes(orphan.memoryBytes)}</span>
                    {orphanOutcome ? (
                      <span className={`orphan-card__outcome is-${orphanOutcome.status}`}>
                        {killStatusLabel(orphanOutcome.status, t)}
                      </span>
                    ) : null}
                    <button
                      className="button button--secondary"
                      type="button"
                      disabled={busy}
                      onClick={() => setDetailPid(detailOpen ? null : orphan.pid)}
                    >
                      {detailOpen ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
                      {t("process:orphan.inspect")}
                    </button>
                    {!orphanOutcome || orphanOutcome.status === "survived" ? (
                      <button
                        className="button orphan-card__kill"
                        type="button"
                        disabled={busy}
                        onClick={() => void killOne(orphan, false)}
                      >
                        {busy ? <RefreshCw className="is-spinning" size={13} /> : <X size={13} />}
                        {t("process:orphan.end")}
                      </button>
                    ) : null}
                  </div>
                  {detailOpen ? (
                    <div className="orphan-card__detail">
                      <dl>
                        <div><dt>{t("process:orphan.detail.command")}</dt><dd>{orphan.commandLine || "—"}</dd></div>
                        <div>
                          <dt>{t("process:orphan.detail.parent")}</dt>
                          <dd>
                            {orphan.parentName ?? "—"}
                            {orphan.parentPid ? ` (PID ${orphan.parentPid})` : ""}
                          </dd>
                        </div>
                        <div><dt>{t("process:orphan.detail.reason")}</dt><dd>{t(`process:orphan.reason.${orphan.orphanReason}`)}</dd></div>
                        <div><dt>{t("process:orphan.detail.started")}</dt><dd>{new Date(orphan.startTime * 1000).toLocaleString()}</dd></div>
                        <div><dt>{t("process:orphan.detail.cpu")}</dt><dd>{orphan.cpuPercent.toFixed(1)}%</dd></div>
                        <div><dt>{t("process:orphan.detail.status")}</dt><dd>{orphan.status}</dd></div>
                      </dl>
                      <div className="orphan-card__detail-actions">
                        {orphanOutcome?.status === "survived" ? (
                          <button
                            className="button orphan-card__kill is-force"
                            type="button"
                            disabled={busy}
                            onClick={() => void killOne(orphan, true)}
                          >
                            {t("process:orphan.forceEnd")}
                          </button>
                        ) : null}
                        <button
                          className="button button--secondary"
                          type="button"
                          onClick={() => setDetailPid(null)}
                        >
                          {t("common:close")}
                        </button>
                      </div>
                    </div>
                  ) : null}
                </li>
              );
            })}
          </ul>
          <div className="orphan-card__footer">
            <small>
              <ShieldCheck size={13} />
              {t("process:orphan.safety")}
            </small>
            {confirmAll ? (
              <div className="orphan-card__confirm">
                <span>{t("process:orphan.confirmAll", { count })}</span>
                <small className="orphan-card__confirm-list">
                  {orphans.slice(0, 6).map((orphan) => orphan.name).join("、")}
                  {orphans.length > 6 ? t("process:orphan.confirmMore", { count: orphans.length - 6 }) : ""}
                </small>
                <button className="button orphan-card__kill" type="button" onClick={killAll}>
                  {t("process:orphan.confirmYes")}
                </button>
                <button
                  className="button button--secondary"
                  type="button"
                  onClick={() => setConfirmAll(false)}
                >
                  {t("common:cancel")}
                </button>
              </div>
            ) : (
              <button
                className="button orphan-card__kill"
                type="button"
                disabled={busyPids.size > 0}
                onClick={() => setConfirmAll(true)}
              >
                <X size={13} />
                {t("process:orphan.cleanAll")}
              </button>
            )}
          </div>
        </div>
      ) : null}

      {report ? (
        <div className="orphan-card__report" role="status">
          <span>{t("process:orphan.reportTitle")}</span>
          <strong>
            {report.outcomes.filter((outcome) => outcome.status === "killed" || outcome.status === "force_killed").length}
            {" / "}
            {report.outcomes.length}
          </strong>
          <button className="button button--plain" type="button" onClick={closeReport}>
            <X size={13} />
            {t("common:close")}
          </button>
        </div>
      ) : null}

      {error ? (
        <div className="orphan-card__error" role="alert">
          <AlertTriangle size={14} />
          <span>{error}</span>
        </div>
      ) : null}
    </section>
  );
}
