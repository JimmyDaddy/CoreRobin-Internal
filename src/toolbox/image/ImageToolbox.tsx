import { Download, FileImage, Play, RotateCcw, ShieldCheck, Square, Upload } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  ImageFormat,
  Position,
  createWebMarker,
  type MarkerResult,
} from "@image-marker/web";
import {
  BATCH_MAX_FILES,
  BATCH_MAX_INPUT_BYTES,
  dataUrlToBytes,
  IMAGE_MAX_OUTPUT_EDGE,
  assertBatchBudget,
  createTextRecipe,
  inspectImageBudget,
  inspectLocalManifest,
  parseRecipeDocument,
  resultLabel,
} from "./imageTools";
import type { ToolId } from "../contracts";
import "./image.css";

type ImageToolId = Extract<ToolId, "image-watermark" | "image-batch-watermark" | "confidential-watermark" | "image-recipe" | "image-editor" | "invisible-watermark-write" | "invisible-watermark-check" | "recipient-tracking" | "robustness-lab" | "c2pa-inspector">;

export function ImageToolbox({ toolId }: { toolId: ImageToolId }) {
  const marker = useMemo(() => createWebMarker(), []);
  const [files, setFiles] = useState<File[]>([]);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState(0);
  const [result, setResult] = useState<MarkerResult | null>(null);
  const [zipUrl, setZipUrl] = useState("");
  const cancelRef = useRef<AbortController | null>(null);

  useEffect(() => () => {
    cancelRef.current?.abort();
    void marker.cancel().catch(() => undefined);
    void marker.dispose();
  }, [marker]);

  useEffect(() => () => {
    if (zipUrl) URL.revokeObjectURL(zipUrl);
  }, [zipUrl]);

  const selectFiles = async (selected: File[]) => {
    try {
      assertBatchBudget(selected);
      const inspected = [];
      for (const file of selected) inspected.push(await inspectImageBudget(marker, file));
      setFiles(inspected.map((item) => item.file));
      setError("");
      setNotice(`${inspected.length} 张图片已通过输入预算检查。`);
    } catch (reason) {
      setFiles([]);
      setError(reason instanceof Error ? reason.message : "图片输入不可用。");
    }
  };

  const run = async (task: (signal: AbortSignal) => Promise<void>) => {
    if (running) return;
    const controller = new AbortController();
    cancelRef.current = controller;
    setRunning(true);
    setProgress(0);
    setError("");
    setNotice("");
    try {
      await task(controller.signal);
    } catch (reason) {
      setError(controller.signal.aborted ? "已请求停止；等待图片执行器确认释放资源。" : reason instanceof Error ? reason.message : "图片处理失败。");
    } finally {
      cancelRef.current = null;
      setRunning(false);
    }
  };

  const stop = async () => {
    cancelRef.current?.abort();
    await marker.cancel().catch(() => undefined);
  };

  const runVisible = () => void run(async (signal) => {
    if (files.length === 0) throw new Error("请先选择图片。");
    const batch = toolId === "image-batch-watermark";
    const inputs = batch ? files : files.slice(0, 1);
    const bytes: Array<{ name: string; bytes: ArrayBuffer }> = [];
    let last: MarkerResult | null = null;
    for (const [index, file] of inputs.entries()) {
      if (signal.aborted) throw new Error("图片处理已停止。");
      last = await marker.markText({
        backgroundImage: { src: file },
        watermarkTexts: [{
          text: watermarkText(toolId),
          position: { position: Position.bottomRight, X: 24, Y: 24 },
          alpha: toolId === "confidential-watermark" ? 0.72 : 0.84,
          style: { color: watermarkColor(toolId), fontSize: 28, shadowStyle: { dx: 1, dy: 1, radius: 2, color: "#00000088" } },
        }],
        saveFormat: ImageFormat.png,
        maxSize: IMAGE_MAX_OUTPUT_EDGE,
        filename: safeOutputName(file.name),
      }, { signal });
      if (batch) bytes.push({ name: `${String(index + 1).padStart(2, "0")}-${safeOutputName(file.name)}.png`, bytes: dataUrlToBytes(last.uri).slice().buffer as ArrayBuffer });
      setProgress((index + 1) / inputs.length);
    }
    setResult(last);
    if (batch) {
      const url = await zipResults(bytes, signal);
      setZipUrl((old) => { if (old) URL.revokeObjectURL(old); return url; });
      setNotice(`批量处理完成：${bytes.length} 张图片按选择顺序写入 ZIP。`);
    } else {
      setNotice(last ? resultLabel(last) : "处理完成。");
    }
  });

  const runInvisibleWrite = () => void run(async (signal) => {
    const file = requireFirstFile(files);
    const payload = promptValue("短 locator（最多 12 UTF-8 字节）", "cr-demo-01");
    const key = promptValue("临时密钥（至少 16 UTF-8 字节；不会保存）", "local-demo-key-2026");
    if (!payload || !key) return;
    const output = await marker.embedInvisible({ image: { src: file }, payload, key, strength: "balanced", saveFormat: ImageFormat.png, maxSize: IMAGE_MAX_OUTPUT_EDGE }, { signal });
    setResult(output);
    setNotice("隐形 locator 已写入当前结果；它不是加密、DRM 或归属证明，密钥不会写入记录。");
  });

  const runInvisibleCheck = () => void run(async (signal) => {
    const file = requireFirstFile(files);
    const key = promptValue("检测密钥（与写入时相同）", "local-demo-key-2026");
    if (!key) return;
    const detected = await marker.detectInvisible({ image: { src: file }, key, strength: "balanced", search: "robust", maxSize: IMAGE_MAX_OUTPUT_EDGE }, { signal });
    setNotice(detected.detected ? `检测到 locator：${detected.payload ?? "(空)"}，置信度 ${detected.confidence.toFixed(2)}；正结果不代表图片未被修改。` : "未检测到经过认证的 locator；没有把失败显示为成功。");
  });

  const runRecipe = () => void run(async (signal) => {
    const file = requireFirstFile(files);
    const recipe = parseRecipeDocument(recipeTextFor(toolId));
    const output = await marker.createRecipe({ layers: recipe.layers, output: recipe.output }).apply({ backgroundImage: { src: file } }, { signal });
    setResult(output);
    setNotice("Recipe 已校验、应用并生成结果；可复制 JSON 作为本地配方，不会自动上传。");
  });

  const runRobustness = () => void run(async (signal) => {
    const file = requireFirstFile(files);
    const output = await marker.markText({ backgroundImage: { src: file }, watermarkTexts: [{ text: "ROBUSTNESS-LAB", layout: { type: "tile", gapX: 80, gapY: 80 }, style: { color: "#ffffff", fontSize: 22, rotate: -25 }, alpha: 0.45 }], saveFormat: ImageFormat.jpg, quality: 75, maxSize: IMAGE_MAX_OUTPUT_EDGE }, { signal });
    setResult(output);
    setNotice("实验输出为约定 JPEG 质量 75；请手动用 95% 缩放/有限裁剪样本复核，不外推任意变换抗性。");
  });

  const runManifest = () => {
    const raw = promptValue("粘贴本地 C2PA manifest JSON（不联网）", '{"manifests":{}}');
    if (!raw) return;
    try { setNotice(JSON.stringify(inspectLocalManifest(raw), null, 2)); setError(""); } catch (reason) { setError(reason instanceof Error ? reason.message : "Manifest 解析失败。"); }
  };

  const runRecipient = () => void run(async (signal) => {
    const file = requireFirstFile(files);
    const recipients = promptValue("收件人 locator 列表（逗号分隔，最多 30 个短 ID）", "recipient-a,recipient-b");
    const values = (recipients ?? "").split(",").map((value) => value.trim()).filter(Boolean);
    if (values.length === 0 || values.length > 30) throw new Error("收件人最多 30 个，且必须使用短 locator；不要直接写入个人资料。");
    const key = "recipient-session-key-2026";
    for (const [index, value] of values.entries()) {
      if (signal.aborted) throw new Error("收件人分发已停止。");
      await marker.embedInvisible({ image: { src: file }, payload: value, key, strength: "balanced", saveFormat: ImageFormat.png, maxSize: IMAGE_MAX_OUTPUT_EDGE }, { signal });
      setProgress((index + 1) / values.length);
    }
    setNotice(`已在内存中处理 ${values.length} 个分发 locator；图片与映射应分离保存，映射不会由 CoreRobin 持久化。`);
  });

  const action = toolId === "invisible-watermark-write" ? runInvisibleWrite
    : toolId === "invisible-watermark-check" ? runInvisibleCheck
      : toolId === "image-recipe" || toolId === "image-editor" ? runRecipe
        : toolId === "recipient-tracking" ? runRecipient
          : toolId === "robustness-lab" ? runRobustness
            : toolId === "c2pa-inspector" ? runManifest
              : runVisible;

  return <div className="toolbox-tool-layout image-toolbox">
    <div className="toolbox-tool-layout__body">
      <div className="image-toolbox__boundary"><ShieldCheck size={18} /><span>本地文件、显式操作、预算受限；不会自动打开 URL。取消会调用 SDK 实例的 cancel 并等待当前任务收束。</span></div>
      {toolId !== "c2pa-inspector" ? <label className="toolbox-file-pick button button--secondary"><Upload size={15} />选择 PNG / JPEG / WebP<input hidden type="file" accept="image/png,image/jpeg,image/webp" multiple={toolId === "image-batch-watermark"} onChange={(event) => void selectFiles(Array.from(event.target.files ?? []))} /></label> : null}
      {files.length > 0 ? <p className="toolbox-hint"><FileImage size={14} />已选 {files.length} 张 · 输入上限 {BATCH_MAX_FILES} 张 / {Math.round(BATCH_MAX_INPUT_BYTES / 1024 / 1024)} MiB · 常规输出最长边 {IMAGE_MAX_OUTPUT_EDGE}px</p> : null}
      {toolId === "image-editor" ? <p className="toolbox-hint">编辑入口使用版本化 Recipe 图层：当前可编辑文字水印、位置、透明度并重新导出；锁定/分组等高级操作由 Recipe JSON 校验器拒绝未知字段。</p> : null}
      {toolId === "c2pa-inspector" ? <button className="button button--secondary" type="button" onClick={runManifest}>粘贴并检查本地 manifest</button> : <div className="toolbox-inline-actions"><button className="button button--primary" type="button" disabled={running || files.length === 0} onClick={action}><Play size={14} />{running ? "正在处理…" : actionLabel(toolId)}</button>{running ? <button className="button button--secondary" type="button" onClick={() => void stop()}><Square size={14} />停止</button> : null}<button className="button button--secondary" type="button" onClick={() => { setFiles([]); setResult(null); setNotice(""); setError(""); }}><RotateCcw size={14} />清空</button></div>}
      {running ? <progress max="1" value={progress} /> : null}
      {error ? <p className="toolbox-error" role="alert">{error}</p> : null}
      {notice ? <pre className="toolbox-notice">{notice}</pre> : null}
      {result ? <div className="image-toolbox__result"><img src={result.uri} alt="本地水印结果预览" /><div className="toolbox-inline-actions"><a className="button button--secondary" download={result.filename ?? "corerobin-watermarked.png"} href={result.uri}><Download size={14} />保存结果</a><span className="toolbox-hint">{resultLabel(result)}</span></div></div> : null}
      {zipUrl ? <a className="button button--primary" download="corerobin-watermarks.zip" href={zipUrl}><Download size={14} />下载批量 ZIP</a> : null}
    </div>
    <div className="toolbox-tool-layout__footer"><span>图片输入仅在当前页面内存处理；输出会去除源 EXIF/GPS 等元数据，不承诺保留 ICC 或旧 C2PA 签名。</span></div>
  </div>;
}

