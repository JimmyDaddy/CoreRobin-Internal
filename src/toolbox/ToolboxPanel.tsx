import {
  ArrowLeft,
  ChevronRight,
  CircleAlert,
  Code2,
  Copy,
  Download,
  FileCheck2,
  FileImage,
  FileKey2,
  Hash,
  Heart,
  Image as ImageIcon,
  Network,
  Play,
  QrCode,
  Search,
  ShieldCheck,
  Sparkles,
  TerminalSquare,
  Timer,
  Wrench,
  X,
} from "lucide-react";
import { lazy, Suspense, useCallback, useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import QRCode from "qrcode";

import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import { cancelToolboxKeepAwake, cancelToolboxOccupancy, cancelToolboxProcessWatch, createToolboxSchedule, deleteToolboxSchedule, getToolboxKeepAwakeState, getToolboxProcessWatches, getToolboxScheduleSnapshot, getToolboxStorageSnapshot, isDesktopRuntime, listToolboxHistory, pauseToolboxSchedule, previewToolboxSchedule, scanToolboxFileOccupancy, scanToolboxVolumeOccupancy, startToolboxKeepAwake, startToolboxProcessWatch, updateToolboxSchedule, type ToolboxHistoryRecord, type ToolboxHistoryPage, type ToolboxProcessWatchSnapshot, type ToolboxScheduleSnapshot } from "../api";
import { FileHashTool } from "./local/FileHashTool";
import { analyzeJson, assertTextLimit } from "./local/jsonTools";
import { analyzeUrl, convertIsoTime, convertUnixTime, decodeBase64, encodeBase64, generateUuidV4 } from "./local/encodingTools";
import { userFacingError, ToolboxInputError } from "./local/toolboxErrors";
import { analyzeRegex, runRegexInWorker, type RegexAnalysis } from "./regex/regexTools";
import { formatColor, parseColor } from "./color/colorTools";
import { getToolboxNetworkSnapshot, getToolboxSnapshot, subscribeToolboxEvents } from "./client";
import { getToolDefinition, searchTools, toolboxToolTranslationKey } from "./registry";
import type { ToolDefinition, ToolId, ToolboxCapability, ToolboxCategory } from "./contracts";
import "./toolbox.css";

const ImageToolbox = lazy(async () => ({ default: (await import("./image/ImageToolbox")).ImageToolbox }));
const BinaryPatchToolbox = lazy(async () => ({ default: (await import("./binary-patch/BinaryPatchToolbox")).BinaryPatchToolbox }));
const NetworkAddressesTool = lazy(async () => ({ default: (await import("./network/NetworkAddressesTool")).NetworkAddressesTool }));
const KeyboardCleaningTool = lazy(async () => ({ default: (await import("./system/keyboard-cleaning/KeyboardCleaningTool")).KeyboardCleaningTool }));

const FAVORITES_KEY = "core-robin.toolbox.favorite-tool-ids.v1";
const CATEGORY_LABEL_KEYS = {
  "system-network": "categories.systemNetwork",
  "text-development": "categories.textDevelopment",
  image: "categories.image",
  "file-patch": "categories.filePatch",
} as const satisfies Record<ToolboxCategory, string>;
const CATEGORY_ICONS: Record<ToolboxCategory, typeof Wrench> = {
  "system-network": Network,
  "text-development": Code2,
  image: ImageIcon,
  "file-patch": FileKey2,
};

export function ToolboxPanel({ onClose }: { onClose?: () => void }) {
  const { t } = useTranslation("toolbox");
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<ToolId | null>(null);
  const [favorites, setFavorites] = useState<Set<ToolId>>(() => readFavorites());
  const [nativeCapabilities, setNativeCapabilities] = useState<Partial<Record<ToolId, ToolboxCapability>>>();
  const translateTool = useCallback(
    (id: ToolId, field: "title" | "description" | "aliases") =>
      t(toolboxToolTranslationKey(id, field)),
    [t],
  );
  const tools = useMemo(
    () => searchTools(query, nativeCapabilities, translateTool),
    [query, nativeCapabilities, translateTool],
  );
  const selectedTool = selected
    ? getToolDefinition(selected, nativeCapabilities, translateTool)
    : null;

  useEffect(() => {
    if (!isDesktopRuntime()) return;
    let mounted = true;
    let unlisten: (() => void) | undefined;
    void getToolboxSnapshot()
      .then((snapshot) => { if (mounted) setNativeCapabilities(snapshot.capabilities); })
      .catch(() => undefined);
    void subscribeToolboxEvents((event) => {
      if (mounted && event.type === "snapshot") setNativeCapabilities(event.snapshot.capabilities);
    }).then((nextUnlisten) => {
      if (mounted) unlisten = nextUnlisten;
      else nextUnlisten();
    }).catch(() => undefined);
    return () => {
      mounted = false;
      unlisten?.();
    };
  }, []);

  const toggleFavorite = (id: ToolId) => {
    setFavorites((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id); else next.add(id);
      try { localStorage.setItem(FAVORITES_KEY, JSON.stringify([...next])); } catch { /* private preference is best effort */ }
      return next;
    });
  };

  const openTool = (tool: ToolDefinition) => {
    if (tool.capability.state !== "unavailable") setSelected(tool.id);
  };

  return (
    <section className="toolbox-panel" aria-labelledby="toolbox-title">
      {selectedTool ? (
        <ToolPage tool={selectedTool} onBack={() => setSelected(null)}>
          {selectedTool.capability.state === "unavailable" ? <UnavailableTool tool={selectedTool} /> : <>
            <ToolCapabilityNotice capability={selectedTool.capability} />
            <Suspense fallback={<div className="surface-loading" role="status">{t("loading")}</div>}>
              <ToolContent toolId={selectedTool.id} />
            </Suspense>
          </>}
        </ToolPage>
      ) : (
        <>
          <header className="toolbox-panel__header">
            <div>
              <span className="toolbox-eyebrow"><Sparkles size={14} />CoreRobin</span>
              <h1 id="toolbox-title">{t("title")}</h1>
              <p>{t("description")}</p>
            </div>
            {onClose ? <button className="icon-button" type="button" aria-label={t("close")} onClick={onClose}><X size={18} /></button> : null}
          </header>
          <label className="toolbox-search">
            <Search size={16} />
            <span className="sr-only">{t("search.label")}</span>
            <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t("search.placeholder")} />
            {query ? <button type="button" aria-label={t("search.clear")} onClick={() => setQuery("")}><X size={14} /></button> : null}
          </label>
          <div className="toolbox-category-tabs" role="group" aria-label={t("categories.label")}>
            {(Object.keys(CATEGORY_LABEL_KEYS) as ToolboxCategory[]).map((category) => {
              const Icon = CATEGORY_ICONS[category];
              return <span key={category} className="toolbox-category-tab"><Icon size={14} />{t(CATEGORY_LABEL_KEYS[category])}</span>;
            })}
          </div>
          {favorites.size > 0 && !query ? <ToolSection sectionId="favorites" title={t("favorites.title")} tools={tools.filter((tool) => favorites.has(tool.id))} favorites={favorites} onOpen={openTool} onFavorite={toggleFavorite} /> : null}
          {(Object.keys(CATEGORY_LABEL_KEYS) as ToolboxCategory[]).map((category) => (
            <ToolSection key={category} sectionId={category} title={t(CATEGORY_LABEL_KEYS[category])} tools={tools.filter((tool) => tool.category === category)} favorites={favorites} onOpen={openTool} onFavorite={toggleFavorite} />
          ))}
          {tools.length === 0 ? <div className="toolbox-empty"><Wrench size={22} /><strong>{t("empty.title")}</strong><span>{t("empty.description")}</span></div> : null}
          <ToolboxHistoryPanel />
        </>
      )}
    </section>
  );
}

