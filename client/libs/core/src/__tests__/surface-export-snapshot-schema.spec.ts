/**
 * @vitest-environment happy-dom
 *
 * Edgeless snapshot capture — surface schema contract (#1238).
 *
 * The server-side PDF builder (`server/crates/pdf_export/src/builder/yjs.rs`,
 * `build_edgeless_snapshot`) reads three Yjs map keys off
 * `myoxus:surface|surface-ref|frame|mindmap` blocks:
 *   - `prop:exportSnapshotBlobId` (string)
 *   - `prop:exportSnapshotWidth`  (u32)
 *   - `prop:exportSnapshotHeight` (u32)
 * The editor side writes them via
 * `ExportManager.captureEdgelessSnapshotForExport()` using
 * `doc.updateBlock(surfaceModel, { exportSnapshotBlobId, ... })`. That call
 * routes through the proxy in
 * `virgultum/framework/store/src/model/block/sync-controller.ts:179-200`,
 * which gates writes on `model.keys.includes(p)`. `model.keys` is hydrated
 * from the schema's `props()` factory at parse time.
 *
 * Contract: if any of the three keys disappears from the schema, write
 * attempts will be silently dropped and the server will fall back to the
 * empty-snapshot placeholder — exactly the regression this test guards.
 *
 * Invariants:
 *  - INV-EDGELESS-SNAPSHOT-SCHEMA-01: schema's props() factory yields all
 *    three export-snapshot keys with correct default types
 *  - INV-EDGELESS-SNAPSHOT-SCHEMA-02: schema version is 6 (bumped from 5
 *    when the keys were added)
 *  - INV-EDGELESS-SNAPSHOT-SCHEMA-03: flavour is canonical `myoxus:surface`
 *    (server reads canonical flavour after `flavour-alias` normalization)
 */
import { SurfaceBlockSchema } from "@virgultum/editor/blocks/surface";
import { internalPrimitives } from "@virgultum/editor/store";
import { describe, expect, test } from "vitest";

describe("SurfaceBlockSchema — edgeless export-snapshot contract (#1238)", () => {
  test("INV-EDGELESS-SNAPSHOT-SCHEMA-01: props() declares all three export-snapshot keys", () => {
    const props = SurfaceBlockSchema.model.props!(internalPrimitives);
    const keys = Object.keys(props);

    expect(keys).toContain("exportSnapshotBlobId");
    expect(keys).toContain("exportSnapshotWidth");
    expect(keys).toContain("exportSnapshotHeight");

    expect(props.exportSnapshotBlobId).toBe("");
    expect(props.exportSnapshotWidth).toBe(0);
    expect(props.exportSnapshotHeight).toBe(0);
  });

  test("INV-EDGELESS-SNAPSHOT-SCHEMA-02: schema version is 6", () => {
    expect(SurfaceBlockSchema.version).toBe(6);
  });

  test("INV-EDGELESS-SNAPSHOT-SCHEMA-03: flavour is canonical myoxus:surface", () => {
    expect(SurfaceBlockSchema.model.flavour).toBe("myoxus:surface");
  });
});
