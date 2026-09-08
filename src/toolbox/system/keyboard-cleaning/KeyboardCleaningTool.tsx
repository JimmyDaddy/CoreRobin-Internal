import { Select } from "../../../components/Select";
import { CircleAlert, ShieldCheck, Square, Timer } from "lucide-react";
import type { TFunction } from "i18next";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { heartbeatKeyboardCleaning, isDesktopRuntime, openSystemSettings, startKeyboardCleaning, stopKeyboardCleaning, subscribeKeyboardCleaning } from "../../../api";

import {
  KeyboardCleaningMachine,
  KeyboardCleaningError,
  type KeyboardCleaningCapability,
  type KeyboardCleaningEndReason,
  type KeyboardCleaningEffect,
  type KeyboardCleaningHeartbeatCommand,
  type KeyboardCleaningSignal,
  type KeyboardCleaningState,
  type KeyboardCleaningStatus,
} from "./keyboardCleaning";
import { KEYBOARD_CLEANING_RESTRICTED_HELPER_REASON } from "./keyboardCleaning";

export interface KeyboardCleaningBridge {
  send(effect: KeyboardCleaningEffect): Promise<void>;
  subscribe(listener: (signal: KeyboardCleaningSignal) => void): (() => void) | Promise<() => void>;
}

const NATIVE_BRIDGE: KeyboardCleaningBridge = {
  send(effect) {
    if (effect.type === "start_helper") return startKeyboardCleaning(effect.command.payload);
    if (effect.type === "stop_helper") return stopKeyboardCleaning(effect.command.payload);
    return heartbeatKeyboardCleaning(effect.command.payload);
  },
  subscribe: subscribeKeyboardCleaning,
};

const DEFAULT_CAPABILITY: KeyboardCleaningCapability = {
  state: "unavailable",
  platform: "unknown",
  reason: null,
};

type ToolboxTFunction = TFunction<"toolbox">;

const STATUS_KEYS = {
  idle: "keyboardCleaning.statuses.idle",
  unavailable: "keyboardCleaning.statuses.unavailable",
  preparing: "keyboardCleaning.statuses.preparing",
  active: "keyboardCleaning.statuses.active",
  releasing: "keyboardCleaning.statuses.releasing",
  ended: "keyboardCleaning.statuses.ended",
} as const satisfies Record<KeyboardCleaningStatus, string>;

const END_REASON_KEYS = {
  cancelled: "keyboardCleaning.endReasons.cancelled",
  mouse_activity: "keyboardCleaning.endReasons.mouse_activity",
  heartbeat_lost: "keyboardCleaning.endReasons.heartbeat_lost",
  focus_lost: "keyboardCleaning.endReasons.focus_lost",
  host_exited: "keyboardCleaning.endReasons.host_exited",
  sleeping: "keyboardCleaning.endReasons.sleeping",
  permission_revoked: "keyboardCleaning.endReasons.permission_revoked",
  hook_unconfirmed: "keyboardCleaning.endReasons.hook_unconfirmed",
  hook_ineffective: "keyboardCleaning.endReasons.hook_ineffective",
  hard_deadline: "keyboardCleaning.endReasons.hard_deadline",
  completed: "keyboardCleaning.endReasons.completed",
  helper_unavailable: "keyboardCleaning.endReasons.helper_unavailable",
} as const satisfies Record<KeyboardCleaningEndReason, string>;

const ERROR_KEYS = {
  capability_unavailable: "keyboardCleaning.errors.codes.capability_unavailable",
  invalid_duration: "keyboardCleaning.errors.codes.invalid_duration",
  invalid_request_id: "keyboardCleaning.errors.codes.invalid_request_id",
  clock_went_backward: "keyboardCleaning.errors.codes.clock_went_backward",
  invalid_state: "keyboardCleaning.errors.codes.invalid_state",
  wrong_request: "keyboardCleaning.errors.codes.wrong_request",
  heartbeat_out_of_order: "keyboardCleaning.errors.codes.heartbeat_out_of_order",
} as const satisfies Record<KeyboardCleaningError["code"], string>;

