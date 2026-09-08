import type { TFunction } from "i18next";
import {
CheckCircle2,
CircleAlert,
Copy,
Download,
FileCheck2,
Hash,
Network,
Play,
QrCode,
ShieldCheck,
TerminalSquare,
Timer,
Wrench
} from "lucide-react";
import QRCode from "qrcode";
import type { ReactNode } from "react";
import { lazy,useEffect,useRef,useState } from "react";
import { useTranslation } from "react-i18next";
import { captureToolStateVersion, publishToolValues, useSharedToolState } from "./local/sharedToolState";
import { ProcessTargetPicker } from "../capabilities/ProcessTargetPicker";

import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import { cancelToolboxKeepAwake,cancelToolboxOccupancy,cancelToolboxProcessWatch,createToolboxSchedule,deleteToolboxSchedule,ejectRemovableVolume,getToolboxKeepAwakeState,getToolboxProcessWatches,getToolboxScheduleSnapshot,isDesktopRuntime,pauseToolboxSchedule,prepareEjectRemovableVolume,previewToolboxSchedule,resumeToolboxSchedule,retryToolboxKeepAwakeRelease,scanToolboxFileOccupancy,scanToolboxVolumeOccupancy,startToolboxKeepAwake,startToolboxProcessWatch,updateToolboxSchedule,type ToolboxPowerState,type ToolboxProcessWatchSnapshot,type ToolboxProcessWatchStatus,type ToolboxScheduleAction,type ToolboxScheduleSnapshot,type ToolboxScheduleTrigger } from "../api";
import type { ProcessRow } from "../types";
import { getToolboxNetworkSnapshot,subscribeToolboxActivity } from "./client";
import { ColorPickerTool } from "./color/ColorPickerTool";
import { formatColor,parseColor } from "./color/colorTools";
import type { ToolboxCapability,ToolDefinition,ToolId } from "./contracts";
import { analyzeUrl,convertTime,hashText,decodeBase64,decodeUrlComponent,encodeBase64,encodeUrlComponent,generateUuidV4 } from "./local/encodingTools";
import { FileHashTool } from "./local/FileHashTool";
import { analyzeJson,assertTextLimit } from "./local/jsonTools";
import { ToolboxInputError,userFacingError } from "./local/toolboxErrors";
import { analyzeRegex,runRegexInWorker,type RegexAnalysis } from "./regex/regexTools";
import { getToolDefinition } from "./registry";
import { KEYBOARD_CLEANING_RESTRICTED_HELPER_REASON,type KeyboardCleaningCapability } from "./system/keyboard-cleaning/keyboardCleaning";
import "./toolbox.css";

const ImageToolbox = lazy(async () => ({ default: (await import("./image/ImageToolbox")).ImageToolbox }));
const BinaryPatchToolbox = lazy(async () => ({ default: (await import("./binary-patch/BinaryPatchToolbox")).BinaryPatchToolbox }));
const NetworkAddressesTool = lazy(async () => ({ default: (await import("./network/NetworkAddressesTool")).NetworkAddressesTool }));
const KeyboardCleaningTool = lazy(async () => ({ default: (await import("./system/keyboard-cleaning/KeyboardCleaningTool")).KeyboardCleaningTool }));

const PENDING_SCHEDULE_MUTATIONS_KEY = "core-robin.toolbox.pending-schedule-mutations.v1";
export type ToolboxProcessWatchTarget = Pick<ProcessRow, "pid" | "birthToken" | "name" | "startTime">;
type ScheduleMutationPayload = {
  scheduleId?: string;
  expectedRevision?: number;
  timeZone?: string;
  title?: string;
  action?: ToolboxScheduleAction;
  trigger?: ToolboxScheduleTrigger;
};
type PendingScheduleMutation = { requestId: string; payload: ScheduleMutationPayload };
const DETERMINISTIC_SCHEDULE_ERROR_CODES = new Set([
  "invalid_schedule",
  "invalid_schedule_id",
  "invalid_cron",
  "invalid_trigger",
  "invalid_time_zone",
  "time_zone_unavailable",
  "cron_no_occurrence",
  "invalid_duration",
  "schedule_not_found",
  "revision_conflict",
  "request_id_conflict",
  "stale_schedule_request",
]);

export function ToolCapabilityNotice({ capability }: { capability: ToolboxCapability }) {
  const { t } = useTranslation("toolbox");
  if (capability.state === "available") return null;
  return <p className={`toolbox-capability-notice toolbox-capability-notice--${capability.state}`} role="status"><CircleAlert size={16} /><span><strong>{capabilityLabel(t, capability)}</strong>：{capabilityReason(t, capability)}</span></p>;
}

export function ToolOperation({
  toolId,
  capability,
  processWatchTarget,
  onOpenProcessInspector,
}: {
  toolId: ToolId;
  capability: ToolboxCapability;
  processWatchTarget?: ToolboxProcessWatchTarget | null;
  onOpenProcessInspector?: () => void;
}) {
  const { t } = useTranslation("toolbox");
  switch (toolId) {
    case "json": return <JsonTool />;
    case "url": return <UrlTool />;
    case "base64": return <Base64Tool />;
    case "time": return <TimeTool />;
    case "uuid": return <UuidTool />;
    case "qr-code": return <QrTool />;
    case "text-sha256": return <TextHashTool />;
    case "file-sha256": return <FileHashTool />;
    case "file-occupancy": return <OccupancyTool initialScope="file" />;
    case "volume-occupancy": return <OccupancyTool initialScope="volume" />;
    case "keep-awake": return <KeepAwakeTool />;
    case "process-watch": return <ProcessWatchTool initialTarget={processWatchTarget} onOpenProcessInspector={onOpenProcessInspector} />;
    case "keyboard-cleaning": return <KeyboardCleaningTool capability={toKeyboardCleaningCapability(capability, t)} />;
    case "regex": return <RegexTool />;
    case "color": return <ColorTool />;
    case "color-picker": return <ColorPickerTool />;
    case "network-addresses": return <NetworkAddressesTool loadSnapshot={getToolboxNetworkSnapshot} />;
    case "ifconfig-parser": return <NetworkAddressesTool loadSnapshot={getToolboxNetworkSnapshot} initialView="ifconfig" />;
    case "schedules": return <ScheduleTool />;
    case "image-watermark":
    case "image-batch-watermark":
    case "confidential-watermark":
    case "image-recipe":
    case "image-editor":
    case "invisible-watermark-write":
    case "invisible-watermark-check":
    case "recipient-tracking":
    case "robustness-lab":
    case "c2pa-inspector": return <ImageToolbox toolId={toolId} />;
    case "binary-patch-create":
    case "binary-patch-apply":
    case "binary-patch-inspector":
    case "integrity-manifest":
    case "transfer-savings":
    case "patch-errors":
    case "patch-planner": return <BinaryPatchToolbox toolId={toolId} />;
    default: return <UnavailableTool tool={getToolDefinition(toolId)} />;
  }
}

function toKeyboardCleaningCapability(capability: ToolboxCapability, t: ToolboxTFunction): KeyboardCleaningCapability {
  if (!isDesktopRuntime()) {
    return {
      state: "unavailable",
      platform: "unknown",
      reason: t("overview.restrictedNativeHelperUnavailable.description"),
    };
  }
  const platform = capability.platform?.toLowerCase();
  return {
    state: capability.state === "available" ? "available" : "unavailable",
    platform: platform === "macos" || platform === "windows" || platform === "linux" ? platform : "unknown",
    reason: capability.reason === KEYBOARD_CLEANING_RESTRICTED_HELPER_REASON
      ? t("overview.restrictedNativeHelperUnavailable.description")
      : capability.reason,
  };
}

