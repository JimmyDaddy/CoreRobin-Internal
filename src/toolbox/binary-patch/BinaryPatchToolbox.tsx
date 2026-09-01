import { ArrowDown, ArrowUp, Braces, CheckCircle2, CircleAlert, Download, FileCheck2, FileDiff, FileOutput, Info, Play, Square, Trash2 } from "lucide-react";
import type { TFunction } from "i18next";
import { useEffect, useMemo, useRef, useState, type ChangeEvent } from "react";
import { useTranslation } from "react-i18next";
import { classifyPatchError } from "bs-diff-patch-web";
import {
  applyPatchAndVerify,
  inspectPatchSafely,
  isPatchTaskCancelled,
  calculateTransferSavings,
  createPatchCollection,
  makePatchManifest,
  manifestJson,
  planPatches,
  planPatchesFromSources,
  patchInputLimit,
  generateVerifiedPatch,
  isPatchTaskTimedOut,
  patchDeadlineForTool,
  runWithPatchDeadline,
} from "./binaryPatchTools";
import { isTerminalJobStatus, type ToolboxError, type ToolboxJob, type ToolId } from "../contracts";
import { cancelToolboxJob, cancelToolboxOutput, exportToolboxOutput, finishToolboxJob, newToolboxRequest, prepareToolboxInputs, registerToolboxOutput, releaseToolboxInputs, revalidateToolboxInputs, startToolboxSession } from "../client";
import { isDesktopRuntime } from "../../api";
import { fileJobKey, readBoundToolboxInput } from "../runtime/files";
import type { ToolboxFileJobKey, ToolboxInputToken } from "../contracts";
import { formatBytes } from "../../utils";
import "./binaryPatch.css";

type BinaryToolId = Extract<ToolId, "binary-patch-create" | "binary-patch-apply" | "binary-patch-inspector" | "integrity-manifest" | "transfer-savings" | "patch-errors" | "patch-planner">;
type BinaryInputKind = "baseline" | "target" | "patch" | "expected";
type BinaryFileInputKind = BinaryInputKind | "plannerBaselines";
type NativeInputRole = "input" | "target" | "patch" | "expected";
type ToolboxTFunction = TFunction<"toolbox">;

const NATIVE_INPUT_ROLES = {
  baseline: "input",
  target: "target",
  patch: "patch",
  expected: "expected",
} as const satisfies Record<BinaryInputKind, NativeInputRole>;

interface BinaryOutput {
  bytes: Uint8Array;
  filename: string;
  validation: "verified" | "unverified";
  copyOnlyConfirmed?: boolean;
}

interface BinaryInputReader {
  (file: File | null, input: BinaryInputKind, max?: number, index?: number, signal?: AbortSignal): Promise<Uint8Array>;
  count(input: BinaryInputKind): Promise<number>;
}

interface BinaryDiffLine {
  offset: number;
  baseline: Uint8Array;
  target: Uint8Array;
}

interface BinaryDiffPreview {
  lines: BinaryDiffLine[];
  omittedRows: number;
}

interface PendingNativeCleanup {
  job: ToolboxJob;
  outcome: "cancelled" | "deadline" | "failed";
}

async function registerNativeOutput(job: ToolboxJob, output: BinaryOutput, signal: AbortSignal): Promise<ToolboxJob> {
  let registered: ToolboxJob | null = null;
  let cancellation: Promise<void> | null = null;
  const cancelRegisteredOutput = () => {
    const ready = registered;
    const nativeOutput = ready?.outputToken;
    if (!nativeOutput) return Promise.resolve();
    cancellation ??= cancelToolboxOutput({
      requestId: crypto.randomUUID(),
      jobId: ready.jobId,
      outputToken: nativeOutput.token,
      generation: ready.generation,
      resetEpoch: ready.resetEpoch,
    }).then(() => undefined);
    return cancellation;
  };
  const abortRegistration = () => { void cancelRegisteredOutput().catch(() => undefined); };
  signal.addEventListener("abort", abortRegistration, { once: true });
  try {
    signal.throwIfAborted();
    const ready = await registerToolboxOutput({
      ...newToolboxRequest(),
      jobId: job.jobId,
      generation: job.generation,
      resetEpoch: job.resetEpoch,
      bytes: output.bytes,
      validation: output.validation,
    });
    registered = ready;
    if (signal.aborted) {
      await cancelRegisteredOutput();
      signal.throwIfAborted();
    }
    return ready;
  } finally {
    signal.removeEventListener("abort", abortRegistration);
  }
}

