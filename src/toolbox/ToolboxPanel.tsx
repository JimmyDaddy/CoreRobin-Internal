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
import { useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import QRCode from "qrcode";

import { open } from "@tauri-apps/plugin-dialog";
import { cancelToolboxFileHash, cancelToolboxKeepAwake, hashToolboxFile, isDesktopRuntime, scanToolboxFileOccupancy, startToolboxKeepAwake } from "../api";
import { analyzeJson, assertTextLimit } from "./local/jsonTools";
import { analyzeUrl, convertIsoTime, convertUnixTime, decodeBase64, encodeBase64, generateUuidV4 } from "./local/encodingTools";
import { userFacingError, ToolboxInputError } from "./local/toolboxErrors";
import { analyzeRegex, runRegexInWorker, type RegexAnalysis } from "./regex/regexTools";
import { formatColor, parseColor } from "./color/colorTools";
import { parseIfconfig } from "./network/networkTools";
import { findNextCronOccurrence, parseCron, type CronSchedule } from "./schedules/scheduleTools";
import { ImageToolbox } from "./image/ImageToolbox";
import { BinaryPatchToolbox } from "./binary-patch/BinaryPatchToolbox";
import { getToolDefinition, searchTools } from "./registry";
import type { ToolDefinition, ToolId, ToolboxCategory } from "./contracts";
import "./toolbox.css";

const FAVORITES_KEY = "core-robin.toolbox.favorite-tool-ids.v1";
const CATEGORY_LABELS: Record<ToolboxCategory, string> = {
  "system-network": "系统与网络",
  "text-development": "文本与开发",
  image: "图片",
  "file-patch": "文件与补丁",
};
const CATEGORY_ICONS: Record<ToolboxCategory, typeof Wrench> = {
  "system-network": Network,
  "text-development": Code2,
  image: ImageIcon,
  "file-patch": FileKey2,
};

export function ToolboxPanel({ onClose }: { onClose?: () => void }) {
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<ToolId | null>(null);
  const [favorites, setFavorites] = useState<Set<ToolId>>(() => readFavorites());
  const tools = useMemo(() => searchTools(query), [query]);
  const selectedTool = selected ? getToolDefinition(selected) : null;

  const toggleFavorite = (id: ToolId) => {
    setFavorites((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id); else next.add(id);
      try { localStorage.setItem(FAVORITES_KEY, JSON.stringify([...next])); } catch { /* private preference is best effort */ }
      return next;
    });
  };

  return (
    <section className="toolbox-panel" aria-labelledby="toolbox-title">
      {selectedTool ? (
        <ToolPage tool={selectedTool} onBack={() => setSelected(null)}>
          <ToolContent toolId={selectedTool.id} />
        </ToolPage>
      ) : (
        <>
          <header className="toolbox-panel__header">
            <div>
              <span className="toolbox-eyebrow"><Sparkles size={14} />CoreRobin</span>
              <h1 id="toolbox-title">工具箱</h1>
              <p>在本机处理文本、图片、文件和系统小委托。普通输入只停留在当前页面。</p>
            </div>
            {onClose ? <button className="icon-button" type="button" aria-label="关闭工具箱" onClick={onClose}><X size={18} /></button> : null}
          </header>
          <label className="toolbox-search">
            <Search size={16} />
            <span className="sr-only">搜索功能名称</span>
            <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索功能名称、别名或说明…" />
            {query ? <button type="button" aria-label="清空搜索" onClick={() => setQuery("")}><X size={14} /></button> : null}
          </label>
          <div className="toolbox-category-tabs" role="tablist" aria-label="工具分类">
            {(Object.keys(CATEGORY_LABELS) as ToolboxCategory[]).map((category) => {
              const Icon = CATEGORY_ICONS[category];
              return <span key={category} className="toolbox-category-tab"><Icon size={14} />{CATEGORY_LABELS[category]}</span>;
            })}
          </div>
          {favorites.size > 0 && !query ? <ToolSection title="收藏" tools={tools.filter((tool) => favorites.has(tool.id))} favorites={favorites} onOpen={setSelected} onFavorite={toggleFavorite} /> : null}
          {(Object.keys(CATEGORY_LABELS) as ToolboxCategory[]).map((category) => (
            <ToolSection key={category} title={CATEGORY_LABELS[category]} tools={tools.filter((tool) => tool.category === category)} favorites={favorites} onOpen={setSelected} onFavorite={toggleFavorite} />
          ))}
          {tools.length === 0 ? <div className="toolbox-empty"><Wrench size={22} /><strong>没有匹配的工具</strong><span>搜索只查找工具名称、别名和说明，不会查看你的输入。</span></div> : null}
        </>
      )}
    </section>
  );
}

