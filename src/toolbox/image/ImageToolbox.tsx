import { Download, FileImage, Play, RotateCcw, ShieldCheck, Square, Upload } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  ImageFormat,
  Position,
  type MarkerResult,
} from "@image-marker/web";
import {
  BATCH_MAX_FILES,
  BATCH_MAX_INPUT_BYTES,
  appendBatchInput,
  appendBatchZipOutput,
  createBatchZipBudget,
  createImageAbortError,
  createRecipientZipBudget,
  dataUrlToBytes,
  IMAGE_MAX_OUTPUT_EDGE,
  assertBatchBudget,
  inspectImageBudget,
  inspectLocalFontBytes,
  inspectLocalManifest,
  isAbortError,
  LOCAL_MANIFEST_MAX_BYTES,
  parseRecipientLocators,
  requireOneTimeRecipientKey,
  resultLabel,
} from "./imageTools";
import { createImageToolRuntime, IMAGE_FONT_MAX_BYTES, IMAGE_OPERATION_DEADLINE_MS, withLocalImageFonts, type LocalImageFontResource } from "./imageExecution";
import { createBrowserImageInputs, createNativeImageInputs, type ImageRunInputs } from "./imageInputs";
import { ImageRecipeEditor } from "./ImageRecipeEditor";
import type { LocalImageEditor } from "./imageEditor";
import { markerResultOutput, type ImageOutputDelivery, type ImageOutputPayload } from "./imageOutput";
import type { ToolboxError, ToolboxJob, ToolId } from "../contracts";
import { cancelToolboxJob, cancelToolboxOutput, exportToolboxOutput, finishToolboxJob, newToolboxRequest, prepareToolboxInputs, registerToolboxOutput, releaseToolboxInputs, revalidateToolboxInputs, startToolboxSession } from "../client";
import { isDesktopRuntime } from "../../api";
import { fileJobKey, readBoundToolboxInput } from "../runtime/files";
import type { ToolboxFileJobKey, ToolboxInputToken } from "../contracts";
import "./image.css";

type ImageToolId = Extract<ToolId, "image-watermark" | "image-batch-watermark" | "confidential-watermark" | "image-recipe" | "image-editor" | "invisible-watermark-write" | "invisible-watermark-check" | "recipient-tracking" | "robustness-lab" | "c2pa-inspector">;

interface RecipientDeliveryState {
  status: "preparing" | "ready" | "failed" | "cancelled";
  requested: number;
  delivered: number;
  detail: string;
}

interface ImageRunResources {
  logo?: File;
  font?: LocalImageFontResource;
}

interface ImageRunOptions {
  deadlineMs?: number;
  requestNativeLogo?: boolean;
}

