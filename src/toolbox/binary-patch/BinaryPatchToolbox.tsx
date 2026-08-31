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
import type { ToolId } from "../contracts";

type BinaryToolId = Extract<ToolId, "binary-patch-create" | "binary-patch-apply" | "binary-patch-inspector" | "integrity-manifest" | "transfer-savings" | "patch-errors" | "patch-planner">;
const MAX_BINARY_BYTES = 64 * 1024 * 1024;

export function BinaryPatchToolbox({ toolId }: { toolId: BinaryToolId }) {
  const [baseline, setBaseline] = useState<File | null>(null);
  const [target, setTarget] = useState<File | null>(null);
  const [patch, setPatch] = useState<File | null>(null);
  const [expected, setExpected] = useState<File | null>(null);
  const [plannerBaselines, setPlannerBaselines] = useState<File[]>([]);
  const [output, setOutput] = useState("");
  const [downloadUrl, setDownloadUrl] = useState("");
  const [downloadName, setDownloadName] = useState("");
  const [error, setError] = useState("");
  const [running, setRunning] = useState(false);
  const controllerRef = useRef<AbortController | null>(null);

  useEffect(() => () => { controllerRef.current?.abort(); }, []);
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

  const run = async (task: (signal: AbortSignal) => Promise<void>) => {
    if (running) return;
    const controller = new AbortController();
    controllerRef.current = controller;
    setRunning(true);
    setError("");
    setOutput("");
    clearDownload();
    try { await runWithPatchDeadline(task, controller.signal, PATCH_PLANNER_DEADLINE_MS); } catch (reason) {
      if (isPatchTaskCancelled(reason)) {
        setOutput(JSON.stringify({ state: "cancelled", note: "补丁任务已终止，未生成可下载结果。" }, null, 2));
        setError("任务已取消（cancelled）；未生成可下载结果。");
      } else setError(classifyPatchError(reason).message);
    } finally { controllerRef.current = null; setRunning(false); }
  };

  const read = async (file: File | null, role: string, max = MAX_BINARY_BYTES): Promise<Uint8Array> => {
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
    void run(async (signal) => {
      if (toolId === "binary-patch-create") {
        const result = await generateVerifiedPatch(await read(baseline, "基线"), await read(target, "目标", 16 * 1024 * 1024), signal);
        setOutput(JSON.stringify({ verification: result.verification, baselineSha256: result.baselineSha256, targetSha256: result.targetSha256 }, null, 2));
        setDownload(result.patch, "corerobin.endsley.patch", "application/octet-stream");
        return;
      }
      if (toolId === "binary-patch-apply") {
        const applied = await applyPatchAndVerify(await read(baseline, "基线", 16 * 1024 * 1024), await read(patch, "补丁"), expected ? await read(expected, "预期目标") : undefined, signal);
        if (!applied.verification) {
          const unverified = { validation: "unverified", state: "unverified_without_expected_target", outputBytes: applied.output.byteLength, note: "未提供预期目标，不能验证输出；只能在明确确认后另存副本，绝不能替换源文件。" };
          setOutput(JSON.stringify(unverified, null, 2));
          if (!window.confirm("未提供预期目标，输出为 unverified，无法验证是否正确。确认仅另存此副本吗？")) {
            setError("未验证结果未获确认，未提供下载。 ");
            return;
          }
        } else setOutput(JSON.stringify(applied.verification, null, 2));
        setDownload(applied.output, "corerobin-restored.bin", "application/octet-stream");
        return;
      }
      if (toolId === "binary-patch-inspector") {
        setOutput(JSON.stringify(await inspectPatchSafely(await read(patch, "补丁")), null, 2));
        return;
      }
      if (toolId === "integrity-manifest") {
        const baselineBytes = await read(baseline, "基线");
        const targetBytes = await read(target, "目标");
        const patchBytes = await read(patch, "补丁");
        setOutput(manifestJson(await makePatchManifest(baselineBytes, patchBytes, targetBytes, { baseline: baseline?.name, patch: patch?.name, target: target?.name })));
        return;
      }
      if (toolId === "patch-planner") {
        const targetBytes = await read(target, "目标", 16 * 1024 * 1024);
        const bases = [];
        for (const file of plannerBaselines) bases.push({ name: file.name, data: await read(file, "基线", 16 * 1024 * 1024) });
        setOutput(JSON.stringify(await planPatches(targetBytes, bases, 0.8, signal), (_key, value) => value instanceof Uint8Array ? `[${value.byteLength} bytes]` : value, 2));
      }
    });
  };

  const needs = toolId === "binary-patch-create" ? ["baseline", "target"] : toolId === "binary-patch-apply" ? ["baseline", "patch", "expected (optional)"] : toolId === "binary-patch-inspector" ? ["patch"] : toolId === "integrity-manifest" ? ["baseline", "patch", "target"] : toolId === "patch-planner" ? ["target", "up to 8 baselines"] : [];

  return <div className="toolbox-tool-layout binary-patch-toolbox"><div className="toolbox-tool-layout__body">
    <p className="toolbox-hint">补丁保持二进制；生成后必须逐字节验证。无预期目标的应用结果标记为 unverified，只有明确确认后才能另存副本。ENDSLEY/BSDIFF43 可生成/应用，BSDIFF40 仅检查。</p>
    {needs.map((label) => label === "baseline" ? <FileInput key={label} label="基线" file={baseline} onChange={choose(setBaseline)} /> : label === "target" ? <FileInput key={label} label="目标" file={target} onChange={choose(setTarget)} /> : label === "patch" ? <FileInput key={label} label="补丁" file={patch} onChange={choose(setPatch)} /> : label.startsWith("expected") ? <FileInput key={label} label="预期目标（可选）" file={expected} onChange={choose(setExpected)} optional /> : <FileInput key={label} label="发布基线（最多 8 个）" files={plannerBaselines} onChange={chooseMany} multiple />)}
    {toolId === "binary-patch-apply" && !expected ? <p className="toolbox-error" role="alert">未选择预期目标：结果将标记为 unverified，另存前必须再次确认。</p> : null}
    <div className="toolbox-inline-actions"><button className="button button--primary" type="button" disabled={running} onClick={execute}><Play size={14} />{running ? "正在处理…" : binaryActionLabel(toolId)}</button>{running ? <button className="button button--secondary" type="button" onClick={() => { controllerRef.current?.abort(); }}><Square size={14} />停止</button> : null}<button className="button button--secondary" type="button" onClick={() => { setOutput(""); setError(""); clearDownload(); }}><Trash2 size={14} />清空</button></div>
    {error ? <p className="toolbox-error" role="alert">{error}</p> : null}<pre className="toolbox-result__pre">{output}</pre>
    {downloadUrl ? <a className="button button--secondary" download={downloadName} href={downloadUrl}><Download size={14} />另存结果副本</a> : null}
  </div><div className="toolbox-tool-layout__footer"><span>BSDIFF43 SDK Worker 使用每项 120 秒、整次最多 600 秒的取消 deadline；本页面不覆盖源文件、不执行补丁、不联网。规划累计产物最多 512 MiB。</span></div></div>;
}

function FileInput({ label, file, files, onChange, multiple, optional }: { label: string; file?: File | null; files?: File[]; onChange: (event: ChangeEvent<HTMLInputElement>) => void; multiple?: boolean; optional?: boolean }) {
  return <label className="toolbox-file-pick button button--secondary"><FileCheck2 size={15} />{label}{file ? `：${file.name}` : files?.length ? `：${files.length} 个` : optional ? "（未选择）" : ""}<input hidden type="file" multiple={multiple} onChange={onChange} /></label>;
}

function binaryActionLabel(toolId: BinaryToolId): string { return toolId === "binary-patch-create" ? "生成并验证补丁" : toolId === "binary-patch-apply" ? "应用并校验" : toolId === "binary-patch-inspector" ? "检查补丁" : toolId === "integrity-manifest" ? "生成完整性清单" : toolId === "patch-planner" ? "逐基线规划" : "解释错误"; }
