import { invoke } from "@tauri-apps/api/core";
import { PhysicalPosition } from "@tauri-apps/api/dpi";
import { emitTo, listen } from "@tauri-apps/api/event";
import { currentMonitor, getCurrentWindow } from "@tauri-apps/api/window";
import { ArrowRight, EyeOff } from "lucide-react";
import {
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  useEffect,
  useRef,
  useState,
} from "react";

import type { TraySummary } from "../traySummary";
import { useAuxiliaryTranslation } from "../useAuxiliaryTranslation";

const COMPANION_POSITION_KEY = "status-orbit.companion-position.v1";
const COMPANION_EXPANDED_LOGICAL_SIZE = { width: 386, height: 92 };
const COMPANION_HOVER_COLLAPSE_DELAY_MS = 220;
type CompanionHealth = TraySummary["health"] | "loading";
type CompanionDailyTarget = "more" | "overview";
interface CompanionDailyBridge {
  showMainWindow: () => Promise<unknown>;
  openDaily: (target: CompanionDailyTarget) => Promise<void>;
}

const nativeCompanionDailyBridge: CompanionDailyBridge = {
  showMainWindow: () => invoke("show_main_window"),
  openDaily: (target) => emitTo("main", "status-orbit:open-daily", target),
};
const desktopRuntime = typeof window !== "undefined"
  && "__TAURI_INTERNALS__" in window
  && getCurrentWindow().label === "companion";

