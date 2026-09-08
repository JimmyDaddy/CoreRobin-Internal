import { useState } from "react";
import { useTranslation } from "react-i18next";
import { getSystemSnapshot } from "../api";
import type { ProcessRow } from "../types";
import { userFacingError } from "../toolbox/local/toolboxErrors";

type Target = Pick<ProcessRow, "pid" | "birthToken" | "name" | "startTime">;
export function ProcessTargetPicker({ value, onSelect }: { value: string; onSelect: (target: Target) => void }) {
  const { t } = useTranslation("capabilities");
  const [targets, setTargets] = useState<Target[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const load = async () => {
    if (loading) return;
    setLoading(true); setError(null);
    try { const snapshot = await getSystemSnapshot(); setTargets(snapshot.processes.filter((process) => process.birthToken).slice(0, 100)); }
    catch (reason) { setError(userFacingError(reason)); }
    finally { setLoading(false); }
  };
  return <div className="toolbox-inline-actions">
    <button className="button button--secondary" type="button" disabled={loading} onClick={() => void load()}>{t("loadProcesses")}</button>
    {targets.length > 0 && <label>{t("selectProcess")} <select value={value} onChange={(event) => { const target = targets.find((item) => `${item.pid}:${item.birthToken}` === event.target.value); if (target) onSelect(target); }}><option value="">{t("selectProcess")}</option>{targets.map((target) => <option key={`${target.pid}:${target.birthToken}`} value={`${target.pid}:${target.birthToken}`}>{target.name} · PID {target.pid}</option>)}</select></label>}
    {error && <p role="alert">{error}</p>}
  </div>;
}
