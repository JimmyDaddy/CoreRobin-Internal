import { invoke } from "@tauri-apps/api/core";
import { PhysicalPosition } from "@tauri-apps/api/dpi";
import { emitTo, listen } from "@tauri-apps/api/event";
import { currentMonitor, getCurrentWindow } from "@tauri-apps/api/window";
import { ArrowRight, EyeOff, Maximize2, RefreshCw, Wand2 } from "lucide-react";
import {
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";

import { createAsyncListenerRegistry } from "../asyncListener";
import type { HealthStateSnapshot } from "../healthState";
import { useSharedHealthState } from "../hooks/useSharedHealthState";
import { useAuxiliaryTranslation } from "../useAuxiliaryTranslation";
import {
  LEGACY_STORAGE_KEYS,
  readMigratedStorageItem,
} from "../storageMigration";
import { AnimatedRobin } from "./AnimatedRobin";

const COMPANION_POSITION_KEY = "core-robin.companion-position.v1";
const COMPANION_EXPANDED_LOGICAL_SIZE = { width: 386, height: 92 };
const COMPANION_HOVER_COLLAPSE_DELAY_MS = 220;
type CompanionHealth = HealthStateSnapshot["health"] | "loading";
type CompanionDailyTarget = "more" | "overview";
interface CompanionDailyBridge {
  showMainWindow: () => Promise<unknown>;
  openDaily: (
    target: CompanionDailyTarget,
    occurrenceId?: string | null,
  ) => Promise<void>;
}
interface CompanionMainBridge {
  showMainWindow: () => Promise<unknown>;
}

const nativeCompanionDailyBridge: CompanionDailyBridge = {
  showMainWindow: () => invoke("show_main_window"),
  openDaily: (target, occurrenceId) => emitTo(
    "main",
    "core-robin:open-daily",
    occurrenceId ? { view: target, occurrenceId } : target,
  ),
};
const desktopRuntime = typeof window !== "undefined"
  && "__TAURI_INTERNALS__" in window
  && getCurrentWindow().label === "companion";

function QuickCleanCompanionAction() {
  const { t } = useAuxiliaryTranslation();
  const [opening, setOpening] = useState(false);

  const openQuickClean = useCallback(async () => {
    if (opening) return;
    setOpening(true);
    try {
      if (desktopRuntime) {
        await emitTo("main", "core-robin:open-quick-clean");
        await invoke("show_main_window");
      }
    } finally {
      setOpening(false);
    }
  }, [opening]);

  return (
    <button
      className="robin-buddy-clean"
      type="button"
      disabled={opening}
      onClick={() => void openQuickClean()}
    >
      {opening ? (
        <RefreshCw className="is-spinning" size={11} />
      ) : (
        <Wand2 size={11} />
      )}
      {t("companion:quickClean.action")}
    </button>
  );
}

export function RobinCompanionWindow() {
  const { t } = useAuxiliaryTranslation();
  const summary = useSharedHealthState();
  const previewExpanded = !desktopRuntime
    && new URLSearchParams(window.location.search).get("preview") === "expanded";
  const [expanded, setExpanded] = useState(previewExpanded);
  const expandedRef = useRef(previewExpanded);
  const [chatOpen, setChatOpen] = useState(false);
  const chatOpenRef = useRef(false);
  const pointerStartRef = useRef<{ x: number; y: number } | null>(null);
  const draggedRef = useRef(false);
  const [contextMenuOpen, setContextMenuOpen] = useState(false);
  const contextMenuOpenRef = useRef(false);
  const hoverCollapseTimerRef = useRef<number | undefined>(undefined);
  const resizeEpochRef = useRef(0);
  const shellRef = useRef<HTMLElement | null>(null);
  const [visibilityPhase, setVisibilityPhase] = useState<"idle" | "entering" | "exiting">("idle");
  const dataStale = summary?.dataStatus === "stale";
  const health = dataStale ? "observing" : summary?.health ?? "loading";

  useEffect(() => {
    return () => {
      if (hoverCollapseTimerRef.current !== undefined) {
        window.clearTimeout(hoverCollapseTimerRef.current);
      }
    };
  }, []);

  useEffect(() => {
    if (!desktopRuntime) return;
    const companionWindow = getCurrentWindow();
    const listeners = createAsyncListenerRegistry();
    let visibilityTimer: number | undefined;

    const playEntrance = () => {
      if (listeners.disposed) return;
      if (visibilityTimer !== undefined) window.clearTimeout(visibilityTimer);
      setVisibilityPhase("entering");
      visibilityTimer = window.setTimeout(() => {
        setVisibilityPhase("idle");
        visibilityTimer = undefined;
      }, 520);
    };

    const playExit = () => {
      if (listeners.disposed) return;
      if (visibilityTimer !== undefined) window.clearTimeout(visibilityTimer);
      visibilityTimer = undefined;
      setVisibilityPhase("exiting");
    };

    const restorePosition = async () => {
      const [monitor, size] = await Promise.all([
        currentMonitor(),
        companionWindow.outerSize(),
      ]);
      if (!monitor || listeners.disposed) return;
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
        const saved = JSON.parse(readMigratedStorageItem(
          window.localStorage,
          COMPANION_POSITION_KEY,
          LEGACY_STORAGE_KEYS.companionPosition,
        ) ?? "null") as unknown;
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
    listeners.register(
      companionWindow.onMoved(({ payload }) => {
        if (listeners.disposed) return;
        try {
          window.localStorage.setItem(
            COMPANION_POSITION_KEY,
            JSON.stringify({ x: payload.x, y: payload.y }),
          );
        } catch {
          // Position persistence is optional.
        }
      }),
    );
    listeners.register(
      companionWindow.onFocusChanged(({ payload: focused }) => {
        if (!listeners.disposed && !focused) {
          contextMenuOpenRef.current = false;
          setContextMenuOpen(false);
          if (expandedRef.current) void updateExpanded(false);
        }
      }),
    );
    listeners.register(
      listen("core-robin:companion-collapse", () => {
        if (listeners.disposed) return;
        contextMenuOpenRef.current = false;
        setContextMenuOpen(false);
        expandedRef.current = false;
        setExpanded(false);
      }),
    );
    listeners.register(listen("core-robin:companion-enter", playEntrance));
    listeners.register(listen("core-robin:companion-exit", playExit));
    listeners.register(listen<boolean>("core-robin:ai-chat-visibility", ({ payload }) => {
      if (listeners.disposed) return;
      chatOpenRef.current = payload;
      setChatOpen(payload);
      if (payload) void updateExpanded(false);
    }));
    void companionWindow.isVisible().then((visible) => {
      if (!listeners.disposed && visible) playEntrance();
    });
    return () => {
      listeners.dispose();
      if (visibilityTimer !== undefined) window.clearTimeout(visibilityTimer);
      window.removeEventListener("keydown", onKeyDown);
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
    if (!contextMenuOpenRef.current && !chatOpenRef.current) void updateExpanded(true);
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
    await openDailyFromCompanion(
      health,
      () => updateExpanded(false),
      nativeCompanionDailyBridge,
      summary?.primaryIncident?.occurrenceId,
    );
  };

  const beginDragging = (event: ReactMouseEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    pointerStartRef.current = { x: event.clientX, y: event.clientY };
    draggedRef.current = false;
    contextMenuOpenRef.current = false;
    setContextMenuOpen(false);
  };

  const moveMascot = (event: ReactMouseEvent<HTMLDivElement>) => {
    const start = pointerStartRef.current;
    if (!start || draggedRef.current || !(event.buttons & 1)) return;
    if (Math.hypot(event.clientX - start.x, event.clientY - start.y) < 5) return;
    draggedRef.current = true;
    pointerStartRef.current = null;
    clearHoverCollapseTimer();
    if (desktopRuntime) void getCurrentWindow().startDragging();
  };

  const toggleChat = async () => {
    clearHoverCollapseTimer();
    contextMenuOpenRef.current = false;
    setContextMenuOpen(false);
    await updateExpanded(false);
    const visible = desktopRuntime
      ? await invoke<boolean>("toggle_ai_chat_window")
      : !chatOpenRef.current;
    chatOpenRef.current = visible;
    setChatOpen(visible);
  };

  const clickMascot = (event: ReactMouseEvent<HTMLDivElement>) => {
    pointerStartRef.current = null;
    if (draggedRef.current || event.detail > 1) return;
    void toggleChat().catch(() => {
      chatOpenRef.current = false;
      setChatOpen(false);
    });
  };

  const openMainWindow = (event?: ReactMouseEvent<HTMLElement>) => {
    event?.preventDefault();
    event?.stopPropagation();
    contextMenuOpenRef.current = false;
    setContextMenuOpen(false);
    void openMainFromCompanion();
  };

  const handleMascotKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.nativeEvent.isComposing || event.repeat || (event.key !== "Enter" && event.key !== " ")) return;
    event.preventDefault();
    void toggleChat().catch(() => undefined);
  };

  const openContextMenu = (event: ReactMouseEvent<HTMLElement>) => {
    event.preventDefault();
    chatOpenRef.current = false;
    setChatOpen(false);
    if (desktopRuntime) void invoke("hide_ai_chat_window");
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
        className="robin-buddy-shell"
        onMouseEnter={expandFromHover}
        onMouseLeave={collapseFromHover}
        onContextMenu={openContextMenu}
      >
        <div
          className="robin-buddy-mascot"
          role="button"
          tabIndex={0}
          aria-expanded={expanded || chatOpen}
          aria-label={t("companion:dragHint")}
          onMouseDown={beginDragging}
          onMouseMove={moveMascot}
          onClick={clickMascot}
          onKeyDown={handleMascotKeyDown}
        >
          <AnimatedRobin
            active={health === "loading"}
            className="robin-buddy-character"
            mood={health}
            size="100%"
          />
          <span className="robin-buddy-status" aria-hidden="true" />
        </div>

        {contextMenuOpen ? <div className="robin-buddy-menu" role="menu" aria-label={t("companion:menu")}>
          <button type="button" role="menuitem" onClick={() => openMainWindow()}>
            <Maximize2 size={14} />
            <span>{t("tray:open")}</span>
          </button>
          <button type="button" role="menuitem" onClick={hideFromContextMenu}>
            <EyeOff size={14} />
            <span>{t("companion:hide")}</span>
          </button>
        </div> : expanded ? <div className="robin-buddy-bubble">
          <small>{t("companion:kicker")}</small>
          <strong>
            {dataStale
              ? t("tray:status.stale.title")
              : summary && summary.activeCount > 0 &&
              (summary.health === "attention" || summary.health === "urgent")
              ? t(`tray:incidentTitle.${summary.health}`, { count: summary.activeCount })
              : t(`tray:status.${health}.title`)}
          </strong>
          <p>
            {dataStale
              ? t("tray:status.stale.description")
              : summary?.primaryIncident?.phase === "recovering"
              ? t("companion:recovering")
              : summary?.reason && summary.reason !== "none"
              ? t("companion:reason", { resource: t(`tray:resource.${summary.reason}`) })
              : t(`tray:status.${health}.description`)}
          </p>
          <div className="robin-buddy-actions">
            <button type="button" onClick={() => void openDaily()}>
              {t(`companion:action.${health}`)}<ArrowRight size={13} />
            </button>
            <QuickCleanCompanionAction />
          </div>
        </div> : null}
      </section>
    </main>
  );
}

export async function openDailyFromCompanion(
  health: CompanionHealth,
  collapse: () => Promise<void>,
  bridge: CompanionDailyBridge = nativeCompanionDailyBridge,
  occurrenceId?: string | null,
) {
  await collapse();
  await bridge.showMainWindow();
  await bridge.openDaily(
    health === "normal" ? "more" : "overview",
    occurrenceId,
  );
}

export async function openMainFromCompanion(
  bridge: CompanionMainBridge = nativeCompanionDailyBridge,
) {
  await bridge.showMainWindow();
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
