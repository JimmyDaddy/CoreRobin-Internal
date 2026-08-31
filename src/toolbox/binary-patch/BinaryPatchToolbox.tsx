import { Download, FileCheck2, Play, Square, Trash2 } from "lucide-react";
import type { TFunction } from "i18next";
import { useEffect, useRef, useState, type ChangeEvent } from "react";
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
  generateVerifiedPatch,
  PATCH_PLANNER_DEADLINE_MS,
  runWithPatchDeadline,
} from "./binaryPatchTools";
import type { ToolboxError, ToolboxJob, ToolId } from "../contracts";
import { cancelToolboxJob, cancelToolboxOutput, exportToolboxOutput, finishToolboxJob, newToolboxRequest, prepareToolboxInputs, registerToolboxOutput, releaseToolboxInputs, revalidateToolboxInputs, startToolboxSession } from "../client";
import { isDesktopRuntime } from "../../api";
import { fileJobKey, readBoundToolboxInput } from "../runtime/files";
import type { ToolboxFileJobKey, ToolboxInputToken } from "../contracts";

type BinaryToolId = Extract<ToolId, "binary-patch-create" | "binary-patch-apply" | "binary-patch-inspector" | "integrity-manifest" | "transfer-savings" | "patch-errors" | "patch-planner">;
type BinaryInputKind = "baseline" | "target" | "patch" | "expected";
type BinaryFileInputKind = BinaryInputKind | "plannerBaselines";
type NativeInputRole = "input" | "target" | "patch" | "expected";
type ToolboxTFunction = TFunction<"toolbox">;
const MAX_BINARY_BYTES = 64 * 1024 * 1024;

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
}

interface BinaryInputReader {
  (file: File | null, input: BinaryInputKind, max?: number, index?: number): Promise<Uint8Array>;
  count(input: BinaryInputKind): Promise<number>;
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
  const [running, setRunning] = useState(false);
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

  const run = async (task: (signal: AbortSignal, readInput: BinaryInputReader) => Promise<BinaryOutput | null>) => {
    if (running || nativeOutputRef.current) return;
    const controller = new AbortController();
    controllerRef.current = controller;
    setRunning(true);
    setError("");
    setOutput("");
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
    const readInput = Object.assign(async (file: File | null, input: BinaryInputKind, max = MAX_BINARY_BYTES, index = 0) => {
      const label = binaryInputLabel(input, t);
      if (!nativeInputJob) return readBrowserInput(file, label, max);
      const tokens = await ensureNativeTokens(input);
      const token = tokens[index];
      if (!token) throw new Error(t("binaryPatch.errors.nativePickerMissing", { label }));
      const bytes = await readBoundToolboxInput(nativeInputJob, token, operationSignal, max);
      return bytes;
    }, { count: async (input: BinaryInputKind) => (nativeInputJob ? (await ensureNativeTokens(input)).length : 0) }) as BinaryInputReader;
    try {
      if (isDesktopRuntime()) {
        nativeJob = await startToolboxSession({ ...newToolboxRequest(), toolId });
        nativeInputJob = fileJobKey(nativeJob);
      }
      const formalOutput = await runWithPatchDeadline((signal) => {
        operationSignal = signal;
        return task(signal, readInput);
      }, controller.signal, PATCH_PLANNER_DEADLINE_MS);
      if (nativeInputJob) {
        await revalidateToolboxInputs(nativeInputJob);
        if (nativeTokenList.length > 0) {
          await releaseToolboxInputs(nativeInputJob, nativeTokenList.map((token) => token.token));
          nativeTokenList.length = 0;
        }
      }
      if (nativeJob && formalOutput) {
        const ready = await registerToolboxOutput({
          ...newToolboxRequest(),
          jobId: nativeJob.jobId,
          generation: nativeJob.generation,
          resetEpoch: nativeJob.resetEpoch,
          bytes: formalOutput.bytes,
          validation: formalOutput.validation,
        });
        setPreparedOutput(ready, formalOutput.filename);
        setOutput((current) => `${current}\n\n${t("binaryPatch.notices.nativeOutputReady")}`);
      } else if (nativeJob) {
        await finishToolboxJob({ ...newToolboxRequest(), jobId: nativeJob.jobId, succeeded: true });
      }
    } catch (reason) {
      if (nativeJob) {
        try {
          if (isPatchTaskCancelled(reason)) {
            await cancelToolboxJob({ ...newToolboxRequest(), jobId: nativeJob.jobId });
          } else {
            await finishToolboxJob({ ...newToolboxRequest(), jobId: nativeJob.jobId, succeeded: false, error: toToolboxError(reason, t("binaryPatch.errors.executionFailed")) });
          }
        } catch (lifecycleReason) {
          setError(t("binaryPatch.errors.nativeLifecycleUnconfirmed", { message: lifecycleReason instanceof Error ? lifecycleReason.message : t("binaryPatch.errors.unknownLifecycleState") }));
        }
      }
      if (isPatchTaskCancelled(reason)) {
        setOutput(JSON.stringify({ state: "cancelled", note: t("binaryPatch.output.cancelledNote") }, null, 2));
        setError(t("binaryPatch.errors.cancelled"));
      } else setError(classifyPatchError(reason).message);
    } finally {
      if (nativeInputJob && nativeTokenList.length > 0) {
        try {
          await releaseToolboxInputs(nativeInputJob, nativeTokenList.map((token) => token.token));
        } catch (releaseReason) {
          setError(t("binaryPatch.errors.inputReleaseUnconfirmed", { message: releaseReason instanceof Error ? releaseReason.message : t("binaryPatch.errors.unknownReleaseState") }));
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
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : t("binaryPatch.errors.saveFailed"));
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
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : t("binaryPatch.errors.cancelFailed"));
    }
  };

