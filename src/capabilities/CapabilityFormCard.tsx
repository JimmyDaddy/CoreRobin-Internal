import { Component, lazy, Suspense, useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { Maximize2, X } from "lucide-react";
import { toolboxToolTranslationKey } from "../toolbox/registry";
import type { ToolId } from "../toolbox/contracts";
import type { QuickCleanCategorySummary } from "../types";
import { formatBytes } from "../utils";
import { BUSINESS_FORM_TITLE_KEYS, isBusinessFormId, type CapabilityFormId } from "./formCatalog";

const CapabilityOperation = lazy(() => import("./CapabilityOperation").then((module) => ({ default: module.CapabilityOperation })));

export function CapabilityFormCard({ capabilityId, analysis, utilityOutput, outputTruncated, compact, busy, onExpand }: {
  capabilityId: CapabilityFormId; analysis?: QuickCleanCategorySummary[]; utilityOutput?: string; outputTruncated?: boolean; compact: boolean; busy: boolean; onExpand?: () => void;
}) {
  const { t } = useTranslation("capabilities");
  const { t: toolbox } = useTranslation("toolbox");
  const { t: cleanup } = useTranslation("cleanup");
  const [opened, setOpened] = useState(false);
  const title = isBusinessFormId(capabilityId) ? t(BUSINESS_FORM_TITLE_KEYS[capabilityId]) : capabilityId === "storage.quick_clean" ? cleanup("quickClean.title") : toolbox(toolboxToolTranslationKey(capabilityId.slice(8) as ToolId, "title"));
  return <div className="capability-form-card" data-capability-id={capabilityId}>
    <strong>{title}</strong>
    {analysis && <><p className="capability-hint">{t("analysisOnly")}</p><ul className="capability-volume-list">{analysis.map((item) => <li key={item.category}><span>{cleanup(`quickClean.category.${item.category}`)}</span><strong>{item.available ? formatBytes(item.byteSize) : cleanup("quickClean.unavailable")}</strong></li>)}</ul></>}
    {utilityOutput !== undefined && <><p className="capability-hint">{t("computedText")}</p><pre className="capability-utility-output">{utilityOutput}</pre>{outputTruncated && <p className="capability-hint">{t("outputTruncated")}</p>}</>}
    <p className="capability-hint">{t("formPrivacy")}</p>
    {compact && <p className="capability-hint">{t("mainWindowForm")}</p>}
    <button type="button" className="button button--secondary" disabled={busy || (compact && !onExpand)} onClick={() => compact ? onExpand?.() : setOpened(true)}><Maximize2 size={14} />{t(compact ? "continueMain" : "openOperation")}</button>
    {opened && <OperationDialog title={title} onClose={() => setOpened(false)}><OperationBoundary fallback={<p role="alert">{toolbox("capability.unavailable")}</p>}><Suspense fallback={<p role="status">{t("loadingOperation")}</p>}><CapabilityOperation capabilityId={capabilityId} onExit={() => setOpened(false)} /></Suspense></OperationBoundary></OperationDialog>}
  </div>;
}

function OperationDialog({ title, children, onClose }: { title: string; children: React.ReactNode; onClose: () => void }) {
  const { t } = useTranslation("capabilities");
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => {
    const previous = document.activeElement;
    if (ref.current?.showModal) ref.current.showModal(); else ref.current?.setAttribute("open", "");
    const dialog = ref.current;
    return () => { dialog?.close?.(); if (previous instanceof HTMLElement && previous.isConnected) previous.focus(); };
  }, []);
  return createPortal(<dialog ref={ref} className="capability-form-dialog" aria-labelledby={titleId} onKeyDown={(event) => { if (event.key === "Escape" && ref.current?.querySelector('[role="alertdialog"]')) event.preventDefault(); }} onCancel={(event) => { event.preventDefault(); event.stopPropagation(); onClose(); }}>
    <header><h2 id={titleId}>{title}</h2><button type="button" className="icon-button" autoFocus aria-label={t("closeOperation")} onClick={onClose}><X size={18} /></button></header>
    <div className="capability-form-body" data-layout="embedded">{children}</div>
  </dialog>, document.body);
}

class OperationBoundary extends Component<{ children: React.ReactNode; fallback: React.ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() { return this.state.failed ? this.props.fallback : this.props.children; }
}
