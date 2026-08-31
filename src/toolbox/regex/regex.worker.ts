interface WorkerMatch {
  index: number;
  text: string;
  groups: Record<string, string | undefined>;
}

self.onmessage = (event: MessageEvent<{ pattern: string; flags: string; text: string; replacement: string }>) => {
  try {
    const { pattern, flags, text, replacement } = event.data;
    const expression = new RegExp(pattern, flags.includes("g") ? flags : `${flags}g`);
    const matches: WorkerMatch[] = [];
    let match: RegExpExecArray | null;
    while ((match = expression.exec(text)) !== null && matches.length < 1_000) {
      matches.push({ index: match.index, text: match[0], groups: { ...(match.groups ?? {}) } });
      if (match[0] === "") expression.lastIndex += 1;
    }
    self.postMessage({ ok: true, value: { matches, replacement: text.replace(new RegExp(pattern, flags), replacement) } });
  } catch (error) {
    self.postMessage({ ok: false, error: error instanceof Error ? error.message : "正则执行失败。" });
  }
};