function ToolboxHistoryPanel() {
  const { t } = useTranslation("toolbox");
  const [page, setPage] = useState<ToolboxHistoryPage | null>(null);
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const refresh = async () => {
    if (!isDesktopRuntime()) return;
    setLoading(true);
    try {
      const storage = await getToolboxStorageSnapshot();
      setEnabled(storage.policy.toolboxHistoryEnabled);
      setPage(storage.policy.toolboxHistoryEnabled ? await listToolboxHistory({ limit: 20 }) : null);
      setError("");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : t("history.unavailable"));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void refresh();
    if (!isDesktopRuntime()) return;
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void listen("system-wake", () => {
      if (!disposed) void refresh();
    }).then((nextUnlisten) => {
      if (disposed) nextUnlisten();
      else unlisten = nextUnlisten;
    }).catch(() => undefined);
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [t]);
  if (!isDesktopRuntime()) return null;

  return <section className="toolbox-section" aria-labelledby="toolbox-history-title">
    <div className="toolbox-section__title"><h2 id="toolbox-history-title">{t("history.title")}</h2><span>{page ? t("history.count", { count: page.records.length }) : enabled === false ? t("history.disabled") : ""}</span></div>
    {enabled === false ? <p className="toolbox-hint">{t("history.disabledDescription")}</p> : null}
    {error ? <p className="toolbox-error" role="alert"><CircleAlert size={15} />{error}</p> : null}
    {enabled !== false && page?.records.length ? <div className="toolbox-history-list">{page.records.map((record) => <HistoryRow key={record.recordId} record={record} />)}</div> : null}
    {enabled !== false && page && page.records.length === 0 ? <p className="toolbox-hint">{t("history.empty")}</p> : null}
    <div className="toolbox-inline-actions"><button className="button button--secondary" type="button" disabled={loading} onClick={() => void refresh()}>{loading ? t("history.refreshing") : t("history.refresh")}</button><span className="toolbox-hint">{t("history.privacy")}</span></div>
  </section>;
}

function HistoryRow({ record }: { record: ToolboxHistoryRecord }) {
  const { t } = useTranslation("toolbox");
  return <div className="toolbox-history-row"><strong>{t(`history.tools.${record.tool}`)}</strong><span>{t(`history.statuses.${record.terminalStatus}`)}</span><small>{new Date(record.completedAtMs).toLocaleString()} · {t("history.notification", { status: t(`history.notifications.${record.notificationStatus}`) })}</small></div>;
}

function ToolSection({ sectionId, title, tools, favorites, onOpen, onFavorite }: { sectionId: string; title: string; tools: ToolDefinition[]; favorites: Set<ToolId>; onOpen: (tool: ToolDefinition) => void; onFavorite: (id: ToolId) => void }) {
  const { t } = useTranslation("toolbox");
  if (tools.length === 0) return null;
  const headingId = `toolbox-section-${sectionId}`;
  return (
    <section className="toolbox-section" aria-labelledby={headingId}>
      <div className="toolbox-section__title"><h2 id={headingId}>{title}</h2><span>{tools.length}</span></div>
      <div className="toolbox-grid">
        {tools.map((tool) => <div className={`toolbox-card toolbox-card--${tool.capability.state}`} key={tool.id}>
          <button className="toolbox-card__open" type="button" disabled={tool.capability.state === "unavailable"} onClick={() => onOpen(tool)}>
            <span className="toolbox-card__icon"><ToolIcon id={tool.id} /></span>
            <span className="toolbox-card__content"><strong>{tool.title}</strong><small>{tool.description}</small>{tool.capability.state !== "available" ? <small className="toolbox-card__capability">{capabilityLabel(t, tool.capability)}：{capabilityReason(t, tool.capability)}</small> : null}</span>
          </button>
          <span className="toolbox-card__actions">
            <button type="button" className={`toolbox-favorite${favorites.has(tool.id) ? " is-active" : ""}`} aria-label={favorites.has(tool.id) ? t("favorites.remove", { tool: tool.title }) : t("favorites.add", { tool: tool.title })} onClick={() => onFavorite(tool.id)}><Heart size={14} fill={favorites.has(tool.id) ? "currentColor" : "none"} /></button>
            <ChevronRight size={16} aria-hidden="true" />
          </span>
        </div>)}
      </div>
    </section>
  );
}

