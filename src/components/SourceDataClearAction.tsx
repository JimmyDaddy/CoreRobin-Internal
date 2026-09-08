import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Trash2 } from "lucide-react";
import { useAppTranslation } from "../i18n/useAppTranslation";
import { withAiSourceClear, type AiSourceCategory } from "../aiSourcePrivacy";

export function SourceDataClearAction({label, disabled = false, category, onClear}: {
  label: string;
  disabled?: boolean;
  category?: AiSourceCategory;
  onClear: (deleteRelated: boolean) => void | boolean | Promise<void | boolean>;
}) {
  const {t} = useAppTranslation();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const [deleteRelated, setDeleteRelated] = useState(false);
  const id = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const dialog = useRef<HTMLElement>(null);
  const cancel = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement;
    cancel.current?.focus();
    return () => { if (previous instanceof HTMLElement && previous.isConnected) previous.focus(); };
  }, [open]);
  const clear = async () => {
    if (busy) return;
    setBusy(true); setFailed(false);
    try {
      const remove = async () => onClear(deleteRelated);
      const result = category ? await withAiSourceClear(category, deleteRelated, remove) : await remove();
      if (result === false) setFailed(true); else setOpen(false);
    } catch { setFailed(true); }
    finally { setBusy(false); }
  };
  return <>
    <button ref={trigger} type="button" className="button button--danger-ghost" disabled={disabled || busy} onClick={() => { setDeleteRelated(false); setFailed(false); setOpen(true); }}><Trash2 size={14} />{label}</button>
    {open ? createPortal(<div className="dialog-backdrop" onMouseDown={(event) => { if (!busy && event.target === event.currentTarget) setOpen(false); }}>
      <section ref={dialog} className="confirm-dialog" role="alertdialog" aria-modal="true" aria-labelledby={id} onKeyDown={(event) => {
        if (event.key === "Escape" && !event.nativeEvent.isComposing && !busy) { event.preventDefault(); event.stopPropagation(); setOpen(false); }
        if (event.key === "Tab") {
          const elements = dialog.current?.querySelectorAll<HTMLElement>("button:not(:disabled),input:not(:disabled)");
          const first = elements?.[0], last = elements?.[elements.length - 1];
          if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
          else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
        }
      }}>
        <h2 id={id}>{label}</h2><p>{t("ai:sourceCopiesRemain")}</p>
        <label className="ai-source-clear-notice"><span><input type="checkbox" disabled={busy} checked={deleteRelated} onChange={(event) => setDeleteRelated(event.target.checked)} /> {t("ai:deleteRelated")}</span></label>
        {failed ? <p role="alert">{t("settings:dataPrivacy.result.failed")}</p> : null}
        <footer><button ref={cancel} type="button" className="button button--secondary" disabled={busy} onClick={() => setOpen(false)}>{t("common:cancel")}</button>
          <button type="button" className="button button--danger" disabled={busy} onClick={() => void clear()}>{t(busy ? "settings:about.clearing" : "settings:dataPrivacy.result.clear")}</button></footer>
      </section>
    </div>, trigger.current?.closest("dialog") ?? document.body) : null}
  </>;
}
