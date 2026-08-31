import { FileCheck2, Copy, Square } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { hashToolboxFile, isDesktopRuntime } from "../../api";
import { cancelToolboxJob, finishToolboxJob, newToolboxRequest, prepareToolboxInputs, startToolboxSession } from "../client";
import type { ToolboxJob } from "../contracts";
import { fileJobKey } from "../runtime/files";
import { userFacingError } from "./toolboxErrors";

interface ActiveHash { controller: AbortController; job: ToolboxJob | null; settled: boolean }

export function FileHashTool() {
  const [fileName, setFileName] = useState("");
  const [progress, setProgress] = useState(0);
  const [output, setOutput] = useState("");
  const [error, setError] = useState("");
  const [running, setRunning] = useState(false);
  const [stopping, setStopping] = useState(false);
  const active = useRef<ActiveHash | null>(null);
  const mounted = useRef(true);
  const generation = useRef(0);

  const clearActive = (operation: ActiveHash) => {
    if (active.current !== operation) return;
    active.current = null;
    if (mounted.current) { setRunning(false); setStopping(false); }
  };

  const releaseNative = async (operation: ActiveHash): Promise<boolean> => {
    if (!operation.job) return true;
    try {
      const state = await cancelToolboxJob({ ...newToolboxRequest(), jobId: operation.job.jobId });
      return ["completed", "cancelled", "expired", "failed"].includes(state.status);
    } catch {
      if (mounted.current) setError("文件资源释放尚未确认，请重试停止。");
      return false;
    }
  };

  const cancel = () => {
    const operation = active.current;
    if (!operation) return;
    operation.controller.abort();
    if (mounted.current) { setStopping(true); setOutput(""); }
    if (operation.job) void releaseNative(operation).then((released) => {
      if (released && operation.settled) clearActive(operation);
    });
  };

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; cancel(); };
  }, []);

  const run = async () => {
    if (active.current) return;
    if (!isDesktopRuntime()) { setError("文件 SHA-256 需要桌面原生运行时。"); return; }
    const operation: ActiveHash = { controller: new AbortController(), job: null, settled: false };
    active.current = operation;
    setRunning(true); setStopping(false); setError(""); setOutput(""); setFileName(""); setProgress(0);
    const current = () => mounted.current && active.current === operation && !operation.controller.signal.aborted;
    try {
      operation.job = await startToolboxSession({ ...newToolboxRequest(), toolId: "file-sha256", generation: ++generation.current });
      operation.controller.signal.throwIfAborted();
      const job = fileJobKey(operation.job);
      const [input] = await prepareToolboxInputs(job, "input");
      operation.controller.signal.throwIfAborted();
      if (!input) { operation.controller.abort(); return; }
      if (current()) setFileName(input.displayName);
      const result = await hashToolboxFile({ ...newToolboxRequest(), job, token: input.token }, (event) => {
        if (current()) setProgress(event.totalBytes ? event.bytesRead / event.totalBytes : 1);
      });
      operation.controller.signal.throwIfAborted();
      const completed = await finishToolboxJob({ ...newToolboxRequest(), jobId: operation.job.jobId, succeeded: true });
      if (completed.status !== "completed") throw new Error("文件任务未完成，结果已丢弃。");
      if (current()) { setOutput(result.digest); setProgress(1); }
    } catch (reason) {
      if (current()) setError(userFacingError(reason));
      if (operation.job && !operation.controller.signal.aborted) {
        await finishToolboxJob({ ...newToolboxRequest(), jobId: operation.job.jobId, succeeded: false,
          error: { code: "file_hash_failed", message: "File hashing could not be completed.", retryable: false },
        }).catch(() => undefined);
      }
    } finally {
      // A completed job is unchanged by cancel. Failed, abandoned and late
      // selections all release the same native owner before a new run starts.
      operation.settled = true;
      if (await releaseNative(operation)) clearActive(operation);
      else if (mounted.current) { setStopping(true); setOutput(""); }
    }
  };

  return <section className="toolbox-tool-layout" aria-label="文件 SHA-256">
    <div className="toolbox-inline-actions"><button className="button button--primary" type="button" disabled={running} onClick={() => void run()}><FileCheck2 size={15} />{running ? "正在计算…" : "选择文件并计算"}</button>{running ? <button className="button button--secondary" type="button" onClick={cancel}><Square size={14} />{stopping ? "正在停止…" : "停止"}</button> : null}<button className="button button--secondary" type="button" disabled={running} onClick={() => { setFileName(""); setOutput(""); setError(""); setProgress(0); }}>清空</button></div>
    {fileName ? <p>{fileName}</p> : null}
    {running ? <progress aria-label="文件读取进度" max="1" value={progress} /> : null}
    {error ? <p className="toolbox-error" role="alert">{error}</p> : null}
    <p className="toolbox-hint">使用原生选择器与身份绑定 token。内容仅在原生服务内以 1 MiB 分块读取，开始、每块和结束均复验；离页停止，不写入历史。</p>
    {output ? <div className="toolbox-result"><pre>{output}</pre><button className="button button--secondary" type="button" onClick={() => { void navigator.clipboard.writeText(output).catch(() => setError("无法写入剪贴板，请手动复制。")); }}><Copy size={14} />复制 SHA-256</button></div> : null}
  </section>;
}