  const readBrowserInput = async (file: File | null, role: string, max = MAX_BINARY_BYTES): Promise<Uint8Array> => {
    if (!file) throw new Error(t("binaryPatch.errors.selectFile", { label: role }));
    if (file.size > max) throw new Error(t("binaryPatch.errors.fileTooLarge", { label: role, max: Math.round(max / 1024 / 1024) }));
    return new Uint8Array(await file.arrayBuffer());
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
      try { setOutput(JSON.stringify(calculateTransferSavings(Number(fullInput), Number(patchInput), Number(countInput)), null, 2)); } catch (reason) { setError(classifyPatchError(reason).message); }
      return;
    }
    if (toolId === "patch-errors") {
      const classified = classifyPatchError(new Error(window.prompt(t("binaryPatch.prompts.errorCode"), "EPATCH") ?? "EPATCH"));
      setOutput(JSON.stringify(classified, null, 2));
      return;
    }
    void run(async (signal, readInput) => {
      if (toolId === "binary-patch-create") {
        const result = await generateVerifiedPatch(await readInput(baseline, "baseline"), await readInput(target, "target", 16 * 1024 * 1024), signal);
        setOutput(JSON.stringify({ verification: result.verification, baselineSha256: result.baselineSha256, targetSha256: result.targetSha256 }, null, 2));
        setDownload(result.patch, "corerobin.endsley.patch", "application/octet-stream");
        return { bytes: result.patch, filename: "corerobin.endsley.patch", validation: "verified" };
      }
      if (toolId === "binary-patch-apply") {
        const expectedBytes = isDesktopRuntime()
          ? nativeExpectedRequested ? await readInput(null, "expected", MAX_BINARY_BYTES) : undefined
          : expected ? await readInput(expected, "expected") : undefined;
        const applied = await applyPatchAndVerify(await readInput(baseline, "baseline", 16 * 1024 * 1024), await readInput(patch, "patch"), expectedBytes, signal);
        if (!applied.verification) {
          const unverified = { validation: "unverified", state: "unverified_without_expected_target", outputBytes: applied.output.byteLength, note: t("binaryPatch.output.unverifiedNote") };
          setOutput(JSON.stringify(unverified, null, 2));
          if (!window.confirm(t("binaryPatch.unverified.confirm"))) {
            setError(t("binaryPatch.errors.unverifiedNotConfirmed"));
            throw new Error(t("binaryPatch.errors.unverifiedOutputCancelled"));
          }
        } else setOutput(JSON.stringify(applied.verification, null, 2));
        setDownload(applied.output, "corerobin-restored.bin", "application/octet-stream");
        return { bytes: applied.output, filename: "corerobin-restored.bin", validation: applied.verification ? "verified" : "unverified" };
      }
      if (toolId === "binary-patch-inspector") {
        setOutput(JSON.stringify(await inspectPatchSafely(await readInput(patch, "patch")), null, 2));
        return null;
      }
      if (toolId === "integrity-manifest") {
        const baselineBytes = await readInput(baseline, "baseline");
        const targetBytes = await readInput(target, "target");
        const patchBytes = await readInput(patch, "patch");
        const manifest = manifestJson(await makePatchManifest(baselineBytes, patchBytes, targetBytes, { baseline: baseline?.name, patch: patch?.name, target: target?.name }));
        const bytes = new TextEncoder().encode(manifest);
        setOutput(manifest);
        setDownload(bytes, "corerobin-patch-manifest.json", "application/json");
        return { bytes, filename: "corerobin-patch-manifest.json", validation: "verified" };
      }
      if (toolId === "patch-planner") {
        const targetBytes = await readInput(target, "target", 16 * 1024 * 1024);
        const bases = [];
        if (isDesktopRuntime()) {
          const baseCount = await readInput.count("baseline");
          for (let index = 0; index < baseCount; index += 1) {
            bases.push({ name: `baseline-${index + 1}.bin`, data: await readInput(null, "baseline", 16 * 1024 * 1024, index) });
          }
        } else {
          for (const file of plannerBaselines) bases.push({ name: file.name, data: await readInput(file, "baseline", 16 * 1024 * 1024) });
        }
        const plan = await planPatches(targetBytes, bases, 0.8, signal);
        const collection = await createPatchCollection({ name: target?.name ?? "target.bin", data: targetBytes }, plan);
        setOutput(manifestJson(collection.plan));
        setDownload(collection.bytes, collection.filename, "application/zip");
        return { bytes: collection.bytes, filename: collection.filename, validation: "verified" };
      }
      return null;
    });
  };

  const needs: BinaryFileInputKind[] = toolId === "binary-patch-create" ? ["baseline", "target"] : toolId === "binary-patch-apply" ? ["baseline", "patch", "expected"] : toolId === "binary-patch-inspector" ? ["patch"] : toolId === "integrity-manifest" ? ["baseline", "patch", "target"] : toolId === "patch-planner" ? ["target", "plannerBaselines"] : [];

  return <div className="toolbox-tool-layout binary-patch-toolbox"><div className="toolbox-tool-layout__body">
    <p className="toolbox-hint">{t("binaryPatch.hint")}</p>
    {needs.map((input) => input === "baseline" ? <FileInput key={input} t={t} label={binaryInputLabel(input, t)} file={baseline} onChange={choose(setBaseline)} desktop={isDesktopRuntime()} /> : input === "target" ? <FileInput key={input} t={t} label={binaryInputLabel(input, t)} file={target} onChange={choose(setTarget)} desktop={isDesktopRuntime()} /> : input === "patch" ? <FileInput key={input} t={t} label={binaryInputLabel(input, t)} file={patch} onChange={choose(setPatch)} desktop={isDesktopRuntime()} /> : input === "expected" ? <FileInput key={input} t={t} label={binaryInputLabel(input, t)} file={expected} onChange={choose(setExpected)} optional desktop={isDesktopRuntime()} /> : <FileInput key={input} t={t} label={binaryInputLabel(input, t)} files={plannerBaselines} onChange={chooseMany} multiple desktop={isDesktopRuntime()} />)}
    {toolId === "binary-patch-apply" && isDesktopRuntime() ? <label className="toolbox-hint"><input type="checkbox" checked={nativeExpectedRequested} disabled={running} onChange={(event) => setNativeExpectedRequested(event.target.checked)} /> {t("binaryPatch.unverified.nativeExpected")}</label> : null}
    {toolId === "binary-patch-apply" && !expected && !nativeExpectedRequested ? <p className="toolbox-error" role="alert">{t("binaryPatch.unverified.missingExpected")}</p> : null}
    <div className="toolbox-inline-actions"><button className="button button--primary" type="button" disabled={running || Boolean(nativeOutput)} onClick={execute}><Play size={14} />{running ? t("binaryPatch.actions.processing") : binaryActionLabel(toolId, t)}</button>{running ? <button className="button button--secondary" type="button" onClick={() => { controllerRef.current?.abort(); }}><Square size={14} />{t("binaryPatch.actions.stop")}</button> : null}<button className="button button--secondary" type="button" onClick={() => { void cancelNativeOutput(); setOutput(""); setNotice(""); setError(""); clearDownload(); }}><Trash2 size={14} />{t("binaryPatch.actions.clear")}</button></div>
    {error ? <p className="toolbox-error" role="alert">{error}</p> : null}{notice ? <p className="toolbox-hint">{notice}</p> : null}<pre className="toolbox-result__pre">{output}</pre>
    {nativeOutput?.outputToken ? <div className="toolbox-inline-actions"><button className="button button--secondary" type="button" onClick={() => void saveNativeOutput()}><Download size={14} />{t("binaryPatch.actions.saveNative")}</button><button className="button button--secondary" type="button" onClick={() => void cancelNativeOutput()}>{t("binaryPatch.actions.cancelNative")}</button><span className="toolbox-hint">{t("binaryPatch.nativeOutput.ttl", { size: Math.ceil(nativeOutput.outputToken.byteLength / 1024) })}</span></div> : null}
    {!isDesktopRuntime() && downloadUrl ? <a className="button button--secondary" download={downloadName} href={downloadUrl}><Download size={14} />{toolId === "patch-planner" ? t("binaryPatch.actions.downloadPlan") : t("binaryPatch.actions.downloadPreview")}</a> : null}
  </div><div className="toolbox-tool-layout__footer"><span>{t("binaryPatch.footer")}</span></div></div>;
}