export function KeyboardCleaningTool({ capability = DEFAULT_CAPABILITY, bridge }: { capability?: KeyboardCleaningCapability; bridge?: KeyboardCleaningBridge }) {
  const { t } = useTranslation("toolbox");
  const effectiveBridge = bridge ?? (isDesktopRuntime() ? NATIVE_BRIDGE : undefined);
  const { state: capabilityState, platform, reason: capabilityReason } = capability;
  const machine = useMemo(() => new KeyboardCleaningMachine({ state: capabilityState, platform, reason: capabilityReason }), [capabilityState, platform, capabilityReason]);
  const [state, setState] = useState<KeyboardCleaningState>(() => machine.snapshot());
  const [bridgeReady, setBridgeReady] = useState(false);
  const [durationSeconds, setDurationSeconds] = useState<30 | 60 | 120>(60);
  const [error, setError] = useState("");
  const clock = useCallback(() => Date.now(), []);
  const machineRef = useRef(machine);
  const heartbeatSequenceRef = useRef<{ requestId: string | null; sequence: number }>({ requestId: null, sequence: 0 });
  machineRef.current = machine;

  useEffect(() => {
    setState(machine.snapshot());
    setError("");
  }, [machine]);

  const sendEffects = useCallback((effects: KeyboardCleaningEffect[]) => {
    if (!effectiveBridge) return;
    for (const effect of effects) void effectiveBridge.send(effect).catch((reason: unknown) => {
      if (effect.type === "start_helper" && isPermissionRequired(reason)
        && machineRef.current.snapshot().requestId === effect.command.payload.requestId) {
        // This native error is returned before spawning a child. There is no
        // tap to release, so allow retry after the user authorizes the app.
        const nowMs = clock();
        machineRef.current.dispatch({ type: "permission_revoked", nowMs });
        setState(machineRef.current.dispatch({ type: "release_confirmed", requestId: effect.command.payload.requestId, nowMs }).state);
        setError(t("keyboardCleaning.permissionHint"));
        return;
      }
      setError(t("keyboardCleaning.errors.helper", { reason: keyboardErrorMessage(reason, t) }));
    });
  }, [effectiveBridge, clock, t]);

  const apply = useCallback((action: Parameters<KeyboardCleaningMachine["dispatch"]>[0]) => {
    try {
      const transition = machineRef.current.dispatch(action);
      setState(transition.state);
      setError("");
      sendEffects(transition.effects);
    } catch (reason) {
      setError(keyboardErrorMessage(reason, t));
    }
  }, [sendEffects, t]);

  useEffect(() => {
    setBridgeReady(false);
    if (!effectiveBridge) return undefined;
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void Promise.resolve().then(() => effectiveBridge.subscribe((signal) => {
      if (disposed) return;
      try {
        const transition = machineRef.current.applySignal(signal, clock());
        setState(transition.state);
        sendEffects(transition.effects);
      } catch (reason) {
        setError(keyboardErrorMessage(reason, t));
      }
    })).then((unsubscribe) => {
      if (disposed) unsubscribe();
      else {
        unlisten = unsubscribe;
        setBridgeReady(true);
      }
    }).catch((reason: unknown) => {
      if (!disposed) setError(keyboardErrorMessage(reason, t));
    });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [effectiveBridge, clock, sendEffects, t]);

  useEffect(() => {
    if (state.status !== "preparing" && state.status !== "active") return undefined;
    const timer = window.setInterval(() => apply({ type: "tick", nowMs: clock() }), 250);
    return () => window.clearInterval(timer);
  }, [apply, clock, state.status]);

  useEffect(() => {
    if (!effectiveBridge || state.hook !== "confirmed" || (state.status !== "preparing" && state.status !== "active") || !state.requestId) return undefined;
    const sendHeartbeat = () => {
      if (heartbeatSequenceRef.current.requestId !== state.requestId) {
        heartbeatSequenceRef.current = { requestId: state.requestId, sequence: 0 };
      }
      heartbeatSequenceRef.current.sequence += 1;
      const request: KeyboardCleaningHeartbeatCommand = {
        protocolVersion: "keyboard-cleaning-helper-v1",
        requestId: state.requestId!,
        sequence: heartbeatSequenceRef.current.sequence,
      };
      void effectiveBridge.send({ type: "heartbeat_helper", command: { type: "heartbeat", payload: request } }).catch((reason: unknown) => {
        setError(t("keyboardCleaning.errors.helper", { reason: reason instanceof Error ? reason.message : t("keyboardCleaning.errors.communication") }));
      });
    };
    sendHeartbeat();
    const timer = window.setInterval(sendHeartbeat, 1_000);
    return () => window.clearInterval(timer);
  }, [effectiveBridge, state.hook, state.requestId, state.status, t]);

  useEffect(() => () => {
    if (machineRef.current.snapshot().status === "preparing" || machineRef.current.snapshot().status === "active") {
      try {
        const transition = machineRef.current.dispatch({ type: "host_exited", nowMs: clock() });
        sendEffects(transition.effects);
      } catch {
        // Unmount cannot safely keep a helper session alive; the helper's own
        // heartbeat deadline is the final release backstop.
      }
    }
  }, [clock, sendEffects]);

  const canStart = bridgeReady && (state.status === "idle" || state.status === "ended") && capability.state === "available";
  const statusText = state.status === "active"
    ? t("keyboardCleaning.statuses.active", { count: state.durationSeconds ?? 0 })
    : t(STATUS_KEYS[state.status]);
  const capabilityText = capability.state === "available"
    ? t("keyboardCleaning.capability.available", { platform: capability.platform })
    : keyboardCapabilityReason(t, capability);

  const cleaning = state.status === "preparing" || state.status === "active";
  const maskVisible = cleaning || state.status === "releasing";
  return <>
    <section className="toolbox-tool-layout keyboard-cleaning-tool" aria-labelledby="keyboard-cleaning-title">
      <div className="toolbox-tool-layout__body">
        <header className="keyboard-cleaning-tool__header">
          <span className="toolbox-eyebrow"><ShieldCheck size={14} />{t("keyboardCleaning.eyebrow")}</span>
          <h2 id="keyboard-cleaning-title">{t("keyboardCleaning.title")}</h2>
          <p>{t("keyboardCleaning.description")}</p>
        </header>
        <p className="toolbox-hint keyboard-cleaning-tool__privacy"><CircleAlert size={15} />{t("keyboardCleaning.privacy")}</p>
        {capability.platform === "macos" && capability.state === "available" ? <div className="keyboard-cleaning-tool__permission">
          <p className="toolbox-hint">{t("keyboardCleaning.permissionHint")}</p>
          <button className="button button--secondary" type="button" disabled={maskVisible} onClick={() => { void openSystemSettings("accessibility").catch((reason: unknown) => setError(keyboardErrorMessage(reason, t))); }}>{t("keyboardCleaning.openSettings")}</button>
        </div> : null}
        <div className="toolbox-inline-actions keyboard-cleaning-tool__actions">
          <label>{t("keyboardCleaning.durationLabel")}<Select value={durationSeconds} onChange={(event) => setDurationSeconds(Number(event.target.value) as 30 | 60 | 120)} disabled={!canStart}><option value={30}>{t("keyboardCleaning.duration", { count: 30 })}</option><option value={60}>{t("keyboardCleaning.duration", { count: 60 })}</option><option value={120}>{t("keyboardCleaning.duration", { count: 120 })}</option></Select></label>
          <button className="button button--primary" type="button" disabled={!canStart} onClick={() => apply({ type: "start", requestId: crypto.randomUUID(), durationSeconds, nowMs: clock() })}><Timer size={14} />{t("keyboardCleaning.start")}</button>
          {cleaning ? <button className="button button--secondary" type="button" onClick={() => apply({ type: "cancel", nowMs: clock() })}><Square size={14} />{t("keyboardCleaning.stop")}</button> : null}
        </div>
        <div className="keyboard-cleaning-tool__status" data-state={state.status}>
          <p className="toolbox-hint" role="status"><span className="keyboard-cleaning-tool__status-dot" aria-hidden="true" /> <span><strong>{t("keyboardCleaning.status.label")}: {statusText}</strong><br />{t("keyboardCleaning.capability.label")}: {capabilityText}{state.endReason ? ` · ${t("keyboardCleaning.reason", { reason: t(END_REASON_KEYS[state.endReason]) })}` : ""}</span></p>
          {state.status === "active" && state.hardDeadlineMs !== null ? <p className="toolbox-hint">{t("keyboardCleaning.hardDeadline", { time: new Date(state.hardDeadlineMs).toLocaleTimeString() })}</p> : null}
        </div>
        {error ? <p className="toolbox-error" role="alert">{error}</p> : null}
        {!effectiveBridge ? <p className="toolbox-hint">{t("keyboardCleaning.noBridge")}</p> : null}
      </div>
      <div className="toolbox-tool-layout__footer"><span>{t("keyboardCleaning.footer")}</span></div>
    </section>
    {maskVisible ? <div className="keyboard-cleaning-mask" role="status" aria-live="polite">
      <div className="keyboard-cleaning-mask__content">
        <ShieldCheck size={24} />
        <strong>{statusText}</strong>
        <button className="button button--primary" type="button" disabled={!cleaning} onClick={() => apply({ type: "cancel", nowMs: clock() })}><Square size={14} />{t("keyboardCleaning.stop")}</button>
      </div>
    </div> : null}
  </>;
}

function keyboardErrorMessage(reason: unknown, t: ToolboxTFunction): string {
  if (isPermissionRequired(reason)) return t("keyboardCleaning.permissionHint");
  if (reason instanceof KeyboardCleaningError) return t(ERROR_KEYS[reason.code]);
  if (reason instanceof Error) return reason.message;
  if (reason && typeof reason === "object" && "message" in reason && typeof reason.message === "string") return reason.message;
  return t("keyboardCleaning.errors.start");
}

function isPermissionRequired(reason: unknown): boolean {
  return Boolean(reason && typeof reason === "object" && "code" in reason && reason.code === "keyboard_cleaning_permission_required");
}

function keyboardCapabilityReason(t: ToolboxTFunction, capability: KeyboardCleaningCapability): string {
  if (capability.reason === KEYBOARD_CLEANING_RESTRICTED_HELPER_REASON) return t("overview.restrictedNativeHelperUnavailable.description");
  return capability.reason ?? t("keyboardCleaning.capability.unavailable");
}