export function BinaryPatchToolbox({ toolId }: { toolId: BinaryToolId }) {
  const { t } = useTranslation("toolbox");
  const [baseline, setBaseline] = useState<File | null>(null);
  const [target, setTarget] = useState<File | null>(null);
  const [patch, setPatch] = useState<File | null>(null);
  const [expected, setExpected] = useState<File | null>(null);
  const [plannerBaselines, setPlannerBaselines] = useState<File[]>([]);
  const [nativeExpectedRequested, setNativeExpectedRequested] = useState(false);
  const [output, setOutput] = useState("");
  const [downloadUrl, setDownloadUrl] = useState("");
  const [downloadName, setDownloadName] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [byteDiff, setByteDiff] = useState<BinaryDiffPreview | null>(null);
  const [running, setRunning] = useState(false);
  const [pendingNativeCleanup, setPendingNativeCleanup] = useState<PendingNativeCleanup | null>(null);
  const [nativeOutput, setNativeOutput] = useState<ToolboxJob | null>(null);
  const nativeOutputRef = useRef<ToolboxJob | null>(null);
  const [nativeOutputName, setNativeOutputName] = useState("");
  const controllerRef = useRef<AbortController | null>(null);

  const setPreparedOutput = (job: ToolboxJob | null, filename = "") => {
    nativeOutputRef.current = job;
    setNativeOutput(job);
    setNativeOutputName(filename);
  };

  useEffect(() => () => { controllerRef.current?.abort(); }, []);
  useEffect(() => () => {
    const job = nativeOutputRef.current;
    const output = job?.outputToken;
    if (job && output) {
      void cancelToolboxOutput({ requestId: crypto.randomUUID(), jobId: job.jobId, outputToken: output.token, generation: job.generation, resetEpoch: job.resetEpoch });
    }
  }, []);
  useEffect(() => () => { if (downloadUrl) URL.revokeObjectURL(downloadUrl); }, [downloadUrl]);

  const choose = (setter: (file: File | null) => void) => (event: ChangeEvent<HTMLInputElement>) => setter(event.target.files?.[0] ?? null);
  const chooseMany = (event: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files ?? []);
    if (files.length > 8) { setError(t("binaryPatch.errors.tooManyBaselines")); return; }
    setPlannerBaselines(files);
    setError("");
  };

  const clearDownload = () => {
    setDownloadUrl((old) => { if (old) URL.revokeObjectURL(old); return ""; });
    setDownloadName("");
  };

  const retainNativeCleanup = (job: ToolboxJob, outcome: PendingNativeCleanup["outcome"]) => {
    setPendingNativeCleanup({ job, outcome });
    const message = t("binaryPatch.errors.nativeLifecycleUnconfirmed", { message: t("binaryPatch.errors.unknownLifecycleState") });
    setError(message);
    setOutput(JSON.stringify({ state: "stopping", note: message }, null, 2));
  };

  const retryNativeCancellation = async () => {
    const pending = pendingNativeCleanup;
    if (!pending) return;
    try {
      const lifecycleJob = await cancelToolboxJob({ ...newToolboxRequest(), jobId: pending.job.jobId });
      if (!isTerminalJobStatus(lifecycleJob.status)) {
        retainNativeCleanup(pending.job, pending.outcome);
        return;
      }
      setPendingNativeCleanup(null);
      if (pending.outcome === "cancelled" && lifecycleJob.status === "cancelled") {
        setOutput(JSON.stringify({ state: "cancelled", note: t("binaryPatch.output.cancelledNote") }, null, 2));
        setError(t("binaryPatch.errors.cancelled"));
      } else if (pending.outcome === "deadline") {
        setOutput(JSON.stringify({ state: "deadline_exceeded", note: t("binaryPatch.errors.executionFailed") }, null, 2));
        setError(t("binaryPatch.errors.executionFailed"));
      } else {
        setOutput("");
        setError(t("binaryPatch.errors.executionFailed"));
      }
    } catch {
      retainNativeCleanup(pending.job, pending.outcome);
    }
  };

  const run = async (task: (signal: AbortSignal, readInput: BinaryInputReader) => Promise<BinaryOutput | null>) => {
    if (running || pendingNativeCleanup || nativeOutputRef.current) return;
    const controller = new AbortController();
    controllerRef.current = controller;
    setRunning(true);
    setError("");
    setOutput("");
    setByteDiff(null);
    clearDownload();
    let nativeJob: ToolboxJob | null = null;
    let nativeInputJob: ToolboxFileJobKey | null = null;
    let operationSignal = controller.signal;
    const nativeTokens = new Map<NativeInputRole, ToolboxInputToken[]>();
    const nativeTokenList: ToolboxInputToken[] = [];
    const ensureNativeTokens = async (input: BinaryInputKind): Promise<ToolboxInputToken[]> => {
      const nativeRole = NATIVE_INPUT_ROLES[input];
      let tokens = nativeTokens.get(nativeRole);
      if (!tokens) {
        tokens = await prepareToolboxInputs(nativeInputJob!, nativeRole);
        nativeTokens.set(nativeRole, tokens);
        nativeTokenList.push(...tokens);
      }
      return tokens;
    };
    const readInput = Object.assign(async (file: File | null, input: BinaryInputKind, max = patchInputLimit(input), index = 0, signal?: AbortSignal) => {
      const label = binaryInputLabel(input, t);
      const readSignal = signal ?? operationSignal;
      if (!nativeInputJob) return readBrowserInput(file, label, max, readSignal);
      const tokens = await ensureNativeTokens(input);
      const token = tokens[index];
      if (!token) throw new Error(t("binaryPatch.errors.nativePickerMissing", { label }));
      const bytes = await readBoundToolboxInput(nativeInputJob, token, readSignal, max);
      return bytes;
    }, { count: async (input: BinaryInputKind) => (nativeInputJob ? (await ensureNativeTokens(input)).length : 0) }) as BinaryInputReader;
    try {
      if (isDesktopRuntime()) {
        nativeJob = await startToolboxSession({ ...newToolboxRequest(), toolId });
        nativeInputJob = fileJobKey(nativeJob);
      }
      await runWithPatchDeadline(async (signal) => {
        operationSignal = signal;
        const formalOutput = await task(signal, readInput);
        signal.throwIfAborted();
        if (nativeInputJob) {
          await revalidateToolboxInputs(nativeInputJob);
          signal.throwIfAborted();
          if (nativeTokenList.length > 0) {
            await releaseToolboxInputs(nativeInputJob, nativeTokenList.map((token) => token.token));
            nativeTokenList.length = 0;
          }
          signal.throwIfAborted();
        }
        if (nativeJob && formalOutput) {
          if (formalOutput.validation !== "verified" && !formalOutput.copyOnlyConfirmed) {
            throw new Error(t("binaryPatch.errors.unverifiedOutputCancelled"));
          }
          const ready = await registerNativeOutput(nativeJob, formalOutput, signal);
          signal.throwIfAborted();
          setPreparedOutput(ready, formalOutput.filename);
          setOutput((current) => `${current}\n\n${t("binaryPatch.notices.nativeOutputReady")}`);
        } else if (nativeJob) {
          signal.throwIfAborted();
          await finishToolboxJob({ ...newToolboxRequest(), jobId: nativeJob.jobId, succeeded: true });
          signal.throwIfAborted();
        }
        return formalOutput;
      }, controller.signal, patchDeadlineForTool(toolId));
    } catch (reason) {
      const cancelled = isPatchTaskCancelled(reason);
      const timedOut = isPatchTaskTimedOut(reason);
      if (cancelled || timedOut) {
        clearDownload();
        setByteDiff(null);
        setPreparedOutput(null);
        setOutput("");
      }
      let lifecycleJob: ToolboxJob | null = null;
      let lifecycleUnconfirmed = false;
      if (nativeJob) {
        try {
          lifecycleJob = cancelled
            ? await cancelToolboxJob({ ...newToolboxRequest(), jobId: nativeJob.jobId })
            : await finishToolboxJob({ ...newToolboxRequest(), jobId: nativeJob.jobId, succeeded: false, error: toToolboxError(reason, t("binaryPatch.errors.executionFailed")) });
          if (isTerminalJobStatus(lifecycleJob.status)) nativeTokenList.length = 0;
          else {
            nativeTokenList.length = 0;
            lifecycleUnconfirmed = true;
            retainNativeCleanup(nativeJob, cancelled ? "cancelled" : timedOut ? "deadline" : "failed");
          }
        } catch {
          nativeTokenList.length = 0;
          lifecycleUnconfirmed = true;
          retainNativeCleanup(nativeJob, cancelled ? "cancelled" : timedOut ? "deadline" : "failed");
        }
      }
      if (cancelled && (!nativeJob || lifecycleJob?.status === "cancelled")) {
        setOutput(JSON.stringify({ state: "cancelled", note: t("binaryPatch.output.cancelledNote") }, null, 2));
        setError(t("binaryPatch.errors.cancelled"));
      } else if (!lifecycleUnconfirmed) setError(localizedPatchError(reason, t));
    } finally {
      if (nativeInputJob && nativeTokenList.length > 0) {
        try {
          await releaseToolboxInputs(nativeInputJob, nativeTokenList.map((token) => token.token));
        } catch {
          nativeTokenList.length = 0;
          if (nativeJob) retainNativeCleanup(nativeJob, "failed");
          else setError(t("binaryPatch.errors.inputReleaseUnconfirmed", { message: t("binaryPatch.errors.unknownReleaseState") }));
        }
      }
      controllerRef.current = null;
      setRunning(false);
    }
  };

  const saveNativeOutput = async () => {
    const job = nativeOutputRef.current;
    const output = job?.outputToken;
    if (!job || !output) return;
    try {
      const { save } = await import("@tauri-apps/plugin-dialog");
      const selected = await save({ defaultPath: nativeOutputName || "corerobin-output.bin" });
      if (!selected) return;
      await exportToolboxOutput({ requestId: crypto.randomUUID(), jobId: job.jobId, outputToken: output.token, generation: job.generation, resetEpoch: job.resetEpoch, path: selected });
      setPreparedOutput(null);
      setNotice(t("binaryPatch.notices.savedAtomically"));
    } catch {
      setError(t("binaryPatch.errors.saveFailed"));
    }
  };

  const cancelNativeOutput = async () => {
    const job = nativeOutputRef.current;
    const output = job?.outputToken;
    if (!job || !output) return;
    try {
      await cancelToolboxOutput({ requestId: crypto.randomUUID(), jobId: job.jobId, outputToken: output.token, generation: job.generation, resetEpoch: job.resetEpoch });
      setPreparedOutput(null);
      clearDownload();
      setNotice(t("binaryPatch.notices.temporaryOutputCancelled"));
    } catch {
      setError(t("binaryPatch.errors.cancelFailed"));
    }
  };

  const readBrowserInput = async (file: File | null, role: string, max: number, signal?: AbortSignal): Promise<Uint8Array> => {
    if (!file) throw new Error(t("binaryPatch.errors.selectFile", { label: role }));
    if (file.size > max) throw new Error(t("binaryPatch.errors.fileTooLarge", { label: role, max: Math.round(max / 1024 / 1024) }));
    signal?.throwIfAborted();
    const bytes = new Uint8Array(await file.arrayBuffer());
    signal?.throwIfAborted();
    return bytes;
  };

  const setDownload = (bytes: Uint8Array, name: string, mime: string) => {
    if (isDesktopRuntime()) return;
    const copy = bytes.slice();
    setDownloadUrl((old) => { if (old) URL.revokeObjectURL(old); return URL.createObjectURL(new Blob([copy.buffer as ArrayBuffer], { type: mime })); });
    setDownloadName(name);
  };

  const execute = () => {
    clearDownload();
    if (toolId === "transfer-savings") {
      const fullInput = window.prompt(t("binaryPatch.prompts.fullSize"), "1000000");
      const patchInput = window.prompt(t("binaryPatch.prompts.patchSize"), "100000");
      const countInput = window.prompt(t("binaryPatch.prompts.downloadCount"), "1");
      if (fullInput === null || patchInput === null || countInput === null) return;
      try {
        setByteDiff(null);
        setOutput(JSON.stringify(calculateTransferSavings(Number(fullInput), Number(patchInput), Number(countInput)), null, 2));
      } catch (reason) { setError(localizedPatchError(reason, t)); }
      return;
    }
    if (toolId === "patch-errors") {
      const classified = classifyPatchError(new Error(window.prompt(t("binaryPatch.prompts.errorCode"), "EPATCH") ?? "EPATCH"));
      setByteDiff(null);
      setOutput(JSON.stringify(classified, null, 2));
      return;
    }
    void run(async (signal, readInput) => {
      if (toolId === "binary-patch-create") {
        const baselineBytes = await readInput(baseline, "baseline");
        const targetBytes = await readInput(target, "target", 16 * 1024 * 1024);
        const result = await generateVerifiedPatch(baselineBytes, targetBytes, signal);
        setByteDiff(createBinaryDiffPreview(baselineBytes, targetBytes));
        setOutput(JSON.stringify({ patchBytes: result.patch.byteLength, verification: result.verification, baselineSha256: result.baselineSha256, targetSha256: result.targetSha256 }, null, 2));
        setDownload(result.patch, "corerobin.endsley.patch", "application/octet-stream");
        return { bytes: result.patch, filename: "corerobin.endsley.patch", validation: "verified" };
      }
      if (toolId === "binary-patch-apply") {
        const expectedBytes = isDesktopRuntime()
          ? nativeExpectedRequested ? await readInput(null, "expected") : undefined
          : expected ? await readInput(expected, "expected") : undefined;
        const baselineBytes = await readInput(baseline, "baseline", 16 * 1024 * 1024);
        const applied = await applyPatchAndVerify(baselineBytes, await readInput(patch, "patch"), expectedBytes, signal);
        setByteDiff(createBinaryDiffPreview(baselineBytes, applied.output));
        if (!applied.verification) {
          const unverified = { validation: "unverified", state: "unverified_without_expected_target", outputBytes: applied.output.byteLength, note: t("binaryPatch.output.unverifiedNote") };
          setOutput(JSON.stringify(unverified, null, 2));
          if (!window.confirm(t("binaryPatch.unverified.confirm"))) {
            setError(t("binaryPatch.errors.unverifiedNotConfirmed"));
            throw new Error(t("binaryPatch.errors.unverifiedOutputCancelled"));
          }
        } else setOutput(JSON.stringify({ outputBytes: applied.output.byteLength, verification: applied.verification }, null, 2));
        setDownload(applied.output, "corerobin-restored.bin", "application/octet-stream");
        return { bytes: applied.output, filename: "corerobin-restored.bin", validation: applied.verification ? "verified" : "unverified", copyOnlyConfirmed: !applied.verification };
      }
      if (toolId === "binary-patch-inspector") {
        setOutput(JSON.stringify(await inspectPatchSafely(await readInput(patch, "patch")), null, 2));
        return null;
      }
      if (toolId === "integrity-manifest") {
        const baselineBytes = await readInput(baseline, "baseline");
        const targetBytes = await readInput(target, "target");
        const patchBytes = await readInput(patch, "patch");
        setByteDiff(createBinaryDiffPreview(baselineBytes, targetBytes));
        let verification: { status: "verified" | "unverified"; method: "replay_byte_exact"; reason?: string };
        try {
          const replay = await applyPatchAndVerify(baselineBytes, patchBytes, targetBytes, signal);
          verification = replay.verification?.verified && replay.byteExact
            ? { status: "verified", method: "replay_byte_exact" }
            : { status: "unverified", method: "replay_byte_exact", reason: "REPLAY_MISMATCH" };
        } catch (reason) {
          if (isPatchTaskCancelled(reason)) throw reason;
          verification = { status: "unverified", method: "replay_byte_exact", reason: classifyPatchError(reason).code };
        }
        const manifest = manifestJson({
          ...await makePatchManifest(baselineBytes, patchBytes, targetBytes, { baseline: baseline?.name, patch: patch?.name, target: target?.name }),
          verification,
        });
        const bytes = new TextEncoder().encode(manifest);
        setOutput(manifest);
        setDownload(bytes, "corerobin-patch-manifest.json", "application/json");
        return { bytes, filename: "corerobin-patch-manifest.json", validation: verification.status };
      }
      if (toolId === "patch-planner") {
        const targetBytes = await readInput(target, "target", 16 * 1024 * 1024);
        if (isDesktopRuntime()) {
          const baseCount = await readInput.count("baseline");
          const sources = Array.from({ length: baseCount }, (_, index) => ({
            name: `baseline-${index + 1}.bin`,
            load: (sourceSignal: AbortSignal) => readInput(null, "baseline", 16 * 1024 * 1024, index, sourceSignal),
          }));
          const plan = await planPatchesFromSources(targetBytes, sources, 0.8, signal);
          const collection = await createPatchCollection({ name: target?.name ?? "target.bin", data: targetBytes }, plan, undefined, signal);
          setOutput(manifestJson(collection.plan));
          return { bytes: collection.bytes, filename: collection.filename, validation: "verified" };
        } else {
          const bases = [];
          for (const file of plannerBaselines) bases.push({ name: file.name, data: await readInput(file, "baseline", 16 * 1024 * 1024) });
          const plan = await planPatches(targetBytes, bases, 0.8, signal);
          const collection = await createPatchCollection({ name: target?.name ?? "target.bin", data: targetBytes }, plan, undefined, signal);
          setOutput(manifestJson(collection.plan));
          setDownload(collection.bytes, collection.filename, "application/zip");
          return { bytes: collection.bytes, filename: collection.filename, validation: "verified" };
        }
      }
      return null;
    });
  };

  const needs: BinaryFileInputKind[] = toolId === "binary-patch-create" ? ["baseline", "target"] : toolId === "binary-patch-apply" ? ["baseline", "patch", "expected"] : toolId === "binary-patch-inspector" ? ["patch"] : toolId === "integrity-manifest" ? ["baseline", "patch", "target"] : toolId === "patch-planner" ? ["target", "plannerBaselines"] : [];

  return <div className="toolbox-tool-layout binary-patch-toolbox"><div className="toolbox-tool-layout__body binary-patch-toolbox__body">
    <section className="binary-patch-toolbox__inputs" aria-label={t("binaryPatch.hint")}>
      <p className="binary-patch-toolbox__hint"><Info size={16} />{t("binaryPatch.hint")}</p>
      <div className="binary-patch-toolbox__input-grid">
        {needs.map((input) => input === "baseline" ? <FileInput key={input} t={t} label={binaryInputLabel(input, t)} file={baseline} onChange={choose(setBaseline)} desktop={isDesktopRuntime()} /> : input === "target" ? <FileInput key={input} t={t} label={binaryInputLabel(input, t)} file={target} onChange={choose(setTarget)} desktop={isDesktopRuntime()} /> : input === "patch" ? <FileInput key={input} t={t} label={binaryInputLabel(input, t)} file={patch} onChange={choose(setPatch)} desktop={isDesktopRuntime()} /> : input === "expected" ? <FileInput key={input} t={t} label={binaryInputLabel(input, t)} file={expected} onChange={choose(setExpected)} optional desktop={isDesktopRuntime()} /> : <FileInput key={input} t={t} label={binaryInputLabel(input, t)} files={plannerBaselines} onChange={chooseMany} multiple desktop={isDesktopRuntime()} />)}
      </div>
      {toolId === "binary-patch-apply" && isDesktopRuntime() ? <label className="binary-patch-toolbox__expected"><input type="checkbox" checked={nativeExpectedRequested} disabled={running} onChange={(event) => setNativeExpectedRequested(event.target.checked)} /> {t("binaryPatch.unverified.nativeExpected")}</label> : null}
    </section>
    {toolId === "binary-patch-apply" && !expected && !nativeExpectedRequested ? <p className="toolbox-error" role="alert">{t("binaryPatch.unverified.missingExpected")}</p> : null}
    <div className="toolbox-inline-actions binary-patch-toolbox__actions"><button className="button button--primary" type="button" disabled={running || Boolean(pendingNativeCleanup) || Boolean(nativeOutput)} onClick={execute}><Play size={14} />{running ? t("binaryPatch.actions.processing") : binaryActionLabel(toolId, t)}</button>{running || pendingNativeCleanup ? <button className="button button--secondary" type="button" onClick={() => { if (pendingNativeCleanup) void retryNativeCancellation(); else controllerRef.current?.abort(); }}><Square size={14} />{t("binaryPatch.actions.stop")}</button> : null}<button className="button button--secondary" type="button" disabled={Boolean(pendingNativeCleanup)} onClick={() => { void cancelNativeOutput(); setOutput(""); setByteDiff(null); setNotice(""); setError(""); clearDownload(); }}><Trash2 size={14} />{t("binaryPatch.actions.clear")}</button></div>
    {error ? <p className="toolbox-error" role="alert">{error}</p> : null}{notice ? <p className="toolbox-hint">{notice}</p> : null}
    {output ? <BinaryPatchResult output={output} title={binaryActionLabel(toolId, t)} baselineLabel={binaryInputLabel("baseline", t)} targetLabel={binaryInputLabel("target", t)} byteDiff={byteDiff} /> : null}
    {nativeOutput?.outputToken ? <div className="toolbox-inline-actions binary-patch-toolbox__delivery"><button className="button button--secondary" type="button" onClick={() => void saveNativeOutput()}><Download size={14} />{t("binaryPatch.actions.saveNative")}</button><button className="button button--secondary" type="button" onClick={() => void cancelNativeOutput()}>{t("binaryPatch.actions.cancelNative")}</button><span className="toolbox-hint">{t("binaryPatch.nativeOutput.ttl", { size: Math.ceil(nativeOutput.outputToken.byteLength / 1024) })}</span></div> : null}
    {!isDesktopRuntime() && downloadUrl ? <a className="button button--secondary binary-patch-toolbox__delivery" download={downloadName} href={downloadUrl}><Download size={14} />{toolId === "patch-planner" ? t("binaryPatch.actions.downloadPlan") : t("binaryPatch.actions.downloadPreview")}</a> : null}
  </div><div className="toolbox-tool-layout__footer"><span>{t("binaryPatch.footer")}</span></div></div>;
}