function toToolboxError(reason: unknown, fallback: string): ToolboxError {
  return { code: "web_tool_error", message: reason instanceof Error ? reason.message : fallback, retryable: false };
}

function FileInput({ t, label, file, files, onChange, multiple, optional, desktop }: { t: ToolboxTFunction; label: string; file?: File | null; files?: File[]; onChange: (event: ChangeEvent<HTMLInputElement>) => void; multiple?: boolean; optional?: boolean; desktop?: boolean }) {
  return <label className="toolbox-file-pick button button--secondary"><FileCheck2 size={15} />{label}{desktop ? t("binaryPatch.fileInput.nativePicker") : file ? t("binaryPatch.fileInput.selected", { filename: file.name }) : files?.length ? t("binaryPatch.fileInput.selectedCount", { count: files.length }) : optional ? t("binaryPatch.fileInput.notSelected") : ""}{desktop ? null : <input hidden type="file" multiple={multiple} onChange={onChange} />}</label>;
}

function binaryInputLabel(input: BinaryFileInputKind, t: ToolboxTFunction): string { return input === "baseline" ? t("binaryPatch.inputs.baseline") : input === "target" ? t("binaryPatch.inputs.target") : input === "patch" ? t("binaryPatch.inputs.patch") : input === "expected" ? t("binaryPatch.inputs.expected") : t("binaryPatch.inputs.plannerBaselines"); }

function binaryActionLabel(toolId: BinaryToolId, t: ToolboxTFunction): string { return toolId === "binary-patch-create" ? t("binaryPatch.actions.create") : toolId === "binary-patch-apply" ? t("binaryPatch.actions.apply") : toolId === "binary-patch-inspector" ? t("binaryPatch.actions.inspect") : toolId === "integrity-manifest" ? t("binaryPatch.actions.manifest") : toolId === "patch-planner" ? t("binaryPatch.actions.plan") : t("binaryPatch.actions.explainError"); }
