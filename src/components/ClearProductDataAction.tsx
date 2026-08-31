import { AlertTriangle, LoaderCircle, Trash2, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { useAppTranslation } from "../i18n/useAppTranslation";
import type { ProductDataClearResult } from "../productDataClear";
import { Button, type ButtonVariant } from "./Button";

export function ClearProductDataAction({
  label,
  variant = "dangerGhost",
  onClearAllData,
}: {
  label: string;
  variant?: ButtonVariant;
  onClearAllData: () => Promise<void | ProductDataClearResult[]>;
}) {
  const { t } = useAppTranslation();
  const [open, setOpen] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [failed, setFailed] = useState(false);
  const [results, setResults] = useState<ProductDataClearResult[]>([]);
  const cancelButtonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    cancelButtonRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !clearing) setOpen(false);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [clearing, open]);

  const clear = async () => {
    if (clearing) return;
    setClearing(true);
    setFailed(false);
    setResults([]);
    try {
      const nextResults = await onClearAllData();
      if (Array.isArray(nextResults)) {
        setResults(nextResults);
        const hasFailure = nextResults.some((result) => result.status !== "succeeded");
        setFailed(hasFailure);
        if (!hasFailure) setOpen(false);
      } else {
        setOpen(false);
      }
    } catch {
      setFailed(true);
    } finally {
      setClearing(false);
    }
  };

  return (
    <>
      <Button variant={variant} onClick={() => {
        setFailed(false);
        setResults([]);
        setOpen(true);
      }}>
        <Trash2 size={15} />{label}
      </Button>
      {open ? (
        <div
          className="dialog-backdrop"
          role="presentation"
          onMouseDown={clearing ? undefined : () => setOpen(false)}
        >
          <section
            className="confirm-dialog clear-product-data-dialog"
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="clear-product-data-title"
            onMouseDown={(event) => event.stopPropagation()}
          >
            <header>
              <span className="dialog-icon dialog-icon--danger"><Trash2 size={20} /></span>
              <div>
                <h2 id="clear-product-data-title">{t("settings:about.clearTitle")}</h2>
                <p>{t("settings:about.clearConfirm")}</p>
              </div>
              <button
                className="icon-button"
                type="button"
                aria-label={t("common:cancel")}
                disabled={clearing}
                onClick={() => setOpen(false)}
              >
                <X size={17} />
              </button>
            </header>
            <ul className="clear-product-data-dialog__scope">
              <li>{t("settings:about.clearScope.history")}</li>
              <li>{t("settings:about.clearScope.scans")}</li>
              <li>{t("settings:dataPrivacy.caches.title")}</li>
              <li>{t("settings:about.clearScope.preferences")}</li>
            </ul>
            {failed ? (
              <p className="clear-product-data-dialog__error" role="alert">
                <AlertTriangle size={15} />{t("settings:about.clearError")}
              </p>
            ) : null}
            {results.length > 0 ? (
              <ul className="clear-product-data-dialog__results">
                {results.map((result) => (
                  <li key={result.scope} data-status={result.status}>
                    <span>
                      {result.scope === "preferences"
                        ? t("settings:about.clearScope.preferences")
                        : result.scope === "toolbox"
                          ? t("settings:dataPrivacy.caches.title")
                          : t(`settings:dataPrivacy.categories.${result.scope}.title`)}
                    </span>
                    <strong>
                      {t(`settings:dataPrivacy.result.${result.status}`)}
                    </strong>
                  </li>
                ))}
              </ul>
            ) : null}
            <footer>
              <Button
                ref={cancelButtonRef}
                variant="secondary"
                disabled={clearing}
                onClick={() => setOpen(false)}
              >
                {t("common:cancel")}
              </Button>
              <Button variant="danger" disabled={clearing} onClick={() => void clear()}>
                {clearing ? <LoaderCircle className="is-spinning" size={15} /> : <Trash2 size={15} />}
                {t(
                  clearing
                    ? "settings:about.clearing"
                    : failed
                      ? "settings:dataPrivacy.result.retry"
                      : "settings:about.clearNow",
                )}
              </Button>
            </footer>
          </section>
        </div>
      ) : null}
    </>
  );
}
