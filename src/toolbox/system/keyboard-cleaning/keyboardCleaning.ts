/**
 * Pure browser-side mirror of the keyboard-cleaning safety protocol.
 *
 * This module intentionally has no DOM keyboard listeners and no payload type
 * that can contain a key value. The native/helper adapter owns platform hooks;
 * this state machine only consumes lifecycle facts.
 */

export const KEYBOARD_CLEANING_PROTOCOL_VERSION = "keyboard-cleaning-helper-v1" as const;
export const PREPARATION_WINDOW_MS = 3_000;
export const HEARTBEAT_GRACE_MS = 3_000;
export const HARD_LIMIT_MS = 180_000;
export const KEYBOARD_CLEANING_DURATIONS = [30, 60, 120] as const;
export const MAX_HELPER_FRAME_BYTES = 4_096;

export type KeyboardCleaningDuration = (typeof KEYBOARD_CLEANING_DURATIONS)[number];
export type KeyboardCleaningCapabilityState = "available" | "unavailable";
export type KeyboardCleaningStatus = "idle" | "unavailable" | "preparing" | "active" | "releasing" | "ended";
export type KeyboardCleaningHookStatus = "unconfirmed" | "confirmed" | "ineffective";
export type KeyboardCleaningHookEffectiveness = "confirmed" | "unconfirmed" | "silently_ineffective";
export type KeyboardCleaningHookFailure = "capability_unavailable" | "permission_revoked" | "host_disconnected" | "hook_stopped" | "hook_not_confirmed";
export type KeyboardCleaningLifecycleReason = "mouse_activity" | "heartbeat_lost" | "focus_lost" | "host_exited" | "sleeping" | "permission_revoked";
export type KeyboardCleaningEndReason =
  | "cancelled"
  | "mouse_activity"
  | "heartbeat_lost"
  | "focus_lost"
  | "host_exited"
  | "sleeping"
  | "permission_revoked"
  | "hook_unconfirmed"
  | "hook_ineffective"
  | "hard_deadline"
  | "completed"
  | "helper_unavailable";

export interface KeyboardCleaningCapability {
  state: KeyboardCleaningCapabilityState;
  platform: "macos" | "windows" | "linux" | "unknown";
  reason: string | null;
}

export interface KeyboardCleaningState {
  capability: KeyboardCleaningCapability;
  status: KeyboardCleaningStatus;
  hook: KeyboardCleaningHookStatus;
  requestId: string | null;
  durationSeconds: KeyboardCleaningDuration | null;
  preparationDeadlineMs: number | null;
  activeDeadlineMs: number | null;
  hardDeadlineMs: number | null;
  lastHeartbeatMs: number | null;
  releaseConfirmed: boolean;
  endReason: KeyboardCleaningEndReason | null;
}

export type KeyboardCleaningEvent =
  | { type: "start"; requestId: string; durationSeconds: number; nowMs: number }
  | { type: "tick"; nowMs: number }
  | { type: "hook_ready"; requestId: string; capability: KeyboardCleaningCapabilityState; effectiveness: KeyboardCleaningHookEffectiveness; nowMs: number }
  | { type: "heartbeat"; requestId: string; sequence: number; nowMs: number }
  | { type: "hook_ineffective"; requestId: string; nowMs: number }
  | { type: "mouse_activity"; nowMs: number }
  | { type: "heartbeat_lost"; nowMs: number }
  | { type: "focus_lost"; nowMs: number }
  | { type: "host_exited"; nowMs: number }
  | { type: "sleeping"; nowMs: number }
  | { type: "permission_revoked"; nowMs: number }
  | { type: "cancel"; nowMs: number }
  | { type: "release_confirmed"; requestId: string; nowMs: number }
  | { type: "release_unconfirmed"; requestId: string; nowMs: number };

export interface KeyboardCleaningStartCommand {
  protocolVersion: typeof KEYBOARD_CLEANING_PROTOCOL_VERSION;
  requestId: string;
  durationSeconds: KeyboardCleaningDuration;
  prepareDeadlineMs: number;
  hardDeadlineMs: number;
}

export interface KeyboardCleaningStopCommand {
  protocolVersion: typeof KEYBOARD_CLEANING_PROTOCOL_VERSION;
  requestId: string;
  reason: KeyboardCleaningEndReason;
}