export function OrbitCompanionWindow() {
  const { t } = useAuxiliaryTranslation();
  const [summary, setSummary] = useState<TraySummary | null>(null);
  const previewExpanded = !desktopRuntime
    && new URLSearchParams(window.location.search).get("preview") === "expanded";
  const [expanded, setExpanded] = useState(previewExpanded);
  const expandedRef = useRef(previewExpanded);
  const [contextMenuOpen, setContextMenuOpen] = useState(false);
  const contextMenuOpenRef = useRef(false);
  const hoverCollapseTimerRef = useRef<number | undefined>(undefined);
  const resizeEpochRef = useRef(0);
  const shellRef = useRef<HTMLElement | null>(null);
  const [visibilityPhase, setVisibilityPhase] = useState<"idle" | "entering" | "exiting">("idle");
  const health = summary?.health ?? "loading";

  useEffect(() => {
    return () => {
      if (hoverCollapseTimerRef.current !== undefined) {
        window.clearTimeout(hoverCollapseTimerRef.current);
      }
    };
  }, []);

  useEffect(() => {
    if (!desktopRuntime) return;
    let disposed = false;
    let stopSummary: (() => void) | undefined;
    void listen<TraySummary>("status-orbit:tray-summary", ({ payload }) => {
      if (!disposed) setSummary(payload);
    }).then((unlisten) => { stopSummary = unlisten; });
    return () => {
      disposed = true;
      stopSummary?.();
    };
  }, []);

  useEffect(() => {
    if (!desktopRuntime) return;
    const companionWindow = getCurrentWindow();
    let disposed = false;
    let stopMoved: (() => void) | undefined;
    let stopFocus: (() => void) | undefined;
    let stopCollapse: (() => void) | undefined;
    let stopEnter: (() => void) | undefined;
    let stopExit: (() => void) | undefined;
    let visibilityTimer: number | undefined;

    const playEntrance = () => {
      if (visibilityTimer !== undefined) window.clearTimeout(visibilityTimer);
      setVisibilityPhase("entering");
      visibilityTimer = window.setTimeout(() => {
        setVisibilityPhase("idle");
        visibilityTimer = undefined;
      }, 520);
    };

    const playExit = () => {
      if (visibilityTimer !== undefined) window.clearTimeout(visibilityTimer);
      visibilityTimer = undefined;
      setVisibilityPhase("exiting");
    };

    const restorePosition = async () => {
      const [monitor, size] = await Promise.all([
        currentMonitor(),
        companionWindow.outerSize(),
      ]);
      if (!monitor || disposed) return;
      const workArea = monitor.workArea;
      const expandedWidth = Math.round(
        COMPANION_EXPANDED_LOGICAL_SIZE.width * monitor.scaleFactor,
      );
      const expandedHeight = Math.round(
        COMPANION_EXPANDED_LOGICAL_SIZE.height * monitor.scaleFactor,
      );
      let position = {
        x: workArea.position.x + workArea.size.width - expandedWidth - 18,
        y: workArea.position.y + workArea.size.height - size.height - 18,
      };
      try {
        const saved = JSON.parse(window.localStorage.getItem(COMPANION_POSITION_KEY) ?? "null") as unknown;
        if (isSavedPosition(saved)) position = saved;
      } catch {
        // Use the safe bottom-right default when storage is unavailable.
      }
      const maxX = workArea.position.x + workArea.size.width - expandedWidth;
      const minY = workArea.position.y + Math.max(0, expandedHeight - size.height);
      const maxY = workArea.position.y + workArea.size.height - size.height;
      await companionWindow.setPosition(new PhysicalPosition(
        Math.min(maxX, Math.max(workArea.position.x, position.x)),
        Math.min(maxY, Math.max(minY, position.y)),
      ));
    };

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (contextMenuOpenRef.current) {
        contextMenuOpenRef.current = false;
        setContextMenuOpen(false);
        void updateExpanded(false);
        return;
      }
      if (expandedRef.current) {
        void updateExpanded(false);
      } else {
        void hideCompanion();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    void restorePosition();
    void Promise.all([
      companionWindow.onMoved(({ payload }) => {
        try {
          window.localStorage.setItem(
            COMPANION_POSITION_KEY,
            JSON.stringify({ x: payload.x, y: payload.y }),
          );
        } catch {
          // Position persistence is optional.
        }
      }).then((unlisten) => { stopMoved = unlisten; }),
      companionWindow.onFocusChanged(({ payload: focused }) => {
        if (!focused) {
          contextMenuOpenRef.current = false;
          setContextMenuOpen(false);
          if (expandedRef.current) void updateExpanded(false);
        }
      }).then((unlisten) => { stopFocus = unlisten; }),
      listen("status-orbit:companion-collapse", () => {
        contextMenuOpenRef.current = false;
        setContextMenuOpen(false);
        expandedRef.current = false;
        setExpanded(false);
      }).then((unlisten) => { stopCollapse = unlisten; }),
      listen("status-orbit:companion-enter", playEntrance)
        .then((unlisten) => { stopEnter = unlisten; }),
      listen("status-orbit:companion-exit", playExit)
        .then((unlisten) => { stopExit = unlisten; }),
    ]);
    void companionWindow.isVisible().then((visible) => {
      if (!disposed && visible) playEntrance();
    });
    return () => {
      disposed = true;
      if (visibilityTimer !== undefined) window.clearTimeout(visibilityTimer);
      window.removeEventListener("keydown", onKeyDown);
      stopMoved?.();
      stopFocus?.();
      stopCollapse?.();
      stopEnter?.();
      stopExit?.();
    };
  }, []);

  const updateExpanded = async (nextExpanded: boolean) => {
    if (expandedRef.current === nextExpanded) return;
    const resizeEpoch = resizeEpochRef.current + 1;
    resizeEpochRef.current = resizeEpoch;
    expandedRef.current = nextExpanded;
    if (!desktopRuntime) {
      setExpanded(nextExpanded);
      return;
    }
    if (!nextExpanded) setExpanded(false);
    try {
      await invoke("set_companion_expanded", { expanded: nextExpanded });
      if (resizeEpochRef.current === resizeEpoch && nextExpanded) setExpanded(true);
    } catch {
      if (resizeEpochRef.current !== resizeEpoch) return;
      expandedRef.current = false;
      setExpanded(false);
    }
  };

  const clearHoverCollapseTimer = () => {
    if (hoverCollapseTimerRef.current === undefined) return;
    window.clearTimeout(hoverCollapseTimerRef.current);
    hoverCollapseTimerRef.current = undefined;
  };

  const expandFromHover = () => {
    clearHoverCollapseTimer();
    if (!contextMenuOpenRef.current) void updateExpanded(true);
  };

  const collapseFromHover = () => {
    if (contextMenuOpenRef.current) return;
    clearHoverCollapseTimer();
    hoverCollapseTimerRef.current = window.setTimeout(() => {
      hoverCollapseTimerRef.current = undefined;
      if (contextMenuOpenRef.current || shellRef.current?.matches(":hover")) return;
      void updateExpanded(false);
    }, COMPANION_HOVER_COLLAPSE_DELAY_MS);
  };

  const openDaily = async () => {
    contextMenuOpenRef.current = false;
    setContextMenuOpen(false);
    await openDailyFromCompanion(health, () => updateExpanded(false));
  };

  const beginDragging = (event: ReactMouseEvent<HTMLDivElement>) => {
    if (!desktopRuntime || event.button !== 0) return;
    event.preventDefault();
    contextMenuOpenRef.current = false;
    setContextMenuOpen(false);
    void getCurrentWindow().startDragging();
  };

  const handleMascotKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    void updateExpanded(!expandedRef.current);
  };

  const openContextMenu = (event: ReactMouseEvent<HTMLElement>) => {
    event.preventDefault();
    contextMenuOpenRef.current = true;
    setContextMenuOpen(true);
    void updateExpanded(true);
  };

  const hideFromContextMenu = () => {
    contextMenuOpenRef.current = false;
    setContextMenuOpen(false);
    expandedRef.current = false;
    setExpanded(false);
    void hideCompanion();
  };

  return (
    <main className={`companion-surface is-${health} ${expanded ? "is-expanded" : "is-collapsed"}${visibilityPhase === "idle" ? "" : ` is-${visibilityPhase}`} ${desktopRuntime ? "" : "is-preview"}`}>
      <section
        ref={shellRef}
        className="orbit-buddy-shell"
        onMouseEnter={expandFromHover}
        onMouseLeave={collapseFromHover}
        onContextMenu={openContextMenu}
      >
        <div
          className="orbit-buddy-mascot"
          data-tauri-drag-region
          role="button"
          tabIndex={0}
          aria-expanded={expanded}
          aria-label={t("companion.dragHint")}
          onMouseDown={beginDragging}
          onKeyDown={handleMascotKeyDown}
        >
          <span className="orbit-buddy-halo" data-tauri-drag-region />
          <span className="orbit-buddy-antenna" data-tauri-drag-region><i /></span>
          <span
            className="orbit-buddy-face"
            data-tauri-drag-region
          >
            <span className="orbit-buddy-eyes" aria-hidden="true"><i /><i /></span>
            <span className="orbit-buddy-mouth" aria-hidden="true" />
          </span>
          <span className="orbit-buddy-moon" data-tauri-drag-region />
          <span className="orbit-buddy-status" aria-hidden="true" />
        </div>

        {contextMenuOpen ? <div className="orbit-buddy-menu" role="menu" aria-label={t("companion.menu")}>
          <button type="button" role="menuitem" onClick={hideFromContextMenu}>
            <EyeOff size={14} />
            <span>{t("companion.hide")}</span>
          </button>
        </div> : expanded ? <div className="orbit-buddy-bubble">
          <small>{t("companion.kicker")}</small>
          <strong>{t(`tray.status.${health}.title`)}</strong>
          <p>
            {summary?.reason && summary.reason !== "none"
              ? t("companion.reason", { resource: t(`tray.resource.${summary.reason}`) })
              : t(`tray.status.${health}.description`)}
          </p>
          <button type="button" onClick={() => void openDaily()}>
            {t(`companion.action.${health}`)}<ArrowRight size={13} />
          </button>
        </div> : null}
      </section>
    </main>
  );
}

export async function openDailyFromCompanion(
  health: CompanionHealth,
  collapse: () => Promise<void>,
  bridge: CompanionDailyBridge = nativeCompanionDailyBridge,
) {
  await collapse();
  await bridge.showMainWindow();
  await bridge.openDaily(health === "normal" ? "more" : "overview");
}

async function hideCompanion() {
  if (!desktopRuntime) return;
  try {
    await invoke("hide_companion_window");
  } catch {
    await getCurrentWindow().hide();
  }
}

function isSavedPosition(value: unknown): value is { x: number; y: number } {
  if (!value || typeof value !== "object") return false;
  const candidate = value as { x?: unknown; y?: unknown };
  return Number.isFinite(candidate.x) && Number.isFinite(candidate.y);
}
