import { useTranslation } from "react-i18next";
import type { CleanupSafety } from "../types";
import { formatBytes } from "../utils";

/** The same item identity and risk presentation in selection cards and confirmation dialogs. */
export function CleanupItemSummary({ name, path, bytes, safety, caption }: {
  name: string; path?: string | null; bytes: number; safety: CleanupSafety; caption?: string;
}) {
  const { t } = useTranslation("cleanup");
  return <>
    <span className={`is-${safety}`}><i />{t(`safety.${safety}`)}</span>
    <div><strong>{name}</strong>{path && <code title={path}>{path}</code>}{caption && <small>{caption}</small>}</div>
    <b>{formatBytes(bytes)}</b>
  </>;
}