function ToolSection({ title, tools, favorites, onOpen, onFavorite }: { title: string; tools: ToolDefinition[]; favorites: Set<ToolId>; onOpen: (id: ToolId) => void; onFavorite: (id: ToolId) => void }) {
  if (tools.length === 0) return null;
  return (
    <section className="toolbox-section" aria-labelledby={`toolbox-section-${title}`}>
      <div className="toolbox-section__title"><h2 id={`toolbox-section-${title}`}>{title}</h2><span>{tools.length}</span></div>
      <div className="toolbox-grid">
        {tools.map((tool) => <button className="toolbox-card" type="button" key={tool.id} onClick={() => onOpen(tool.id)}>
          <span className="toolbox-card__icon"><ToolIcon id={tool.id} /></span>
          <span className="toolbox-card__content"><strong>{tool.title}</strong><small>{tool.description}</small></span>
          <span className="toolbox-card__actions">
            <span role="button" tabIndex={0} className={`toolbox-favorite${favorites.has(tool.id) ? " is-active" : ""}`} aria-label={favorites.has(tool.id) ? `取消收藏 ${tool.title}` : `收藏 ${tool.title}`} onClick={(event) => { event.stopPropagation(); onFavorite(tool.id); }} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); event.stopPropagation(); onFavorite(tool.id); } }}><Heart size={14} fill={favorites.has(tool.id) ? "currentColor" : "none"} /></span>
            <ChevronRight size={16} />
          </span>
        </button>)}
      </div>
    </section>
  );
}

