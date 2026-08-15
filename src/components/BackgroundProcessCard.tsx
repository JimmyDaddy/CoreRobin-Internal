import { useMemo, useState } from "react";
import {
  ChevronDown,
  ChevronRight,
  CircleDotDashed,
  SearchCheck,
  ShieldCheck,
} from "lucide-react";

import { useAppTranslation } from "../i18n/useAppTranslation";
import { isResidualProcess } from "../processExplorer";
import type { ProcessRow } from "../types";
import { formatBytes, formatDuration } from "../utils";
import "./BackgroundProcessCard.css";

interface BackgroundProcessCardProps {
  processes: readonly ProcessRow[];
  onInspect: (process: ProcessRow) => void;
}

export function BackgroundProcessCard({
  processes,
  onInspect,
}: BackgroundProcessCardProps) {
  const { t } = useAppTranslation();
  const [expanded, setExpanded] = useState(false);
  const candidates = useMemo(
    () => processes.filter(isResidualProcess).sort((left, right) => right.memoryBytes - left.memoryBytes),
    [processes],
  );

  if (candidates.length === 0) return null;

  const totalMemory = candidates.reduce(
    (total, process) => total + process.memoryBytes,
    0,
  );

  return (
    <section
      className="panel background-process-card"
      aria-labelledby="background-process-card-title"
    >
      <header className="background-process-card__header">
        <span className="background-process-card__icon" aria-hidden="true">
          <CircleDotDashed size={19} />
        </span>
        <div>
          <span className="eyebrow">{t("process:background.kicker")}</span>
          <h3 id="background-process-card-title">
            {t("process:background.title")}
          </h3>
          <p>
            {t("process:background.summary", {
              count: candidates.length,
              size: formatBytes(totalMemory),
            })}
          </p>
        </div>
        <button
          className="button button--secondary"
          type="button"
          aria-expanded={expanded}
          onClick={() => setExpanded((current) => !current)}
        >
          {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
          {t(expanded ? "process:background.collapse" : "process:background.view")}
        </button>
      </header>

      {expanded ? (
        <div className="background-process-card__body">
          <ul className="background-process-card__list">
            {candidates.map((process) => (
              <li key={process.birthToken ?? `${process.pid}:${process.startTime}`}>
                <span className="background-process-card__state" aria-hidden="true">
                  <SearchCheck size={13} />
                </span>
                <span className="background-process-card__identity">
                  <strong>{process.name}</strong>
                  <small>
                    PID {process.pid}
                    {process.backgroundObservedSeconds !== null
                      && process.backgroundObservedSeconds !== undefined
                      ? ` · ${t("process:background.observed", {
                          duration: formatDuration(process.backgroundObservedSeconds),
                        })}`
                      : ""}
                  </small>
                </span>
                <span className="background-process-card__memory">
                  {formatBytes(process.memoryBytes)}
                </span>
                <button
                  className="button button--secondary"
                  type="button"
                  onClick={() => onInspect(process)}
                >
                  <SearchCheck size={14} />
                  {t("process:background.inspect")}
                </button>
              </li>
            ))}
          </ul>
          <footer>
            <ShieldCheck size={14} />
            <span>{t("process:background.safety")}</span>
          </footer>
        </div>
      ) : null}
    </section>
  );
}