function toToolboxError(reason: unknown, fallback: string): ToolboxError {
  return {
    code: isPatchTaskTimedOut(reason) ? "binary_patch_deadline" : "binary_patch_failed",
    message: fallback,
    retryable: isPatchTaskTimedOut(reason),
  };
}

function FileInput({ t, label, file, files, onChange, multiple, optional, desktop }: { t: ToolboxTFunction; label: string; file?: File | null; files?: File[]; onChange: (event: ChangeEvent<HTMLInputElement>) => void; multiple?: boolean; optional?: boolean; desktop?: boolean }) {
  const selected = desktop
    ? t("binaryPatch.fileInput.nativePicker")
    : file
      ? t("binaryPatch.fileInput.selected", { filename: file.name })
      : files?.length
        ? t("binaryPatch.fileInput.selectedCount", { count: files.length })
        : optional
          ? t("binaryPatch.fileInput.notSelected")
          : "";
  if (desktop) {
    return <div className="toolbox-file-pick binary-patch-toolbox__file binary-patch-toolbox__file--native" aria-label={label}><span className="binary-patch-toolbox__file-icon"><FileCheck2 size={16} /></span><span className="binary-patch-toolbox__file-copy"><strong>{label}</strong><small>{selected}</small></span></div>;
  }
  return <label className="toolbox-file-pick button button--secondary binary-patch-toolbox__file"><span className="binary-patch-toolbox__file-icon"><FileCheck2 size={16} /></span><span className="binary-patch-toolbox__file-copy"><strong>{label}</strong><small>{selected}</small></span><input hidden type="file" multiple={multiple} onChange={onChange} /></label>;
}