function actionLabel(toolId: ImageToolId): string {
  if (toolId === "invisible-watermark-write") return "写入隐形 locator";
  if (toolId === "invisible-watermark-check") return "检测隐形 locator";
  if (toolId === "recipient-tracking") return "生成分发样本";
  if (toolId === "robustness-lab") return "生成实验样本";
  if (toolId === "image-recipe" || toolId === "image-editor") return "校验并应用 Recipe";
  return toolId === "image-batch-watermark" ? "批量处理并打包" : "添加文字水印";
}

function watermarkText(toolId: ImageToolId): string {
  return toolId === "confidential-watermark" ? "CONFIDENTIAL · INTERNAL" : "© CoreRobin";
}

function watermarkColor(toolId: ImageToolId): string { return toolId === "confidential-watermark" ? "#ffcf66" : "#ffffff"; }
function safeOutputName(name: string): string { return name.replace(/[^a-zA-Z0-9._-]+/g, "_").slice(0, 80) || "image"; }
function requireFirstFile(files: File[]): File { const file = files[0]; if (!file) throw new Error("请先选择图片。"); return file; }
function promptValue(label: string, initial: string): string | null { const value = window.prompt(label, initial); return value?.trim() || null; }
function recipeTextFor(toolId: ImageToolId): string { return JSON.stringify(createTextRecipe(toolId === "image-editor" ? "可编辑水印" : "© CoreRobin", "#ffffff", 0.84)); }

async function zipResults(items: Array<{ name: string; bytes: ArrayBuffer }>, signal: AbortSignal): Promise<string> {
  if (signal.aborted) throw new Error("ZIP 生成已停止。");
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL("./zip.worker.ts", import.meta.url), { type: "module" });
    const finish = () => worker.terminate();
    signal.addEventListener("abort", () => { finish(); reject(new Error("ZIP 生成已停止。")); }, { once: true });
    worker.onmessage = (event: MessageEvent<{ ok: boolean; bytes?: ArrayBuffer; error?: string }>) => {
      finish();
      if (!event.data.ok || !event.data.bytes) reject(new Error(event.data.error ?? "ZIP 生成失败。"));
      else resolve(URL.createObjectURL(new Blob([event.data.bytes], { type: "application/zip" })));
    };
    worker.onerror = () => { finish(); reject(new Error("ZIP Worker 无法启动。")); };
    worker.postMessage({ items }, items.map((item) => item.bytes));
  });
}
