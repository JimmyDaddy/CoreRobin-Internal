export class ToolboxInputError extends Error {
  readonly code: string;
  readonly line: number | null;
  readonly column: number | null;

  constructor(code: string, message: string, line: number | null = null, column: number | null = null) {
    super(message);
    this.name = "ToolboxInputError";
    this.code = code;
    this.line = line;
    this.column = column;
  }
}
export function userFacingError(error: unknown): string {
  if (error instanceof ToolboxInputError) {
    const location = error.line !== null && error.column !== null
      ? `（第 ${error.line} 行，第 ${error.column} 列）`
      : "";
    return `${error.message}${location}`;
  }
  const command = readCommandError(error);
  if (command) return command.message;
  if (error instanceof Error) return error.message;
  return "处理失败，请检查输入后重试。";
}

function readCommandError(error: unknown): { code: string; message: string } | null {
  if (typeof error === "object" && error !== null && !Array.isArray(error)) {
    const record = error as Record<string, unknown>;
    if (typeof record.code === "string" && typeof record.message === "string") return { code: record.code, message: record.message };
  }
  const serialized = error instanceof Error ? error.message : typeof error === "string" ? error : null;
  if (!serialized) return null;
  try {
    const parsed: unknown = JSON.parse(serialized);
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      const record = parsed as Record<string, unknown>;
      if (typeof record.code === "string" && typeof record.message === "string") return { code: record.code, message: record.message };
    }
  } catch {
    // Fall through to ordinary Error/string handling.
  }
  return null;
}