function BinaryPatchResult({ output, title, baselineLabel, targetLabel, byteDiff }: { output: string; title: string; baselineLabel: string; targetLabel: string; byteDiff: BinaryDiffPreview | null }) {
  const structuredOutput = useMemo(() => parseStructuredOutput(output), [output]);
  const facts = useMemo(() => structuredOutput ? collectResultFacts(structuredOutput) : [], [structuredOutput]);
  const patchMetadata = useMemo(() => structuredOutput ? findPatchMetadata(structuredOutput) : null, [structuredOutput]);
  const planRows = useMemo(() => structuredOutput ? findPlanRows(structuredOutput) : [], [structuredOutput]);
  const verified = structuredOutput ? findVerification(structuredOutput) : null;

  return <section className="binary-patch-toolbox__result" aria-live="polite" aria-label={title}>
    <header className="binary-patch-toolbox__result-header">
      <span className="binary-patch-toolbox__result-icon"><FileOutput size={17} /></span>
      <strong>{title}</strong>
      {verified === true ? <span className="binary-patch-toolbox__verification is-verified"><CheckCircle2 size={14} />verified</span> : verified === false ? <span className="binary-patch-toolbox__verification is-unverified"><CircleAlert size={14} />unverified</span> : null}
    </header>
    {facts.length > 0 ? <dl className="binary-patch-toolbox__facts">{facts.map((fact) => <div key={fact.path}><dt>{fact.path}</dt><dd title={fact.raw}>{fact.value}</dd></div>)}</dl> : null}
    {patchMetadata ? <PatchInformation metadata={patchMetadata} /> : null}
    {planRows.length > 0 ? <PatchPlanRows rows={planRows} title={title} /> : null}
    {byteDiff ? <BinaryDiffPreviewView preview={byteDiff} baselineLabel={baselineLabel} targetLabel={targetLabel} /> : null}
    <details className="binary-patch-toolbox__raw-result">
      <summary><Braces size={15} />{title}</summary>
      <pre>{output}</pre>
    </details>
  </section>;
}

