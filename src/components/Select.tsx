import { forwardRef, type SelectHTMLAttributes } from "react";
import "../styles/controls.css";

export interface SelectProps extends SelectHTMLAttributes<HTMLSelectElement> {
  density?: "default" | "compact";
}

/** Keep the platform's native keyboard, validation and option-list behavior. */
export const Select = forwardRef<HTMLSelectElement, SelectProps>(function Select(
  { className, density = "default", ...props }, ref,
) {
  return <select {...props} ref={ref} className={["ui-select", density === "compact" && "ui-select--compact", className].filter(Boolean).join(" ")} />;
});
