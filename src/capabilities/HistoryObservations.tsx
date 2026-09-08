import { useTranslation } from "react-i18next";
import type { CapabilityResult } from "./contracts";
import { formatPercent, formatRate } from "../utils";

const labels = {
  "Saved resource sample count": "samples", "Earliest resource sample age": "earliest",
  "Latest resource sample age": "latest", "Saved network buckets": "buckets",
  "Historical TCP probes": "probes", "Historical successful TCP probes": "successes",
  "Historical TCP probe failure percentage (not packet loss)": "failure",
  "Latest network history age": "networkAge", "DNS layer failed buckets": "dnsFailures",
  "Direct TCP layer failed buckets": "tcpFailures", "Saved resource-alert events": "alerts",
} as const;
const metrics = { CPU: "cpu", memory: "memory", "disk reads": "reads", "disk writes": "writes", "receive rate": "receive", "send rate": "send" } as const;
const coverages = {
  "No saved resource samples cover the selected time range. Recording may be off, cleared, or expired.": "noResources",
  "Historical values summarize recorded samples only; gaps between samples are not reconstructed.": "samplesOnly",
  "No saved network-quality history covers the selected range. No additional checks were started.": "noNetwork",
  "No saved resource-alert events cover this range. The selected incident cannot be reconstructed from missing records.": "noAlerts",
  "The selected incident is not an exact match for a saved alert. Only the available time-range observations are included.": "unmatched",
  "The exact selected resource alert and available records from the same occurrence are included. Other alerts in this time range are excluded.": "exact",
} as const;

export function HistoryObservations({ result }: { result: Extract<CapabilityResult, { kind: "observations" }> }) {
  const { t, i18n } = useTranslation("capabilities");
  const numeric = new Intl.NumberFormat(i18n.resolvedLanguage, { maximumFractionDigits: 2 });
  const label = (raw: string) => {
    const key = labels[raw as keyof typeof labels];
    if (key) return t(`history.${key}`);
    const aggregate = /^Historical (CPU|memory|disk reads|disk writes|receive rate|send rate) (mean|peak)$/.exec(raw);
    if (aggregate) return t(aggregate[2] === "mean" ? "history.mean" : "history.peak", { metric: t(`history.${metrics[aggregate[1] as keyof typeof metrics]}`) });
    const alert = /^Resource alert (\d+)( observed value)?$/.exec(raw);
    return alert ? t(alert[2] ? "history.alertValue" : "history.alert", { index: alert[1] }) : raw;
  };
  const value = (raw: string) => {
    const alert = /^(cpu|memory|volume), (triggered|recovered|unknown), (\d+) seconds ago$/.exec(raw);
    if (alert) return t("history.alertState", { resource: t(`history.${alert[1] as "cpu" | "memory" | "volume"}`), state: t(`history.${alert[2] as "triggered" | "recovered" | "unknown"}`), seconds: numeric.format(Number(alert[3])) });
    const measured = /^(\d+(?:\.\d+)?(?:e[+-]?\d+)?)\s*(%|bytes\/second|minutes|samples|buckets|probes|events)?$/i.exec(raw);
    if (!measured) return raw;
    const n = Number(measured[1]);
    if (!Number.isFinite(n)) return raw;
    if (measured[2] === "%") return formatPercent(n);
    if (measured[2] === "bytes/second") return formatRate(n);
    if (measured[2] === "minutes") return t("history.minutes", { value: numeric.format(n) });
    return numeric.format(n);
  };
  return <>
    <dl className="capability-observations">{result.observations.map((item, index) => <div key={index}><dt>{label(item.label)}</dt><dd>{value(item.value)}</dd></div>)}</dl>
    {result.observations.length === 0 && <p>{t("noData")}</p>}
    {result.coverage.map((item, index) => <p className="capability-hint" key={index}>{coverages[item as keyof typeof coverages] ? t(`history.${coverages[item as keyof typeof coverages]}`) : item}</p>)}
  </>;
}
