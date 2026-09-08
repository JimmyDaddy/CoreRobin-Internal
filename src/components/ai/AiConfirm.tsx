import { useEffect, useId, useRef } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "../Button";

export function AiConfirm({
  title,
  description,
  busy,
  onCancel,
  onConfirm,
}: {
  title: string;
  description: string;
  busy: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const { t } = useTranslation("ai");
  const id = useId();
  const cancelRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<HTMLElement>(null);
  useEffect(() => {
    const previous = document.activeElement;
    cancelRef.current?.focus();
    return () => {
      if (previous instanceof HTMLElement && previous.isConnected)
        previous.focus();
    };
  }, []);
  return (
    <div
      className="ai-confirm"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !busy) onCancel();
      }}
    >
      <section
        ref={dialogRef}
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={id}
        onKeyDown={(event) => {
          if (
            event.key === "Escape" &&
            !event.nativeEvent.isComposing &&
            !busy
          ) {
            event.stopPropagation();
            onCancel();
          }
          if (event.key === "Tab") {
            const buttons =
              dialogRef.current?.querySelectorAll<HTMLButtonElement>(
                "button:not(:disabled)",
              );
            if (buttons?.length) {
              const first = buttons[0];
              const last = buttons[buttons.length - 1];
              if (event.shiftKey && document.activeElement === first) {
                event.preventDefault();
                last?.focus();
              } else if (!event.shiftKey && document.activeElement === last) {
                event.preventDefault();
                first?.focus();
              }
            }
          }
        }}
      >
        <h3 id={id}>{title}</h3>
        <p>{description}</p>
        <div className="ai-toolbar">
          <Button ref={cancelRef} disabled={busy} onClick={onCancel}>
            {t("cancel")}
          </Button>
          <Button variant="danger" disabled={busy} onClick={onConfirm}>
            {busy ? t("loading") : t("remove")}
          </Button>
        </div>
      </section>
    </div>
  );
}