export interface KeyboardCleaningHeartbeatCommand {
  protocolVersion: typeof KEYBOARD_CLEANING_PROTOCOL_VERSION;
  requestId: string;
  sequence: number;
}

export type KeyboardCleaningCommand =
  | { type: "start"; payload: KeyboardCleaningStartCommand }
  | { type: "stop"; payload: KeyboardCleaningStopCommand }
  | { type: "heartbeat"; payload: KeyboardCleaningHeartbeatCommand };

export type KeyboardCleaningSignal =
  | {
      type: "ready";
      payload: {
        protocolVersion: typeof KEYBOARD_CLEANING_PROTOCOL_VERSION;
        requestId: string;
        capability: KeyboardCleaningCapabilityState;
        effectiveness: KeyboardCleaningHookEffectiveness;
      };
    }
  | {
      type: "heartbeat";
      payload: { protocolVersion: typeof KEYBOARD_CLEANING_PROTOCOL_VERSION; requestId: string; sequence: number };
    }
  | {
      type: "hook_ineffective";
      payload: { protocolVersion: typeof KEYBOARD_CLEANING_PROTOCOL_VERSION; requestId: string; failure: KeyboardCleaningHookFailure };
    }
  | {
      type: "released";
      payload: { protocolVersion: typeof KEYBOARD_CLEANING_PROTOCOL_VERSION; requestId: string; confirmed: boolean };
    }
  | {
      type: "lifecycle";
      payload: { protocolVersion: typeof KEYBOARD_CLEANING_PROTOCOL_VERSION; requestId: string; reason: KeyboardCleaningLifecycleReason };
    };

export interface KeyboardCleaningTransition {
  state: KeyboardCleaningState;
  effects: KeyboardCleaningEffect[];
}

export type KeyboardCleaningEffect =
  | { type: "start_helper"; command: Extract<KeyboardCleaningCommand, { type: "start" }> }
  | { type: "stop_helper"; command: Extract<KeyboardCleaningCommand, { type: "stop" }> }
  | { type: "heartbeat_helper"; command: Extract<KeyboardCleaningCommand, { type: "heartbeat" }> };

export class KeyboardCleaningError extends Error {
  constructor(public readonly code: "capability_unavailable" | "invalid_duration" | "invalid_request_id" | "clock_went_backward" | "invalid_state" | "wrong_request" | "heartbeat_out_of_order", message: string) {
    super(message);
    this.name = "KeyboardCleaningError";
  }
}

interface Session {
  requestId: string;
  durationSeconds: KeyboardCleaningDuration;
  preparationDeadlineMs: number;
  activeDeadlineMs: number;
  hardDeadlineMs: number;
  hook: KeyboardCleaningHookStatus;
  lastHeartbeatMs: number | null;
  lastHeartbeatSequence: number | null;
  releaseConfirmed: boolean;
  endReason: KeyboardCleaningEndReason | null;
}

export class KeyboardCleaningMachine {
  private status: KeyboardCleaningStatus;
  private session: Session | null = null;
  private lastNowMs = 0;

  constructor(private readonly capability: KeyboardCleaningCapability) {
    this.status = capability.state === "available" ? "idle" : "unavailable";
  }

  snapshot(): KeyboardCleaningState {
    const session = this.session;
    return {
      capability: this.capability,
      status: this.status,
      hook: session?.hook ?? "unconfirmed",
      requestId: session?.requestId ?? null,
      durationSeconds: session?.durationSeconds ?? null,
      preparationDeadlineMs: session?.preparationDeadlineMs ?? null,
      activeDeadlineMs: session?.activeDeadlineMs ?? null,
      hardDeadlineMs: session?.hardDeadlineMs ?? null,
      lastHeartbeatMs: session?.lastHeartbeatMs ?? null,
      releaseConfirmed: session?.releaseConfirmed ?? true,
      endReason: session?.endReason ?? null,
    };
  }