function ToolPage({ tool, onBack, children }: { tool: ToolDefinition; onBack: () => void; children: ReactNode }) {
  const { t } = useTranslation("toolbox");
  return <div className="toolbox-tool-page"><header className="toolbox-tool-page__header"><button className="button button--secondary" type="button" onClick={onBack}><ArrowLeft size={15} />{t("navigation.back")}</button><div><span className="toolbox-eyebrow">{t(CATEGORY_LABEL_KEYS[tool.category])}</span><h1>{tool.title}</h1><p>{tool.description}</p></div></header>{children}</div>;
}

function ToolCapabilityNotice({ capability }: { capability: ToolboxCapability }) {
  const { t } = useTranslation("toolbox");
  if (capability.state === "available") return null;
  return <p className={`toolbox-capability-notice toolbox-capability-notice--${capability.state}`} role="status"><CircleAlert size={16} /><span><strong>{capabilityLabel(t, capability)}</strong>：{capabilityReason(t, capability)}</span></p>;
}

function ToolContent({ toolId }: { toolId: ToolId }) {
  switch (toolId) {
    case "json": return <JsonTool />;
    case "url": return <UrlTool />;
    case "base64": return <Base64Tool />;
    case "time": return <TimeTool />;
    case "uuid": return <UuidTool />;
    case "qr-code": return <QrTool />;
    case "text-sha256": return <TextHashTool />;
    case "file-sha256": return <FileHashTool />;
    case "file-occupancy": return <OccupancyTool />;
    case "keep-awake": return <KeepAwakeTool />;
    case "process-watch": return <ProcessWatchTool />;
    case "keyboard-cleaning": return <KeyboardCleaningTool />;
    case "regex": return <RegexTool />;
    case "color": return <ColorTool />;
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

function JsonTool() {
  const [input, setInput] = useState(""); const [indent, setIndent] = useState<2 | 4>(2); const [output, setOutput] = useState(""); const [error, setError] = useState(""); const [duplicates, setDuplicates] = useState<string[]>([]);
  const run = () => { try { const result = analyzeJson(input, indent); setOutput(result.formatted); setDuplicates(result.duplicateKeys); setError(""); } catch (reason) { setOutput(""); setError(userFacingError(reason)); } };
  return <ToolLayout error={error} onClear={() => { setInput(""); setOutput(""); setError(""); }}><textarea className="toolbox-input toolbox-input--code" value={input} onChange={(event) => setInput(event.target.value)} placeholder={'{"name":"CoreRobin","count":1}'} /><div className="toolbox-inline-actions"><label>缩进 <select value={indent} onChange={(event) => setIndent(Number(event.target.value) as 2 | 4)}><option value="2">2 空格</option><option value="4">4 空格</option></select></label><button className="button button--primary" type="button" onClick={run}><Play size={14} />校验并格式化</button><button className="button button--secondary" type="button" onClick={() => { try { setOutput(analyzeJson(input, indent).compact); setError(""); } catch (reason) { setError(userFacingError(reason)); } }}>压缩</button></div>{duplicates.length > 0 ? <p className="toolbox-warning"><CircleAlert size={15} />重复键：{duplicates.join(", ")}（保留原文顺序，不擅自合并）</p> : null}<ResultBox value={output} /></ToolLayout>;
}

function UrlTool() {
  const [input, setInput] = useState(""); const [mode, setMode] = useState<"encode" | "decode" | "inspect">("inspect"); const [output, setOutput] = useState(""); const [error, setError] = useState("");
  const run = () => { try { if (mode === "encode") setOutput(encodeURIComponent(input)); else if (mode === "decode") setOutput(decodeURIComponent(input)); else setOutput(JSON.stringify(analyzeUrl(input), null, 2)); setError(""); } catch (reason) { setError(userFacingError(reason)); } };
  return <ToolLayout error={error} onClear={() => { setInput(""); setOutput(""); }}><textarea className="toolbox-input toolbox-input--code" value={input} onChange={(event) => setInput(event.target.value)} placeholder="https://example.test/path?a=1&a=two+words" /><div className="toolbox-inline-actions"><select value={mode} onChange={(event) => setMode(event.target.value as typeof mode)}><option value="inspect">结构查看</option><option value="encode">编码参数</option><option value="decode">解码参数</option></select><button className="button button--primary" type="button" onClick={run}><Play size={14} />执行</button></div><p className="toolbox-hint">参数按原始百分号规则处理，+ 保留为加号；不会打开 URL。</p><ResultBox value={output} /></ToolLayout>;
}

function Base64Tool() {
  const [input, setInput] = useState(""); const [urlSafe, setUrlSafe] = useState(false); const [decode, setDecode] = useState(false); const [output, setOutput] = useState(""); const [error, setError] = useState("");
  return <ToolLayout error={error} onClear={() => { setInput(""); setOutput(""); }}><textarea className="toolbox-input toolbox-input--code" value={input} onChange={(event) => setInput(event.target.value)} placeholder={decode ? "SGVsbG8=" : "输入 UTF-8 文本"} /><div className="toolbox-inline-actions"><label><input type="checkbox" checked={decode} onChange={(event) => setDecode(event.target.checked)} />解码</label><label><input type="checkbox" checked={urlSafe} onChange={(event) => setUrlSafe(event.target.checked)} />Base64URL</label><button className="button button--primary" type="button" onClick={() => { try { setOutput(decode ? decodeBase64(input, urlSafe) : encodeBase64(input, urlSafe)); setError(""); } catch (reason) { setError(userFacingError(reason)); } }}><Play size={14} />转换</button></div><ResultBox value={output} /></ToolLayout>;
}

function TimeTool() {
  const [input, setInput] = useState(""); const [unit, setUnit] = useState<"seconds" | "milliseconds">("seconds"); const [output, setOutput] = useState(""); const [error, setError] = useState("");
  return <ToolLayout error={error} onClear={() => { setInput(""); setOutput(""); }}><input className="toolbox-input" value={input} onChange={(event) => setInput(event.target.value)} placeholder="Unix 数字或带时区 ISO 时间" /><div className="toolbox-inline-actions"><select value={unit} onChange={(event) => setUnit(event.target.value as typeof unit)}><option value="seconds">Unix 秒</option><option value="milliseconds">Unix 毫秒</option></select><button className="button button--primary" type="button" onClick={() => { try { const value = input.includes("T") ? convertIsoTime(input) : convertUnixTime(input, unit); setOutput(JSON.stringify(value, null, 2)); setError(""); } catch (reason) { setError(userFacingError(reason)); } }}><Timer size={14} />转换</button></div><p className="toolbox-hint">结果并列显示 UTC 与当前本地时区；不根据位数猜单位。</p><ResultBox value={output} /></ToolLayout>;
}

function UuidTool() {
  const [count, setCount] = useState("1"); const [output, setOutput] = useState(""); const [error, setError] = useState("");
  return <ToolLayout error={error} onClear={() => setOutput("")}><div className="toolbox-inline-actions"><label>数量 <input type="number" min="1" max="100" value={count} onChange={(event) => setCount(event.target.value)} /></label><button className="button button--primary" type="button" onClick={() => { try { setOutput(generateUuidV4(Number(count)).join("\n")); setError(""); } catch (reason) { setError(userFacingError(reason)); } }}><Hash size={14} />生成 UUID v4</button></div><p className="toolbox-hint">使用系统安全随机源；UUID 不是密码。</p><ResultBox value={output} /></ToolLayout>;
}

function QrTool() {
  const [mode, setMode] = useState<"text" | "wifi">("text"); const [text, setText] = useState(""); const [ssid, setSsid] = useState(""); const [password, setPassword] = useState(""); const [security, setSecurity] = useState("WPA"); const [image, setImage] = useState(""); const [error, setError] = useState("");
  const payload = mode === "text" ? text : `WIFI:T:${security};S:${wifiEscape(ssid)};P:${wifiEscape(password)};H:false;;`;
  return <ToolLayout error={error} onClear={() => { setText(""); setSsid(""); setPassword(""); setImage(""); }}><div className="toolbox-inline-actions"><select value={mode} onChange={(event) => setMode(event.target.value as typeof mode)}><option value="text">文本 / URL</option><option value="wifi">Wi-Fi（手填）</option></select></div>{mode === "text" ? <textarea className="toolbox-input" value={text} onChange={(event) => setText(event.target.value)} placeholder="输入文本或 URL（不会自动打开）" /> : <div className="toolbox-form-grid"><input className="toolbox-input" value={ssid} onChange={(event) => setSsid(event.target.value)} placeholder="SSID" /><input className="toolbox-input" type="password" value={password} onChange={(event) => setPassword(event.target.value)} placeholder="密码（可留空）" /><select className="toolbox-input" value={security} onChange={(event) => setSecurity(event.target.value)}><option value="WPA">WPA/WPA2</option><option value="nopass">开放网络</option></select></div>}<div className="toolbox-inline-actions"><button className="button button--primary" type="button" onClick={() => { if (new TextEncoder().encode(payload).byteLength > 2048) { setError("二维码载荷不能超过 2 KiB。"); return; } void QRCode.toDataURL(payload, { width: 320, margin: 2 }).then(setImage).catch((reason: unknown) => setError(userFacingError(reason))); }}><QrCode size={14} />生成 PNG</button></div>{mode === "wifi" ? <p className="toolbox-warning"><ShieldCheck size={15} />二维码包含 Wi-Fi 凭据，请确认保存位置；CoreRobin 不读取钥匙串。</p> : null}{image ? <div className="toolbox-qr-result"><img src={image} alt="生成的二维码" /><a className="button button--secondary" download="corerobin-qr.png" href={image}><Download size={14} />保存 PNG</a></div> : null}</ToolLayout>;
}

function TextHashTool() {
  const [input, setInput] = useState(""); const [output, setOutput] = useState(""); const [error, setError] = useState("");
  return <ToolLayout error={error} onClear={() => { setInput(""); setOutput(""); }}><textarea className="toolbox-input" value={input} onChange={(event) => setInput(event.target.value)} placeholder="输入 UTF-8 文本（最多 1 MiB）" /><button className="button button--primary" type="button" onClick={() => { try { assertTextLimit(input); void crypto.subtle.digest("SHA-256", new TextEncoder().encode(input)).then((digest) => setOutput([...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join(""))).catch((reason: unknown) => setError(userFacingError(reason))); } catch (reason) { setError(userFacingError(reason)); } }}><Hash size={14} />计算 SHA-256</button><ResultBox value={output} /></ToolLayout>;
}


function OccupancyTool() {
  const [targetName, setTargetName] = useState(""); const [path, setPath] = useState(""); const [scope, setScope] = useState<"file" | "volume">("file"); const [output, setOutput] = useState(""); const [error, setError] = useState(""); const [running, setRunning] = useState(false);
  const choose = async (nextScope: "file" | "volume") => { setError(""); if (!isDesktopRuntime()) { setError("占用诊断需要桌面原生运行时。"); return; } const selected = await open({ multiple: false, directory: nextScope === "volume" }); if (typeof selected === "string") { setScope(nextScope); setPath(selected); setTargetName(selected.split(/[\\/]/).filter(Boolean).pop() ?? selected); } };
  const run = async () => { if (!path) { setError(scope === "file" ? "请先选择一个普通文件。" : "请先选择一个挂载目录。"); return; } setRunning(true); setError(""); setOutput(""); try { const result = scope === "file" ? await scanToolboxFileOccupancy({ requestId: crypto.randomUUID(), path }) : await scanToolboxVolumeOccupancy({ requestId: crypto.randomUUID(), path }); setOutput(JSON.stringify(result, null, 2)); } catch (reason) { setError(userFacingError(reason)); } finally { setRunning(false); } };
  const cancel = async () => { try { await cancelToolboxOccupancy(); } catch (reason) { setError(userFacingError(reason)); } };
  return <ToolLayout error={error} onClear={() => { void cancel(); setTargetName(""); setPath(""); setScope("file"); setOutput(""); }}><div className="toolbox-file-pick"><button className="button button--secondary" type="button" onClick={() => void choose("file")}><FileCheck2 size={15} />选择普通文件</button><button className="button button--secondary" type="button" onClick={() => void choose("volume")}><FileCheck2 size={15} />选择外盘挂载点</button><span>{targetName || "未选择目标"}</span></div><div className="toolbox-inline-actions"><button className="button button--primary" disabled={running || !path} type="button" onClick={() => void run()}><Network size={14} />{running ? "正在诊断…" : scope === "file" ? "查找文件使用者" : "查找外盘使用者"}</button>{running ? <button className="button button--secondary" type="button" onClick={() => void cancel()}>停止诊断</button> : null}</div><p className="toolbox-hint">文件诊断仅匹配当前文件；外盘诊断只按挂载点身份匹配固定范围的进程引用。macOS 使用固定参数 lsof，Linux 匹配可见 /proc；结果带覆盖范围、截断和身份复验状态，不会关闭进程或自动推出外盘。</p><ResultBox value={output} /></ToolLayout>;
}

function KeepAwakeTool() {
  const [duration, setDuration] = useState("60"); const [state, setState] = useState(""); const [error, setError] = useState(""); const [running, setRunning] = useState(false);
  useEffect(() => () => { if (isDesktopRuntime()) void cancelToolboxKeepAwake().catch(() => undefined); }, []);
  useEffect(() => {
    if (!isDesktopRuntime()) return;
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void listen("system-wake", () => {
      if (disposed) return;
      void getToolboxKeepAwakeState()
        .then((next) => { if (!disposed) setState(JSON.stringify(next, null, 2)); })
        .catch((reason) => { if (!disposed) setError(userFacingError(reason)); });
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
    if (!isDesktopRuntime()) { setError("限时保活需要桌面原生运行时；浏览器演示不会修改电源状态。"); return; }
    const durationMinutes = Number(duration);
    if (!Number.isInteger(durationMinutes) || durationMinutes < 1 || durationMinutes > 720) { setError("保活时长必须是 1 分钟到 12 小时。"); return; }
    setRunning(true); setError("");
    try { setState(JSON.stringify(await startToolboxKeepAwake({ requestId: crypto.randomUUID(), durationMinutes }), null, 2)); } catch (reason) { setError(userFacingError(reason)); } finally { setRunning(false); }
  };
  const stop = async () => { setRunning(true); try { setState(JSON.stringify(await cancelToolboxKeepAwake(), null, 2)); } catch (reason) { setError(userFacingError(reason)); } finally { setRunning(false); } };
  return <ToolLayout error={error} onClear={() => { setState(""); setError(""); }}><div className="toolbox-inline-actions"><label>时长 <select value={duration} onChange={(event) => setDuration(event.target.value)}><option value="30">30 分钟</option><option value="60">60 分钟</option><option value="120">120 分钟</option><option value="720">12 小时</option></select></label><button className="button button--primary" disabled={running} type="button" onClick={() => void start()}><Timer size={14} />开始保活</button><button className="button button--secondary" disabled={running} type="button" onClick={() => void stop()}>停止并释放</button></div><p className="toolbox-hint">只申请临时系统断言，不修改电源计划、不模拟输入；独立截止线程每 15 秒检查并在到期/取消时释放。当前实机证据范围为本机 macOS。</p><ResultBox value={state} /></ToolLayout>;
}

function RegexTool() {
  const [pattern, setPattern] = useState("(?<word>\\w+)"); const [flags, setFlags] = useState("gu"); const [sample, setSample] = useState("CoreRobin 工具箱"); const [replacement, setReplacement] = useState("[$<word>]"); const [analysis, setAnalysis] = useState<RegexAnalysis | null>(null); const [result, setResult] = useState(""); const [error, setError] = useState(""); const [running, setRunning] = useState(false);
  const run = async () => { setRunning(true); setError(""); try { const next = analyzeRegex(pattern, flags); setAnalysis(next); if (!next.supported) throw new ToolboxInputError("invalid_regex", next.syntaxError ?? "正则语法无效。 "); const value = await runRegexInWorker(pattern, flags, sample, replacement); setResult(JSON.stringify(value, null, 2)); } catch (reason) { setError(userFacingError(reason)); } finally { setRunning(false); } };
  return <ToolLayout error={error} onClear={() => { setAnalysis(null); setResult(""); }}><div className="toolbox-form-grid"><input className="toolbox-input toolbox-input--code" value={pattern} onChange={(event) => setPattern(event.target.value)} aria-label="正则表达式" /><input className="toolbox-input toolbox-input--code" value={flags} onChange={(event) => setFlags(event.target.value)} aria-label="正则 flags" /></div><textarea className="toolbox-input" value={sample} onChange={(event) => setSample(event.target.value)} placeholder="测试文本（最多 256 KiB）" /><input className="toolbox-input" value={replacement} onChange={(event) => setReplacement(event.target.value)} placeholder="文本替换模板，不执行 JavaScript" /><button className="button button--primary" disabled={running} type="button" onClick={() => void run()}><TerminalSquare size={14} />{running ? "正在隔离执行…" : "诊断并匹配"}</button>{analysis ? <div className="toolbox-regex-tree"><strong>结构树（语法关系，不是回溯轨迹）</strong><RegexTree node={analysis.ast} /><ul>{analysis.warnings.map((warning) => <li key={warning}>{warning}</li>)}</ul></div> : null}<ResultBox value={result} /></ToolLayout>;
}

function RegexTree({ node }: { node: RegexAnalysis["ast"] }) { return <details open className="toolbox-regex-node"><summary>{node.kind} · {node.label}</summary>{node.children.map((child) => <RegexTree key={child.id} node={child} />)}</details>; }

function ColorTool() {
  const [input, setInput] = useState("#f15a43"); const [output, setOutput] = useState<Record<string, string> | null>(null); const [error, setError] = useState("");
  return <ToolLayout error={error} onClear={() => { setInput(""); setOutput(null); }}><div className="toolbox-color-input"><input className="toolbox-input" value={input} onChange={(event) => setInput(event.target.value)} placeholder="#RRGGBB / rgb / hsl / hsv / oklch / color(display-p3 …)" /><span style={{ background: output ? output.hex : input }} /></div><button className="button button--primary" type="button" onClick={() => { try { const color = parseColor(input); setOutput(formatColor(color)); setError(""); } catch (reason) { setError(userFacingError(reason)); } }}><Wrench size={14} />转换颜色</button>{output ? <ResultBox value={Object.entries(output).map(([key, value]) => `${key}: ${value}`).join("\n")} /> : null}</ToolLayout>;
}

function ScheduleTool() {
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
      setError("定时规则需要桌面原生运行时；浏览器演示不会保存规则。");
      return;
    }
    setRunning(true);
    setError("");
    try {
      const numericHour = Number(hour);
      const numericMinute = Number(minute);
      const numericWeekday = Number(weekday);
      const durationMinutes = Number(duration);
      const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
      if (!timeZone) throw new ToolboxInputError("time_zone_unavailable", "系统未提供 IANA 时区，无法预览定时规则。");
      let trigger;
      if (kind === "once") {
        const atMs = new Date(onceAt).getTime();
        const preview = await previewToolboxSchedule({ timeZone, trigger: { kind: "once", atUtcMs: atMs } });
        if (preview.status !== "ready" || preview.occurrenceAtMs.length === 0) throw new ToolboxInputError("invalid_once_time", "请选择未来 365 天内的有效日期和时间。");
        trigger = { kind: "once" as const, atMs };
      } else if (kind === "daily") {
        const preview = await previewToolboxSchedule({ timeZone, trigger: { kind: "daily", hour: numericHour, minute: numericMinute } });
        if (preview.status !== "ready" || preview.occurrenceAtMs.length === 0) throw new ToolboxInputError("cron_no_occurrence", "该规则在搜索范围内没有下一次触发时间。");
        const nextRunAtMs = preview.occurrenceAtMs[0];
        trigger = { kind: "daily" as const, hour: numericHour, minute: numericMinute, nextRunAtMs };
      } else if (kind === "weekly") {
        const preview = await previewToolboxSchedule({ timeZone, trigger: { kind: "weekly", weekday: numericWeekday, hour: numericHour, minute: numericMinute } });
        if (preview.status !== "ready" || preview.occurrenceAtMs.length === 0) throw new ToolboxInputError("cron_no_occurrence", "该规则在搜索范围内没有下一次触发时间。");
        const nextRunAtMs = preview.occurrenceAtMs[0];
        trigger = { kind: "weekly" as const, weekday: numericWeekday, hour: numericHour, minute: numericMinute, nextRunAtMs };
      } else {
        const preview = await previewToolboxSchedule({ timeZone, trigger: { kind: "cron", expression: cron } });
        if (preview.status !== "ready" || preview.occurrenceAtMs.length === 0) throw new ToolboxInputError("cron_no_occurrence", "该 Cron 在搜索范围内没有下一次触发时间。");
        trigger = { kind: "cron" as const, expression: cron, nextRunAtMs: preview.occurrenceAtMs[0] };
      }
      if (actionKind === "keepAwake" && (!Number.isInteger(durationMinutes) || durationMinutes < 1 || durationMinutes > 720)) {
        throw new ToolboxInputError("invalid_duration", "保活时长必须是 1 分钟到 12 小时。");
      }
      const action = actionKind === "reminder" ? { kind: "reminder" as const } : { kind: "keepAwake" as const, durationMinutes };
      const request = { requestId: crypto.randomUUID(), timeZone, title: title || undefined, action, trigger };
      setSnapshot(editingScheduleId
        ? await updateToolboxSchedule({ ...request, scheduleId: editingScheduleId, expectedRevision: snapshot?.revision })
        : await createToolboxSchedule(request));
      setEditingScheduleId(null);
    } catch (reason) {
      setError(userFacingError(reason));
    } finally {
      setRunning(false);
    }
  };

  const pause = async (scheduleId: string) => {
    setRunning(true);
    setError("");
    try {
      setSnapshot(await pauseToolboxSchedule({ requestId: crypto.randomUUID(), scheduleId }));
    } catch (reason) {
      setError(userFacingError(reason));
    } finally {
      setRunning(false);
    }
  };

  const remove = async (scheduleId: string) => {
    setRunning(true);
    setError("");
    try {
      setSnapshot(await deleteToolboxSchedule({ requestId: crypto.randomUUID(), scheduleId }));
    } catch (reason) {
      setError(userFacingError(reason));
    } finally {
      setRunning(false);
    }
  };

  return <ToolLayout error={error} onClear={() => { setSnapshot(null); setEditingScheduleId(null); setError(""); }}>
    <div className="toolbox-form-grid">
      <label>规则 <select value={kind} onChange={(event) => setKind(event.target.value as typeof kind)}><option value="once">一次性</option><option value="daily">每天</option><option value="weekly">每周</option><option value="cron">Cron 草稿</option></select></label>
      <label>意图 <select value={actionKind} onChange={(event) => setActionKind(event.target.value as typeof actionKind)}><option value="reminder">提醒</option><option value="keepAwake">限时保活</option></select></label>
      <input className="toolbox-input" value={title} maxLength={80} onChange={(event) => setTitle(event.target.value)} placeholder="可选标题（最多 80 字符）" />
    </div>
    {kind === "once" ? <label>触发时间 <input className="toolbox-input" type="datetime-local" value={onceAt} onChange={(event) => setOnceAt(event.target.value)} /></label> : null}
    {kind === "cron" ? <input className="toolbox-input toolbox-input--code" value={cron} onChange={(event) => setCron(event.target.value)} placeholder="五段 Cron，例如 0 9 * * 1-5" /> : null}
    {kind === "daily" || kind === "weekly" ? <div className="toolbox-form-grid">
      <label>小时 <input className="toolbox-input" inputMode="numeric" value={hour} onChange={(event) => setHour(event.target.value)} /></label>
      <label>分钟 <input className="toolbox-input" inputMode="numeric" value={minute} onChange={(event) => setMinute(event.target.value)} /></label>
      {kind === "weekly" ? <label>星期 <select value={weekday} onChange={(event) => setWeekday(event.target.value)}><option value="0">周日</option><option value="1">周一</option><option value="2">周二</option><option value="3">周三</option><option value="4">周四</option><option value="5">周五</option><option value="6">周六</option></select></label> : null}
    </div> : null}
    {actionKind === "keepAwake" ? <label>保活分钟 <input className="toolbox-input" inputMode="numeric" value={duration} onChange={(event) => setDuration(event.target.value)} /></label> : null}
    <div className="toolbox-inline-actions"><button className="button button--primary" disabled={running} type="button" onClick={() => void create()}><Timer size={14} />{editingScheduleId ? "保存修改" : "创建规则"}</button>{editingScheduleId ? <button className="button button--secondary" disabled={running} type="button" onClick={() => setEditingScheduleId(null)}>取消编辑</button> : null}<button className="button button--secondary" disabled={running || !isDesktopRuntime()} type="button" onClick={() => void refresh()}>查看当前规则</button></div>
    <p className="toolbox-hint">创建前会使用原生 Cron 搜索器计算下一次时间；规则保存在 CoreRobin 私有数据中。到点只会发出提醒或请求 1 分钟至 12 小时的限时保活；错过的时间不会补发，绝不执行 shell、清理、结束进程或键盘操作。</p>
    {snapshot ? <><p className="toolbox-hint">{snapshot.restartNotice} {snapshot.executionNotice}</p>{snapshot.rules.map((rule) => <div className="toolbox-inline-actions" key={rule.scheduleId}><code>{rule.scheduleId}</code><span>{rule.title ?? "未命名"} · {rule.status} · 下次预览 {new Date("atMs" in rule.trigger ? rule.trigger.atMs : rule.trigger.nextRunAtMs).toLocaleString()}</span><button className="button button--secondary" disabled={running} type="button" onClick={() => beginEdit(rule)}>编辑</button><button className="button button--secondary" disabled={running || rule.status === "paused"} type="button" onClick={() => void pause(rule.scheduleId)}>暂停</button><button className="button button--secondary" disabled={running} type="button" onClick={() => void remove(rule.scheduleId)}>删除</button></div>)}</> : null}
  </ToolLayout>;
}

function ProcessWatchTool() {
  const [pid, setPid] = useState("");
  const [birthToken, setBirthToken] = useState("");
  const [duration, setDuration] = useState("240");
  const [keepAwake, setKeepAwake] = useState(false);
  const [watches, setWatches] = useState<ToolboxProcessWatchSnapshot[]>([]);
  const [error, setError] = useState("");
  const [running, setRunning] = useState(false);

  const refresh = async () => {
    if (!isDesktopRuntime()) {
      setError("进程退出提醒需要桌面原生运行时。");
      return;
    }
    try {
      setWatches(await getToolboxProcessWatches());
      setError("");
    } catch (reason) {
      setError(userFacingError(reason));
    }
  };

  useEffect(() => { void refresh(); }, []);

  const start = async () => {
    if (!isDesktopRuntime()) {
      setError("进程退出提醒需要桌面原生运行时。");
      return;
    }
    const numericPid = Number(pid);
    const durationMinutes = Number(duration);
    if (!Number.isInteger(numericPid) || numericPid <= 0 || !birthToken.trim()) {
      setError("请输入已选进程的 PID 与 birth token；不能用同名进程代替稳定身份。");
      return;
    }
    if (!Number.isInteger(durationMinutes) || durationMinutes < 1 || durationMinutes > 720) {
      setError("观察时长必须是 1 分钟到 12 小时。");
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
    <div className="toolbox-form-grid"><label>PID <input className="toolbox-input" inputMode="numeric" value={pid} onChange={(event) => setPid(event.target.value)} placeholder="已选进程 PID" /></label><label>birth token <input className="toolbox-input toolbox-input--code" value={birthToken} onChange={(event) => setBirthToken(event.target.value)} placeholder="从进程详情复制，拒绝同名替代" /></label><label>观察分钟 <input className="toolbox-input" inputMode="numeric" value={duration} onChange={(event) => setDuration(event.target.value)} /></label></div>
    <label className="toolbox-checkbox"><input type="checkbox" checked={keepAwake} onChange={(event) => setKeepAwake(event.target.checked)} />观察期间附加限时保活（低电量独立释放）</label>
    <div className="toolbox-inline-actions"><button className="button button--primary" disabled={running} type="button" onClick={() => void start()}><Timer size={14} />开始只读观察</button><button className="button button--secondary" disabled={running || !isDesktopRuntime()} type="button" onClick={() => void refresh()}>刷新状态</button></div>
    <p className="toolbox-hint">只观察用户已选择的 ProcessKey，不会请求终止权限；最多 3 个观察，默认 4 小时，上限 12 小时。unknown 会重试，PID 复用会终止为 identity_changed，不承诺子进程、退出码或工作成功。</p>
    {watches.map((watch) => <div className="toolbox-inline-actions" key={watch.watchId}><span>#{watch.watchId} PID {watch.key.pid} · {watch.status} · 截止 {new Date(watch.deadlineAtMs).toLocaleString()}</span><button className="button button--secondary" disabled={running || ["exited", "identity_changed", "expired", "cancelled"].includes(watch.status)} type="button" onClick={() => void cancel(watch.watchId)}>取消观察</button></div>)}
  </ToolLayout>;
}

function localDateTimeInput(value: Date): string {
  const local = new Date(value.getTime() - value.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 16);
}


function UnavailableTool({ tool }: { tool: ToolDefinition }) { const { t } = useTranslation("toolbox"); return <div className="toolbox-unavailable"><CircleAlert size={24} /><strong>{t("capability.unavailableTitle", { tool: tool.title })}</strong><p>{capabilityReason(t, tool.capability)}</p><p>{t("capability.unavailableHint")}</p></div>; }

function ToolLayout({ error, onClear, children }: { error?: string; onClear: () => void; children: ReactNode }) { const { t } = useTranslation("toolbox"); return <div className="toolbox-tool-layout"><div className="toolbox-tool-layout__body">{children}</div>{error ? <p className="toolbox-error" role="alert"><CircleAlert size={15} />{error}</p> : null}<div className="toolbox-tool-layout__footer"><button className="button button--secondary" type="button" onClick={onClear}>{t("toolLayout.clear")}</button><span>{t("toolLayout.privacy")}</span></div></div>; }

function ResultBox({ value }: { value: string }) { const { t } = useTranslation("toolbox"); if (!value) return null; return <div className="toolbox-result"><div className="toolbox-result__header"><strong>{t("toolLayout.result")}</strong><button className="icon-button" type="button" aria-label={t("toolLayout.copyResult")} onClick={() => void navigator.clipboard?.writeText(value)}><Copy size={14} /></button></div><pre>{value}</pre></div>; }

function ToolIcon({ id }: { id: ToolId }) { if (id.includes("image") || id.includes("watermark") || id === "c2pa-inspector" || id === "robustness-lab") return <FileImage size={18} />; if (id.includes("patch") || id === "integrity-manifest" || id === "transfer-savings") return <FileKey2 size={18} />; if (id.includes("sha")) return <Hash size={18} />; if (id === "qr-code") return <QrCode size={18} />; if (id.includes("network") || id.includes("occupancy")) return <Network size={18} />; if (id.includes("keep") || id.includes("schedule") || id === "time") return <Timer size={18} />; return <Wrench size={18} />; }

type ToolboxTFunction = TFunction<"toolbox">;
function capabilityLabel(t: ToolboxTFunction, capability: ToolboxCapability): string { return capability.state === "degraded" ? t("capability.degraded") : t("capability.unavailable"); }
function capabilityReason(t: ToolboxTFunction, capability: ToolboxCapability): string { return capability.reason ?? (capability.state === "degraded" ? t("capability.degradedReason") : t("capability.unavailableReason")); }
function wifiEscape(value: string): string { return value.replace(/([\\;,:])/g, "\\$1"); }
function readFavorites(): Set<ToolId> { try { const parsed: unknown = JSON.parse(localStorage.getItem(FAVORITES_KEY) ?? "[]"); return new Set(Array.isArray(parsed) ? parsed.filter((value): value is ToolId => typeof value === "string") : []); } catch { return new Set(); } }
