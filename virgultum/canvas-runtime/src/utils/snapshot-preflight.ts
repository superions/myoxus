export interface EdgelessSnapshotPreflightLimits {
  maxCanvasDimensionPx: number;
  maxCanvasTotalPixels: number;
}

export type EdgelessSnapshotPreflightSeverity = "ok" | "warning" | "severe";

export interface EdgelessSnapshotPreflightResult {
  severity: EdgelessSnapshotPreflightSeverity;
  scale: number;
  width: number;
  height: number;
  scaledWidth: number;
  scaledHeight: number;
  maxCanvasDimensionPx: number;
  maxCanvasTotalPixels: number;
}

export const DEFAULT_EDGELESS_SNAPSHOT_PREFLIGHT_LIMITS: EdgelessSnapshotPreflightLimits =
  {
    maxCanvasDimensionPx: 8192,
    maxCanvasTotalPixels: 4096 * 4096,
  };

function computePreflightScale(
  width: number,
  height: number,
  limits: EdgelessSnapshotPreflightLimits,
): number {
  if (width <= 0 || height <= 0) return 1;
  const dimensionScale = Math.min(
    limits.maxCanvasDimensionPx / width,
    limits.maxCanvasDimensionPx / height,
    1,
  );
  const totalPixelScale = Math.min(
    Math.sqrt(limits.maxCanvasTotalPixels / (width * height)),
    1,
  );
  return Math.min(dimensionScale, totalPixelScale, 1);
}

/**
 * Decide whether an Edgeless canvas needs a pre-export warning before the
 * snapshot capture path downscales it. `warning` means the canvas exceeds at
 * least one server limit but will be reduced within the normal envelope;
 * `severe` means one axis or the total area exceeds 2x the configured limit and
 * the UI should explicitly warn that rendering may take a long time.
 */
export function checkSnapshotPreflight(
  width: number,
  height: number,
  limits: EdgelessSnapshotPreflightLimits = DEFAULT_EDGELESS_SNAPSHOT_PREFLIGHT_LIMITS,
): EdgelessSnapshotPreflightResult {
  const scale = computePreflightScale(width, height, limits);
  const scaledWidth =
    width > 0 ? Math.max(1, Math.floor(width * scale)) : width;
  const scaledHeight =
    height > 0 ? Math.max(1, Math.floor(height * scale)) : height;
  const exceedsDimension =
    width > limits.maxCanvasDimensionPx || height > limits.maxCanvasDimensionPx;
  const exceedsTotal =
    width > 0 && height > 0 && width * height > limits.maxCanvasTotalPixels;
  const severe =
    width > limits.maxCanvasDimensionPx * 2 ||
    height > limits.maxCanvasDimensionPx * 2 ||
    (width > 0 &&
      height > 0 &&
      width * height > limits.maxCanvasTotalPixels * 2);

  return {
    severity: severe
      ? "severe"
      : exceedsDimension || exceedsTotal
        ? "warning"
        : "ok",
    scale,
    width,
    height,
    scaledWidth,
    scaledHeight,
    maxCanvasDimensionPx: limits.maxCanvasDimensionPx,
    maxCanvasTotalPixels: limits.maxCanvasTotalPixels,
  };
}