function JsonTool() {
  const { t } = useTranslation("toolbox");
  const [input, setInput] = useSharedToolState("json", "input", ""); const [indent, setIndent] = useSharedToolState<2 | 4>("json", "indent", 2); const [output, setOutput] = useSharedToolState("json", "output", ""); const [error, setError] = useSharedToolState("json", "error", ""); const [duplicates, setDuplicates] = useSharedToolState<string[]>("json", "duplicates", []);
  const run = () => { try { const result = analyzeJson(input, indent); setOutput(result.formatted); setDuplicates(result.duplicateKeys); setError(""); } catch (reason) { setOutput(""); setError(localizedError(reason, t)); } };
  return <ToolLayout error={error} onClear={() => { setInput(""); setOutput(""); setError(""); }}><textarea className="toolbox-input toolbox-input--code" aria-label={t("tools.json.title")} spellCheck={false} autoCorrect="off" autoCapitalize="none" value={input} onChange={(event) => setInput(event.target.value)} placeholder={'{"name":"CoreRobin","count":1}'} /><div className="toolbox-inline-actions"><label>{t("local.json.indent")} <select value={indent} onChange={(event) => setIndent(Number(event.target.value) as 2 | 4)}><option value="2">{t("local.json.spaces", { count: 2 })}</option><option value="4">{t("local.json.spaces", { count: 4 })}</option></select></label><button className="button button--primary" type="button" onClick={run}><Play size={14} />{t("local.json.format")}</button><button className="button button--secondary" type="button" onClick={() => { try { setOutput(analyzeJson(input, indent).compact); setError(""); } catch (reason) { setError(localizedError(reason, t)); } }}>{t("local.json.compact")}</button></div>{duplicates.length > 0 ? <p className="toolbox-warning"><CircleAlert size={15} />{t("local.json.duplicate", { keys: duplicates.join(", ") })}</p> : null}<ResultBox value={output} /></ToolLayout>;
}

function UrlTool() {
  const { t } = useTranslation("toolbox");
  const [input, setInput] = useSharedToolState("url", "input", ""); const [mode, setMode] = useSharedToolState<"encode" | "decode" | "inspect">("url", "mode", "inspect"); const [output, setOutput] = useSharedToolState("url", "output", ""); const [error, setError] = useSharedToolState("url", "error", "");
  const run = () => { try { if (mode === "encode") setOutput(encodeUrlComponent(input)); else if (mode === "decode") setOutput(decodeUrlComponent(input)); else setOutput(JSON.stringify(analyzeUrl(input), null, 2)); setError(""); } catch (reason) { setError(localizedError(reason, t)); } };
  return <ToolLayout error={error} onClear={() => { setInput(""); setOutput(""); }}><textarea className="toolbox-input toolbox-input--code" value={input} onChange={(event) => setInput(event.target.value)} placeholder="https://example.test/path?a=1&a=two+words" /><div className="toolbox-inline-actions"><select value={mode} onChange={(event) => setMode(event.target.value as typeof mode)}><option value="inspect">{t("local.url.inspect")}</option><option value="encode">{t("local.url.encode")}</option><option value="decode">{t("local.url.decode")}</option></select><button className="button button--primary" type="button" onClick={run}><Play size={14} />{t("local.run")}</button></div><p className="toolbox-hint">{t("local.url.hint")}</p><ResultBox value={output} /></ToolLayout>;
}

function Base64Tool() {
  const { t } = useTranslation("toolbox");
  const [input, setInput] = useSharedToolState("base64", "input", ""); const [urlSafe, setUrlSafe] = useSharedToolState("base64", "urlSafe", false); const [decode, setDecode] = useSharedToolState("base64", "decode", false); const [output, setOutput] = useSharedToolState("base64", "output", ""); const [error, setError] = useSharedToolState("base64", "error", "");
  return <ToolLayout error={error} onClear={() => { setInput(""); setOutput(""); }}><textarea className="toolbox-input toolbox-input--code" value={input} onChange={(event) => setInput(event.target.value)} placeholder={decode ? t("local.base64.encodedPlaceholder") : t("local.base64.textPlaceholder")} /><div className="toolbox-inline-actions"><label><input type="checkbox" checked={decode} onChange={(event) => setDecode(event.target.checked)} />{t("local.base64.decode")}</label><label><input type="checkbox" checked={urlSafe} onChange={(event) => setUrlSafe(event.target.checked)} />{t("local.base64.urlSafe")}</label><button className="button button--primary" type="button" onClick={() => { try { setOutput(decode ? decodeBase64(input, urlSafe) : encodeBase64(input, urlSafe)); setError(""); } catch (reason) { setError(localizedError(reason, t)); } }}><Play size={14} />{t("local.convert")}</button></div><ResultBox value={output} /></ToolLayout>;
}

function TimeTool() {
  const { t } = useTranslation("toolbox");
  const [input, setInput] = useSharedToolState("time", "input", ""); const [unit, setUnit] = useSharedToolState<"seconds" | "milliseconds">("time", "unit", "seconds"); const [output, setOutput] = useSharedToolState("time", "output", ""); const [error, setError] = useSharedToolState("time", "error", "");
  return <ToolLayout error={error} onClear={() => { setInput(""); setOutput(""); }}><input className="toolbox-input" value={input} onChange={(event) => setInput(event.target.value)} placeholder={t("local.time.placeholder")} /><div className="toolbox-inline-actions"><select value={unit} onChange={(event) => setUnit(event.target.value as typeof unit)}><option value="seconds">{t("local.time.seconds")}</option><option value="milliseconds">{t("local.time.milliseconds")}</option></select><button className="button button--primary" type="button" onClick={() => { try { const value = convertTime(input, unit); setOutput(JSON.stringify(value, null, 2)); setError(""); } catch (reason) { setError(localizedError(reason, t)); } }}><Timer size={14} />{t("local.convert")}</button></div><p className="toolbox-hint">{t("local.time.hint")}</p><ResultBox value={output} /></ToolLayout>;
}

function UuidTool() {
  const { t } = useTranslation("toolbox");
  const [count, setCount] = useSharedToolState("uuid", "count", "1"); const [output, setOutput] = useSharedToolState("uuid", "output", ""); const [error, setError] = useSharedToolState("uuid", "error", "");
  return <ToolLayout error={error} onClear={() => setOutput("")}><div className="toolbox-inline-actions"><label>{t("local.uuid.count")} <input type="number" min="1" max="100" value={count} onChange={(event) => setCount(event.target.value)} /></label><button className="button button--primary" type="button" onClick={() => { try { setOutput(generateUuidV4(Number(count)).join("\n")); setError(""); } catch (reason) { setError(localizedError(reason, t)); } }}><Hash size={14} />{t("local.uuid.generate")}</button></div><p className="toolbox-hint">{t("local.uuid.hint")}</p><ResultBox value={output} /></ToolLayout>;
}

