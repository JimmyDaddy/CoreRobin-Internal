import type { LucideIcon } from "lucide-react";
import type { ResourceUsageLevel } from "../utils";

interface MetricCardProps {
  icon: LucideIcon;
  label: string;
  value: string;
  context: string;
  tone: "blue" | "green" | "amber" | "violet";
  progress?: number;
  usageLevel?: ResourceUsageLevel;
}

export function MetricCard({
  icon: Icon,
  label,
  value,
  context,
  tone,
  progress,
  usageLevel,
}: MetricCardProps) {
  return (
    <article className={`metric-card metric-card--${tone}${usageLevel ? ` metric-card--usage-${usageLevel}` : ""}`}>
      <div className="metric-card__header">
        <span className="metric-card__icon" aria-hidden="true">
          <Icon size={17} strokeWidth={1.8} />
        </span>
        <span>{label}</span>
      </div>
      <strong className={`metric-card__value${usageLevel ? ` resource-usage resource-usage--${usageLevel}` : ""}`}>{value}</strong>
      <span className="metric-card__context">{context}</span>
      {progress !== undefined ? (
        <span className="metric-card__track" aria-hidden="true">
          <span style={{ width: `${Math.min(100, Math.max(0, progress))}%` }} />
        </span>
      ) : null}
    </article>
  );
}
