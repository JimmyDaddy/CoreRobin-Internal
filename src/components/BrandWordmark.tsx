interface BrandWordmarkProps {
  className?: string;
}

export function BrandWordmark({ className }: BrandWordmarkProps) {
  return (
    <strong
      className={`brand-wordmark${className ? ` ${className}` : ""}`}
      aria-label="CoreRobin"
    >
      <span aria-hidden="true">
        Core<span className="brand-wordmark__r">R<i /></span>obin
      </span>
    </strong>
  );
}