  dispatch(event: KeyboardCleaningEvent): KeyboardCleaningTransition {
    this.observeTime(event.nowMs);
    const effects: KeyboardCleaningEffect[] = [];
    switch (event.type) {
      case "start": this.start(event, effects); break;
      case "tick": this.advance(event.nowMs, effects); break;
      case "hook_ready": this.hookReady(event, effects); break;
      case "heartbeat": this.heartbeat(event); break;
      case "hook_ineffective": this.hookIneffective(event, effects); break;
      case "mouse_activity": this.release("mouse_activity", effects); break;
      case "heartbeat_lost": this.release("heartbeat_lost", effects); break;
      case "focus_lost": this.release("focus_lost", effects); break;
      case "host_exited": this.release("host_exited", effects); break;
      case "sleeping": this.release("sleeping", effects); break;
      case "permission_revoked": this.release("permission_revoked", effects); break;
      case "cancel": this.release("cancelled", effects); break;
      case "release_confirmed": this.releaseAcknowledgement(event, true); break;
      case "release_unconfirmed": this.releaseAcknowledgement(event, false); break;
    }
    return { state: this.snapshot(), effects };
  }

  applySignal(signal: KeyboardCleaningSignal, nowMs: number): KeyboardCleaningTransition {
    if (signal.payload.protocolVersion !== KEYBOARD_CLEANING_PROTOCOL_VERSION) {
      throw new KeyboardCleaningError("wrong_request", "helper protocol version is not supported");
    }
    switch (signal.type) {
      case "ready":
        return this.dispatch({ type: "hook_ready", requestId: signal.payload.requestId, capability: signal.payload.capability, effectiveness: signal.payload.effectiveness, nowMs });
      case "heartbeat":
        return this.dispatch({ type: "heartbeat", requestId: signal.payload.requestId, sequence: signal.payload.sequence, nowMs });
      case "hook_ineffective":
        return this.dispatch({ type: "hook_ineffective", requestId: signal.payload.requestId, nowMs });
      case "released":
        return this.dispatch({ type: signal.payload.confirmed ? "release_confirmed" : "release_unconfirmed", requestId: signal.payload.requestId, nowMs });
      case "lifecycle":
        this.ensureRequest(signal.payload.requestId);
        return this.dispatch({ type: signal.payload.reason, nowMs });
    }
  }

  private start(event: Extract<KeyboardCleaningEvent, { type: "start" }>, effects: KeyboardCleaningEffect[]): void {
    if (this.capability.state !== "available") throw new KeyboardCleaningError("capability_unavailable", this.capability.reason ?? "键盘清洁能力在当前平台不可用。");
    if (!KEYBOARD_CLEANING_DURATIONS.includes(event.durationSeconds as KeyboardCleaningDuration)) throw new KeyboardCleaningError("invalid_duration", "时长只能选择 30、60 或 120 秒。");
    if (!event.requestId || event.requestId.length > 128 || !/^[A-Za-z0-9_.:-]+$/.test(event.requestId)) throw new KeyboardCleaningError("invalid_request_id", "请求标识无效。");
    if (this.status !== "idle" && this.status !== "ended") throw new KeyboardCleaningError("invalid_state", "当前已有键盘清洁任务。");
    const durationSeconds = event.durationSeconds as KeyboardCleaningDuration;
    const preparationDeadlineMs = deadlineAt(event.nowMs, PREPARATION_WINDOW_MS);
    const hardDeadlineMs = deadlineAt(event.nowMs, HARD_LIMIT_MS);
    const activeDeadlineMs = Math.min(deadlineAt(preparationDeadlineMs, durationSeconds * 1_000), hardDeadlineMs);
    this.session = { requestId: event.requestId, durationSeconds, preparationDeadlineMs, activeDeadlineMs, hardDeadlineMs, hook: "unconfirmed", lastHeartbeatMs: null, lastHeartbeatSequence: null, releaseConfirmed: false, endReason: null };
    this.status = "preparing";
    effects.push({ type: "start_helper", command: { type: "start", payload: { protocolVersion: KEYBOARD_CLEANING_PROTOCOL_VERSION, requestId: event.requestId, durationSeconds, prepareDeadlineMs: preparationDeadlineMs, hardDeadlineMs } } });
  }