export function ImageToolbox({ toolId, deliverOutput: externalDeliverOutput }: { toolId: ImageToolId; deliverOutput?: ImageOutputDelivery }) {
  const runtime = useMemo(() => createImageToolRuntime(), []);
  const marker = runtime.marker;
  const [files, setFiles] = useState<File[]>([]);
  const [manifestFile, setManifestFile] = useState<File | null>(null);
  const [manifestReport, setManifestReport] = useState("");
  const [manifestDownloadUrl, setManifestDownloadUrl] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [running, setRunning] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [progress, setProgress] = useState(0);
  const [result, setResult] = useState<MarkerResult | null>(null);
  const [zipUrl, setZipUrl] = useState("");
  const [recipientDelivery, setRecipientDelivery] = useState<RecipientDeliveryState | null>(null);
  const [nativeOutput, setNativeOutput] = useState<ToolboxJob | null>(null);
  const nativeOutputRef = useRef<ToolboxJob | null>(null);
  const [nativeOutputName, setNativeOutputName] = useState("");
  const [logoFile, setLogoFile] = useState<File | null>(null);
  const [fontFile, setFontFile] = useState<File | null>(null);
  const [requestNativeLogo, setRequestNativeLogo] = useState(false);
  const [requestNativeFont, setRequestNativeFont] = useState(false);
  const [watermarkValue, setWatermarkValue] = useState(() => watermarkText(toolId));
  const [watermarkFont, setWatermarkFont] = useState("");
  const [watermarkDirection, setWatermarkDirection] = useState<"auto" | "ltr" | "rtl">("auto");
  const [watermarkAlpha, setWatermarkAlpha] = useState(toolId === "confidential-watermark" ? 0.72 : 0.84);
  const [logoScale, setLogoScale] = useState(0.2);
  const [logoRotation, setLogoRotation] = useState(0);
  const [logoAlpha, setLogoAlpha] = useState(1);
  const [outputFormat, setOutputFormat] = useState<ImageFormat>(ImageFormat.png);
  const cancelRef = useRef<AbortController | null>(null);
  const zipUrlRef = useRef("");
  const manifestDownloadUrlRef = useRef("");
  const hostExecutorAvailable = runtime.execution.supported
    && marker.capabilities.execution.mode === "host-adapter"
    && marker.capabilities.execution.supportsTerminationAcknowledgement;
  const desktopRuntime = isDesktopRuntime();

  const setPreparedOutput = (job: ToolboxJob | null, filename = "") => {
    nativeOutputRef.current = job;
    setNativeOutput(job);
    setNativeOutputName(filename);
  };

  const releaseOutputs = () => {
    setResult(null);
    if (zipUrlRef.current) URL.revokeObjectURL(zipUrlRef.current);
    zipUrlRef.current = "";
    setZipUrl("");
  };

  const publishZip = (blob: Blob) => {
    if (zipUrlRef.current) URL.revokeObjectURL(zipUrlRef.current);
    zipUrlRef.current = URL.createObjectURL(blob);
    setZipUrl(zipUrlRef.current);
  };

  const publishManifestReport = (report: string) => {
    if (manifestDownloadUrlRef.current) URL.revokeObjectURL(manifestDownloadUrlRef.current);
    const url = URL.createObjectURL(new Blob([new TextEncoder().encode(report)], { type: "application/json" }));
    manifestDownloadUrlRef.current = url;
    setManifestDownloadUrl(url);
  };

  useEffect(() => () => {
    cancelRef.current?.abort();
    if (zipUrlRef.current) URL.revokeObjectURL(zipUrlRef.current);
    zipUrlRef.current = "";
    if (manifestDownloadUrlRef.current) URL.revokeObjectURL(manifestDownloadUrlRef.current);
    manifestDownloadUrlRef.current = "";
    void runtime.dispose();
  }, [runtime]);
  useEffect(() => () => {
    const job = nativeOutputRef.current;
    const output = job?.outputToken;
    if (job && output) {
      void cancelToolboxOutput({
        requestId: crypto.randomUUID(),
        jobId: job.jobId,
        outputToken: output.token,
        generation: job.generation,
        resetEpoch: job.resetEpoch,
      });
    }
  }, []);

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

  const selectLogo = async (selected: File | undefined) => {
    if (!selected) return;
    try {
      await inspectImageBudget(marker, selected);
      setLogoFile(selected);
      setError("");
      setNotice(`本地 Logo“${safeOutputName(selected.name)}”已通过输入预算检查；不会上传或保存路径。`);
    } catch (reason) {
      setLogoFile(null);
      setError(reason instanceof Error ? reason.message : "本地 Logo 不可用。");
    }
  };

  const selectFont = async (selected: File | undefined) => {
    if (!selected) return;
    try {
      if (selected.size === 0 || selected.size > IMAGE_FONT_MAX_BYTES) throw new Error("本地字体不能超过 4 MiB。");
      const bytes = new Uint8Array(await selected.arrayBuffer());
      const mimeType = inspectLocalFontBytes(selected.name, bytes);
      setFontFile(new File([bytes], selected.name, { type: mimeType, lastModified: selected.lastModified }));
      setWatermarkFont((current) => current.trim() || fontFamilyFromFile(selected.name));
      setError("");
      setNotice(`本地字体“${safeOutputName(selected.name)}”将仅加载到本次隔离图片 Worker。`);
    } catch (reason) {
      setFontFile(null);
      setError(reason instanceof Error ? reason.message : "本地字体不可用。");
    }
  };

  const selectManifest = (selected: File | undefined) => {
    if (!selected) return;
    if (selected.size > LOCAL_MANIFEST_MAX_BYTES) {
      setManifestFile(null);
      setError("Manifest 材料不能超过 4 MiB。");
      return;
    }
    setManifestFile(selected);
    setManifestReport("");
    setError("");
    setNotice(`本地 manifest 材料“${safeOutputName(selected.name)}”已选择；不会联网或保存路径。`);
  };

  const run = async (task: (signal: AbortSignal, inputs: ImageRunInputs, resources: ImageRunResources) => Promise<ImageOutputPayload | null>, options: ImageRunOptions = {}) => {
    if (running || nativeOutputRef.current) return;
    const controller = new AbortController();
    cancelRef.current = controller;
    releaseOutputs();
    setRecipientDelivery(null);
    setRunning(true);
    setProgress(0);
    setError("");
    setNotice("");
    let nativeJob: ToolboxJob | null = null;
    let nativeInputJob: ToolboxFileJobKey | null = null;
    let nativeInputTokens: ToolboxInputToken[] = [];
    const releaseNativeInputs = async () => {
      if (!nativeInputJob || nativeInputTokens.length === 0) return;
      const tokens = nativeInputTokens;
      await releaseToolboxInputs(nativeInputJob, tokens.map((token) => token.token));
      nativeInputTokens = [];
    };
    const deadline = window.setTimeout(() => controller.abort(), options.deadlineMs ?? IMAGE_OPERATION_DEADLINE_MS);
    try {
      let inputs: ImageRunInputs;
      let resources: ImageRunResources = {};
      if (isDesktopRuntime()) {
        nativeJob = await startToolboxSession({ ...newToolboxRequest(), toolId });
        nativeInputJob = fileJobKey(nativeJob);
        nativeInputTokens = await prepareToolboxInputs(nativeInputJob, "input");
        if (nativeInputTokens.length === 0) throw new Error("没有选择图片输入。" );
        inputs = createNativeImageInputs(marker, nativeInputJob, nativeInputTokens, controller.signal);
        if (options.requestNativeLogo) {
          const logoTokens = await prepareToolboxInputs(nativeInputJob, "logo");
          if (logoTokens.length !== 1) throw new Error("需要选择一个本地 Logo。" );
          nativeInputTokens = [...nativeInputTokens, ...logoTokens];
          const nativeLogo = createNativeImageInputs(marker, nativeInputJob, logoTokens, controller.signal);
          const logo = await nativeLogo.read(0);
          await inspectImageBudget(marker, logo);
          resources = { logo };
        }
        if (requestNativeFont && (toolId === "image-watermark" || toolId === "image-batch-watermark" || toolId === "confidential-watermark")) {
          const fontTokens = await prepareToolboxInputs(nativeInputJob, "font");
          const fontToken = fontTokens[0];
          if (!fontToken) throw new Error("需要选择一个本地字体文件。");
          const fontBytes = await readBoundToolboxInput(nativeInputJob, fontToken, controller.signal, IMAGE_FONT_MAX_BYTES);
          const fontBuffer = fontBytes.buffer.slice(fontBytes.byteOffset, fontBytes.byteOffset + fontBytes.byteLength) as ArrayBuffer;
          const fontMimeType = inspectLocalFontBytes(fontToken.displayName, fontBytes);
          const source = new File([fontBuffer], fontToken.displayName, { type: fontMimeType });
          resources = { ...resources, font: { family: watermarkFont.trim() || fontFamilyFromFile(fontToken.displayName), source } };
          nativeInputTokens = [...nativeInputTokens, ...fontTokens];
        }
      } else {
        if (files.length === 0) throw new Error("请先选择图片。" );
        inputs = createBrowserImageInputs(marker, files, controller.signal);
        resources = {
          ...(logoFile ? { logo: logoFile } : {}),
          ...(fontFile ? { font: { family: watermarkFont.trim() || fontFamilyFromFile(fontFile.name), source: fontFile } } : {}),
        };
      }
      const formalOutput = await task(controller.signal, inputs, resources);
      if (nativeInputJob) await revalidateToolboxInputs(nativeInputJob);
      await releaseNativeInputs();
      if (nativeJob && formalOutput) {
        const ready = await registerToolboxOutput({
          ...newToolboxRequest(),
          jobId: nativeJob.jobId,
          generation: nativeJob.generation,
          resetEpoch: nativeJob.resetEpoch,
          bytes: new Uint8Array(await formalOutput.blob.arrayBuffer()),
          validation: "verified",
        });
        setPreparedOutput(ready, formalOutput.filename);
        setNotice("原生输出已准备完成；请在 10 分钟内选择正式另存，失败可重试，取消会释放临时结果。");
      } else if (nativeJob) {
        await finishToolboxJob({ ...newToolboxRequest(), jobId: nativeJob.jobId, succeeded: true });
      }
    } catch (reason) {
      if (nativeJob) {
        try {
          if (controller.signal.aborted || isAbortError(reason)) {
            await cancelToolboxJob({ ...newToolboxRequest(), jobId: nativeJob.jobId });
          } else {
            await finishToolboxJob({ ...newToolboxRequest(), jobId: nativeJob.jobId, succeeded: false, error: toToolboxError(reason) });
          }
        } catch (lifecycleReason) {
          setError(`原生任务生命周期未确认：${lifecycleReason instanceof Error ? lifecycleReason.message : "无法更新任务状态"}`);
        }
      }
      if (controller.signal.aborted || isAbortError(reason)) {
        releaseOutputs();
        setNotice(`图片处理已取消（${isAbortError(reason) ? "AbortError" : "abort signal"}）；已释放当前输出。`);
      } else {
        setError(reason instanceof Error ? reason.message : "图片处理失败。");
      }
    } finally {
      window.clearTimeout(deadline);
      if (nativeInputTokens.length > 0) {
        try {
          await releaseNativeInputs();
        } catch (releaseReason) {
          setError(`图片输入资源释放未确认：${releaseReason instanceof Error ? releaseReason.message : "无法释放输入 token"}`);
        }
      }
      cancelRef.current = null;
      setStopping(false);
      setRunning(false);
    }
  };

  const saveNativeOutput = async () => {
    const job = nativeOutputRef.current;
    const output = job?.outputToken;
    if (!job || !output) return;
    try {
      const { save } = await import("@tauri-apps/plugin-dialog");
      const selected = await save({ defaultPath: nativeOutputName || "corerobin-output" });
      if (!selected) return;
      await exportToolboxOutput({
        requestId: crypto.randomUUID(),
        jobId: job.jobId,
        outputToken: output.token,
        generation: job.generation,
        resetEpoch: job.resetEpoch,
        path: selected,
      });
      setPreparedOutput(null);
      setNotice("输出已完成原子另存；源文件未被覆盖。");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "正式输出另存失败；可在 TTL 内重试。");
    }
  };

  const cancelNativeOutput = async () => {
    const job = nativeOutputRef.current;
    const output = job?.outputToken;
    if (!job || !output) return;
    try {
      await cancelToolboxOutput({
        requestId: crypto.randomUUID(),
        jobId: job.jobId,
        outputToken: output.token,
        generation: job.generation,
        resetEpoch: job.resetEpoch,
      });
      setPreparedOutput(null);
      releaseOutputs();
      setNotice("临时输出已取消并释放。");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "临时输出释放未确认。");
    }
  };

  const deliverFormalOutput: ImageOutputDelivery | undefined = externalDeliverOutput ?? (desktopRuntime ? async (payload) => {
    if (nativeOutputRef.current) throw new Error("已有临时输出待另存，请先完成或取消它。");
    const job = await startToolboxSession({ ...newToolboxRequest(), toolId });
    try {
      const ready = await registerToolboxOutput({
        ...newToolboxRequest(),
        jobId: job.jobId,
        generation: job.generation,
        resetEpoch: job.resetEpoch,
        bytes: new Uint8Array(await payload.blob.arrayBuffer()),
        validation: "verified",
      });
      setPreparedOutput(ready, payload.filename);
      setNotice("原生输出已准备完成；请在 10 分钟内选择正式另存，失败可重试，取消会释放临时结果。");
    } catch (reason) {
      try {
        await finishToolboxJob({ ...newToolboxRequest(), jobId: job.jobId, succeeded: false, error: toToolboxError(reason) });
      } catch (lifecycleReason) {
        setError(`原生任务生命周期未确认：${lifecycleReason instanceof Error ? lifecycleReason.message : "无法更新任务状态"}`);
      }
      throw reason;
    }
  } : undefined);

  const stop = async () => {
    if (!cancelRef.current || stopping) return;
    setStopping(true);
    cancelRef.current.abort();
    try {
      await marker.cancel();
    } catch (reason) {
      setError(`图片隔离执行器释放未确认：${reason instanceof Error ? reason.message : "无法确认停止"}`);
    }
  };

  const runVisible = () => void run(async (signal, selectedInputs, resources) => {
    const batch = toolId === "image-batch-watermark";
    const inputCount = batch ? selectedInputs.count : 1;
    let zipBudget = batch ? createBatchZipBudget([]) : null;
    const zipWriter = batch ? createZipWriter(signal, BATCH_MAX_FILES) : null;
    let last: MarkerResult | null = null;
    try {
      for (let index = 0; index < inputCount; index += 1) {
        if (signal.aborted) throw createImageAbortError();
        const file = await selectedInputs.read(index);
        if (batch && zipBudget) zipBudget = appendBatchInput(zipBudget, file.size);
        const textLayer = {
          type: "text" as const,
          text: watermarkValue.trim() || watermarkText(toolId),
          position: { position: Position.bottomRight, X: 24, Y: 24 },
          alpha: watermarkAlpha,
          style: { color: watermarkColor(toolId), fontName: watermarkFont.trim() || undefined, direction: watermarkDirection, fontSize: 28, shadowStyle: { dx: 1, dy: 1, radius: 2, color: "#00000088" } },
        };
        const logoLayer = resources.logo ? [{
          type: "image" as const,
          src: resources.logo,
          position: { position: Position.topRight, X: 24, Y: 24 },
          scale: logoScale,
          rotate: logoRotation,
          alpha: logoAlpha,
        }] : [];
        const markOptions = {
          backgroundImage: { src: file },
          watermarks: [textLayer, ...logoLayer],
          saveFormat: outputFormat,
          maxSize: IMAGE_MAX_OUTPUT_EDGE,
          filename: safeOutputName(file.name),
        };
        const output = await marker.mark(resources.font ? withLocalImageFonts(markOptions, [resources.font]) : markOptions, imageControl(signal));
        if (signal.aborted) throw createImageAbortError();
        if (batch && zipBudget && zipWriter) {
          const item = resultToZipItem(`${String(index + 1).padStart(2, "0")}-${safeOutputName(file.name)}.png`, output);
          zipBudget = appendBatchZipOutput(zipBudget, item.bytes.byteLength);
          await zipWriter.append(item, zipBudget.inputBytes);
        } else {
          last = output;
        }
        setProgress((index + 1) / inputCount);
      }
      if (batch && zipBudget && zipWriter) {
        const zipBlob = await zipWriter.finish();
        if (signal.aborted) {
          throw createImageAbortError();
        }
        if (!desktopRuntime) publishZip(zipBlob);
        setNotice(`批量处理完成：${zipBudget.outputFileCount} 张图片按选择顺序写入 ZIP；已执行 20 文件 / 80 MiB 输入 / 512 MiB 输出预算。`);
        if (desktopRuntime) return { kind: "archive", filename: "corerobin-watermarks.zip", blob: zipBlob };
      } else {
        setResult(last);
        setNotice(last ? resultLabel(last) : "处理完成。");
        return last ? markerResultOutput(last) : null;
      }
      return null;
    } finally {
      zipWriter?.dispose();
    }
  }, { deadlineMs: toolId === "image-batch-watermark" ? 180_000 : IMAGE_OPERATION_DEADLINE_MS, requestNativeLogo: desktopRuntime && requestNativeLogo });

  const runInvisibleWrite = () => void run(async (signal, inputs) => {
    const file = await inputs.read(0);
    const payload = promptValue("短 locator（最多 12 UTF-8 字节）", "cr-demo-01");
    const key = promptValue("临时密钥（至少 16 UTF-8 字节；不会保存）", "local-demo-key-2026");
    if (!payload || !key) return null;
    const output = await marker.embedInvisible({ image: { src: file }, payload, key, strength: "balanced", saveFormat: ImageFormat.png, maxSize: IMAGE_MAX_OUTPUT_EDGE }, imageControl(signal));
    setResult(output);
    setNotice("隐形 locator 已写入当前结果；它不是加密、DRM 或归属证明，密钥不会写入记录。");
    return markerResultOutput(output);
  });

  const runInvisibleCheck = () => void run(async (signal, inputs) => {
    const file = await inputs.read(0);
    const key = promptValue("检测密钥（与写入时相同）", "local-demo-key-2026");
    if (!key) return null;
    if (!hostExecutorAvailable) throw new Error(runtime.execution.reason ?? "当前 WebView 不支持可终止的图片隔离执行器。" );
    let detected;
    try {
      detected = await marker.detectInvisible({
        image: { src: file },
        key,
        strength: "balanced",
        search: "robust",
        maxSize: IMAGE_MAX_OUTPUT_EDGE,
      }, imageControl(signal, (phase) => setProgress(phase === "queued" ? 0.15 : phase === "detecting" ? 0.7 : 1)));
    } catch (reason) {
      if (signal.aborted) throw createImageAbortError("隐形检测已取消。");
      throw reason;
    }
    setNotice(detected.detected ? `检测到 locator：${detected.payload ?? "(空)"}，置信度 ${detected.confidence.toFixed(2)}；正结果不代表图片未被修改。` : "未检测到经过认证的 locator；没有把失败显示为成功。");
    return null;
  });

  const runRecipeEditor = (editor: LocalImageEditor, nativeLogo: boolean) => void run(async (signal, inputs, resources) => {
    if (resources.logo) {
      const info = await marker.getImageInfo(resources.logo);
      const asset = editor.registerAsset(resources.logo, { width: info.width, height: info.height });
      editor.addImageAsset(asset);
    }
    const file = await inputs.read(0);
    const recipe = editor.exportRecipe();
    const output = toolId === "image-editor"
      ? await runtime.editorAdapter.renderPreview({ recipe, input: { backgroundImage: { src: file } }, control: imageControl(signal) })
      : await marker.importRecipe(recipe).apply({ backgroundImage: { src: file } }, imageControl(signal));
    setResult(output);
    setNotice("Recipe 已校验、迁移并由同一个隔离 marker 预览；本地素材不会写入 JSON 或上传。");
    return markerResultOutput(output);
  }, { requestNativeLogo: nativeLogo });

  const runRobustness = () => void run(async (signal, inputs) => {
    const file = await inputs.read(0);
    const output = await marker.markText({ backgroundImage: { src: file }, watermarkTexts: [{ text: "ROBUSTNESS-LAB", layout: { type: "tile", gapX: 80, gapY: 80 }, style: { color: "#ffffff", fontSize: 22, rotate: -25 }, alpha: 0.45 }], saveFormat: ImageFormat.jpg, quality: 75, maxSize: IMAGE_MAX_OUTPUT_EDGE }, imageControl(signal));
    setResult(output);
    setNotice("实验输出为约定 JPEG 质量 75；请手动用 95% 缩放/有限裁剪样本复核，不外推任意变换抗性。");
    return markerResultOutput(output);
  }, { deadlineMs: 180_000 });

  const runManifest = () => void (async () => {
    if (running || nativeOutputRef.current) return;
    const controller = new AbortController();
    cancelRef.current = controller;
    setRunning(true);
    setStopping(false);
    setError("");
    setNotice("");
    setManifestReport("");
    if (manifestDownloadUrlRef.current) URL.revokeObjectURL(manifestDownloadUrlRef.current);
    manifestDownloadUrlRef.current = "";
    setManifestDownloadUrl("");
    let nativeJob: ToolboxJob | null = null;
    let nativeInputJob: ToolboxFileJobKey | null = null;
    let nativeInputTokens: ToolboxInputToken[] = [];
    try {
      let file = manifestFile;
      if (desktopRuntime) {
        nativeJob = await startToolboxSession({ ...newToolboxRequest(), toolId });
        nativeInputJob = fileJobKey(nativeJob);
        nativeInputTokens = await prepareToolboxInputs(nativeInputJob, "manifest");
        const token = nativeInputTokens[0];
        if (!token) throw new Error("请选择一个本地 manifest JSON 文件。");
        const bytes = await readBoundToolboxInput(nativeInputJob, token, controller.signal, LOCAL_MANIFEST_MAX_BYTES);
        const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
        file = new File([buffer], token.displayName, { type: "application/json" });
      }
      if (!file) throw new Error("请选择一个本地 manifest JSON 文件。");
      if (file.size > LOCAL_MANIFEST_MAX_BYTES) throw new Error("Manifest 材料不能超过 4 MiB。");
      const report = JSON.stringify(inspectLocalManifest(await file.text()), null, 2);
      setManifestReport(report);
      publishManifestReport(report);
      if (nativeInputJob) await revalidateToolboxInputs(nativeInputJob);
      if (nativeJob) {
        const ready = await registerToolboxOutput({
          ...newToolboxRequest(),
          jobId: nativeJob.jobId,
          generation: nativeJob.generation,
          resetEpoch: nativeJob.resetEpoch,
          bytes: new TextEncoder().encode(report),
          validation: "verified",
        });
        setPreparedOutput(ready, "corerobin-c2pa-manifest-report.json");
        setNotice("本地 manifest 摘要已生成；解析与信任状态分开显示，信任仍为 unknown。请在 10 分钟内正式另存报告。");
      } else {
        setNotice("本地 manifest 摘要已生成；未联网、未验证签名或信任链。下载的是显式检查报告。");
      }
    } catch (reason) {
      if (nativeJob) {
        try {
          if (controller.signal.aborted) {
            await cancelToolboxJob({ ...newToolboxRequest(), jobId: nativeJob.jobId });
          } else {
            await finishToolboxJob({ ...newToolboxRequest(), jobId: nativeJob.jobId, succeeded: false, error: toToolboxError(reason) });
          }
        } catch (lifecycleReason) {
          setError(`原生任务生命周期未确认：${lifecycleReason instanceof Error ? lifecycleReason.message : "无法更新任务状态"}`);
        }
      }
      if (controller.signal.aborted) setNotice("Manifest 检查已取消；未生成正式报告。");
      else setError(reason instanceof Error ? reason.message : "Manifest 解析失败。");
    } finally {
      if (nativeInputJob && nativeInputTokens.length > 0) {
        try {
          await releaseToolboxInputs(nativeInputJob, nativeInputTokens.map((token) => token.token));
        } catch (releaseReason) {
          setError(`Manifest 输入资源释放未确认：${releaseReason instanceof Error ? releaseReason.message : "无法释放输入 token"}`);
        }
      }
      cancelRef.current = null;
      setStopping(false);
      setRunning(false);
    }
  })();

  const runRecipient = () => void run(async (signal, inputs) => {
    const file = await inputs.read(0);
    const recipients = promptValue("收件人 locator 列表（逗号分隔，最多 30 个短 ID）", "recipient-a,recipient-b");
    const values = parseRecipientLocators(recipients ?? "");
    const sessionKey = { value: requireOneTimeRecipientKey(promptValue("一次性分发密钥（至少 16 UTF-8 字节；只保留在当前操作内存中）", "")) };
    let delivered = 0;
    let zipBudget = createRecipientZipBudget(file);
    const zipWriter = createZipWriter(signal, zipBudget.maxOutputFiles);
    setRecipientDelivery({ status: "preparing", requested: values.length, delivered, detail: "正在生成本次会话的交付 ZIP。" });
    try {
      for (const [index, value] of values.entries()) {
        if (signal.aborted) throw createImageAbortError("收件人分发已停止。");
        const output = await marker.embedInvisible({ image: { src: file }, payload: value, key: sessionKey.value, strength: "balanced", saveFormat: ImageFormat.png, maxSize: IMAGE_MAX_OUTPUT_EDGE }, imageControl(signal));
        if (signal.aborted) throw createImageAbortError("收件人分发已停止。");
        const item = resultToZipItem(`delivery-${String(index + 1).padStart(2, "0")}.png`, output);
        zipBudget = appendBatchZipOutput(zipBudget, item.bytes.byteLength);
        await zipWriter.append(item, zipBudget.inputBytes);
        delivered += 1;
        setProgress(delivered / values.length);
        setRecipientDelivery({ status: "preparing", requested: values.length, delivered, detail: "正在生成本次会话的交付 ZIP。" });
      }
      const zipBlob = await zipWriter.finish();
      if (signal.aborted) {
        throw createImageAbortError("收件人分发已停止。");
      }
      if (!desktopRuntime) publishZip(zipBlob);
      setRecipientDelivery({ status: "ready", requested: values.length, delivered, detail: "交付 ZIP 已就绪；文件按输入顺序编号，locator 映射未持久化。" });
      setNotice(`交付状态：ready。已生成 ${delivered}/${values.length} 个分发样本；一次性密钥和 locator 映射不会由 CoreRobin 保存。`);
      if (desktopRuntime) return { kind: "archive", filename: "corerobin-recipient-delivery.zip", blob: zipBlob };
    } catch (reason) {
      const cancelled = signal.aborted || isAbortError(reason);
      releaseOutputs();
      setRecipientDelivery({
        status: cancelled ? "cancelled" : "failed",
        requested: values.length,
        delivered,
        detail: cancelled ? "操作已取消，未保留部分交付输出。" : reason instanceof Error ? reason.message : "无法生成交付 ZIP。",
      });
      throw reason;
    } finally {
      zipWriter.dispose();
      sessionKey.value = "";
    }
    return null;
  }, { deadlineMs: 180_000 });

  const action = toolId === "invisible-watermark-write" ? runInvisibleWrite
    : toolId === "invisible-watermark-check" ? runInvisibleCheck
      : toolId === "image-recipe" || toolId === "image-editor" ? undefined
        : toolId === "recipient-tracking" ? runRecipient
          : toolId === "robustness-lab" ? runRobustness
            : toolId === "c2pa-inspector" ? runManifest
              : runVisible;

  return <div className="toolbox-tool-layout image-toolbox">
    <div className="toolbox-tool-layout__body">
      <div className="image-toolbox__boundary"><ShieldCheck size={18} /><span>本地文件、显式操作、预算受限；不会自动打开 URL。完整渲染、编码和隐形处理均在每任务 Dedicated Worker 的 OffscreenCanvas 中执行；停止会终止该 Worker 并等待 SDK 释放确认：{hostExecutorAvailable ? "available" : runtime.execution.reason ?? "unavailable"}。</span></div>
      {toolId !== "c2pa-inspector" && !desktopRuntime ? <label className="toolbox-file-pick button button--secondary"><Upload size={15} />选择 PNG / JPEG / WebP<input hidden type="file" accept="image/png,image/jpeg,image/webp" multiple={toolId === "image-batch-watermark"} onChange={(event) => void selectFiles(Array.from(event.target.files ?? []))} /></label> : null}
      {toolId !== "c2pa-inspector" && desktopRuntime ? <p className="toolbox-hint"><FileImage size={14} />开始处理后由原生选择器签发绑定输入 token；页面不会接收真实路径。</p> : null}
      {files.length > 0 && !desktopRuntime ? <p className="toolbox-hint"><FileImage size={14} />已选 {files.length} 张 · 输入上限 {BATCH_MAX_FILES} 张 / {Math.round(BATCH_MAX_INPUT_BYTES / 1024 / 1024)} MiB · 常规输出最长边 {IMAGE_MAX_OUTPUT_EDGE}px</p> : null}
      {toolId === "image-watermark" || toolId === "confidential-watermark" || toolId === "image-batch-watermark" ? <div className="image-watermark-form"><label>文字<input className="toolbox-input" value={watermarkValue} maxLength={4096} disabled={running} onChange={(event) => setWatermarkValue(event.target.value)} /></label><label>字体族<input className="toolbox-input" value={watermarkFont} disabled={running} onChange={(event) => setWatermarkFont(event.target.value)} placeholder="系统已安装字体，例如 PingFang SC" /></label><label>文字方向<select className="toolbox-input" value={watermarkDirection} disabled={running} onChange={(event) => setWatermarkDirection(event.target.value as typeof watermarkDirection)}><option value="auto">自动</option><option value="ltr">从左到右</option><option value="rtl">从右到左</option></select></label><label>文字透明度<input type="range" min="0.1" max="1" step="0.05" value={watermarkAlpha} disabled={running} onChange={(event) => setWatermarkAlpha(Number(event.target.value))} /></label><label>输出格式<select className="toolbox-input" value={outputFormat} disabled={running} onChange={(event) => setOutputFormat(event.target.value as ImageFormat)}><option value={ImageFormat.png}>PNG</option><option value={ImageFormat.jpg}>JPEG</option><option value={ImageFormat.webp}>WebP</option></select></label>{!desktopRuntime ? <><label className="toolbox-file-pick button button--secondary"><Upload size={14} />选择本地 Logo<input hidden type="file" accept="image/png,image/jpeg,image/webp" disabled={running} onChange={(event) => void selectLogo(event.target.files?.[0])} /></label><label className="toolbox-file-pick button button--secondary"><Upload size={14} />选择本地字体<input hidden type="file" accept=".ttf,.otf,.woff,.woff2,font/*" disabled={running} onChange={(event) => selectFont(event.target.files?.[0])} /></label></> : <><label className="image-editor__native-asset"><input type="checkbox" checked={requestNativeLogo} disabled={running} onChange={(event) => setRequestNativeLogo(event.target.checked)} />本次操作选择一个本地 Logo</label><label className="image-editor__native-asset"><input type="checkbox" checked={requestNativeFont} disabled={running} onChange={(event) => setRequestNativeFont(event.target.checked)} />本次操作选择一个本地字体</label><p className="toolbox-hint">桌面端本地字体通过 W02 绑定 token 读取，仅在本次隔离 Worker 内存中使用。</p></>}{fontFile ? <p className="toolbox-hint">字体：{safeOutputName(fontFile.name)} · 仅本次 Worker 可见，Worker 终止后释放。</p> : null}{logoFile ? <p className="toolbox-hint">Logo：{safeOutputName(logoFile.name)} · 缩放 <input type="number" min="0.01" max="100" step="0.05" value={logoScale} disabled={running} onChange={(event) => setLogoScale(Number(event.target.value))} /> · 旋转 <input type="number" min="0" max="360" value={logoRotation} disabled={running} onChange={(event) => setLogoRotation(Number(event.target.value))} /> · 透明度 <input type="range" min="0.1" max="1" step="0.05" value={logoAlpha} disabled={running} onChange={(event) => setLogoAlpha(Number(event.target.value))} /></p> : null}</div> : null}
      {toolId === "image-recipe" || toolId === "image-editor" ? <ImageRecipeEditor marker={marker} desktopRuntime={desktopRuntime} disabled={running || !hostExecutorAvailable || (!desktopRuntime && files.length === 0)} onPreview={runRecipeEditor} onError={setError} onNotice={setNotice} deliverOutput={deliverFormalOutput} /> : null}
      {toolId === "c2pa-inspector" ? <div className="toolbox-inline-actions">{!desktopRuntime ? <label className="toolbox-file-pick button button--secondary"><Upload size={14} />选择 manifest JSON<input hidden type="file" accept="application/json,.json,text/json" disabled={running} onChange={(event) => selectManifest(event.target.files?.[0])} /></label> : <span className="toolbox-hint"><FileImage size={14} />开始检查后由原生选择器签发 manifest token。</span>}<button className="button button--primary" type="button" disabled={running || Boolean(nativeOutput) || (!desktopRuntime && !manifestFile)} onClick={runManifest}><Play size={14} />检查本地 manifest</button>{running ? <button className="button button--secondary" type="button" disabled={stopping} onClick={() => void stop()}><Square size={14} />{stopping ? "正在停止…" : "停止"}</button> : null}<button className="button button--secondary" type="button" disabled={running} onClick={() => { void cancelNativeOutput(); setManifestFile(null); setManifestReport(""); if (manifestDownloadUrlRef.current) URL.revokeObjectURL(manifestDownloadUrlRef.current); manifestDownloadUrlRef.current = ""; setManifestDownloadUrl(""); setNotice(""); setError(""); }}><RotateCcw size={14} />清空</button></div> : toolId === "image-recipe" || toolId === "image-editor" ? <div className="toolbox-inline-actions">{running ? <button className="button button--secondary" type="button" disabled={stopping} onClick={() => void stop()}><Square size={14} />{stopping ? "正在停止…" : "停止"}</button> : null}<button className="button button--secondary" type="button" disabled={running} onClick={() => { void cancelNativeOutput(); setFiles([]); releaseOutputs(); setRecipientDelivery(null); setNotice(""); setError(""); }}><RotateCcw size={14} />清空</button></div> : <div className="toolbox-inline-actions"><button className="button button--primary" type="button" disabled={running || Boolean(nativeOutput) || !hostExecutorAvailable || (!desktopRuntime && files.length === 0)} onClick={action}><Play size={14} />{stopping ? "正在停止…" : running ? "正在处理…" : actionLabel(toolId)}</button>{running ? <button className="button button--secondary" type="button" disabled={stopping} onClick={() => void stop()}><Square size={14} />{stopping ? "正在停止…" : "停止"}</button> : null}<button className="button button--secondary" type="button" disabled={running} onClick={() => { void cancelNativeOutput(); setFiles([]); setLogoFile(null); setFontFile(null); releaseOutputs(); setRecipientDelivery(null); setNotice(""); setError(""); }}><RotateCcw size={14} />清空</button></div>}
      {running ? <progress max="1" value={progress} /> : null}
      {error ? <p className="toolbox-error" role="alert">{error}</p> : null}
      {notice ? <pre className="toolbox-notice">{notice}</pre> : null}
      {manifestReport ? <div className="toolbox-output"><pre className="toolbox-notice">{manifestReport}</pre>{manifestDownloadUrl && !desktopRuntime ? <a className="button button--secondary" download="corerobin-c2pa-manifest-report.json" href={manifestDownloadUrl}><Download size={14} />下载检查报告</a> : null}</div> : null}
      {toolId === "recipient-tracking" && recipientDelivery ? <p className={recipientDelivery.status === "ready" ? "toolbox-hint" : "toolbox-error"} role={recipientDelivery.status === "ready" ? undefined : "alert"}>交付状态：{recipientDelivery.status} · {recipientDelivery.delivered}/{recipientDelivery.requested} · {recipientDelivery.detail}</p> : null}
      {result ? <div className="image-toolbox__result"><img src={result.uri} alt="本地水印结果预览" /><div className="toolbox-inline-actions">{nativeOutput?.outputToken ? <><button className="button button--secondary" type="button" onClick={() => void saveNativeOutput()}><Download size={14} />正式另存结果</button><button className="button button--secondary" type="button" onClick={() => void cancelNativeOutput()}>取消临时输出</button></> : null}{deliverFormalOutput ? <button className="button button--secondary" type="button" onClick={() => void deliverFormalOutput(markerResultOutput(result)).then(() => setNotice("图片已交给原生输出 provider；请按 TTL/另存流程完成导出。"), (reason: unknown) => setError(reason instanceof Error ? reason.message : "正式输出交付失败。"))}><Download size={14} />交给正式另存</button> : null}{!desktopRuntime ? <a className="button button--secondary" download={result.filename ?? "corerobin-watermarked.png"} href={result.uri}><Download size={14} />下载预览副本（非正式导出）</a> : null}<span className="toolbox-hint">{resultLabel(result)}{nativeOutput?.outputToken ? ` · 原生输出 ${Math.ceil(nativeOutput.outputToken.byteLength / 1024)} KiB，剩余约 10 分钟` : ""}</span></div></div> : null}
      {!result && nativeOutput?.outputToken ? <div className="toolbox-inline-actions"><button className="button button--secondary" type="button" onClick={() => void saveNativeOutput()}><Download size={14} />正式另存结果</button><button className="button button--secondary" type="button" onClick={() => void cancelNativeOutput()}>取消临时输出</button><span className="toolbox-hint">原生输出 {Math.ceil(nativeOutput.outputToken.byteLength / 1024)} KiB，剩余约 10 分钟</span></div> : null}
      {zipUrl && !desktopRuntime ? <a className="button button--primary" download="corerobin-watermarks.zip" href={zipUrl}><Download size={14} />下载预览 ZIP（非正式导出）</a> : null}
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

