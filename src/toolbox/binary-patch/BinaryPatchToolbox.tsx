import { Download, FileCheck2, Play, Square, Trash2 } from "lucide-react";
import { useEffect, useRef, useState, type ChangeEvent } from "react";
import { classifyPatchError } from "bs-diff-patch-web";
import {
  applyPatchAndVerify,
  inspectPatchSafely,
  isPatchTaskCancelled,
  calculateTransferSavings,
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
const MAX_BINARY_BYTES = 64 * 1024 * 1024;

interface BinaryOutput {
  bytes: Uint8Array;
  filename: string;
  validation: "verified" | "unverified";
}

interface BinaryInputReader {
  (file: File | null, label: string, max?: number, index?: number): Promise<Uint8Array>;
  count(label: string): Promise<number>;
}

export function BinaryPatchToolbox({ toolId }: { toolId: BinaryToolId }) {
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
    if (files.length > 8) { setError("发布规划最多接受 8 个基线文件。"); return; }
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
    const nativeTokens = new Map<string, ToolboxInputToken[]>();
    const nativeTokenList: ToolboxInputToken[] = [];
    const ensureNativeTokens = async (label: string): Promise<ToolboxInputToken[]> => {
      const nativeRole = label === "基线" ? "input" : label === "目标" ? "target" : label === "补丁" ? "patch" : "expected";
      let tokens = nativeTokens.get(nativeRole);
      if (!tokens) {
        tokens = await prepareToolboxInputs(nativeInputJob!, nativeRole);
        nativeTokens.set(nativeRole, tokens);
        nativeTokenList.push(...tokens);
      }
      return tokens;
    };
    const readInput = Object.assign(async (file: File | null, role: string, max = MAX_BINARY_BYTES, index = 0) => {
      if (!nativeInputJob) return readBrowserInput(file, role, max);
      const tokens = await ensureNativeTokens(role);
      const token = tokens[index];
      if (!token) throw new Error(`原生选择器没有提供${role}。`);
      const bytes = await readBoundToolboxInput(nativeInputJob, token, operationSignal, max);
      return bytes;
    }, { count: async (label: string) => (nativeInputJob ? (await ensureNativeTokens(label)).length : 0) }) as BinaryInputReader;
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
        setOutput((current) => `${current}\n\n原生输出已准备完成；请在 10 分钟内选择正式另存。`);
      } else if (nativeJob) {
        await finishToolboxJob({ ...newToolboxRequest(), jobId: nativeJob.jobId, succeeded: true });
      }
    } catch (reason) {
      if (nativeJob) {
        try {
          if (isPatchTaskCancelled(reason)) {
            await cancelToolboxJob({ ...newToolboxRequest(), jobId: nativeJob.jobId });
          } else {
            await finishToolboxJob({ ...newToolboxRequest(), jobId: nativeJob.jobId, succeeded: false, error: toToolboxError(reason) });
          }
        } catch (lifecycleReason) {
          setError(`原生任务生命周期未确认：${lifecycleReason instanceof Error ? lifecycleReason.message : "无法更新任务状态"}`);
        }
      }
      if (isPatchTaskCancelled(reason)) {
        setOutput(JSON.stringify({ state: "cancelled", note: "补丁任务已终止，未生成可下载结果。" }, null, 2));
        setError("任务已取消（cancelled）；未生成可下载结果。");
      } else setError(classifyPatchError(reason).message);
    } finally {
      if (nativeInputJob && nativeTokenList.length > 0) {
        try {
          await releaseToolboxInputs(nativeInputJob, nativeTokenList.map((token) => token.token));
        } catch (releaseReason) {
          setError(`补丁输入资源释放未确认：${releaseReason instanceof Error ? releaseReason.message : "无法释放输入 token"}`);
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
      await cancelToolboxOutput({ requestId: crypto.randomUUID(), jobId: job.jobId, outputToken: output.token, generation: job.generation, resetEpoch: job.resetEpoch });
      setPreparedOutput(null);
      clearDownload();
      setNotice("临时输出已取消并释放。");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "临时输出释放未确认。");
    }
  };

  const readBrowserInput = async (file: File | null, role: string, max = MAX_BINARY_BYTES): Promise<Uint8Array> => {
    if (!file) throw new Error(`请选择${role}。`);
    if (file.size > max) throw new Error(`${role}超过 ${Math.round(max / 1024 / 1024)} MiB 安全上限。`);
    return new Uint8Array(await file.arrayBuffer());
  };

  const setDownload = (bytes: Uint8Array, name: string, mime: string) => {
    const copy = bytes.slice();
    setDownloadUrl((old) => { if (old) URL.revokeObjectURL(old); return URL.createObjectURL(new Blob([copy.buffer as ArrayBuffer], { type: mime })); });
    setDownloadName(name);
  };

  const execute = () => {
    clearDownload();
    if (toolId === "transfer-savings") {
      const fullInput = window.prompt("完整包大小（字节）", "1000000");
      const patchInput = window.prompt("补丁大小（字节）", "100000");
      const countInput = window.prompt("下载次数", "1");
      if (fullInput === null || patchInput === null || countInput === null) return;
      try { setOutput(JSON.stringify(calculateTransferSavings(Number(fullInput), Number(patchInput), Number(countInput)), null, 2)); } catch (reason) { setError(classifyPatchError(reason).message); }
      return;
    }
    if (toolId === "patch-errors") {
      const classified = classifyPatchError(new Error(window.prompt("输入要解释的补丁错误代码", "EPATCH") ?? "EPATCH"));
      setOutput(JSON.stringify(classified, null, 2));
      return;
    }
    void run(async (signal, readInput) => {
      if (toolId === "binary-patch-create") {
        const result = await generateVerifiedPatch(await readInput(baseline, "基线"), await readInput(target, "目标", 16 * 1024 * 1024), signal);
        setOutput(JSON.stringify({ verification: result.verification, baselineSha256: result.baselineSha256, targetSha256: result.targetSha256 }, null, 2));
        setDownload(result.patch, "corerobin.endsley.patch", "application/octet-stream");
        return { bytes: result.patch, filename: "corerobin.endsley.patch", validation: "verified" };
      }
      if (toolId === "binary-patch-apply") {
        const expectedBytes = isDesktopRuntime()
          ? nativeExpectedRequested ? await readInput(null, "预期目标", MAX_BINARY_BYTES) : undefined
          : expected ? await readInput(expected, "预期目标") : undefined;
        const applied = await applyPatchAndVerify(await readInput(baseline, "基线", 16 * 1024 * 1024), await readInput(patch, "补丁"), expectedBytes, signal);
        if (!applied.verification) {
          const unverified = { validation: "unverified", state: "unverified_without_expected_target", outputBytes: applied.output.byteLength, note: "未提供预期目标，不能验证输出；只能在明确确认后另存副本，绝不能替换源文件。" };
          setOutput(JSON.stringify(unverified, null, 2));
          if (!window.confirm("未提供预期目标，输出为 unverified，无法验证是否正确。确认仅另存此副本吗？")) {
            setError("未验证结果未获确认，未提供下载。 ");
            throw new Error("未验证输出未获确认，已取消正式结果。");
          }
        } else setOutput(JSON.stringify(applied.verification, null, 2));
        setDownload(applied.output, "corerobin-restored.bin", "application/octet-stream");
        return { bytes: applied.output, filename: "corerobin-restored.bin", validation: applied.verification ? "verified" : "unverified" };
      }
      if (toolId === "binary-patch-inspector") {
        setOutput(JSON.stringify(await inspectPatchSafely(await readInput(patch, "补丁")), null, 2));
        return null;
      }
      if (toolId === "integrity-manifest") {
        const baselineBytes = await readInput(baseline, "基线");
        const targetBytes = await readInput(target, "目标");
        const patchBytes = await readInput(patch, "补丁");
        const manifest = manifestJson(await makePatchManifest(baselineBytes, patchBytes, targetBytes, { baseline: baseline?.name, patch: patch?.name, target: target?.name }));
        const bytes = new TextEncoder().encode(manifest);
        setOutput(manifest);
        setDownload(bytes, "corerobin-patch-manifest.json", "application/json");
        return { bytes, filename: "corerobin-patch-manifest.json", validation: "verified" };
      }
      if (toolId === "patch-planner") {
        const targetBytes = await readInput(target, "目标", 16 * 1024 * 1024);
        const bases = [];
        if (isDesktopRuntime()) {
          const baseCount = await readInput.count("基线");
          for (let index = 0; index < baseCount; index += 1) {
            bases.push({ name: `baseline-${index + 1}.bin`, data: await readInput(null, "基线", 16 * 1024 * 1024, index) });
          }
        } else {
          for (const file of plannerBaselines) bases.push({ name: file.name, data: await readInput(file, "基线", 16 * 1024 * 1024) });
        }
        setOutput(JSON.stringify(await planPatches(targetBytes, bases, 0.8, signal), (_key, value) => value instanceof Uint8Array ? `[${value.byteLength} bytes]` : value, 2));
        return null;
      }
      return null;
    });
  };

  const needs = toolId === "binary-patch-create" ? ["baseline", "target"] : toolId === "binary-patch-apply" ? ["baseline", "patch", "expected (optional)"] : toolId === "binary-patch-inspector" ? ["patch"] : toolId === "integrity-manifest" ? ["baseline", "patch", "target"] : toolId === "patch-planner" ? ["target", "up to 8 baselines"] : [];

  return <div className="toolbox-tool-layout binary-patch-toolbox"><div className="toolbox-tool-layout__body">
    <p className="toolbox-hint">补丁保持二进制；生成后必须逐字节验证。无预期目标的应用结果标记为 unverified，只有明确确认后才能另存副本。ENDSLEY/BSDIFF43 可生成/应用，BSDIFF40 仅检查。</p>
    {needs.map((label) => label === "baseline" ? <FileInput key={label} label="基线" file={baseline} onChange={choose(setBaseline)} desktop={isDesktopRuntime()} /> : label === "target" ? <FileInput key={label} label="目标" file={target} onChange={choose(setTarget)} desktop={isDesktopRuntime()} /> : label === "patch" ? <FileInput key={label} label="补丁" file={patch} onChange={choose(setPatch)} desktop={isDesktopRuntime()} /> : label.startsWith("expected") ? <FileInput key={label} label="预期目标（可选）" file={expected} onChange={choose(setExpected)} optional desktop={isDesktopRuntime()} /> : <FileInput key={label} label="发布基线（最多 8 个）" files={plannerBaselines} onChange={chooseMany} multiple desktop={isDesktopRuntime()} />)}
    {toolId === "binary-patch-apply" && isDesktopRuntime() ? <label className="toolbox-hint"><input type="checkbox" checked={nativeExpectedRequested} disabled={running} onChange={(event) => setNativeExpectedRequested(event.target.checked)} /> 从原生选择器选择预期目标，以生成 verified 结果</label> : null}
    {toolId === "binary-patch-apply" && !expected && !nativeExpectedRequested ? <p className="toolbox-error" role="alert">未选择预期目标：结果将标记为 unverified，另存前必须再次确认。</p> : null}
    <div className="toolbox-inline-actions"><button className="button button--primary" type="button" disabled={running || Boolean(nativeOutput)} onClick={execute}><Play size={14} />{running ? "正在处理…" : binaryActionLabel(toolId)}</button>{running ? <button className="button button--secondary" type="button" onClick={() => { controllerRef.current?.abort(); }}><Square size={14} />停止</button> : null}<button className="button button--secondary" type="button" onClick={() => { void cancelNativeOutput(); setOutput(""); setNotice(""); setError(""); clearDownload(); }}><Trash2 size={14} />清空</button></div>
    {error ? <p className="toolbox-error" role="alert">{error}</p> : null}{notice ? <p className="toolbox-hint">{notice}</p> : null}<pre className="toolbox-result__pre">{output}</pre>
    {nativeOutput?.outputToken ? <div className="toolbox-inline-actions"><button className="button button--secondary" type="button" onClick={() => void saveNativeOutput()}><Download size={14} />正式另存结果</button><button className="button button--secondary" type="button" onClick={() => void cancelNativeOutput()}>取消临时输出</button><span className="toolbox-hint">原生输出 {Math.ceil(nativeOutput.outputToken.byteLength / 1024)} KiB，剩余约 10 分钟</span></div> : null}
    {downloadUrl ? <a className="button button--secondary" download={downloadName} href={downloadUrl}><Download size={14} />下载预览副本（非正式导出）</a> : null}
  </div><div className="toolbox-tool-layout__footer"><span>BSDIFF43 SDK Worker 使用每项 120 秒、整次最多 600 秒的取消 deadline；正式输出经过原生 TTL、验证和原子另存，不覆盖源文件、不执行补丁、不联网。规划累计产物最多 512 MiB。</span></div></div>;
}

function toToolboxError(reason: unknown): ToolboxError {
  return { code: "web_tool_error", message: reason instanceof Error ? reason.message : "补丁工具执行失败。", retryable: false };
}

function FileInput({ label, file, files, onChange, multiple, optional, desktop }: { label: string; file?: File | null; files?: File[]; onChange: (event: ChangeEvent<HTMLInputElement>) => void; multiple?: boolean; optional?: boolean; desktop?: boolean }) {
  return <label className="toolbox-file-pick button button--secondary"><FileCheck2 size={15} />{label}{desktop ? "（开始时由原生选择器选择）" : file ? `：${file.name}` : files?.length ? `：${files.length} 个` : optional ? "（未选择）" : ""}{desktop ? null : <input hidden type="file" multiple={multiple} onChange={onChange} />}</label>;
}

function binaryActionLabel(toolId: BinaryToolId): string { return toolId === "binary-patch-create" ? "生成并验证补丁" : toolId === "binary-patch-apply" ? "应用并校验" : toolId === "binary-patch-inspector" ? "检查补丁" : toolId === "integrity-manifest" ? "生成完整性清单" : toolId === "patch-planner" ? "逐基线规划" : "解释错误"; }
