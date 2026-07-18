import { Activity, ChevronDown, Cpu, RefreshCw, Zap } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

import { getGpuEnergySnapshot } from "../api";
import { useAppTranslation } from "../i18n/useAppTranslation";
import type { GpuEnergySnapshot, ProcessRow } from "../types";
import { formatPercent, normalizeCommandError } from "../utils";
import "./GpuEnergyPanel.css";

const REFRESH_INTERVAL_MS = 15_000;
const MINIMUM_VISIBLE_IMPACT = 0.05;

export function GpuEnergyPanel({ processes }: { processes: ProcessRow[] }) {
  const { t } = useAppTranslation();
  const [expanded, setExpanded] = useState(false);
  const [snapshot, setSnapshot] = useState<GpuEnergySnapshot | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      setSnapshot(await getGpuEnergySnapshot());
      setError(null);
    } catch (reason) {
      setError(normalizeCommandError(reason).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!expanded) return;
    void refresh();
    const timer = window.setInterval(() => void refresh(), REFRESH_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [expanded, refresh]);

  const applications = useMemo(() => {
    if (!snapshot) return [];
    const byPid = new Map(processes.map((process) => [process.pid, process]));
    const impact = new Map<string, number>();
    for (const sample of snapshot.processEnergy) {
      if (!Number.isFinite(sample.impact) || sample.impact <= MINIMUM_VISIBLE_IMPACT) continue;
      const name = byPid.get(sample.pid)?.name ?? `PID ${sample.pid}`;
      impact.set(name, (impact.get(name) ?? 0) + sample.impact);
    }
    return [...impact.entries()]
      .map(([name, value]) => ({ name, impact: value }))
      .sort((left, right) => right.impact - left.impact)
      .slice(0, 8);
  }, [processes, snapshot]);
  const maximumImpact = applications[0]?.impact ?? 1;
  const primaryAdapter = snapshot?.adapters[0] ?? null;

  return (
    <section className={`panel gpu-energy${expanded ? " is-expanded" : ""}`} aria-labelledby="gpu-energy-title">
      <header className="gpu-energy__header">
        <button
          className="gpu-energy__disclosure"
          type="button"
          aria-expanded={expanded}
          aria-controls="gpu-energy-details"
          onClick={() => setExpanded((current) => !current)}
        >
          <span className="gpu-energy__mark" aria-hidden="true"><Cpu size={17} /></span>
          <span className="gpu-energy__heading">
            <small>{t("applications:energy.eyebrow")}</small>
            <strong id="gpu-energy-title">{t("applications:energy.title")}</strong>
            <em>{t("applications:energy.collapsedDescription")}</em>
          </span>
          <span className="gpu-energy__glance">
            {primaryAdapter?.utilizationPercent === null || primaryAdapter?.utilizationPercent === undefined
              ? t("applications:energy.onDemand")
              : t("applications:energy.activity", { value: formatPercent(primaryAdapter.utilizationPercent) })}
          </span>
          <ChevronDown className="gpu-energy__chevron" size={16} aria-hidden="true" />
        </button>
        {expanded ? <button className="icon-button" type="button" aria-label={t("common:refresh")} disabled={loading} onClick={() => void refresh()}><RefreshCw className={loading ? "is-spinning" : undefined} size={14} /></button> : null}
      </header>
      {expanded ? <div className="gpu-energy__details" id="gpu-energy-details">
        {error ? <div className="network-connections__notice is-error" role="alert">{error}</div> : null}
        {snapshot?.gpuAvailable ? (
          <div className="gpu-energy__adapters">
            {snapshot.adapters.map((adapter) => (
              <article key={adapter.name}>
                <span><Cpu size={17} /></span>
                <div><strong>{adapter.name}</strong><small>{adapter.coreCount === null ? t("applications:energy.gpu") : t("applications:energy.cores", { count: adapter.coreCount })}</small></div>
                <b>{adapter.utilizationPercent === null ? "—" : formatPercent(adapter.utilizationPercent)}</b>
              </article>
            ))}
          </div>
        ) : (
          <div className="gpu-energy__unavailable"><Activity size={18} /><span>{loading ? t("common:loading") : t("applications:energy.gpuUnavailable")}</span></div>
        )}
        {snapshot?.processEnergyAvailable && applications.length > 0 ? (
          <div className="gpu-energy__applications">
            <h3><Zap size={15} />{t("applications:energy.applicationImpact")}</h3>
            <ol>{applications.map((application) => (
              <li key={application.name}><strong>{application.name}</strong><span><i style={{ width: `${Math.max(3, application.impact / maximumImpact * 100)}%` }} /></span><b>{application.impact.toFixed(1)}</b></li>
            ))}</ol>
          </div>
        ) : <p className="gpu-energy__unavailable">{snapshot?.processEnergyAvailable
          ? t("applications:energy.noProcessActivity")
          : t("applications:energy.processUnavailable")}</p>}
        <small>{t("applications:energy.boundary")}</small>
      </div> : null}
    </section>
  );
}