function toToolboxError(reason: unknown): ToolboxError {
  const rawMessage = reason instanceof Error ? reason.message : "图片工具执行失败。";
  const message = rawMessage.replace(/(?:[A-Za-z]:)?[\\/][^\s)]+/gu, "本地文件").slice(0, 180);
  return { code: "image_execution_failed", message, retryable: false };
}

function watermarkText(toolId: ImageToolId): string {
  return toolId === "confidential-watermark" ? "CONFIDENTIAL · INTERNAL" : "© CoreRobin";
}

function watermarkColor(toolId: ImageToolId): string { return toolId === "confidential-watermark" ? "#ffcf66" : "#ffffff"; }

function imageControl(signal: AbortSignal, onPhase?: (phase: string) => void) {
  return {
    signal,
    timeoutMs: IMAGE_OPERATION_DEADLINE_MS,
    onProgress: (progress: { phase: string }) => onPhase?.(progress.phase),
  };
}

function safeOutputName(name: string): string { return name.replace(/[^a-zA-Z0-9._-]+/g, "_").slice(0, 80) || "image"; }
function promptValue(label: string, initial = ""): string | null { const value = window.prompt(label, initial); return value?.trim() || null; }
function fontFamilyFromFile(name: string): string { return name.replace(/\.(?:ttf|otf|woff2?)$/iu, "").replace(/[^\p{L}\p{N} _.-]+/gu, " ").trim().slice(0, 120) || "CoreRobinLocalFont"; }