function QrTool() {
  const { t } = useTranslation("toolbox");
  const [mode, setMode] = useState<"text" | "wifi">("text"); const [text, setText] = useSharedToolState("qr-code", "text", ""); const [ssid, setSsid] = useState(""); const [password, setPassword] = useState(""); const [security, setSecurity] = useState("WPA"); const [textImage, setTextImage] = useSharedToolState("qr-code", "image", ""); const [wifiImage, setWifiImage] = useState(""); const [error, setError] = useState("");
  const qrGeneration = useRef(0);
  const image = mode === "text" ? textImage : wifiImage;
  const payload = mode === "text" ? text : `WIFI:T:${security};S:${wifiEscape(ssid)};P:${wifiEscape(password)};H:false;;`;
  return <ToolLayout error={error} onClear={() => { setText(""); setSsid(""); setPassword(""); setTextImage(""); setWifiImage(""); ++qrGeneration.current; }}><div className="toolbox-inline-actions"><select value={mode} onChange={(event) => setMode(event.target.value as typeof mode)}><option value="text">{t("local.qr.text")}</option><option value="wifi">{t("local.qr.wifi")}</option></select></div>{mode === "text" ? <textarea className="toolbox-input" value={text} onChange={(event) => setText(event.target.value)} placeholder={t("local.qr.textPlaceholder")} /> : <div className="toolbox-form-grid"><input className="toolbox-input" value={ssid} onChange={(event) => setSsid(event.target.value)} placeholder={t("local.qr.ssid")} /><input className="toolbox-input" type="password" value={password} onChange={(event) => setPassword(event.target.value)} placeholder={t("local.qr.password")} /><select className="toolbox-input" value={security} onChange={(event) => setSecurity(event.target.value)}><option value="WPA">{t("local.qr.wpa")}</option><option value="nopass">{t("local.qr.open")}</option></select></div>}<div className="toolbox-inline-actions"><button className="button button--primary" type="button" onClick={() => { if (new TextEncoder().encode(payload).byteLength > 2048) { setError(t("local.qr.tooLarge")); return; } const version = captureToolStateVersion("qr-code"); const generation = ++qrGeneration.current; void QRCode.toDataURL(payload, { width: 320, margin: 2 }).then((value) => { if (generation !== qrGeneration.current) return; if (mode === "text") publishToolValues("qr-code", { image: value }, version); else setWifiImage(value); }).catch((reason: unknown) => { if (generation === qrGeneration.current) setError(localizedError(reason, t)); }); }}><QrCode size={14} />{t("local.qr.generate")}</button></div>{mode === "wifi" ? <p className="toolbox-warning"><ShieldCheck size={15} />{t("local.qr.warning")}</p> : null}{image ? <div className="toolbox-qr-result"><img src={image} alt={t("local.qr.alt")} /><a className="button button--secondary" download="corerobin-qr.png" href={image}><Download size={14} />{t("local.qr.save")}</a></div> : null}</ToolLayout>;
}

function TextHashTool() {
  const { t } = useTranslation("toolbox");
  const [input, setInput] = useSharedToolState("text-sha256", "input", ""); const [expectedDigest, setExpectedDigest] = useSharedToolState("text-sha256", "expectedDigest", ""); const [output, setOutput] = useSharedToolState("text-sha256", "output", ""); const [error, setError] = useSharedToolState("text-sha256", "error", "");
  const computeGeneration = useRef(0);
  const normalizedExpectedDigest = expectedDigest.trim().toLowerCase();
  const comparison = output && normalizedExpectedDigest ? output === normalizedExpectedDigest : null;
  const compute = () => {
    try {
      assertTextLimit(input);
      const generation = ++computeGeneration.current;
      const version = captureToolStateVersion("text-sha256");
      void hashText(input).then((digest) => {
        if (generation !== computeGeneration.current) return;
        publishToolValues("text-sha256", { output: digest, error: "" }, version);
      }).catch((reason: unknown) => {
        if (generation === computeGeneration.current) setError(localizedError(reason, t));
      });
    } catch (reason) { setError(localizedError(reason, t)); }
  };
  return <ToolLayout error={error} onClear={() => { computeGeneration.current += 1; setInput(""); setExpectedDigest(""); setOutput(""); setError(""); }}><textarea className="toolbox-input" value={input} onChange={(event) => setInput(event.target.value)} placeholder={t("local.textHash.placeholder")} /><div className="toolbox-inline-actions"><input className="toolbox-input toolbox-input--code" value={expectedDigest} onChange={(event) => setExpectedDigest(event.target.value)} placeholder={"0".repeat(64)} aria-label={t("binaryPatch.inputs.expected")} aria-invalid={comparison === false || undefined} autoCapitalize="none" spellCheck={false} />{comparison !== null ? <span className={comparison ? "toolbox-hint" : "toolbox-warning"} role="status" data-comparison={comparison ? "match" : "mismatch"} aria-label={t("binaryPatch.inputs.expected")}>{comparison ? <ShieldCheck size={16} aria-hidden="true" /> : <CircleAlert size={16} aria-hidden="true" />}</span> : null}</div><button className="button button--primary" type="button" onClick={compute}><Hash size={14} />{t("local.textHash.compute")}</button><ResultBox value={output} /></ToolLayout>;
}


function OccupancyTool({ initialScope = "file" }: { initialScope?: "file" | "volume" }) {
  const { t } = useTranslation("toolbox");
  const [targetName, setTargetName] = useState("");
  const [path, setPath] = useState("");
  const [scope, setScope] = useState<"file" | "volume">(initialScope);
  const [output, setOutput] = useState("");
  const [error, setError] = useState("");
  const [running, setRunning] = useState(false);
  const [ejectConfirmation, setEjectConfirmation] = useState<string | null>(null);
  const [ejecting, setEjecting] = useState(false);

  useEffect(() => () => { void cancelToolboxOccupancy().catch(() => undefined); }, []);

  const choose = async (nextScope: "file" | "volume") => {
    setError("");
    setEjectConfirmation(null);
    if (!isDesktopRuntime()) { setError(t("occupancy.desktopOnly")); return; }
    const selected = await open({ multiple: false, directory: nextScope === "volume" });
    if (typeof selected === "string") {
      setScope(nextScope);
      setPath(selected);
      setTargetName(selected.split(/[\\/]/).filter(Boolean).pop() ?? selected);
    }
  };

  const run = async () => {
    if (!path) { setError(t(scope === "file" ? "occupancy.fileRequired" : "occupancy.volumeRequired")); return; }
    setRunning(true); setError(""); setOutput(""); setEjectConfirmation(null);
    try {
      const result = scope === "file"
        ? await scanToolboxFileOccupancy({ requestId: crypto.randomUUID(), path })
        : await scanToolboxVolumeOccupancy({ requestId: crypto.randomUUID(), path });
      setOutput(JSON.stringify(result, null, 2));
    } catch (reason) { setError(userFacingError(reason)); }
    finally { setRunning(false); }
  };

  const cancel = async () => { try { await cancelToolboxOccupancy(); } catch (reason) { setError(userFacingError(reason)); } };

  const prepareEject = async () => {
    if (!path || scope !== "volume") return;
    setEjecting(true); setError(""); setEjectConfirmation(null);
    try { setEjectConfirmation(await prepareEjectRemovableVolume(path)); }
    catch (reason) { setError(userFacingError(reason)); }
    finally { setEjecting(false); }
  };

  const eject = async () => {
    if (!ejectConfirmation) return;
    setEjecting(true); setError("");
    try {
      await ejectRemovableVolume(ejectConfirmation);
      setEjectConfirmation(null); setTargetName(""); setPath(""); setOutput("");
    } catch (reason) { setError(userFacingError(reason)); }
    finally { setEjecting(false); }
  };

  return <ToolLayout error={error} onClear={() => { void cancel(); setTargetName(""); setPath(""); setScope(initialScope); setOutput(""); setEjectConfirmation(null); }}>
    <div className="toolbox-file-pick"><button className="button button--secondary" type="button" onClick={() => void choose("file")}><FileCheck2 size={15} />{t("occupancy.selectFile")}</button><button className="button button--secondary" type="button" onClick={() => void choose("volume")}><FileCheck2 size={15} />{t("occupancy.selectVolume")}</button><span>{targetName || t("occupancy.noTarget")}</span></div>
    <div className="toolbox-inline-actions"><button className="button button--primary" disabled={running || !path} type="button" onClick={() => void run()}><Network size={14} />{running ? t("occupancy.running") : scope === "file" ? t("occupancy.fileAction") : t("occupancy.volumeAction")}</button>{running ? <button className="button button--secondary" type="button" onClick={() => void cancel()}>{t("occupancy.stop")}</button> : null}</div>
    {scope === "volume" && path && !running ? <div className="toolbox-inline-actions toolbox-occupancy-eject"><button className="button button--secondary" disabled={ejecting} type="button" onClick={() => void prepareEject()}><ShieldCheck size={14} />{ejecting ? t("occupancy.ejecting") : t("occupancy.prepareEject")}</button>{ejectConfirmation ? <button className="button button--primary" disabled={ejecting} type="button" onClick={() => void eject()}><CheckCircle2 size={14} />{t("occupancy.confirmEject")}</button> : null}</div> : null}
    <p className="toolbox-hint">{t("occupancy.hint")}</p><ResultBox value={output} />
  </ToolLayout>;
}

