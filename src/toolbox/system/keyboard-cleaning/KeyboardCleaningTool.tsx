import { CircleAlert, ShieldCheck, Square, Timer } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  KeyboardCleaningMachine,
  type KeyboardCleaningCapability,
  type KeyboardCleaningEffect,
  type KeyboardCleaningSignal,
  type KeyboardCleaningState,
} from "./keyboardCleaning";

export interface KeyboardCleaningBridge {
  send(effect: KeyboardCleaningEffect): Promise<void>;
  subscribe(listener: (signal: KeyboardCleaningSignal) => void): () => void;
}

const DEFAULT_CAPABILITY: KeyboardCleaningCapability = {
  state: "unavailable",
  platform: "unknown",
  reason: "当前没有经过验证的受限键盘 hook 能力。",
};

export function KeyboardCleaningTool({ capability = DEFAULT_CAPABILITY, bridge }: { capability?: KeyboardCleaningCapability; bridge?: KeyboardCleaningBridge }) {
  const machine = useMemo(() => new KeyboardCleaningMachine(capability), [capability]);
  const [state, setState] = useState<KeyboardCleaningState>(() => machine.snapshot());
  const [durationSeconds, setDurationSeconds] = useState<30 | 60 | 120>(30);
  const [error, setError] = useState("");
  const clock = useCallback(() => Date.now(), []);
  const machineRef = useRef(machine);
  machineRef.current = machine;

  const sendEffects = useCallback((effects: KeyboardCleaningEffect[]) => {
    if (!bridge) return;
    for (const effect of effects) void bridge.send(effect).catch((reason: unknown) => setError(`受限 helper 未确认：${reason instanceof Error ? reason.message : "通信失败"}`));
  }, [bridge]);

  const apply = useCallback((action: Parameters<KeyboardCleaningMachine["dispatch"]>[0]) => {
    try {
      const transition = machineRef.current.dispatch(action);
      setState(transition.state);
      setError("");
      sendEffects(transition.effects);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "键盘清洁任务无法启动。 ");
    }
  }, [sendEffects]);

  useEffect(() => {
    if (!bridge) return undefined;
    return bridge.subscribe((signal) => {
      try {
        const transition = machineRef.current.applySignal(signal, clock());
        setState(transition.state);
        sendEffects(transition.effects);
      } catch (reason) {
        setError(reason instanceof Error ? reason.message : "helper 事件无效。 ");
      }
    });
  }, [bridge, clock, sendEffects]);

  useEffect(() => {
    if (state.status !== "preparing" && state.status !== "active") return undefined;
    const timer = window.setInterval(() => apply({ type: "tick", nowMs: clock() }), 250);
    return () => window.clearInterval(timer);
  }, [apply, clock, state.status]);

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

  const canStart = Boolean(bridge) && (state.status === "idle" || state.status === "ended") && capability.state === "available";
  const statusText = state.status === "unavailable" ? "不可用" : state.status === "preparing" ? "准备中（3 秒）" : state.status === "active" ? `清洁中（最多 ${state.durationSeconds} 秒）` : state.status === "releasing" ? "正在释放 hook" : state.status === "ended" ? "已结束" : "待机";

  return <section className="toolbox-tool-layout keyboard-cleaning-tool" aria-labelledby="keyboard-cleaning-title">
    <div className="toolbox-tool-layout__body">
      <header>
        <span className="toolbox-eyebrow"><ShieldCheck size={14} />系统安全 PoC</span>
        <h2 id="keyboard-cleaning-title">键盘清洁</h2>
        <p>临时阻止误触输入；只有受限 helper 明确确认 hook 有效后才会进入清洁状态。</p>
      </header>
      <p className="toolbox-hint"><CircleAlert size={15} />不记录键值、不把键盘内容传给 WebView、不申请全权限 WebView；鼠标活动、失焦、宿主退出、睡眠、撤权或 helper 心跳中断都会释放。</p>
      <div className="toolbox-inline-actions">
        <label>清洁时长<select value={durationSeconds} onChange={(event) => setDurationSeconds(Number(event.target.value) as 30 | 60 | 120)} disabled={!canStart}><option value={30}>30 秒</option><option value={60}>60 秒</option><option value={120}>120 秒</option></select></label>
        <button className="button button--primary" type="button" disabled={!canStart} onClick={() => apply({ type: "start", requestId: crypto.randomUUID(), durationSeconds, nowMs: clock() })}><Timer size={14} />开始清洁</button>
        {(state.status === "preparing" || state.status === "active") ? <button className="button button--secondary" type="button" onClick={() => apply({ type: "cancel", nowMs: clock() })}><Square size={14} />停止</button> : null}
      </div>
      <p className="toolbox-hint" role="status">能力：{capability.state === "available" ? `可用（${capability.platform}）` : capability.reason ?? "不可用"} · 状态：{statusText}{state.endReason ? ` · 原因：${state.endReason}` : ""}</p>
      {state.status === "active" && state.hardDeadlineMs !== null ? <p className="toolbox-hint">独立硬截止：{new Date(state.hardDeadlineMs).toLocaleTimeString()}；helper 未持续心跳时不会继续保持 active。</p> : null}
      {error ? <p className="toolbox-error" role="alert">{error}</p> : null}
      {!bridge ? <p className="toolbox-hint">尚未接入受限 helper bridge；页面保持不可用，不会模拟激活。</p> : null}
    </div>
    <div className="toolbox-tool-layout__footer"><span>平台能力必须由宿主以最小权限提供；本页面不监听 DOM 键盘事件，真实平台验证必须在隔离测试环境完成。</span></div>
  </section>;
}