function resultToZipItem(name: string, result: MarkerResult): { name: string; bytes: ArrayBuffer } {
  const encoded = dataUrlToBytes(result.uri);
  return { name, bytes: encoded.buffer as ArrayBuffer };
}

interface ZipItem {
  name: string;
  bytes: ArrayBuffer;
}

interface ZipWriter {
  append(item: ZipItem, inputBytes: number): Promise<void>;
  finish(): Promise<Blob>;
  dispose(): void;
}

type ZipWorkerReply = {
  type: "appended";
  id: number;
} | {
  type: "complete";
  blob: Blob;
} | {
  type: "error";
  error?: string;
};

type ZipWorkerPending = {
  kind: "append";
  id: number;
  resolve: () => void;
  reject: (reason: Error) => void;
} | {
  kind: "finish";
  resolve: (blob: Blob) => void;
  reject: (reason: Error) => void;
};

function createZipWriter(signal: AbortSignal, maxOutputFiles: number): ZipWriter {
  if (signal.aborted) throw createImageAbortError("ZIP 生成已停止。");
  let worker: Worker;
  try {
    worker = new Worker(new URL("./zip.worker.ts", import.meta.url), { type: "module" });
  } catch (reason) {
    throw reason instanceof Error ? reason : new Error("ZIP Worker 无法启动。");
  }

  let closed = false;
  let nextId = 1;
  let pending: ZipWorkerPending | null = null;
  const cleanup = () => {
    worker.onmessage = null;
    worker.onerror = null;
    signal.removeEventListener("abort", abort);
    worker.terminate();
  };
  const fail = (reason: Error) => {
    if (closed) return;
    closed = true;
    const current = pending;
    pending = null;
    cleanup();
    current?.reject(reason);
  };
  const abort = () => fail(createImageAbortError("ZIP 生成已停止。"));
  const complete = (blob: Blob) => {
    if (closed) return;
    if (!pending || pending.kind !== "finish") {
      fail(new Error("ZIP Worker 返回了无效的完成状态。"));
      return;
    }
    closed = true;
    const current = pending;
    pending = null;
    cleanup();
    current.resolve(blob);
  };

  signal.addEventListener("abort", abort, { once: true });
  worker.onmessage = (event: MessageEvent<ZipWorkerReply>) => {
    const reply = event.data;
    if (reply.type === "error") {
      fail(new Error(reply.error ?? "ZIP 生成失败。"));
    } else if (reply.type === "complete") {
      complete(reply.blob);
    } else if (!pending || pending.kind !== "append" || pending.id !== reply.id) {
      fail(new Error("ZIP Worker 返回了无效的分块状态。"));
    } else {
      const current = pending;
      pending = null;
      current.resolve();
    }
  };
  worker.onerror = () => fail(new Error("ZIP Worker 无法启动。"));
  try {
    worker.postMessage({ type: "start", maxOutputFiles });
  } catch (reason) {
    fail(reason instanceof Error ? reason : new Error("ZIP Worker 无法启动。"));
    throw reason instanceof Error ? reason : new Error("ZIP Worker 无法启动。");
  }

  return {
    append(item, inputBytes) {
      if (signal.aborted) return Promise.reject(createImageAbortError("ZIP 生成已停止。"));
      if (closed) return Promise.reject(new Error("ZIP 生成已结束。"));
      if (pending) return Promise.reject(new Error("ZIP Worker 正在处理前一项输出。"));
      const id = nextId;
      nextId += 1;
      return new Promise((resolve, reject) => {
        pending = { kind: "append", id, resolve, reject };
        try {
          worker.postMessage({ type: "append", id, inputBytes, item }, [item.bytes]);
        } catch (reason) {
          fail(reason instanceof Error ? reason : new Error("ZIP Worker 无法接收输出。"));
        }
      });
    },
    finish() {
      if (signal.aborted) return Promise.reject(createImageAbortError("ZIP 生成已停止。"));
      if (closed) return Promise.reject(new Error("ZIP 生成已结束。"));
      if (pending) return Promise.reject(new Error("ZIP Worker 正在处理前一项输出。"));
      return new Promise((resolve, reject) => {
        pending = { kind: "finish", resolve, reject };
        try {
          worker.postMessage({ type: "finish" });
        } catch (reason) {
          fail(reason instanceof Error ? reason : new Error("ZIP Worker 无法完成归档。"));
        }
      });
    },
    dispose() {
      fail(new Error("ZIP 生成已释放。"));
    },
  };
}