function PatchInformation({ metadata }: { metadata: PatchMetadataRecord }) {
  return <section className="binary-patch-toolbox__patch-info" aria-label={metadata.format}>
    <header><FileDiff size={16} /><code>{metadata.format}</code></header>
    <dl>
      <div><dt>patchBytes</dt><dd>{formatBytes(metadata.patchBytes)}</dd></div>
      <div><dt>headerBytes</dt><dd>{formatBytes(metadata.headerBytes)}</dd></div>
      <div><dt>payloadBytes</dt><dd>{formatBytes(metadata.payloadBytes)}</dd></div>
      <div><dt>declaredTargetBytes</dt><dd>{metadata.declaredTargetBytes ?? "null"}</dd></div>
    </dl>
  </section>;
}

function PatchPlanRows({ rows, title }: { rows: PatchPlanRow[]; title: string }) {
  return <ul className="binary-patch-toolbox__plan" aria-label={title}>
    {rows.map((row, index) => <li key={`${row.baselineName}-${index}`} className={row.status === "verified" ? "is-verified" : "is-failed"}>
      {row.status === "verified" ? <CheckCircle2 size={15} /> : <CircleAlert size={15} />}
      <code>{row.baselineName}</code>
      <span>{row.patchBytes === null ? row.reason ?? row.errorCode ?? row.status : formatBytes(row.patchBytes)}</span>
    </li>)}
  </ul>;
}