function KeepAwakeTool() {
  const { t } = useTranslation("toolbox");
  const [duration, setDuration] = useState("60"); const [state, setState] = useState<ToolboxPowerState | null>(null); const [error, setError] = useState(""); const [running, setRunning] = useState(false);
  useEffect(() => () => { if (isDesktopRuntime()) void cancelToolboxKeepAwake().catch(() => undefined); }, []);
  useEffect(() => {
    if (!isDesktopRuntime()) return;
    let disposed = false;
    let unlisten: (() => void) | undefined;
    const refresh = () => {
      void getToolboxKeepAwakeState()
        .then((next) => { if (!disposed) setState(next); })
        .catch((reason) => { if (!disposed) setError(userFacingError(reason)); });
    };
    void listen("system-wake", () => {
      if (disposed) return;
      refresh();
    }).then((nextUnlisten) => {
      if (disposed) nextUnlisten();
      else unlisten = nextUnlisten;
    }).catch(() => undefined);
    let unlistenActivity: (() => void) | undefined;
    void subscribeToolboxActivity(refresh).then((nextUnlisten) => {
      if (disposed) nextUnlisten();
      else unlistenActivity = nextUnlisten;
    }).catch(() => undefined);
    return () => {
      disposed = true;
      unlisten?.();
      unlistenActivity?.();
    };
  }, []);
  const start = async () => {
    if (!isDesktopRuntime()) { setError(t("keepAwake.desktopOnly")); return; }
    const durationMinutes = Number(duration);
    if (!Number.isInteger(durationMinutes) || durationMinutes < 1 || durationMinutes > 720) { setError(t("keepAwake.invalidDuration")); return; }
    setRunning(true); setError("");
    try { setState(await startToolboxKeepAwake({ requestId: crypto.randomUUID(), durationMinutes })); } catch (reason) { setError(userFacingError(reason)); } finally { setRunning(false); }
  };
  const stop = async () => { setRunning(true); try { setState(await cancelToolboxKeepAwake()); } catch (reason) { setError(userFacingError(reason)); } finally { setRunning(false); } };
  const retryRelease = async () => { setRunning(true); try { setState(await retryToolboxKeepAwakeRelease()); } catch (reason) { setError(userFacingError(reason)); } finally { setRunning(false); } };
  return <ToolLayout error={error} onClear={() => { setState(null); setError(""); }}><div className="toolbox-inline-actions"><label>{t("keepAwake.durationLabel")} <input className="toolbox-input" type="number" min="1" max="720" step="1" inputMode="numeric" value={duration} onChange={(event) => setDuration(event.target.value)} /></label><button className="button button--primary" disabled={running} type="button" onClick={() => void start()}><Timer size={14} />{t("keepAwake.start")}</button><button className="button button--secondary" disabled={running} type="button" onClick={() => void stop()}>{t("keepAwake.stop")}</button>{state?.resourceStatus === "release_unconfirmed" ? <button className="button button--danger-ghost" disabled={running} type="button" onClick={() => void retryRelease()}>{t("keepAwake.retryRelease")}</button> : null}</div><p className="toolbox-hint">{t("keepAwake.hint")}</p><ResultBox value={state ? JSON.stringify(state, null, 2) : ""} /></ToolLayout>;
}

function RegexTool() {
  const { t } = useTranslation("toolbox");
  const [pattern, setPattern] = useSharedToolState("regex", "pattern", "(?<word>\\w+)"); const [flags, setFlags] = useSharedToolState("regex", "flags", "gu"); const [sample, setSample] = useSharedToolState("regex", "sample", "CoreRobin 工具箱"); const [replacement, setReplacement] = useSharedToolState("regex", "replacement", "[$<word>]"); const [analysis, setAnalysis] = useSharedToolState<RegexAnalysis | null>("regex", "analysis", null); const [result, setResult] = useSharedToolState("regex", "result", ""); const [error, setError] = useSharedToolState("regex", "error", ""); const [running, setRunning] = useState(false);
  const run = async () => { setRunning(true); setError(""); try { const next = analyzeRegex(pattern, flags); setAnalysis(next); if (!next.supported) throw new ToolboxInputError("invalid_regex", next.syntaxError ?? t("errors.invalidRegex")); const version = captureToolStateVersion("regex"); const value = await runRegexInWorker(pattern, flags, sample, replacement); publishToolValues("regex", { result: JSON.stringify(value, null, 2), analysis: next, error: "" }, version); } catch (reason) { setError(localizedError(reason, t)); } finally { setRunning(false); } };
  return <ToolLayout error={error} onClear={() => { setAnalysis(null); setResult(""); }}><div className="toolbox-form-grid"><input className="toolbox-input toolbox-input--code" value={pattern} onChange={(event) => setPattern(event.target.value)} aria-label={t("local.regex.patternLabel")} /><input className="toolbox-input toolbox-input--code" value={flags} onChange={(event) => setFlags(event.target.value)} aria-label={t("local.regex.flagsLabel")} /></div><textarea className="toolbox-input" value={sample} onChange={(event) => setSample(event.target.value)} placeholder={t("local.regex.samplePlaceholder")} /><input className="toolbox-input" value={replacement} onChange={(event) => setReplacement(event.target.value)} placeholder={t("local.regex.replacementPlaceholder")} /><button className="button button--primary" disabled={running} type="button" onClick={() => void run()}><TerminalSquare size={14} />{running ? t("local.regex.running") : t("local.regex.run")}</button>{analysis ? <div className="toolbox-regex-tree"><strong>{t("local.regex.tree")}</strong><RegexTree node={analysis.ast} /><ul>{analysis.warnings.map((warning) => <li key={warning}>{warning}</li>)}</ul></div> : null}<ResultBox value={result} /></ToolLayout>;
}