function ToolPage({ tool, onBack, children }: { tool: ToolDefinition; onBack: () => void; children: ReactNode }) {
  return <div className="toolbox-tool-page"><header className="toolbox-tool-page__header"><button className="button button--secondary" type="button" onClick={onBack}><ArrowLeft size={15} />返回工具箱</button><div><span className="toolbox-eyebrow">{CATEGORY_LABELS[tool.category]}</span><h1>{tool.title}</h1><p>{tool.description}</p></div></header>{children}</div>;
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
    case "regex": return <RegexTool />;
    case "color": return <ColorTool />;
    case "ifconfig-parser": return <IfconfigTool />;
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
    default: return <UnavailableTool toolId={toolId} />;
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

function FileHashTool() {
  const [fileName, setFileName] = useState(""); const [path, setPath] = useState(""); const [progress, setProgress] = useState(0); const [output, setOutput] = useState(""); const [error, setError] = useState(""); const [running, setRunning] = useState(false);
  const choose = async () => { setError(""); if (isDesktopRuntime()) { const selected = await open({ multiple: false, directory: false }); if (typeof selected === "string") { setPath(selected); setFileName(selected.split(/[\\/]/).pop() ?? selected); } } else setError("文件 SHA-256 需要在桌面运行时通过原生选择器选择普通文件。"); };
  const run = async () => { if (!path) { setError("请先选择一个普通文件。"); return; } setRunning(true); setOutput(""); try { const result = await hashToolboxFile({ requestId: crypto.randomUUID(), path }, (event) => setProgress(event.totalBytes ? event.bytesRead / event.totalBytes : 0)); setOutput(result.digest); } catch (reason) { setError(userFacingError(reason)); } finally { setRunning(false); } };
  return <ToolLayout error={error} onClear={() => { setFileName(""); setPath(""); setOutput(""); setProgress(0); }}><div className="toolbox-file-pick"><button className="button button--secondary" type="button" onClick={() => void choose}><FileCheck2 size={15} />选择普通文件</button><span>{fileName || "未选择文件"}</span></div>{running ? <progress max="1" value={progress} /> : null}<div className="toolbox-inline-actions"><button className="button button--primary" disabled={running || !path} type="button" onClick={() => void run}><Play size={14} />{running ? "正在计算…" : "计算文件 SHA-256"}</button>{running ? <button className="button button--secondary" type="button" onClick={() => void cancelToolboxFileHash()}>停止</button> : null}</div><p className="toolbox-hint">原生服务使用 1 MiB 流式缓冲，并在开始/结束复验文件身份；文件内容不会进入 WebView。</p><ResultBox value={output} /></ToolLayout>;
}

function OccupancyTool() {
  const [fileName, setFileName] = useState(""); const [path, setPath] = useState(""); const [output, setOutput] = useState(""); const [error, setError] = useState(""); const [running, setRunning] = useState(false);
  const choose = async () => { setError(""); if (!isDesktopRuntime()) { setError("文件占用诊断需要桌面原生运行时。 "); return; } const selected = await open({ multiple: false, directory: false }); if (typeof selected === "string") { setPath(selected); setFileName(selected.split(/[\\/]/).pop() ?? selected); } };
  const run = async () => { if (!path) { setError("请先选择一个普通文件。"); return; } setRunning(true); setError(""); setOutput(""); try { const result = await scanToolboxFileOccupancy({ requestId: crypto.randomUUID(), path }); setOutput(JSON.stringify(result, null, 2)); } catch (reason) { setError(userFacingError(reason)); } finally { setRunning(false); } };
  return <ToolLayout error={error} onClear={() => { setFileName(""); setPath(""); setOutput(""); }}><div className="toolbox-file-pick"><button className="button button--secondary" type="button" onClick={() => void choose}><FileCheck2 size={15} />选择普通文件</button><span>{fileName || "未选择文件"}</span></div><button className="button button--primary" disabled={running || !path} type="button" onClick={() => void run}><Network size={14} />{running ? "正在诊断…" : "查找文件使用者"}</button><p className="toolbox-hint">仅诊断当前文件：macOS 使用固定参数 lsof，Linux 匹配可见 /proc 的 fd/cwd/root；结果带覆盖范围、截断和身份复验状态，不会关闭进程。</p><ResultBox value={output} /></ToolLayout>;
}

function KeepAwakeTool() {
  const [duration, setDuration] = useState("60"); const [state, setState] = useState(""); const [error, setError] = useState(""); const [running, setRunning] = useState(false);
  useEffect(() => () => { if (isDesktopRuntime()) void cancelToolboxKeepAwake().catch(() => undefined); }, []);
  const start = async () => {
    if (!isDesktopRuntime()) { setError("限时保活需要桌面原生运行时；浏览器演示不会修改电源状态。"); return; }
    const durationMinutes = Number(duration);
    if (!Number.isInteger(durationMinutes) || durationMinutes < 1 || durationMinutes > 720) { setError("保活时长必须是 1 分钟到 12 小时。"); return; }
    setRunning(true); setError("");
    try { setState(JSON.stringify(await startToolboxKeepAwake({ requestId: crypto.randomUUID(), durationMinutes }), null, 2)); } catch (reason) { setError(userFacingError(reason)); } finally { setRunning(false); }
  };
  const stop = async () => { setRunning(true); try { setState(JSON.stringify(await cancelToolboxKeepAwake(), null, 2)); } catch (reason) { setError(userFacingError(reason)); } finally { setRunning(false); } };
  return <ToolLayout error={error} onClear={() => { setState(""); setError(""); }}><div className="toolbox-inline-actions"><label>时长 <select value={duration} onChange={(event) => setDuration(event.target.value)}><option value="30">30 分钟</option><option value="60">60 分钟</option><option value="120">120 分钟</option><option value="720">12 小时</option></select></label><button className="button button--primary" disabled={running} type="button" onClick={() => void start}><Timer size={14} />开始保活</button><button className="button button--secondary" disabled={running} type="button" onClick={() => void stop}>停止并释放</button></div><p className="toolbox-hint">只申请临时系统断言，不修改电源计划、不模拟输入；独立截止线程每 15 秒检查并在到期/取消时释放。低电量和 Windows/Linux 后端必须在对应平台实机复核。</p><ResultBox value={state} /></ToolLayout>;
}

function RegexTool() {
  const [pattern, setPattern] = useState("(?<word>\\w+)"); const [flags, setFlags] = useState("gu"); const [sample, setSample] = useState("CoreRobin 工具箱"); const [replacement, setReplacement] = useState("[$<word>]"); const [analysis, setAnalysis] = useState<RegexAnalysis | null>(null); const [result, setResult] = useState(""); const [error, setError] = useState(""); const [running, setRunning] = useState(false);
  const run = async () => { setRunning(true); setError(""); try { const next = analyzeRegex(pattern, flags); setAnalysis(next); if (!next.supported) throw new ToolboxInputError("invalid_regex", next.syntaxError ?? "正则语法无效。 "); const value = await runRegexInWorker(pattern, flags, sample, replacement); setResult(JSON.stringify(value, null, 2)); } catch (reason) { setError(userFacingError(reason)); } finally { setRunning(false); } };
  return <ToolLayout error={error} onClear={() => { setAnalysis(null); setResult(""); }}><div className="toolbox-form-grid"><input className="toolbox-input toolbox-input--code" value={pattern} onChange={(event) => setPattern(event.target.value)} aria-label="正则表达式" /><input className="toolbox-input toolbox-input--code" value={flags} onChange={(event) => setFlags(event.target.value)} aria-label="正则 flags" /></div><textarea className="toolbox-input" value={sample} onChange={(event) => setSample(event.target.value)} placeholder="测试文本（最多 256 KiB）" /><input className="toolbox-input" value={replacement} onChange={(event) => setReplacement(event.target.value)} placeholder="文本替换模板，不执行 JavaScript" /><button className="button button--primary" disabled={running} type="button" onClick={() => void run}><TerminalSquare size={14} />{running ? "正在隔离执行…" : "诊断并匹配"}</button>{analysis ? <div className="toolbox-regex-tree"><strong>结构树（语法关系，不是回溯轨迹）</strong><RegexTree node={analysis.ast} /><ul>{analysis.warnings.map((warning) => <li key={warning}>{warning}</li>)}</ul></div> : null}<ResultBox value={result} /></ToolLayout>;
}

function RegexTree({ node }: { node: RegexAnalysis["ast"] }) { return <details open className="toolbox-regex-node"><summary>{node.kind} · {node.label}</summary>{node.children.map((child) => <RegexTree key={child.id} node={child} />)}</details>; }

function ColorTool() {
  const [input, setInput] = useState("#f15a43"); const [output, setOutput] = useState<Record<string, string> | null>(null); const [error, setError] = useState("");
  return <ToolLayout error={error} onClear={() => { setInput(""); setOutput(null); }}><div className="toolbox-color-input"><input className="toolbox-input" value={input} onChange={(event) => setInput(event.target.value)} placeholder="#RRGGBB / rgb / hsl / hsv / oklch / color(display-p3 …)" /><span style={{ background: output ? output.hex : input }} /></div><button className="button button--primary" type="button" onClick={() => { try { const color = parseColor(input); setOutput(formatColor(color)); setError(""); } catch (reason) { setError(userFacingError(reason)); } }}><Wrench size={14} />转换颜色</button>{output ? <ResultBox value={Object.entries(output).map(([key, value]) => `${key}: ${value}`).join("\n")} /> : null}</ToolLayout>;
}

function IfconfigTool() {
  const [input, setInput] = useState(""); const [output, setOutput] = useState(""); const [error, setError] = useState("");
  return <ToolLayout error={error} onClear={() => { setInput(""); setOutput(""); }}><textarea className="toolbox-input toolbox-input--code" value={input} onChange={(event) => setInput(event.target.value)} placeholder="粘贴 BSD/Linux ifconfig 文本；只解析，不执行" /><button className="button button--primary" type="button" onClick={() => { try { setOutput(JSON.stringify(parseIfconfig(input), null, 2)); setError(""); } catch (reason) { setError(userFacingError(reason)); } }}><Network size={14} />解析地址</button><ResultBox value={output} /></ToolLayout>;
}

function ScheduleTool() {
  const [input, setInput] = useState("*/15 9-17 * * 1-5"); const [output, setOutput] = useState(""); const [error, setError] = useState(""); const [schedule, setSchedule] = useState<CronSchedule | null>(null);
  return <ToolLayout error={error} onClear={() => { setOutput(""); setSchedule(null); }}><input className="toolbox-input toolbox-input--code" value={input} onChange={(event) => setInput(event.target.value)} placeholder="五段 Cron，例如 0 9 * * 1-5" /><button className="button button--primary" type="button" onClick={() => { try { const parsed = parseCron(input); setSchedule(parsed); const next = findNextCronOccurrence(parsed, new Date()); setOutput(next.at ? next.at.toString() : next.state); setError(""); } catch (reason) { setError(userFacingError(reason)); } }}><Timer size={14} />解释并查找下一次</button>{schedule ? <p className="toolbox-hint">只允许提醒和限时保活，不执行 shell、清理、kill 或键盘锁。</p> : null}<ResultBox value={output} /></ToolLayout>;
}


function UnavailableTool({ toolId }: { toolId: ToolId }) { return <div className="toolbox-unavailable"><CircleAlert size={24} /><strong>{getToolDefinition(toolId).title}尚未完成原生/执行器接线</strong><p>此入口已纳入工具箱契约；在对应 provider、停止确认和真实平台验收完成前，不显示“成功”结果。</p></div>; }

function ToolLayout({ error, onClear, children }: { error?: string; onClear: () => void; children: ReactNode }) { return <div className="toolbox-tool-layout"><div className="toolbox-tool-layout__body">{children}</div>{error ? <p className="toolbox-error" role="alert"><CircleAlert size={15} />{error}</p> : null}<div className="toolbox-tool-layout__footer"><button className="button button--secondary" type="button" onClick={onClear}>清空</button><span>输入与结果只保留在当前工具页内存；复制和保存都需要明确点击。</span></div></div>; }

function ResultBox({ value }: { value: string }) { if (!value) return null; return <div className="toolbox-result"><div className="toolbox-result__header"><strong>结果</strong><button className="icon-button" type="button" aria-label="复制结果" onClick={() => void navigator.clipboard?.writeText(value)}><Copy size={14} /></button></div><pre>{value}</pre></div>; }

function ToolIcon({ id }: { id: ToolId }) { if (id.includes("image") || id.includes("watermark") || id === "c2pa-inspector" || id === "robustness-lab") return <FileImage size={18} />; if (id.includes("patch") || id === "integrity-manifest" || id === "transfer-savings") return <FileKey2 size={18} />; if (id.includes("sha")) return <Hash size={18} />; if (id === "qr-code") return <QrCode size={18} />; if (id.includes("network") || id.includes("occupancy")) return <Network size={18} />; if (id.includes("keep") || id.includes("schedule") || id === "time") return <Timer size={18} />; return <Wrench size={18} />; }

function wifiEscape(value: string): string { return value.replace(/([\\;,:])/g, "\\$1"); }
function readFavorites(): Set<ToolId> { try { const parsed: unknown = JSON.parse(localStorage.getItem(FAVORITES_KEY) ?? "[]"); return new Set(Array.isArray(parsed) ? parsed.filter((value): value is ToolId => typeof value === "string") : []); } catch { return new Set(); } }
