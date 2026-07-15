import { forwardRef, type ButtonHTMLAttributes } from "react";

export type ButtonVariant = "plain" | "primary" | "secondary" | "danger" | "dangerGhost";

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
}

const VARIANT_CLASS: Record<ButtonVariant, string | null> = {
  plain: null,
  primary: "button--primary",
  secondary: "button--secondary",
  danger: "button--danger",
  dangerGhost: "button--danger-ghost",
};

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { className, type = "button", variant = "plain", ...props },
  ref,
) {
  return (
    <button
      {...props}
      ref={ref}
      type={type}
      className={["button", VARIANT_CLASS[variant], className].filter(Boolean).join(" ")}
    />
  );
});
