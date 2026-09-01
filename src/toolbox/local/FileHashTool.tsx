import { FileCheck2, Copy, Square } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { hashToolboxFile, isDesktopRuntime } from "../../api";
import { cancelToolboxJob, finishToolboxJob, newToolboxRequest, prepareToolboxInputs, startToolboxSession } from "../client";
import type { ToolboxJob } from "../contracts";
import { fileJobKey } from "../runtime/files";

interface ActiveHash { controller: AbortController; job: ToolboxJob | null; settled: boolean }

export function FileHashTool() {
  const { t } = useTranslation("toolbox");
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
      if (mounted.current) setError(t("fileHash.releaseUnconfirmed"));
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
    if (!isDesktopRuntime()) { setError(t("fileHash.desktopOnly")); return; }
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
      if (completed.status !== "completed") throw new Error("file_hash_job_incomplete");
      if (current()) { setOutput(result.digest); setProgress(1); }
    } catch (reason) {
      if (current()) setError(reason instanceof Error && reason.message === "file_hash_job_incomplete"
        ? t("fileHash.jobIncomplete")
        : t("errors.generic"));
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

  return <section className="toolbox-tool-layout" aria-label={t("tools.file-sha256.title")}>
    <div className="toolbox-inline-actions"><button className="button button--primary" type="button" disabled={running} onClick={() => void run()}><FileCheck2 size={15} />{running ? t("fileHash.running") : t("fileHash.chooseAndCompute")}</button>{running ? <button className="button button--secondary" type="button" onClick={cancel}><Square size={14} />{stopping ? t("fileHash.stopping") : t("fileHash.stop")}</button> : null}<button className="button button--secondary" type="button" disabled={running} onClick={() => { setFileName(""); setOutput(""); setError(""); setProgress(0); }}>{t("fileHash.clear")}</button></div>
    {fileName ? <p>{fileName}</p> : null}
    {running ? <progress aria-label={t("fileHash.progressLabel")} max="1" value={progress} /> : null}
    {error ? <p className="toolbox-error" role="alert">{error}</p> : null}
    <p className="toolbox-hint">{t("fileHash.hint")}</p>
    {output ? <div className="toolbox-result"><pre>{output}</pre><button className="button button--secondary" type="button" onClick={() => { void navigator.clipboard.writeText(output).catch(() => setError(t("fileHash.clipboardFailed"))); }}><Copy size={14} />{t("fileHash.copy")}</button></div> : null}
  </section>;
}
