import {
  CheckCircle2,
  Download,
  FileJson2,
  FileSpreadsheet,
  LoaderCircle,
  ShieldCheck,
} from "lucide-react";
import { useMemo, useState } from "react";

import { isDesktopRuntime, writeHistoryExport } from "../api";
import {
  buildHistoryExport,
  HISTORY_EXPORT_METRICS,
  historyExportFileName,
  previewHistoryExport,
  type HistoryExportFormat,
  type HistoryExportMetric,
  type HistoryExportRange,
  type HistoryExportSources,
} from "../historyExport";
import { useAppTranslation } from "../i18n/useAppTranslation";
import { normalizeCommandError } from "../utils";
import { Button } from "./Button";

export function HistoryExportPanel({
  sources,
  nowMs,
}: {
  sources: HistoryExportSources;
  nowMs?: number;
}) {
  const { t, i18n } = useAppTranslation();
  const now = useMemo(() => nowMs ?? Date.now(), [nowMs]);
  const [range, setRange] = useState<HistoryExportRange>(168);
  const [format, setFormat] = useState<HistoryExportFormat>("json");
  const [metrics, setMetrics] = useState<HistoryExportMetric[]>([
    "cpu",
    "memory",
    "disk",
    "network",
    "events",
    "actions",
  ]);
  const [includeApplicationNames, setIncludeApplicationNames] = useState(false);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<{
    kind: "success" | "error";
    message: string;
  } | null>(null);
  const selection = useMemo(() => ({
    range,
    metrics,
    includeApplicationNames,
  }), [includeApplicationNames, metrics, range]);
  const preview = useMemo(
    () => previewHistoryExport(sources, selection, now),
    [now, selection, sources],
  );

  const toggleMetric = (metric: HistoryExportMetric, checked: boolean) => {
    setMetrics((current) => checked
      ? [...new Set([...current, metric])]
      : current.filter((value) => value !== metric));
  };
  const saveExport = async () => {
    if (metrics.length === 0 || saving) return;
    setSaving(true);
    setNotice(null);
    try {
      const fileName = historyExportFileName(format, now);
      let path = fileName;
      if (isDesktopRuntime()) {
        const { save } = await import("@tauri-apps/plugin-dialog");
        const selected = await save({
          defaultPath: fileName,
          filters: [{
            name: format === "json" ? "JSON" : "CSV",
            extensions: [format],
          }],
        });
        if (!selected) return;
        path = selected;
      }
      await writeHistoryExport(
        path,
        buildHistoryExport(sources, selection, format, now),
      );
      setNotice({
        kind: "success",
        message: t("history:export.saved"),
      });
    } catch (error) {
      setNotice({
        kind: "error",
        message: normalizeCommandError(error).message,
      });
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="panel history-export" aria-labelledby="history-export-title">
      <header>
        <span className="history-export__icon"><Download size={18} /></span>
        <div>
          <span className="eyebrow">{t("history:export.eyebrow")}</span>
          <h3 id="history-export-title">{t("history:export.title")}</h3>
          <p>{t("history:export.description")}</p>
        </div>
      </header>

      <div className="history-export__controls">
        <fieldset>
          <legend>{t("history:export.range")}</legend>
          <div className="history-export__segmented">
            {([24, 168, "all"] as const).map((value) => (
              <button
                key={value}
                className={range === value ? "is-active" : undefined}
                type="button"
                aria-pressed={range === value}
                onClick={() => setRange(value)}
              >
                {t(`history:export.ranges.${value}`)}
              </button>
            ))}
          </div>
        </fieldset>
        <fieldset>
          <legend>{t("history:export.format")}</legend>
          <div className="history-export__segmented">
            <button
              className={format === "json" ? "is-active" : undefined}
              type="button"
              aria-pressed={format === "json"}
              onClick={() => setFormat("json")}
            >
              <FileJson2 size={14} />JSON
            </button>
            <button
              className={format === "csv" ? "is-active" : undefined}
              type="button"
              aria-pressed={format === "csv"}
              onClick={() => setFormat("csv")}
            >
              <FileSpreadsheet size={14} />CSV
            </button>
          </div>
        </fieldset>
      </div>

      <fieldset className="history-export__metrics">
        <legend>{t("history:export.metrics")}</legend>
        {HISTORY_EXPORT_METRICS.map((metric) => (
          <label key={metric}>
            <input
              type="checkbox"
              checked={metrics.includes(metric)}
              onChange={(event) => toggleMetric(metric, event.target.checked)}
            />
            <span>{t(`history:export.metric.${metric}`)}</span>
          </label>
        ))}
      </fieldset>

      <div className="history-export__preview">
        <ShieldCheck size={17} />
        <div>
          <strong>{t("history:export.previewTitle")}</strong>
          <p>{t("history:export.preview", {
            count: preview.recordCount,
            from: preview.fromMs === null
              ? "—"
              : new Date(preview.fromMs).toLocaleString(i18n.resolvedLanguage),
            to: new Date(preview.toMs).toLocaleString(i18n.resolvedLanguage),
          })}</p>
          <small>{t("history:export.excluded")}</small>
        </div>
      </div>
      <label className="history-export__names">
        <input
          type="checkbox"
          checked={includeApplicationNames}
          onChange={(event) => setIncludeApplicationNames(event.target.checked)}
        />
        <span>
          <strong>{t("history:export.includeNames")}</strong>
          <small>{t("history:export.includeNamesDescription")}</small>
        </span>
      </label>

      <footer>
        <span>{t("history:export.localOnly")}</span>
        <Button
          variant="primary"
          disabled={metrics.length === 0 || saving}
          aria-busy={saving}
          onClick={() => void saveExport()}
        >
          {saving
            ? <LoaderCircle className="is-spinning" size={15} />
            : <Download size={15} />}
          {t("history:export.save")}
        </Button>
      </footer>
      {notice ? (
        <p className={`history-export__notice is-${notice.kind}`} role={notice.kind === "error" ? "alert" : "status"}>
          {notice.kind === "success" ? <CheckCircle2 size={14} /> : null}
          {notice.message}
        </p>
      ) : null}
    </section>
  );
}