function BinaryDiffPreviewView({ preview, baselineLabel, targetLabel }: { preview: BinaryDiffPreview; baselineLabel: string; targetLabel: string }) {
  return <figure className="binary-patch-toolbox__diff" aria-label={`${baselineLabel} ${targetLabel}`}>
    <figcaption><FileDiff size={16} /><strong>{baselineLabel} <span aria-hidden="true">→</span> {targetLabel}</strong></figcaption>
    <div className="binary-patch-toolbox__diff-table" role="list">
      {preview.lines.map((line) => <div className="binary-patch-toolbox__diff-pair" role="listitem" key={line.offset}>
        <div className="binary-patch-toolbox__diff-line is-removed"><span aria-hidden="true"><ArrowDown size={14} /></span><span className="sr-only">{baselineLabel}</span><code>{formatOffset(line.offset)}</code><code>{hexBytes(line.baseline)}</code></div>
        <div className="binary-patch-toolbox__diff-line is-added"><span aria-hidden="true"><ArrowUp size={14} /></span><span className="sr-only">{targetLabel}</span><code>{formatOffset(line.offset)}</code><code>{hexBytes(line.target)}</code></div>
      </div>)}
      {preview.omittedRows > 0 ? <div className="binary-patch-toolbox__diff-more"><span aria-hidden="true">…</span><span className="sr-only">{preview.omittedRows}</span></div> : null}
    </div>
  </figure>;
}