  private hookReady(event: Extract<KeyboardCleaningEvent, { type: "hook_ready" }>, effects: KeyboardCleaningEffect[]): void {
    this.ensureRequest(event.requestId);
    if (this.status !== "preparing" || !this.session) return;
    if (event.capability !== "available") {
      this.session.hook = "ineffective";
      this.release("helper_unavailable", effects);
      return;
    }
    if (event.effectiveness === "confirmed" && event.nowMs < this.session.preparationDeadlineMs) {
      this.session.hook = "confirmed";
      this.session.lastHeartbeatMs = event.nowMs;
    } else if (event.effectiveness === "confirmed") {
      this.release("hook_unconfirmed", effects);
    } else if (event.effectiveness === "unconfirmed") {
      this.session.hook = "unconfirmed";
      this.release("hook_unconfirmed", effects);
    } else {
      this.session.hook = "ineffective";
      this.release("hook_ineffective", effects);
    }
  }

  private heartbeat(event: Extract<KeyboardCleaningEvent, { type: "heartbeat" }>): void {
    this.ensureRequest(event.requestId);
    if ((this.status !== "preparing" && this.status !== "active") || !this.session) return;
    if (this.session.lastHeartbeatSequence !== null && event.sequence <= this.session.lastHeartbeatSequence) throw new KeyboardCleaningError("heartbeat_out_of_order", "helper 心跳序号没有递增。");
    this.session.lastHeartbeatSequence = event.sequence;
    this.session.lastHeartbeatMs = event.nowMs;
  }

  private hookIneffective(event: Extract<KeyboardCleaningEvent, { type: "hook_ineffective" }>, effects: KeyboardCleaningEffect[]): void {
    this.ensureRequest(event.requestId);
    if (this.session) this.session.hook = "ineffective";
    this.release("hook_ineffective", effects);
  }

  private advance(nowMs: number, effects: KeyboardCleaningEffect[]): void {
    if (!this.session) return;
    if (this.status === "preparing" && nowMs >= this.session.preparationDeadlineMs) {
      if (this.session.hook === "confirmed") this.status = "active";
      else this.release("hook_unconfirmed", effects);
      return;
    }
    if (this.status !== "active") return;
    if (nowMs >= this.session.hardDeadlineMs) this.release("hard_deadline", effects);
    else if (nowMs >= this.session.activeDeadlineMs) this.release("completed", effects);
    else if (this.session.lastHeartbeatMs === null || nowMs - this.session.lastHeartbeatMs >= HEARTBEAT_GRACE_MS) this.release("heartbeat_lost", effects);
  }

  private release(reason: KeyboardCleaningEndReason, effects: KeyboardCleaningEffect[]): void {
    if ((this.status !== "preparing" && this.status !== "active") || !this.session) return;
    this.session.endReason = reason;
    this.session.releaseConfirmed = false;
    this.status = "releasing";
    effects.push({ type: "stop_helper", command: { type: "stop", payload: { protocolVersion: KEYBOARD_CLEANING_PROTOCOL_VERSION, requestId: this.session.requestId, reason } } });
  }

  private releaseAcknowledgement(event: Extract<KeyboardCleaningEvent, { type: "release_confirmed" | "release_unconfirmed" }>, confirmed: boolean): void {
    this.ensureRequest(event.requestId);
    if (this.status !== "releasing" || !this.session) return;
    this.session.releaseConfirmed = confirmed;
    if (confirmed) this.status = "ended";
  }

  private ensureRequest(requestId: string): void {
    if (!this.session || this.session.requestId !== requestId) throw new KeyboardCleaningError("wrong_request", "helper 事件不属于当前任务。");
  }

  private observeTime(nowMs: number): void {
    if (!Number.isSafeInteger(nowMs) || nowMs < this.lastNowMs) throw new KeyboardCleaningError("clock_went_backward", "时钟必须单调递增。");
    this.lastNowMs = nowMs;
  }
}

export function encodeKeyboardCleaningCommand(command: KeyboardCleaningCommand): string {
  const frame = JSON.stringify(command);
  if (new TextEncoder().encode(frame).byteLength > MAX_HELPER_FRAME_BYTES || /[\r\n]/.test(frame)) throw new KeyboardCleaningError("invalid_request_id", "helper 协议帧超出限制。");
  return frame;
}

function deadlineAt(nowMs: number, deltaMs: number): number {
  return Math.min(Number.MAX_SAFE_INTEGER, nowMs + deltaMs);
}
