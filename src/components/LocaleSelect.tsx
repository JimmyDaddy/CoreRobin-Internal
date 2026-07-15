import { ChevronDown, Languages } from "lucide-react";

import {
  SUPPORTED_LOCALES,
  isSupportedLanguage,
  type SupportedLanguage,
} from "../language";

export function LocaleSelect({
  value,
  label,
  onChange,
  compact = false,
  withIcon = false,
  className = "",
}: {
  value: SupportedLanguage;
  label: string;
  onChange: (language: SupportedLanguage) => void;
  compact?: boolean;
  withIcon?: boolean;
  className?: string;
}) {
  const classes = [
    "settings-select",
    "locale-select",
    compact ? "settings-select--compact" : "",
    withIcon ? "locale-select--with-icon" : "",
    className,
  ].filter(Boolean).join(" ");

  return (
    <span className={classes}>
      {withIcon ? (
        <Languages
          className="locale-select__icon"
          size={15}
          aria-hidden="true"
        />
      ) : null}
      <select
        value={value}
        aria-label={label}
        title={label}
        onChange={(event) => {
          if (isSupportedLanguage(event.target.value)) {
            onChange(event.target.value);
          }
        }}
      >
        {SUPPORTED_LOCALES.map((locale) => (
          <option key={locale.code} value={locale.code}>
            {compact ? locale.compactLabel : locale.nativeName}
          </option>
        ))}
      </select>
      <ChevronDown
        className="locale-select__chevron"
        size={14}
        strokeWidth={2}
        aria-hidden="true"
      />
    </span>
  );
}