type StructuredOutput = Record<string, unknown>;

interface PatchMetadataRecord {
  format: string;
  patchBytes: number;
  headerBytes: number;
  payloadBytes: number;
  declaredTargetBytes: string | null;
}

interface PatchPlanRow {
  baselineName: string;
  status: "verified" | "failed";
  patchBytes: number | null;
  reason: string | null;
  errorCode: string | null;
}

interface ResultFact {
  path: string;
  value: string;
  raw: string;
}

function parseStructuredOutput(output: string): StructuredOutput | null {
  try {
    const value: unknown = JSON.parse(output);
    return isRecord(value) ? value : null;
  } catch {
    return null;
  }
}

function collectResultFacts(value: StructuredOutput): ResultFact[] {
  const facts: ResultFact[] = [];
  const collect = (candidate: unknown, path: string) => {
    if (facts.length >= 12) return;
    if (Array.isArray(candidate)) {
      facts.push({ path: `${path}.length`, value: String(candidate.length), raw: String(candidate.length) });
      return;
    }
    if (isRecord(candidate)) {
      for (const [key, child] of Object.entries(candidate)) collect(child, path ? `${path}.${key}` : key);
      return;
    }
    if (candidate === null || ["string", "number", "boolean"].includes(typeof candidate)) {
      const raw = String(candidate);
      facts.push({ path, value: formatFactValue(path, candidate), raw });
    }
  };
  collect(value, "");
  return facts;
}

function formatFactValue(path: string, value: unknown): string {
  if (typeof value === "number" && /Bytes$/.test(path)) return `${formatBytes(value)} (${value} B)`;
  if (typeof value === "number" && /ratio$/i.test(path)) return `${value} (${(value * 100).toFixed(1)}%)`;
  return String(value);
}

