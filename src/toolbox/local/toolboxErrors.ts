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
  if (error instanceof Error) return error.message;
  return "处理失败，请检查输入后重试。";
}
