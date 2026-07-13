import type { LucideIcon } from "lucide-react";

interface MetricCardProps {
  icon: LucideIcon;
  label: string;
  value: string;
  context: string;
  tone: "blue" | "green" | "amber" | "violet";
  progress?: number;
}

export function MetricCard({
  icon: Icon,
  label,
  value,
  context,
  tone,
  progress,
}: MetricCardProps) {
  return (
    <article className={`metric-card metric-card--${tone}`}>
      <div className="metric-card__header">
        <span className="metric-card__icon" aria-hidden="true">
          <Icon size={17} strokeWidth={1.8} />
        </span>
        <span>{label}</span>
      </div>
      <strong className="metric-card__value">{value}</strong>
      <span className="metric-card__context">{context}</span>
      {progress !== undefined ? (
        <span className="metric-card__track" aria-hidden="true">
          <span style={{ width: `${Math.min(100, Math.max(0, progress))}%` }} />
        </span>
      ) : null}
    </article>
  );
}