function findPatchMetadata(value: unknown): PatchMetadataRecord | null {
  if (!isRecord(value)) return null;
  if (typeof value.format === "string" && typeof value.patchBytes === "number" && typeof value.headerBytes === "number" && typeof value.payloadBytes === "number") {
    return { format: value.format, patchBytes: value.patchBytes, headerBytes: value.headerBytes, payloadBytes: value.payloadBytes, declaredTargetBytes: typeof value.declaredTargetBytes === "string" ? value.declaredTargetBytes : null };
  }
  for (const child of Object.values(value)) {
    const metadata = findPatchMetadata(child);
    if (metadata) return metadata;
  }
  return null;
}

function findPlanRows(value: unknown): PatchPlanRow[] {
  if (!isRecord(value) || !isRecord(value.planning) || !Array.isArray(value.planning.results)) return [];
  return value.planning.results.flatMap((item) => {
    if (!isRecord(item) || typeof item.baselineName !== "string" || (item.status !== "verified" && item.status !== "failed")) return [];
    const errorCode = isRecord(item.error) && typeof item.error.code === "string" ? item.error.code : null;
    return [{ baselineName: item.baselineName, status: item.status, patchBytes: typeof item.patchBytes === "number" ? item.patchBytes : null, reason: typeof item.reason === "string" ? item.reason : null, errorCode }];
  });
}

function findVerification(value: unknown): boolean | null {
  if (!isRecord(value)) return null;
  if (typeof value.verified === "boolean") return value.verified;
  for (const child of Object.values(value)) {
    const verified = findVerification(child);
    if (verified !== null) return verified;
  }
  return null;
}

function createBinaryDiffPreview(baseline: Uint8Array, target: Uint8Array): BinaryDiffPreview | null {
  const rowBytes = 16;
  const maxRows = 8;
  const lines: BinaryDiffLine[] = [];
  let omittedRows = 0;
  for (let offset = 0; offset < Math.max(baseline.byteLength, target.byteLength); offset += rowBytes) {
    if (!rowDiffers(baseline, target, offset, rowBytes)) continue;
    if (lines.length < maxRows) lines.push({
      offset,
      baseline: baseline.slice(offset, offset + rowBytes),
      target: target.slice(offset, offset + rowBytes),
    });
    else omittedRows += 1;
  }
  return lines.length > 0 ? { lines, omittedRows } : null;
}

function rowDiffers(left: Uint8Array, right: Uint8Array, offset: number, rowBytes: number): boolean {
  const end = Math.min(Math.max(left.byteLength, right.byteLength), offset + rowBytes);
  for (let index = offset; index < end; index += 1) if (left[index] !== right[index]) return true;
  return false;
}

function hexBytes(bytes: Uint8Array): string {
  return bytes.byteLength === 0 ? "∅" : [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join(" ");
}

function formatOffset(offset: number): string { return `0x${offset.toString(16).padStart(8, "0")}`; }

function isRecord(value: unknown): value is StructuredOutput { return typeof value === "object" && value !== null && !Array.isArray(value); }

function binaryInputLabel(input: BinaryFileInputKind, t: ToolboxTFunction): string { return input === "baseline" ? t("binaryPatch.inputs.baseline") : input === "target" ? t("binaryPatch.inputs.target") : input === "patch" ? t("binaryPatch.inputs.patch") : input === "expected" ? t("binaryPatch.inputs.expected") : t("binaryPatch.inputs.plannerBaselines"); }

function binaryActionLabel(toolId: BinaryToolId, t: ToolboxTFunction): string { return toolId === "binary-patch-create" ? t("binaryPatch.actions.create") : toolId === "binary-patch-apply" ? t("binaryPatch.actions.apply") : toolId === "binary-patch-inspector" ? t("binaryPatch.actions.inspect") : toolId === "integrity-manifest" ? t("binaryPatch.actions.manifest") : toolId === "patch-planner" ? t("binaryPatch.actions.plan") : t("binaryPatch.actions.explainError"); }

function localizedPatchError(reason: unknown, t: ToolboxTFunction): string {
  const classified = classifyPatchError(reason);
  const key = classified.category === "ABORTED" ? "binaryPatch.errors.classified.aborted"
    : classified.category === "RESOURCE" ? "binaryPatch.errors.classified.resource"
      : classified.category === "INVALID_ARGUMENT" ? "binaryPatch.errors.classified.invalidArgument"
        : classified.category === "INVALID_PATCH" ? "binaryPatch.errors.classified.invalidPatch"
          : classified.category === "VERIFICATION" ? "binaryPatch.errors.classified.verification"
            : classified.category === "DESTINATION" ? "binaryPatch.errors.classified.destination"
              : classified.category === "UNSUPPORTED" ? "binaryPatch.errors.classified.unsupported"
                : "binaryPatch.errors.classified.runtime";
  const message = t(key, { code: classified.code });
  return classified.category === "RUNTIME" ? message : `${message} [${classified.code}]`;
}
