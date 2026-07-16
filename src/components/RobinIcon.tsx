import brandMark from "../assets/brand-mark.png";

interface RobinIconProps {
  className?: string;
  size?: number | string;
}

export function RobinIcon({ className, size = 24 }: RobinIconProps) {
  return (
    <img
      className={`robin-icon${className ? ` ${className}` : ""}`}
      src={brandMark}
      width={size}
      height={size}
      alt=""
      aria-hidden="true"
    />
  );
}