function RegexTree({ node }: { node: RegexAnalysis["ast"] }) { return <details open className="toolbox-regex-node"><summary>{node.kind} · {node.label}</summary>{node.children.map((child) => <RegexTree key={child.id} node={child} />)}</details>; }

function ColorTool() {
  const { t } = useTranslation("toolbox");
  const [input, setInput] = useSharedToolState("color", "input", "#f15a43"); const [output, setOutput] = useSharedToolState<Record<string, string> | null>("color", "output", null); const [error, setError] = useSharedToolState("color", "error", "");
  return <ToolLayout error={error} onClear={() => { setInput(""); setOutput(null); }}><div className="toolbox-color-input"><input className="toolbox-input" value={input} onChange={(event) => setInput(event.target.value)} placeholder={t("local.color.placeholder")} /><span style={{ background: output ? output.hex : input }} /></div><button className="button button--primary" type="button" onClick={() => { try { const color = parseColor(input); setOutput(formatColor(color)); setError(""); } catch (reason) { setError(localizedError(reason, t)); } }}><Wrench size={14} />{t("local.color.convert")}</button>{output ? <ResultBox value={Object.entries(output).map(([key, value]) => `${key}: ${value}`).join("\n")} /> : null}</ToolLayout>;
}

function ScheduleTool() {
  const { t } = useTranslation("toolbox");
  const [kind, setKind] = useState<"once" | "daily" | "weekly" | "cron">("daily");
  const [actionKind, setActionKind] = useState<"reminder" | "keepAwake">("reminder");
  const [title, setTitle] = useState("");
  const [onceAt, setOnceAt] = useState(() => localDateTimeInput(new Date(Date.now() + 60 * 60 * 1_000)));
  const [hour, setHour] = useState("9");
  const [minute, setMinute] = useState("0");
  const [weekday, setWeekday] = useState("1");
  const [cron, setCron] = useState("*/15 9-17 * * 1-5");
  const [duration, setDuration] = useState("60");
  const [snapshot, setSnapshot] = useState<ToolboxScheduleSnapshot | null>(null);
  const [editingScheduleId, setEditingScheduleId] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [running, setRunning] = useState(false);
  const pendingMutations = useRef<Map<string, PendingScheduleMutation>>(readPendingScheduleMutations());

  const requestFor = (mutationKey: string, payload: ScheduleMutationPayload) => {
    const existing = pendingMutations.current.get(mutationKey);
    if (existing) return existing;
    const current = { requestId: crypto.randomUUID(), payload };
    pendingMutations.current.set(mutationKey, current);
    persistPendingScheduleMutations(pendingMutations.current);
    return current;
  };
  const settleMutation = (mutationKey: string) => {
    pendingMutations.current.delete(mutationKey);
    persistPendingScheduleMutations(pendingMutations.current);
  };
  const handleMutationFailure = async (mutationKey: string, reason: unknown) => {
    setError(userFacingError(reason));
    if (!isDeterministicScheduleFailure(reason)) return;
    settleMutation(mutationKey);
    const code = commandErrorCode(reason);
    if (code === "revision_conflict" || code === "schedule_not_found") {
      try {
        setSnapshot(await getToolboxScheduleSnapshot());
      } catch {
        // Keep the original command error visible when the refresh is unavailable.
      }
    }
  };

  useEffect(() => {
    if (!isDesktopRuntime()) return;
    void getToolboxScheduleSnapshot().then(setSnapshot).catch((reason) => setError(userFacingError(reason)));
  }, []);

  const refresh = async () => {
    if (!isDesktopRuntime()) return;
    setRunning(true);
    setError("");
    try {
      setSnapshot(await getToolboxScheduleSnapshot());
    } catch (reason) {
      setError(userFacingError(reason));
    } finally {
      setRunning(false);
    }
  };

  useEffect(() => {
    if (!isDesktopRuntime()) return;
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void subscribeToolboxActivity(() => {
      if (!disposed) void refresh();
    }).then((nextUnlisten) => {
      if (disposed) nextUnlisten();
      else unlisten = nextUnlisten;
    }).catch(() => undefined);
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  const beginEdit = (rule: ToolboxScheduleSnapshot["rules"][number]) => {
    setEditingScheduleId(rule.scheduleId);
    setTitle(rule.title ?? "");
    if (rule.action.kind === "keepAwake") {
      setActionKind("keepAwake");
      setDuration(String(rule.action.durationMinutes));
    } else {
      setActionKind("reminder");
    }
    if (rule.trigger.kind === "once") {
      setKind("once");
      setOnceAt(localDateTimeInput(new Date(rule.trigger.atMs)));
    } else if (rule.trigger.kind === "daily") {
      setKind("daily");
      setHour(String(rule.trigger.hour));
      setMinute(String(rule.trigger.minute));
    } else if (rule.trigger.kind === "weekly") {
      setKind("weekly");
      setHour(String(rule.trigger.hour));
      setMinute(String(rule.trigger.minute));
      setWeekday(String(rule.trigger.weekday));
    } else {
      setKind("cron");
      setCron(rule.trigger.expression);
    }
    setError("");
  };

  const create = async () => {
    if (!isDesktopRuntime()) {
      setError(t("schedule.desktopOnly"));
      return;
    }
    setRunning(true);
    setError("");
    let mutationKey: string | null = null;
    try {
      const numericHour = Number(hour);
      const numericMinute = Number(minute);
      const numericWeekday = Number(weekday);
      const durationMinutes = Number(duration);
      const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
      if (!timeZone) throw new ToolboxInputError("time_zone_unavailable", t("schedule.timeZoneUnavailable"));
      let trigger;
      let mutationTrigger;
      if (kind === "once") {
        const atMs = new Date(onceAt).getTime();
        const preview = await previewToolboxSchedule({ timeZone, trigger: { kind: "once", atUtcMs: atMs } });
        if (preview.status !== "ready" || preview.occurrenceAtMs.length === 0) throw new ToolboxInputError("invalid_once_time", t("schedule.invalidOnce"));
        trigger = { kind: "once" as const, atMs };
        mutationTrigger = { kind: "once" as const, atMs };
      } else if (kind === "daily") {
        const preview = await previewToolboxSchedule({ timeZone, trigger: { kind: "daily", hour: numericHour, minute: numericMinute } });
        if (preview.status !== "ready" || preview.occurrenceAtMs.length === 0) throw new ToolboxInputError("cron_no_occurrence", t("schedule.noOccurrence"));
        const nextRunAtMs = preview.occurrenceAtMs[0];
        trigger = { kind: "daily" as const, hour: numericHour, minute: numericMinute, nextRunAtMs };
        mutationTrigger = { kind: "daily" as const, hour: numericHour, minute: numericMinute };
      } else if (kind === "weekly") {
        const preview = await previewToolboxSchedule({ timeZone, trigger: { kind: "weekly", weekday: numericWeekday, hour: numericHour, minute: numericMinute } });
        if (preview.status !== "ready" || preview.occurrenceAtMs.length === 0) throw new ToolboxInputError("cron_no_occurrence", t("schedule.noOccurrence"));
        const nextRunAtMs = preview.occurrenceAtMs[0];
        trigger = { kind: "weekly" as const, weekday: numericWeekday, hour: numericHour, minute: numericMinute, nextRunAtMs };
        mutationTrigger = { kind: "weekly" as const, weekday: numericWeekday, hour: numericHour, minute: numericMinute };
      } else {
        const preview = await previewToolboxSchedule({ timeZone, trigger: { kind: "cron", expression: cron } });
        if (preview.status !== "ready" || preview.occurrenceAtMs.length === 0) throw new ToolboxInputError("cron_no_occurrence", t("schedule.noOccurrence"));
        trigger = { kind: "cron" as const, expression: cron, nextRunAtMs: preview.occurrenceAtMs[0] };
        mutationTrigger = { kind: "cron" as const, expression: cron };
      }
      if (actionKind === "keepAwake" && (!Number.isInteger(durationMinutes) || durationMinutes < 1 || durationMinutes > 720)) {
        throw new ToolboxInputError("invalid_duration", t("schedule.invalidDuration"));
      }
      const action = actionKind === "reminder" ? { kind: "reminder" as const } : { kind: "keepAwake" as const, durationMinutes };
      mutationKey = JSON.stringify({
        operation: editingScheduleId ? "update" : "create",
        scheduleId: editingScheduleId,
        timeZone,
        title: title || undefined,
        action,
        trigger: mutationTrigger,
      });
      const pending = requestFor(mutationKey, {
        ...(editingScheduleId ? { scheduleId: editingScheduleId, expectedRevision: snapshot?.revision } : {}),
        timeZone,
        title: title || undefined,
        action,
        trigger,
      });
      if (editingScheduleId) {
        const payload = pending.payload;
        setSnapshot(await updateToolboxSchedule({
          requestId: pending.requestId,
          scheduleId: payload.scheduleId ?? editingScheduleId,
          expectedRevision: payload.expectedRevision,
          timeZone: payload.timeZone ?? timeZone,
          title: payload.title,
          action: payload.action ?? action,
          trigger: payload.trigger ?? trigger,
        }));
      } else {
        const payload = pending.payload;
        setSnapshot(await createToolboxSchedule({
          requestId: pending.requestId,
          timeZone: payload.timeZone ?? timeZone,
          title: payload.title,
          action: payload.action ?? action,
          trigger: payload.trigger ?? trigger,
        }));
      }
      settleMutation(mutationKey);
      setEditingScheduleId(null);
    } catch (reason) {
      if (mutationKey) await handleMutationFailure(mutationKey, reason);
      else setError(userFacingError(reason));
    } finally {
      setRunning(false);
    }
  };

  const pause = async (scheduleId: string) => {
    setRunning(true);
    setError("");
    const mutationKey = JSON.stringify({ operation: "pause", scheduleId });
    try {
      const pending = requestFor(mutationKey, { scheduleId, expectedRevision: snapshot?.revision });
      setSnapshot(await pauseToolboxSchedule({
        requestId: pending.requestId,
        scheduleId: pending.payload.scheduleId ?? scheduleId,
        expectedRevision: pending.payload.expectedRevision,
      }));
      settleMutation(mutationKey);
    } catch (reason) {
      await handleMutationFailure(mutationKey, reason);
    } finally {
      setRunning(false);
    }
  };

  const resume = async (scheduleId: string) => {
    setRunning(true);
    setError("");
    const mutationKey = JSON.stringify({ operation: "resume", scheduleId });
    try {
      const pending = requestFor(mutationKey, { scheduleId, expectedRevision: snapshot?.revision });
      setSnapshot(await resumeToolboxSchedule({
        requestId: pending.requestId,
        scheduleId: pending.payload.scheduleId ?? scheduleId,
        expectedRevision: pending.payload.expectedRevision,
      }));
      settleMutation(mutationKey);
    } catch (reason) {
      await handleMutationFailure(mutationKey, reason);
    } finally {
      setRunning(false);
    }
  };

  const remove = async (scheduleId: string) => {
    setRunning(true);
    setError("");
    const mutationKey = JSON.stringify({ operation: "delete", scheduleId });
    try {
      const pending = requestFor(mutationKey, { scheduleId, expectedRevision: snapshot?.revision });
      setSnapshot(await deleteToolboxSchedule({
        requestId: pending.requestId,
        scheduleId: pending.payload.scheduleId ?? scheduleId,
        expectedRevision: pending.payload.expectedRevision,
      }));
      settleMutation(mutationKey);
    } catch (reason) {
      await handleMutationFailure(mutationKey, reason);
    } finally {
      setRunning(false);
    }
  };

  return <ToolLayout error={error} onClear={() => { setSnapshot(null); setEditingScheduleId(null); setError(""); }}>
    <div className="toolbox-form-grid">
      <label>{t("schedule.rule")} <select value={kind} onChange={(event) => setKind(event.target.value as typeof kind)}><option value="once">{t("schedule.once")}</option><option value="daily">{t("schedule.daily")}</option><option value="weekly">{t("schedule.weekly")}</option><option value="cron">{t("schedule.cron")}</option></select></label>
      <label>{t("schedule.intent")} <select value={actionKind} onChange={(event) => setActionKind(event.target.value as typeof actionKind)}><option value="reminder">{t("schedule.reminder")}</option><option value="keepAwake">{t("schedule.keepAwake")}</option></select></label>
      <input className="toolbox-input" value={title} maxLength={80} onChange={(event) => setTitle(event.target.value)} placeholder={t("schedule.titlePlaceholder")} />
    </div>
    {kind === "once" ? <label>{t("schedule.triggerAt")} <input className="toolbox-input" type="datetime-local" value={onceAt} onChange={(event) => setOnceAt(event.target.value)} /></label> : null}
    {kind === "cron" ? <input className="toolbox-input toolbox-input--code" value={cron} onChange={(event) => setCron(event.target.value)} placeholder={t("schedule.cronPlaceholder")} /> : null}
    {kind === "daily" || kind === "weekly" ? <div className="toolbox-form-grid">
      <label>{t("schedule.hour")} <input className="toolbox-input" inputMode="numeric" value={hour} onChange={(event) => setHour(event.target.value)} /></label>
      <label>{t("schedule.minute")} <input className="toolbox-input" inputMode="numeric" value={minute} onChange={(event) => setMinute(event.target.value)} /></label>
      {kind === "weekly" ? <label>{t("schedule.weekday")} <select value={weekday} onChange={(event) => setWeekday(event.target.value)}><option value="0">{t("schedule.weekdays.0")}</option><option value="1">{t("schedule.weekdays.1")}</option><option value="2">{t("schedule.weekdays.2")}</option><option value="3">{t("schedule.weekdays.3")}</option><option value="4">{t("schedule.weekdays.4")}</option><option value="5">{t("schedule.weekdays.5")}</option><option value="6">{t("schedule.weekdays.6")}</option></select></label> : null}
    </div> : null}
    {actionKind === "keepAwake" ? <label>{t("schedule.keepAwakeMinutes")} <input className="toolbox-input" inputMode="numeric" value={duration} onChange={(event) => setDuration(event.target.value)} /></label> : null}
    <div className="toolbox-inline-actions"><button className="button button--primary" disabled={running} type="button" onClick={() => void create()}><Timer size={14} />{editingScheduleId ? t("schedule.save") : t("schedule.create")}</button>{editingScheduleId ? <button className="button button--secondary" disabled={running} type="button" onClick={() => setEditingScheduleId(null)}>{t("schedule.cancelEdit")}</button> : null}<button className="button button--secondary" disabled={running || !isDesktopRuntime()} type="button" onClick={() => void refresh()}>{t("schedule.refresh")}</button></div>
    <p className="toolbox-hint">{t("schedule.hint")}</p>
    {snapshot ? snapshot.rules.map((rule) => <div className="toolbox-inline-actions" key={rule.scheduleId}><code>{rule.scheduleId}</code><span>{rule.title ?? t("schedule.unnamed")} · {rule.status === "paused" ? t("schedule.statusPaused") : t("schedule.statusScheduled")} · {t("schedule.nextPreview")} {new Date("atMs" in rule.trigger ? rule.trigger.atMs : rule.trigger.nextRunAtMs).toLocaleString()}</span><button className="button button--secondary" disabled={running} type="button" onClick={() => beginEdit(rule)}>{t("schedule.edit")}</button>{rule.status === "paused" ? <button className="button button--secondary" disabled={running} type="button" onClick={() => void resume(rule.scheduleId)}>{t("schedule.resume")}</button> : <button className="button button--secondary" disabled={running} type="button" onClick={() => void pause(rule.scheduleId)}>{t("schedule.pause")}</button>}<button className="button button--secondary" disabled={running} type="button" onClick={() => void remove(rule.scheduleId)}>{t("schedule.delete")}</button></div>) : null}
  </ToolLayout>;
}

function ProcessWatchTool({ initialTarget, onOpenProcessInspector }: { initialTarget?: ToolboxProcessWatchTarget | null; onOpenProcessInspector?: () => void }) {
  const { t } = useTranslation("toolbox");
  const [pid, setPid] = useState("");
  const [birthToken, setBirthToken] = useState("");
  const [targetName, setTargetName] = useState("");
  const [duration, setDuration] = useState("240");
  const [keepAwake, setKeepAwake] = useState(false);
  const [watches, setWatches] = useState<ToolboxProcessWatchSnapshot[]>([]);
  const [error, setError] = useState("");
  const [running, setRunning] = useState(false);

  useEffect(() => {
    if (!initialTarget?.birthToken) return;
    setPid(String(initialTarget.pid));
    setBirthToken(initialTarget.birthToken);
    setTargetName(initialTarget.name);
  }, [initialTarget]);

  const refresh = async () => {
    if (!isDesktopRuntime()) {
      setError(t("processWatch.desktopOnly"));
      return;
    }
    try {
      setWatches(await getToolboxProcessWatches());
      setError("");
    } catch (reason) {
      setError(userFacingError(reason));
    }
  };

  useEffect(() => {
    void refresh();
    if (!isDesktopRuntime()) return;
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void subscribeToolboxActivity(() => {
      if (!disposed) void refresh();
    }).then((nextUnlisten) => {
      if (disposed) nextUnlisten();
      else unlisten = nextUnlisten;
    }).catch(() => undefined);
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  const start = async () => {
    if (!isDesktopRuntime()) {
      setError(t("processWatch.desktopOnly"));
      return;
    }
    const numericPid = Number(pid);
    const durationMinutes = Number(duration);
    if (!Number.isInteger(numericPid) || numericPid <= 0 || !birthToken.trim()) {
      setError(t("processWatch.identityRequired"));
      return;
    }
    if (!Number.isInteger(durationMinutes) || durationMinutes < 1 || durationMinutes > 720) {
      setError(t("processWatch.invalidDuration"));
      return;
    }
    setRunning(true);
    setError("");
    try {
      await startToolboxProcessWatch({ key: { pid: numericPid, birthToken: birthToken.trim() }, durationMinutes, keepAwake });
      setBirthToken("");
      await refresh();
    } catch (reason) {
      setError(userFacingError(reason));
    } finally {
      setRunning(false);
    }
  };

  const cancel = async (watchId: number) => {
    setRunning(true);
    setError("");
    try {
      await cancelToolboxProcessWatch({ watchId });
      await refresh();
    } catch (reason) {
      setError(userFacingError(reason));
    } finally {
      setRunning(false);
    }
  };

  return <ToolLayout error={error} onClear={() => { setPid(""); setBirthToken(""); setWatches([]); setKeepAwake(false); setError(""); }}>
    <div className="toolbox-form-grid">
      <div className="toolbox-readonly-field"><span>{t("processWatch.pid")}</span><strong>{pid || "—"}</strong>{targetName ? <small>{targetName} · PID {pid}</small> : null}</div>
      <label>{t("processWatch.duration")} <input className="toolbox-input" inputMode="numeric" value={duration} onChange={(event) => setDuration(event.target.value)} /></label>
    </div>
    <ProcessTargetPicker value={birthToken ? `${pid}:${birthToken}` : ""} onSelect={(target) => { setPid(String(target.pid)); setBirthToken(target.birthToken ?? ""); setTargetName(target.name); }} />
    {!birthToken ? <div className="toolbox-warning" role="status"><CircleAlert size={15} /><span>{t("processWatch.identityRequired")}</span>{onOpenProcessInspector ? <button className="button button--secondary" type="button" onClick={onOpenProcessInspector}>{t("processWatch.openInspector")}</button> : null}</div> : null}
    <label className="toolbox-checkbox"><input type="checkbox" checked={keepAwake} onChange={(event) => setKeepAwake(event.target.checked)} />{t("processWatch.keepAwake")}</label>
    <div className="toolbox-inline-actions"><button className="button button--primary" disabled={running || !birthToken} type="button" onClick={() => void start()}><Timer size={14} />{t("processWatch.start")}</button><button className="button button--secondary" disabled={running || !isDesktopRuntime()} type="button" onClick={() => void refresh()}>{t("processWatch.refresh")}</button></div>
    <p className="toolbox-hint">{t("processWatch.hint")}</p>
    {watches.map((watch) => <div className="toolbox-inline-actions" key={watch.watchId}><span>#{watch.watchId} PID {watch.key.pid} · {t(PROCESS_WATCH_STATUS_KEYS[watch.status] as never)}{watch.keepAwakeStatus !== "not_requested" ? ` · ${t(KEEP_AWAKE_STATUS_KEYS[watch.keepAwakeStatus] as never)}` : ""} · {t("processWatch.deadline")} {new Date(watch.deadlineAtMs).toLocaleString()}</span><button className="button button--secondary" disabled={running || ["exited", "identity_changed", "interrupted", "expired", "cancelled"].includes(watch.status)} type="button" onClick={() => void cancel(watch.watchId)}>{t("processWatch.cancel")}</button></div>)}
  </ToolLayout>;
}

function localDateTimeInput(value: Date): string {
  const local = new Date(value.getTime() - value.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 16);
}

function readPendingScheduleMutations(): Map<string, PendingScheduleMutation> {
  try {
    const parsed: unknown = JSON.parse(sessionStorage.getItem(PENDING_SCHEDULE_MUTATIONS_KEY) ?? "[]");
    if (!Array.isArray(parsed)) return new Map();
    return new Map(parsed.filter((entry): entry is [string, PendingScheduleMutation] => {
      if (!Array.isArray(entry) || entry.length !== 2 || typeof entry[0] !== "string" || !isRecord(entry[1])) return false;
      return typeof entry[1].requestId === "string" && isRecord(entry[1].payload);
    }).slice(-8));
  } catch {
    return new Map();
  }
}

function persistPendingScheduleMutations(mutations: Map<string, PendingScheduleMutation>): void {
  try {
    sessionStorage.setItem(PENDING_SCHEDULE_MUTATIONS_KEY, JSON.stringify([...mutations.entries()].slice(-8)));
  } catch {
    // Retry identity is best effort when storage is unavailable.
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function commandErrorCode(error: unknown): string | null {
  if (isRecord(error) && typeof error.code === "string") return error.code;
  const message = error instanceof Error ? error.message : typeof error === "string" ? error : null;
  if (!message) return null;
  try {
    const parsed: unknown = JSON.parse(message);
    if (isRecord(parsed) && typeof parsed.code === "string") return parsed.code;
  } catch {
    // Tauri may serialize command errors as `code: message` text.
  }
  const prefix = message.split(":", 1)[0]?.trim();
  return prefix && /^[a-z][a-z0-9_]*$/.test(prefix) ? prefix : null;
}

function isDeterministicScheduleFailure(error: unknown): boolean {
  const code = commandErrorCode(error);
  return code !== null && DETERMINISTIC_SCHEDULE_ERROR_CODES.has(code);
}


export function UnavailableTool({ tool }: { tool: ToolDefinition }) { const { t } = useTranslation("toolbox"); return <div className="toolbox-unavailable"><CircleAlert size={24} /><strong>{t("capability.unavailableTitle", { tool: tool.title })}</strong><p>{capabilityReason(t, tool.capability)}</p><p>{t("capability.unavailableHint")}</p></div>; }

function ToolLayout({ error, onClear, children }: { error?: string; onClear: () => void; children: ReactNode }) { const { t } = useTranslation("toolbox"); return <div className="toolbox-tool-layout"><div className="toolbox-tool-layout__body">{children}</div>{error ? <p className="toolbox-error" role="alert"><CircleAlert size={15} />{error}</p> : null}<div className="toolbox-tool-layout__footer"><button className="button button--secondary" type="button" onClick={onClear}>{t("toolLayout.clear")}</button><span>{t("toolLayout.privacy")}</span></div></div>; }

function ResultBox({ value }: { value: string }) { const { t } = useTranslation("toolbox"); if (!value) return null; return <div className="toolbox-result" aria-live="polite"><div className="toolbox-result__header"><strong>{t("toolLayout.result")}</strong><button className="icon-button" type="button" aria-label={t("toolLayout.copyResult")} onClick={() => void navigator.clipboard?.writeText(value)}><Copy size={14} /></button></div><CodePreview value={value} /></div>; }

function CodePreview({ value }: { value: string }) {
  const isJson = looksLikeJson(value);
  const lines = value.split("\n");
  return <pre className={`toolbox-code-preview${isJson ? " toolbox-code-preview--json" : ""}`}><code>{isJson ? lines.map((line, index) => <span className="toolbox-code-line" key={`${index}-${line}`}><span className="toolbox-code-line__number" aria-hidden="true">{index + 1}</span><span>{highlightJsonLine(line)}</span>{index < lines.length - 1 ? "\n" : null}</span>) : value}</code></pre>;
}

function looksLikeJson(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return false;
  try { JSON.parse(trimmed); return true; } catch { return false; }
}

function highlightJsonLine(line: string): ReactNode[] {
  const token = /("(?:\\.|[^"\\])*")|(-?\b\d+(?:\.\d+)?(?:[eE][+-]?\d+)?\b)|(\b(?:true|false|null)\b)|(\{|\}|\[|\]|,|:)/g;
  const result: ReactNode[] = [];
  let cursor = 0;
  let match: RegExpExecArray | null;
  while ((match = token.exec(line)) !== null) {
    if (match.index > cursor) result.push(line.slice(cursor, match.index));
    const kind = match[1] ? /^\s*:/.test(line.slice(match.index + match[0].length)) ? "key" : "string" : match[2] ? "number" : match[3] ? "literal" : "punctuation";
    result.push(<span className={`toolbox-code-token toolbox-code-token--${kind}`} key={`${match.index}-${match[0]}`}>{match[0]}</span>);
    cursor = match.index + match[0].length;
  }
  if (cursor < line.length) result.push(line.slice(cursor));
  return result;
}

type ToolboxTFunction = TFunction<"toolbox">;
const PROCESS_WATCH_STATUS_KEYS: Record<ToolboxProcessWatchStatus, string> = {
  running: "processWatch.status.running",
  exited: "processWatch.status.exited",
  unknown: "processWatch.status.unknown",
  identity_changed: "processWatch.status.identityChanged",
  interrupted: "processWatch.status.interrupted",
  expired: "processWatch.status.expired",
  cancelled: "processWatch.status.cancelled",
};
const KEEP_AWAKE_STATUS_KEYS: Record<NonNullable<ToolboxProcessWatchSnapshot["keepAwakeStatus"]>, string> = {
  not_requested: "processWatch.keepAwakeStatus.notRequested",
  active: "processWatch.keepAwakeStatus.active",
  low_battery_ended: "processWatch.keepAwakeStatus.lowBatteryEnded",
  expired: "processWatch.keepAwakeStatus.expired",
  cancelled: "processWatch.keepAwakeStatus.cancelled",
  unavailable: "processWatch.keepAwakeStatus.unavailable",
};
export function capabilityLabel(t: ToolboxTFunction, capability: ToolboxCapability): string { return capability.state === "degraded" ? t("capability.degraded") : t("capability.unavailable"); }
export function capabilityReason(t: ToolboxTFunction, capability: ToolboxCapability): string {
  if (capability.reason === KEYBOARD_CLEANING_RESTRICTED_HELPER_REASON) return t("overview.restrictedNativeHelperUnavailable.description");
  return capability.reason ?? (capability.state === "degraded" ? t("capability.degradedReason") : t("capability.unavailableReason"));
}
const LOCAL_ERROR_KEYS: Record<string, string> = {
  input_too_large: "errors.inputTooLarge",
  json_too_deep: "errors.jsonTooDeep",
  invalid_json: "errors.invalidJson",
  invalid_percent_encoding: "errors.invalidPercentEncoding",
  invalid_url: "errors.invalidUrl",
  invalid_base64: "errors.invalidBase64",
  invalid_utf8: "errors.invalidUtf8",
  invalid_timestamp: "errors.invalidTimestamp",
  timestamp_out_of_range: "errors.timestampOutOfRange",
  timezone_required: "errors.timezoneRequired",
  invalid_iso: "errors.invalidIso",
  invalid_count: "errors.invalidCount",
  regex_too_large: "errors.regexTooLarge",
  regex_text_too_large: "errors.regexTextTooLarge",
  invalid_regex: "errors.invalidRegex",
  regex_worker_unavailable: "errors.regexWorkerUnavailable",
  regex_timeout: "errors.regexTimeout",
  regex_failed: "errors.regexFailed",
  invalid_color: "errors.invalidColor",
  time_zone_unavailable: "errors.timeZoneUnavailable",
  invalid_once_time: "errors.invalidOnceTime",
  cron_no_occurrence: "errors.cronNoOccurrence",
  invalid_duration: "errors.invalidDuration",
};
function localizedError(error: unknown, t: ToolboxTFunction): string {
  if (error instanceof ToolboxInputError) {
    const key = LOCAL_ERROR_KEYS[error.code];
    const message = key ? t(key as never, { message: error.message }) : error.message;
    const location = error.line !== null && error.column !== null ? t("errors.location", { line: error.line, column: error.column }) : "";
    return `${message}${location}`;
  }
  if (error instanceof Error) return error.message;
  return t("errors.generic");
}
function wifiEscape(value: string): string { return value.replace(/([\\;,:])/g, "\\$1"); }
