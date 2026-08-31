import { Download, FileImage, Play, RotateCcw, ShieldCheck, Square, Upload } from "lucide-react";
import type { TFunction } from "i18next";
import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
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
import { createImageToolRuntime, IMAGE_FONT_MAX_BYTES, IMAGE_OPERATION_DEADLINE_MS, transformImageInWorker, withLocalImageFonts, type LocalImageFontResource } from "./imageExecution";
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
  const { t } = useTranslation("toolbox");
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
  const [robustnessReport, setRobustnessReport] = useState("");
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
    setRobustnessReport("");
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
      setNotice(t("image.inputAccepted", { count: inspected.length }));
    } catch (reason) {
      setFiles([]);
      setError(reason instanceof Error ? reason.message : t("image.inputUnavailable"));
    }
  };

  const selectLogo = async (selected: File | undefined) => {
    if (!selected) return;
    try {
      await inspectImageBudget(marker, selected);
      setLogoFile(selected);
      setError("");
      setNotice(t("image.logoAccepted", { name: safeOutputName(selected.name) }));
    } catch (reason) {
      setLogoFile(null);
      setError(reason instanceof Error ? reason.message : t("image.logoUnavailable"));
    }
  };

  const selectFont = async (selected: File | undefined) => {
    if (!selected) return;
    try {
      if (selected.size === 0 || selected.size > IMAGE_FONT_MAX_BYTES) throw new Error(t("image.fontTooLarge"));
      const bytes = new Uint8Array(await selected.arrayBuffer());
      const mimeType = inspectLocalFontBytes(selected.name, bytes);
      setFontFile(new File([bytes], selected.name, { type: mimeType, lastModified: selected.lastModified }));
      setWatermarkFont((current) => current.trim() || fontFamilyFromFile(selected.name));
      setError("");
      setNotice(t("image.fontAccepted", { name: safeOutputName(selected.name) }));
    } catch (reason) {
      setFontFile(null);
      setError(reason instanceof Error ? reason.message : t("image.fontUnavailable"));
    }
  };

  const selectManifest = (selected: File | undefined) => {
    if (!selected) return;
    if (selected.size > LOCAL_MANIFEST_MAX_BYTES) {
      setManifestFile(null);
      setError(t("image.manifestTooLarge"));
      return;
    }
    setManifestFile(selected);
    setManifestReport("");
    setError("");
    setNotice(t("image.manifestSelected", { name: safeOutputName(selected.name) }));
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
        if (nativeInputTokens.length === 0) throw new Error(t("image.noInput"));
        inputs = createNativeImageInputs(marker, nativeInputJob, nativeInputTokens, controller.signal);
        if (options.requestNativeLogo) {
          const logoTokens = await prepareToolboxInputs(nativeInputJob, "logo");
          if (logoTokens.length !== 1) throw new Error(t("image.logoRequired"));
          nativeInputTokens = [...nativeInputTokens, ...logoTokens];
          const nativeLogo = createNativeImageInputs(marker, nativeInputJob, logoTokens, controller.signal);
          const logo = await nativeLogo.read(0);
          await inspectImageBudget(marker, logo);
          resources = { logo };
        }
        if (requestNativeFont && (toolId === "image-watermark" || toolId === "image-batch-watermark" || toolId === "confidential-watermark")) {
          const fontTokens = await prepareToolboxInputs(nativeInputJob, "font");
          const fontToken = fontTokens[0];
          if (!fontToken) throw new Error(t("image.fontRequired"));
          const fontBytes = await readBoundToolboxInput(nativeInputJob, fontToken, controller.signal, IMAGE_FONT_MAX_BYTES);
          const fontBuffer = fontBytes.buffer.slice(fontBytes.byteOffset, fontBytes.byteOffset + fontBytes.byteLength) as ArrayBuffer;
          const fontMimeType = inspectLocalFontBytes(fontToken.displayName, fontBytes);
          const source = new File([fontBuffer], fontToken.displayName, { type: fontMimeType });
          resources = { ...resources, font: { family: watermarkFont.trim() || fontFamilyFromFile(fontToken.displayName), source } };
          nativeInputTokens = [...nativeInputTokens, ...fontTokens];
        }
      } else {
        if (files.length === 0) throw new Error(t("image.selectImageFirst"));
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
        setNotice(t("image.nativeOutputReady"));
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
          setError(t("image.lifecycleUnconfirmed", { message: lifecycleReason instanceof Error ? lifecycleReason.message : t("image.lifecycleUnknown") }));
        }
      }
      if (controller.signal.aborted || isAbortError(reason)) {
        releaseOutputs();
        setNotice(t("image.cancelled", { reason: isAbortError(reason) ? "AbortError" : "abort signal" }));
      } else {
        setError(reason instanceof Error ? reason.message : t("image.processingFailed"));
      }
    } finally {
      window.clearTimeout(deadline);
      if (nativeInputTokens.length > 0) {
        try {
          await releaseNativeInputs();
        } catch (releaseReason) {
          setError(t("image.inputReleaseUnconfirmed", { message: releaseReason instanceof Error ? releaseReason.message : t("image.releaseUnknown") }));
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
      setNotice(t("image.savedAtomically"));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : t("image.saveFailed"));
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
      setNotice(t("image.temporaryCancelled"));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : t("image.temporaryReleaseUnconfirmed"));
    }
  };

  const deliverFormalOutput: ImageOutputDelivery | undefined = externalDeliverOutput ?? (desktopRuntime ? async (payload) => {
    if (nativeOutputRef.current) throw new Error(t("image.outputPending"));
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
      setNotice(t("image.nativeOutputReady"));
    } catch (reason) {
      try {
        await finishToolboxJob({ ...newToolboxRequest(), jobId: job.jobId, succeeded: false, error: toToolboxError(reason) });
      } catch (lifecycleReason) {
        setError(t("image.lifecycleUnconfirmed", { message: lifecycleReason instanceof Error ? lifecycleReason.message : t("image.lifecycleUnknown") }));
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
      setError(t("image.executorReleaseUnconfirmed", { message: reason instanceof Error ? reason.message : t("image.releaseUnknown") }));
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
        setNotice(t("image.batchComplete", { count: zipBudget.outputFileCount }));
        if (desktopRuntime) return { kind: "archive", filename: "corerobin-watermarks.zip", blob: zipBlob };
      } else {
        setResult(last);
        setNotice(last ? resultLabel(last) : t("image.processingComplete"));
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
    setNotice(t("image.invisibleWritten"));
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
      if (signal.aborted) throw createImageAbortError(t("image.invisibleCancelled"));
      throw reason;
    }
    setNotice(detected.detected
      ? t("image.invisibleDetected", { payload: detected.payload ?? "(empty)", confidence: detected.confidence.toFixed(2) })
      : t("image.invisibleNotDetected"));
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
    setNotice(t("image.recipeReady"));
    return markerResultOutput(output);
  }, { requestNativeLogo: nativeLogo });

  const runRobustness = () => void run(async (signal, inputs) => {
    const file = await inputs.read(0);
    const payload = `rb-${crypto.randomUUID().replace(/-/gu, "").slice(0, 8)}`;
    const key = crypto.randomUUID().replace(/-/gu, "");
    const embedded = await marker.embedInvisible({
      image: { src: file },
      payload,
      key,
      strength: "robust",
      saveFormat: ImageFormat.png,
      maxSize: IMAGE_MAX_OUTPUT_EDGE,
    }, imageControl(signal));
    const embeddedBytes = dataUrlToBytes(embedded.uri);
    const embeddedBuffer = embeddedBytes.buffer.slice(embeddedBytes.byteOffset, embeddedBytes.byteOffset + embeddedBytes.byteLength) as ArrayBuffer;
    const embeddedBlob = new Blob([embeddedBuffer], { type: "image/png" });
    const cases = [
      { id: "jpeg-quality-75", request: { mode: "jpeg-quality" as const, quality: 75 } },
      { id: "scale-95-percent", request: { mode: "scale" as const, scale: 0.95 } },
      { id: "limited-crop-4-percent", request: { mode: "crop" as const, cropRatio: 0.04 } },
    ];
    const results: Array<Record<string, unknown>> = [];
    for (const [index, sample] of cases.entries()) {
      signal.throwIfAborted();
      try {
        const transformed = await transformImageInWorker(embeddedBlob, sample.request, signal);
        const detected = await marker.detectInvisible({
          image: { src: transformed },
          key,
          strength: "robust",
          search: "robust",
          maxSize: IMAGE_MAX_OUTPUT_EDGE,
        }, imageControl(signal, (phase) => setProgress(Math.min(0.95, (index + (phase === "complete" ? 1 : 0.5)) / cases.length))));
        results.push({
          id: sample.id,
          detected: detected.detected,
          confidence: Number(detected.confidence.toFixed(4)),
          scale: detected.scale ?? null,
          outputBytes: transformed.size,
        });
      } catch (reason) {
        if (signal.aborted || isAbortError(reason)) throw reason;
        results.push({ id: sample.id, detected: false, error: "sample_failed" });
      }
      setProgress((index + 1) / cases.length);
    }
    setRobustnessReport(JSON.stringify({
      algorithm: "dct-qim-v1",
      strength: "robust",
      locator: payload,
      keyStored: false,
      cases: results,
    }, null, 2));
    setResult(embedded);
    setNotice(t("image.robustnessNotice"));
    return markerResultOutput(embedded);
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
        if (!token) throw new Error(t("image.noManifest"));
        const bytes = await readBoundToolboxInput(nativeInputJob, token, controller.signal, LOCAL_MANIFEST_MAX_BYTES);
        const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
        file = new File([buffer], token.displayName, { type: "application/json" });
      }
      if (!file) throw new Error(t("image.noManifest"));
      if (file.size > LOCAL_MANIFEST_MAX_BYTES) throw new Error(t("image.manifestTooLarge"));
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
        setNotice(t("image.manifestReadyNative"));
      } else {
        setNotice(t("image.manifestReadyBrowser"));
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
          setError(t("image.lifecycleUnconfirmed", { message: lifecycleReason instanceof Error ? lifecycleReason.message : t("image.lifecycleUnknown") }));
        }
      }
      if (controller.signal.aborted) setNotice(t("image.manifestCancelled"));
      else setError(reason instanceof Error ? reason.message : t("image.manifestFailed"));
    } finally {
      if (nativeInputJob && nativeInputTokens.length > 0) {
        try {
          await releaseToolboxInputs(nativeInputJob, nativeInputTokens.map((token) => token.token));
        } catch (releaseReason) {
          setError(t("image.manifestInputReleaseUnconfirmed", { message: releaseReason instanceof Error ? releaseReason.message : t("image.releaseUnknown") }));
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
    setRecipientDelivery({ status: "preparing", requested: values.length, delivered, detail: t("image.recipientPreparing") });
    try {
      for (const [index, value] of values.entries()) {
        if (signal.aborted) throw createImageAbortError(t("image.recipientStopped"));
        const output = await marker.embedInvisible({ image: { src: file }, payload: value, key: sessionKey.value, strength: "balanced", saveFormat: ImageFormat.png, maxSize: IMAGE_MAX_OUTPUT_EDGE }, imageControl(signal));
        if (signal.aborted) throw createImageAbortError(t("image.recipientStopped"));
        const item = resultToZipItem(`delivery-${String(index + 1).padStart(2, "0")}.png`, output);
        zipBudget = appendBatchZipOutput(zipBudget, item.bytes.byteLength);
        await zipWriter.append(item, zipBudget.inputBytes);
        delivered += 1;
        setProgress(delivered / values.length);
        setRecipientDelivery({ status: "preparing", requested: values.length, delivered, detail: t("image.recipientPreparing") });
      }
      const zipBlob = await zipWriter.finish();
      if (signal.aborted) {
        throw createImageAbortError(t("image.recipientStopped"));
      }
      if (!desktopRuntime) publishZip(zipBlob);
      setRecipientDelivery({ status: "ready", requested: values.length, delivered, detail: t("image.recipientReady") });
      setNotice(t("image.recipientNotice", { delivered, requested: values.length }));
      if (desktopRuntime) return { kind: "archive", filename: "corerobin-recipient-delivery.zip", blob: zipBlob };
    } catch (reason) {
      const cancelled = signal.aborted || isAbortError(reason);
      releaseOutputs();
      setRecipientDelivery({
        status: cancelled ? "cancelled" : "failed",
        requested: values.length,
        delivered,
        detail: cancelled ? t("image.recipientCancelled") : reason instanceof Error ? reason.message : t("image.recipientFailed"),
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
      <div className="image-toolbox__boundary"><ShieldCheck size={18} /><span>{t("image.boundary", { executor: hostExecutorAvailable ? "available" : runtime.execution.reason ?? "unavailable" })}</span></div>
      {toolId !== "c2pa-inspector" && !desktopRuntime ? <label className="toolbox-file-pick button button--secondary"><Upload size={15} />{t("image.selectInput")}<input hidden type="file" accept="image/png,image/jpeg,image/webp" multiple={toolId === "image-batch-watermark"} onChange={(event) => void selectFiles(Array.from(event.target.files ?? []))} /></label> : null}
      {toolId !== "c2pa-inspector" && desktopRuntime ? <p className="toolbox-hint"><FileImage size={14} />{t("image.nativeInputHint")}</p> : null}
      {files.length > 0 && !desktopRuntime ? <p className="toolbox-hint"><FileImage size={14} />{t("image.selectedInputSummary", { count: files.length, maxFiles: BATCH_MAX_FILES, maxInputMiB: Math.round(BATCH_MAX_INPUT_BYTES / 1024 / 1024), maxEdge: IMAGE_MAX_OUTPUT_EDGE })}</p> : null}
      {toolId === "image-watermark" || toolId === "confidential-watermark" || toolId === "image-batch-watermark" ? <div className="image-watermark-form"><label>{t("image.text")}<input className="toolbox-input" value={watermarkValue} maxLength={4096} disabled={running} onChange={(event) => setWatermarkValue(event.target.value)} /></label><label>{t("image.fontFamily")}<input className="toolbox-input" value={watermarkFont} disabled={running} onChange={(event) => setWatermarkFont(event.target.value)} placeholder={t("image.fontPlaceholder")} /></label><label>{t("image.direction")}<select className="toolbox-input" value={watermarkDirection} disabled={running} onChange={(event) => setWatermarkDirection(event.target.value as typeof watermarkDirection)}><option value="auto">{t("image.directionAuto")}</option><option value="ltr">{t("image.directionLtr")}</option><option value="rtl">{t("image.directionRtl")}</option></select></label><label>{t("image.opacity")}<input type="range" min="0.1" max="1" step="0.05" value={watermarkAlpha} disabled={running} onChange={(event) => setWatermarkAlpha(Number(event.target.value))} /></label><label>{t("image.outputFormat")}<select className="toolbox-input" value={outputFormat} disabled={running} onChange={(event) => setOutputFormat(event.target.value as ImageFormat)}><option value={ImageFormat.png}>PNG</option><option value={ImageFormat.jpg}>JPEG</option><option value={ImageFormat.webp}>WebP</option></select></label>{!desktopRuntime ? <><label className="toolbox-file-pick button button--secondary"><Upload size={14} />{t("image.selectLogo")}<input hidden type="file" accept="image/png,image/jpeg,image/webp" disabled={running} onChange={(event) => void selectLogo(event.target.files?.[0])} /></label><label className="toolbox-file-pick button button--secondary"><Upload size={14} />{t("image.selectFont")}<input hidden type="file" accept=".ttf,.otf,.woff,.woff2,font/*" disabled={running} onChange={(event) => selectFont(event.target.files?.[0])} /></label></> : <><label className="image-editor__native-asset"><input type="checkbox" checked={requestNativeLogo} disabled={running} onChange={(event) => setRequestNativeLogo(event.target.checked)} />{t("image.nativeLogo")}</label><label className="image-editor__native-asset"><input type="checkbox" checked={requestNativeFont} disabled={running} onChange={(event) => setRequestNativeFont(event.target.checked)} />{t("image.nativeFont")}</label><p className="toolbox-hint">{t("image.nativeFontHint")}</p></>}{fontFile ? <p className="toolbox-hint">{t("image.fontSummary", { name: safeOutputName(fontFile.name) })}</p> : null}{logoFile ? <p className="toolbox-hint">{t("image.logoSummary", { name: safeOutputName(logoFile.name) })} <input type="number" min="0.01" max="100" step="0.05" value={logoScale} disabled={running} onChange={(event) => setLogoScale(Number(event.target.value))} /> · {t("image.rotation")} <input type="number" min="0" max="360" value={logoRotation} disabled={running} onChange={(event) => setLogoRotation(Number(event.target.value))} /> · {t("image.opacity")} <input type="range" min="0.1" max="1" step="0.05" value={logoAlpha} disabled={running} onChange={(event) => setLogoAlpha(Number(event.target.value))} /></p> : null}</div> : null}
      {toolId === "image-recipe" || toolId === "image-editor" ? <ImageRecipeEditor marker={marker} desktopRuntime={desktopRuntime} disabled={running || !hostExecutorAvailable || (!desktopRuntime && files.length === 0)} onPreview={runRecipeEditor} onError={setError} onNotice={setNotice} deliverOutput={deliverFormalOutput} /> : null}
      {toolId === "c2pa-inspector" ? <div className="toolbox-inline-actions">{!desktopRuntime ? <label className="toolbox-file-pick button button--secondary"><Upload size={14} />{t("image.selectManifest")}<input hidden type="file" accept="application/json,.json,text/json" disabled={running} onChange={(event) => selectManifest(event.target.files?.[0])} /></label> : <span className="toolbox-hint"><FileImage size={14} />{t("image.nativeManifestHint")}</span>}<button className="button button--primary" type="button" disabled={running || Boolean(nativeOutput) || (!desktopRuntime && !manifestFile)} onClick={runManifest}><Play size={14} />{t("image.inspectManifest")}</button>{running ? <button className="button button--secondary" type="button" disabled={stopping} onClick={() => void stop()}><Square size={14} />{stopping ? t("image.stopping") : t("image.stop")}</button> : null}<button className="button button--secondary" type="button" disabled={running} onClick={() => { void cancelNativeOutput(); setManifestFile(null); setManifestReport(""); if (manifestDownloadUrlRef.current) URL.revokeObjectURL(manifestDownloadUrlRef.current); manifestDownloadUrlRef.current = ""; setManifestDownloadUrl(""); setNotice(""); setError(""); }}><RotateCcw size={14} />{t("image.clear")}</button></div> : toolId === "image-recipe" || toolId === "image-editor" ? <div className="toolbox-inline-actions">{running ? <button className="button button--secondary" type="button" disabled={stopping} onClick={() => void stop()}><Square size={14} />{stopping ? t("image.stopping") : t("image.stop")}</button> : null}<button className="button button--secondary" type="button" disabled={running} onClick={() => { void cancelNativeOutput(); setFiles([]); releaseOutputs(); setRecipientDelivery(null); setNotice(""); setError(""); }}><RotateCcw size={14} />{t("image.clear")}</button></div> : <div className="toolbox-inline-actions"><button className="button button--primary" type="button" disabled={running || Boolean(nativeOutput) || !hostExecutorAvailable || (!desktopRuntime && files.length === 0)} onClick={action}><Play size={14} />{stopping ? t("image.stopping") : running ? t("image.processing") : actionLabel(toolId, t)}</button>{running ? <button className="button button--secondary" type="button" disabled={stopping} onClick={() => void stop()}><Square size={14} />{stopping ? t("image.stopping") : t("image.stop")}</button> : null}<button className="button button--secondary" type="button" disabled={running} onClick={() => { void cancelNativeOutput(); setFiles([]); setLogoFile(null); setFontFile(null); releaseOutputs(); setRecipientDelivery(null); setNotice(""); setError(""); }}><RotateCcw size={14} />{t("image.clear")}</button></div>}
      {running ? <progress max="1" value={progress} /> : null}
      {error ? <p className="toolbox-error" role="alert">{error}</p> : null}
      {notice ? <pre className="toolbox-notice">{notice}</pre> : null}
      {manifestReport ? <div className="toolbox-output"><pre className="toolbox-notice">{manifestReport}</pre>{manifestDownloadUrl && !desktopRuntime ? <a className="button button--secondary" download="corerobin-c2pa-manifest-report.json" href={manifestDownloadUrl}><Download size={14} />{t("image.downloadReport")}</a> : null}</div> : null}
      {robustnessReport ? <div className="toolbox-output"><pre className="toolbox-notice">{robustnessReport}</pre></div> : null}
      {toolId === "recipient-tracking" && recipientDelivery ? <p className={recipientDelivery.status === "ready" ? "toolbox-hint" : "toolbox-error"} role={recipientDelivery.status === "ready" ? undefined : "alert"}>{t("image.recipientStatusLabel")}: {t(`image.recipientStatus.${recipientDelivery.status}`)} · {recipientDelivery.delivered}/{recipientDelivery.requested} · {recipientDelivery.detail}</p> : null}
      {result ? <div className="image-toolbox__result"><img src={result.uri} alt={t("image.resultAlt")} /><div className="toolbox-inline-actions">{nativeOutput?.outputToken ? <><button className="button button--secondary" type="button" onClick={() => void saveNativeOutput()}><Download size={14} />{t("image.saveFormal")}</button><button className="button button--secondary" type="button" onClick={() => void cancelNativeOutput()}>{t("image.cancelTemporary")}</button></> : null}{deliverFormalOutput ? <button className="button button--secondary" type="button" onClick={() => void deliverFormalOutput(markerResultOutput(result)).then(() => setNotice(t("image.handedToProvider")), (reason: unknown) => setError(reason instanceof Error ? reason.message : t("image.formalDeliveryFailed")))}><Download size={14} />{t("image.deliverFormal")}</button> : null}{!desktopRuntime ? <a className="button button--secondary" download={result.filename ?? "corerobin-watermarked.png"} href={result.uri}><Download size={14} />{t("image.downloadPreview")}</a> : null}<span className="toolbox-hint">{resultLabel(result)}{nativeOutput?.outputToken ? ` · ${t("image.nativeOutputSummary", { sizeKiB: Math.ceil(nativeOutput.outputToken.byteLength / 1024) })}` : ""}</span></div></div> : null}
      {!result && nativeOutput?.outputToken ? <div className="toolbox-inline-actions"><button className="button button--secondary" type="button" onClick={() => void saveNativeOutput()}><Download size={14} />{t("image.saveFormal")}</button><button className="button button--secondary" type="button" onClick={() => void cancelNativeOutput()}>{t("image.cancelTemporary")}</button><span className="toolbox-hint">{t("image.nativeOutputSummary", { sizeKiB: Math.ceil(nativeOutput.outputToken.byteLength / 1024) })}</span></div> : null}
      {zipUrl && !desktopRuntime ? <a className="button button--primary" download="corerobin-watermarks.zip" href={zipUrl}><Download size={14} />{t("image.downloadZip")}</a> : null}
    </div>
    <div className="toolbox-tool-layout__footer"><span>{t("image.footer")}</span></div>
  </div>;
}

function actionLabel(toolId: ImageToolId, t: TFunction<"toolbox">): string {
  if (toolId === "invisible-watermark-write") return t("image.actions.invisibleWrite");
  if (toolId === "invisible-watermark-check") return t("image.actions.invisibleCheck");
  if (toolId === "recipient-tracking") return t("image.actions.recipient");
  if (toolId === "robustness-lab") return t("image.actions.robustness");
  if (toolId === "image-recipe" || toolId === "image-editor") return t("image.actions.recipe");
  return toolId === "image-batch-watermark" ? t("image.actions.batch") : t("image.actions.watermark");
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
