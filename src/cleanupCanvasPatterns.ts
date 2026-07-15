export interface CleanupHatchPatternOptions {
  color: string;
  lineWidth: number;
  pixelRatio: number;
  spacing: number;
  themeKey: string;
}

type PatternSourceFactory = (
  context: CanvasRenderingContext2D,
  options: CleanupHatchPatternOptions,
) => CanvasImageSource | null;

const patternsByContext = new WeakMap<
  CanvasRenderingContext2D,
  Map<string, CanvasPattern | null>
>();

export function cleanupHatchPattern(
  context: CanvasRenderingContext2D,
  options: CleanupHatchPatternOptions,
  createSource: PatternSourceFactory = createPatternSource,
): CanvasPattern | null {
  let cache = patternsByContext.get(context);
  if (!cache) {
    cache = new Map();
    patternsByContext.set(context, cache);
  }
  const key = patternKey(options);
  if (cache.has(key)) return cache.get(key) ?? null;

  const source = createSource(context, options);
  const pattern = source ? context.createPattern(source, "repeat") : null;
  if (pattern) {
    const scale = 1 / normalizedPixelRatio(options.pixelRatio);
    pattern.setTransform({ a: scale, b: 0, c: 0, d: scale, e: 0, f: 0 });
  }
  cache.set(key, pattern);
  return pattern;
}

function patternKey(options: CleanupHatchPatternOptions): string {
  return [
    options.themeKey,
    options.color,
    options.spacing,
    options.lineWidth,
    normalizedPixelRatio(options.pixelRatio),
  ].join("|");
}

function createPatternSource(
  context: CanvasRenderingContext2D,
  options: CleanupHatchPatternOptions,
): CanvasImageSource | null {
  const document = context.canvas.ownerDocument;
  const tile = document.createElement("canvas");
  const pixelRatio = normalizedPixelRatio(options.pixelRatio);
  const spacing = Math.max(1, options.spacing);
  tile.width = Math.max(1, Math.round(spacing * pixelRatio));
  tile.height = tile.width;
  const tileContext = tile.getContext("2d");
  if (!tileContext) return null;

  tileContext.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
  tileContext.strokeStyle = options.color;
  tileContext.lineWidth = options.lineWidth;
  tileContext.beginPath();
  tileContext.moveTo(-spacing, 0);
  tileContext.lineTo(0, spacing);
  tileContext.moveTo(0, 0);
  tileContext.lineTo(spacing, spacing);
  tileContext.moveTo(spacing, 0);
  tileContext.lineTo(spacing * 2, spacing);
  tileContext.stroke();
  return tile;
}

function normalizedPixelRatio(pixelRatio: number): number {
  return Math.max(1, Math.min(Number.isFinite(pixelRatio) ? pixelRatio : 1, 2));
}
