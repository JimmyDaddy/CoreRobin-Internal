import { Download, FileCheck2, Play, Square, Trash2 } from "lucide-react";
import { useEffect, useRef, useState, type ChangeEvent } from "react";
import { classifyPatchError } from "bs-diff-patch-web";
import {
  applyPatchAndVerify,
  inspectPatchSafely,
  makePatchManifest,
  manifestJson,
  planPatches,
  generateVerifiedPatch,
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

  const run = async (task: (signal: AbortSignal) => Promise<void>) => {
    if (running) return;
    const controller = new AbortController();
    controllerRef.current = controller;
    setRunning(true);
    setError("");
    setOutput("");
    try { await task(controller.signal); } catch (reason) { setError(controller.signal.aborted ? "已请求停止；等待补丁 Worker 确认退出。" : classifyPatchError(reason).message); } finally { controllerRef.current = null; setRunning(false); }
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
    if (toolId === "transfer-savings") {
      const full = Number(window.prompt("完整包大小（字节）", "1000000"));
      const patchBytes = Number(window.prompt("补丁大小（字节）", "100000"));
      const count = Number(window.prompt("下载次数", "1"));
      if ([full, patchBytes, count].some((value) => !Number.isFinite(value) || value < 0)) { setError("大小和次数必须是非负数字。"); return; }
      const totalFull = full * count;
      const totalPatch = patchBytes * count;
      setOutput(JSON.stringify({ fullBytes: totalFull, patchBytes: totalPatch, savedBytes: totalFull - totalPatch, savingsPercent: totalFull === 0 ? null : ((totalFull - totalPatch) / totalFull) * 100 }, null, 2));
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
        setOutput(JSON.stringify(applied.verification ?? { verified: false, state: "unverified_without_expected_target", outputBytes: applied.output.byteLength, note: "只允许另存副本；不能替换源文件。" }, null, 2));
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
    <p className="toolbox-hint">补丁保持二进制；生成后必须逐字节验证，应用无预期目标时只标记 unverified 并只能另存副本。ENDSLEY/BSDIFF43 可生成/应用，BSDIFF40 仅检查。</p>
    {needs.map((label) => label === "baseline" ? <FileInput key={label} label="基线" file={baseline} onChange={choose(setBaseline)} /> : label === "target" ? <FileInput key={label} label="目标" file={target} onChange={choose(setTarget)} /> : label === "patch" ? <FileInput key={label} label="补丁" file={patch} onChange={choose(setPatch)} /> : label.startsWith("expected") ? <FileInput key={label} label="预期目标（可选）" file={expected} onChange={choose(setExpected)} optional /> : <FileInput key={label} label="发布基线（最多 8 个）" files={plannerBaselines} onChange={chooseMany} multiple />)}
    <div className="toolbox-inline-actions"><button className="button button--primary" type="button" disabled={running} onClick={execute}><Play size={14} />{running ? "正在处理…" : binaryActionLabel(toolId)}</button>{running ? <button className="button button--secondary" type="button" onClick={() => { controllerRef.current?.abort(); }}><Square size={14} />停止</button> : null}<button className="button button--secondary" type="button" onClick={() => { setOutput(""); setError(""); }}><Trash2 size={14} />清空</button></div>
    {error ? <p className="toolbox-error" role="alert">{error}</p> : null}<pre className="toolbox-result__pre">{output}</pre>
    {downloadUrl ? <a className="button button--secondary" download={downloadName} href={downloadUrl}><Download size={14} />另存结果副本</a> : null}
  </div><div className="toolbox-tool-layout__footer"><span>SDK Worker 使用每任务取消；本页面不覆盖源文件、不执行补丁、不联网。应用/规划仍受角色上限和工作集约束。</span></div></div>;
}

function FileInput({ label, file, files, onChange, multiple, optional }: { label: string; file?: File | null; files?: File[]; onChange: (event: ChangeEvent<HTMLInputElement>) => void; multiple?: boolean; optional?: boolean }) {
  return <label className="toolbox-file-pick button button--secondary"><FileCheck2 size={15} />{label}{file ? `：${file.name}` : files?.length ? `：${files.length} 个` : optional ? "（未选择）" : ""}<input hidden type="file" multiple={multiple} onChange={onChange} /></label>;
}

function binaryActionLabel(toolId: BinaryToolId): string { return toolId === "binary-patch-create" ? "生成并验证补丁" : toolId === "binary-patch-apply" ? "应用并校验" : toolId === "binary-patch-inspector" ? "检查补丁" : toolId === "integrity-manifest" ? "生成完整性清单" : toolId === "patch-planner" ? "逐基线规划" : "解释错误"; }
