/**
 * @vitest-environment happy-dom
 *
 * Edgeless snapshot client-side limit math (#358 client-side mirror, #367).
 *
 * `ExportManager.captureEdgelessSnapshotForExport()` downscales the captured
 * canvas before upload so it fits the symmetric envelope enforced server-side
 * (`server/crates/pdf_export/src/ir/block.rs::EdgelessSnapshotLimits`):
 *   - max_canvas_dimension_px = 8192 (per axis)
 *   - max_canvas_total_pixels = 4096 * 4096 = 16,777,216
 *   - max_snapshot_size_bytes = 32 MiB (post-encode iterative downscale)
 *
 * `computeSnapshotScale(width, height)` is the pure math used by the capture
 * pipeline. The contract is symmetric: if the client returns scale s, the
 * encoded canvas (rounded width = floor(w*s)) MUST satisfy server validation
 * — otherwise the user sees a successful capture followed by an opaque
 * `error_class="TooLarge"` from the worker.
 *
 * Invariants:
 *  - INV-EDGELESS-LIMIT-01: small canvas (within all limits) yields scale 1
 *    — no unnecessary re-encode for the common case.
 *  - INV-EDGELESS-LIMIT-02: width-overshoot yields a scale that brings the
 *    longer axis under the per-axis limit (and never below the natural ratio).
 *  - INV-EDGELESS-LIMIT-03: total-pixel-overshoot at moderate dimensions
 *    yields a scale that brings the area under 16,777,216 px².
 *  - INV-EDGELESS-LIMIT-04: zero or negative dims return scale 1 (defensive,
 *    avoids NaN propagation into canvas dimensions).
 *  - INV-EDGELESS-LIMIT-05: scale never exceeds 1 — we only ever downscale.
 */
import { computeSnapshotScale } from "@virgultum/editor/blocks/surface";
import { describe, expect, test } from "vitest";

const MAX_DIM = 8192;
const MAX_TOTAL = 4096 * 4096;

describe("computeSnapshotScale — symmetric snapshot limit math (#367)", () => {
  test("INV-EDGELESS-LIMIT-01: within-limits canvas returns scale 1", () => {
    expect(computeSnapshotScale(1920, 1080)).toBe(1);
    expect(computeSnapshotScale(8192, 2048)).toBe(1); // exactly at dim limit
    expect(computeSnapshotScale(4096, 4096)).toBe(1); // exactly at total-px limit
  });

  test("INV-EDGELESS-LIMIT-02: width-overshoot scales the longer axis under the limit", () => {
    const scale = computeSnapshotScale(16384, 1024);
    expect(scale).toBeLessThan(1);
    expect(Math.floor(16384 * scale)).toBeLessThanOrEqual(MAX_DIM);
    expect(Math.floor(1024 * scale)).toBeLessThanOrEqual(MAX_DIM);
  });

  test("INV-EDGELESS-LIMIT-02b: height-overshoot also obeys the per-axis ceiling", () => {
    const scale = computeSnapshotScale(2048, 12288);
    expect(scale).toBeLessThan(1);
    expect(Math.floor(2048 * scale)).toBeLessThanOrEqual(MAX_DIM);
    expect(Math.floor(12288 * scale)).toBeLessThanOrEqual(MAX_DIM);
  });

  test("INV-EDGELESS-LIMIT-03: total-pixel overshoot drops area under 16,777,216 px²", () => {
    // 6000 × 6000 = 36,000,000 px — under per-axis ceiling but over total
    const scale = computeSnapshotScale(6000, 6000);
    expect(scale).toBeLessThan(1);
    const w = Math.floor(6000 * scale);
    const h = Math.floor(6000 * scale);
    expect(w * h).toBeLessThanOrEqual(MAX_TOTAL);
  });

  test("INV-EDGELESS-LIMIT-04: zero or negative dimensions return scale 1", () => {
    expect(computeSnapshotScale(0, 1080)).toBe(1);
    expect(computeSnapshotScale(1920, 0)).toBe(1);
    expect(computeSnapshotScale(-100, -100)).toBe(1);
  });

  test("INV-EDGELESS-LIMIT-05: scale never exceeds 1 (no upscaling)", () => {
    expect(computeSnapshotScale(100, 100)).toBe(1);
    expect(computeSnapshotScale(1, 1)).toBe(1);
    expect(computeSnapshotScale(50, 50)).toBe(1);
  });
});
