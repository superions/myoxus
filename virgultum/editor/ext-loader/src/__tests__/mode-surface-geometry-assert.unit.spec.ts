// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `mode-surface-geometry-assert.unit.spec.ts` -
 * P-VIRG-ARCH-D-02 unit tests for the pure-logic
 * `assertModeSurfaceGeometry` helper.
 *
 * The Playwright-coupled `captureModeSurfaceGeometry` lives in
 * `tests/client/editor-core/virgultum/e2e/utils/capture-mode-surface-geometry.ts`.
 * The assertion logic is split into
 * `virgultum/editor/ext-loader/src/mode-surface-geometry-assert.ts` so it
 * can be tested without a browser. This spec pins the contract so the
 * e2e helper cannot drift from the unit test.
 *
 * The test covers:
 *
 * 1. **Schema shape.** The `MatrixRowId`, `CaptureDocMode` and
 *    `CaptureSurface` types compile and the 15 rows are accepted.
 * 2. **Happy path.** A payload + options pair that satisfies all
 *    row-specific requirements does not throw.
 * 3. **Edgeless rows** (M07, M08, M09, M10, M12, M14) require a
 *    non-empty `surfaceBox`; missing or zero-sized box throws.
 * 4. **Page rows** (M01..M06, M11, M13) require a `root`; missing
 *    root throws.
 * 5. **M08 / M10** require at least one note; empty `notes` throws.
 * 6. **M10** requires at least one frame AND `notes.length >= 2`; both
 *    conditions throw independently.
 * 7. **M13 / M14** require `viewport.width <= 640`; oversize viewport
 *    throws.
 * 8. **M15** requires `payload.readonly === true` OR
 *    `payload.surface === "readonly"`; neither throws.
 * 9. **Generic checks.** `matrixRow` and `mode` mismatch throw.
 * 10. **Error propagation.** A payload with `error` set throws.
 * 11. **`checkModeSurfaceGeometry` is the non-throwing twin.**
 * 12. **`isEdgelessMatrixRow` agrees with the contract.**
 *
 * @see docs/dev/virgultum/refactor-roadmap.md §D
 *      (P-VIRG-ARCH-D-02)
 */

import { describe, expect, test } from "vitest";

import {
  getMatrixRowDisplayId,
  MODE_SURFACE_CONTRACT,
} from "../mode-surface-contract";
import {
  assertModeSurfaceGeometry,
  type CaptureModeSurfaceOptions,
  checkModeSurfaceGeometry,
  isEdgelessMatrixRow,
  type ModeSurfaceGeometryPayload,
} from "../mode-surface-geometry-assert";

/**
 * Build a minimal valid payload. Each test customizes the fields it
 * wants to violate.
 */
function makePayload(
  row: ModeSurfaceGeometryPayload["matrixRow"],
  mode: ModeSurfaceGeometryPayload["mode"],
  surface: ModeSurfaceGeometryPayload["surface"],
  overrides: Partial<ModeSurfaceGeometryPayload> = {},
): ModeSurfaceGeometryPayload {
  return {
    matrixRow: row,
    mode,
    surface,
    theme: "light",
    capturedAt: new Date(0).toISOString(),
    viewport: { width: 1024, height: 768 },
    ...overrides,
  };
}

function makeOptions(
  row: ModeSurfaceGeometryPayload["matrixRow"],
  mode: ModeSurfaceGeometryPayload["mode"],
  surface: ModeSurfaceGeometryPayload["surface"],
): CaptureModeSurfaceOptions {
  return { matrixRow: row, mode, surface };
}

describe("P-VIRG-ARCH-D-02 assertModeSurfaceGeometry", () => {
  describe("happy path", () => {
    test("M07 edgeless-empty with a non-empty surfaceBox does not throw", () => {
      const payload = makePayload("M07-edgeless-empty", "edgeless", "empty", {
        surfaceBox: { x: 0, y: 0, w: 1024, h: 768 },
        root: {
          selector: "myoxus-edgeless-root",
          box: { x: 0, y: 0, w: 1024, h: 768 },
        },
      });
      expect(() =>
        assertModeSurfaceGeometry(
          payload,
          makeOptions("M07-edgeless-empty", "edgeless", "empty"),
        ),
      ).not.toThrow();
    });

    test("M01 page-empty with a page root does not throw", () => {
      const payload = makePayload("M01-page-empty", "page", "empty", {
        root: {
          selector: "myoxus-page-root",
          box: { x: 0, y: 0, w: 1024, h: 768 },
        },
        pageBlocksCount: 0,
      });
      expect(() =>
        assertModeSurfaceGeometry(
          payload,
          makeOptions("M01-page-empty", "page", "empty"),
        ),
      ).not.toThrow();
    });

    test("M10 edgeless-frame-note-selection with >=2 notes and >=1 frame does not throw", () => {
      const xywh: [number, number, number, number] = [0, 0, 100, 100];
      const payload = makePayload(
        "M10-edgeless-frame-note-selection",
        "edgeless",
        "frame-multi",
        {
          surfaceBox: { x: 0, y: 0, w: 1024, h: 768 },
          notes: [
            { id: "n1", xywh },
            { id: "n2", xywh },
          ],
          frames: [{ id: "f1", title: "", xywh }],
        },
      );
      expect(() =>
        assertModeSurfaceGeometry(
          payload,
          makeOptions(
            "M10-edgeless-frame-note-selection",
            "edgeless",
            "frame-multi",
          ),
        ),
      ).not.toThrow();
    });

    test("M15 readonly-shared with readonly === true does not throw", () => {
      const payload = makePayload("M15-readonly-shared", "page", "readonly", {
        readonly: true,
        root: {
          selector: "myoxus-page-root",
          box: { x: 0, y: 0, w: 1024, h: 768 },
        },
      });
      expect(() =>
        assertModeSurfaceGeometry(
          payload,
          makeOptions("M15-readonly-shared", "page", "readonly"),
        ),
      ).not.toThrow();
    });

    test("M15 readonly-shared with surface === 'readonly' does not throw", () => {
      const payload = makePayload("M15-readonly-shared", "page", "readonly", {
        root: {
          selector: "myoxus-page-root",
          box: { x: 0, y: 0, w: 1024, h: 768 },
        },
      });
      expect(() =>
        assertModeSurfaceGeometry(
          payload,
          makeOptions("M15-readonly-shared", "page", "readonly"),
        ),
      ).not.toThrow();
    });
  });

  describe("generic checks", () => {
    test("matrixRow mismatch throws", () => {
      const payload = makePayload("M01-page-empty", "page", "empty", {
        root: {
          selector: "myoxus-page-root",
          box: { x: 0, y: 0, w: 1024, h: 768 },
        },
      });
      expect(() =>
        assertModeSurfaceGeometry(
          payload,
          makeOptions("M07-edgeless-empty", "page", "empty"),
        ),
      ).toThrow(/matrixRow mismatch/);
    });

    test("mode mismatch throws", () => {
      const payload = makePayload("M01-page-empty", "page", "empty", {
        root: {
          selector: "myoxus-page-root",
          box: { x: 0, y: 0, w: 1024, h: 768 },
        },
      });
      expect(() =>
        assertModeSurfaceGeometry(
          payload,
          makeOptions("M01-page-empty", "edgeless", "empty"),
        ),
      ).toThrow(/mode mismatch/);
    });

    test("payload.error is propagated", () => {
      const payload = makePayload("M01-page-empty", "page", "empty", {
        error: "captured at the wrong time",
      });
      expect(() =>
        assertModeSurfaceGeometry(
          payload,
          makeOptions("M01-page-empty", "page", "empty"),
        ),
      ).toThrow(/capture returned error/);
    });
  });

  describe("edgeless rows require surfaceBox", () => {
    for (const row of [
      "M07-edgeless-empty",
      "M08-edgeless-note-with-page-content",
      "M09-edgeless-kanban-canvas-path",
      "M10-edgeless-frame-note-selection",
      "M12-preview-edgeless",
      "M14-mobile-edgeless",
    ] as const) {
      test(`${row} without surfaceBox throws`, () => {
        const payload = makePayload(row, "edgeless", "empty", {});
        expect(() =>
          assertModeSurfaceGeometry(
            payload,
            makeOptions(row, "edgeless", "empty"),
          ),
        ).toThrow(/non-empty edgeless surfaceBox/);
      });

      test(`${row} with zero-width surfaceBox throws`, () => {
        const payload = makePayload(row, "edgeless", "empty", {
          surfaceBox: { x: 0, y: 0, w: 0, h: 768 },
        });
        expect(() =>
          assertModeSurfaceGeometry(
            payload,
            makeOptions(row, "edgeless", "empty"),
          ),
        ).toThrow(/non-empty edgeless surfaceBox/);
      });
    }
  });

  describe("page rows require root", () => {
    for (const row of [
      "M01-page-empty",
      "M02-page-rich-text",
      "M03-page-database-table",
      "M04-page-database-kanban",
      "M05-page-event-block",
      "M06-page-bpmn-hidden-beta",
      "M11-preview-page",
      "M13-mobile-page",
    ] as const) {
      test(`${row} without root throws`, () => {
        const payload = makePayload(row, "page", "empty", {});
        expect(() =>
          assertModeSurfaceGeometry(payload, makeOptions(row, "page", "empty")),
        ).toThrow(/requires a page root/);
      });
    }
  });

  describe("notes-required rows", () => {
    for (const row of [
      "M08-edgeless-note-with-page-content",
      "M09-edgeless-kanban-canvas-path",
      "M10-edgeless-frame-note-selection",
    ] as const) {
      test(`${row} with empty notes throws`, () => {
        const payload = makePayload(row, "edgeless", "note-page", {
          surfaceBox: { x: 0, y: 0, w: 1024, h: 768 },
          notes: [],
        });
        expect(() =>
          assertModeSurfaceGeometry(
            payload,
            makeOptions(row, "edgeless", "note-page"),
          ),
        ).toThrow(/at least one note/);
      });
    }
  });

  describe("M10 frame requirements", () => {
    test("frames missing throws", () => {
      const xywh: [number, number, number, number] = [0, 0, 100, 100];
      const payload = makePayload(
        "M10-edgeless-frame-note-selection",
        "edgeless",
        "frame-multi",
        {
          surfaceBox: { x: 0, y: 0, w: 1024, h: 768 },
          notes: [
            { id: "n1", xywh },
            { id: "n2", xywh },
          ],
          frames: [],
        },
      );
      expect(() =>
        assertModeSurfaceGeometry(
          payload,
          makeOptions(
            "M10-edgeless-frame-note-selection",
            "edgeless",
            "frame-multi",
          ),
        ),
      ).toThrow(/at least one frame/);
    });

    test("notes.length < 2 throws", () => {
      const xywh: [number, number, number, number] = [0, 0, 100, 100];
      const payload = makePayload(
        "M10-edgeless-frame-note-selection",
        "edgeless",
        "frame-multi",
        {
          surfaceBox: { x: 0, y: 0, w: 1024, h: 768 },
          notes: [{ id: "n1", xywh }],
          frames: [{ id: "f1", title: "", xywh }],
        },
      );
      expect(() =>
        assertModeSurfaceGeometry(
          payload,
          makeOptions(
            "M10-edgeless-frame-note-selection",
            "edgeless",
            "frame-multi",
          ),
        ),
      ).toThrow(/>= 2 notes in a frame/);
    });
  });

  describe("mobile rows require viewport.width <= 640", () => {
    test("M13 with width 1024 throws", () => {
      const payload = makePayload("M13-mobile-page", "page", "mobile", {
        root: {
          selector: "myoxus-page-root",
          box: { x: 0, y: 0, w: 1024, h: 768 },
        },
        viewport: { width: 1024, height: 768 },
      });
      expect(() =>
        assertModeSurfaceGeometry(
          payload,
          makeOptions("M13-mobile-page", "page", "mobile"),
        ),
      ).toThrow(/viewport.width <= 640/);
    });

    test("M14 with width 640 is fine", () => {
      const payload = makePayload("M14-mobile-edgeless", "edgeless", "mobile", {
        surfaceBox: { x: 0, y: 0, w: 640, h: 768 },
        viewport: { width: 640, height: 768 },
      });
      expect(() =>
        assertModeSurfaceGeometry(
          payload,
          makeOptions("M14-mobile-edgeless", "edgeless", "mobile"),
        ),
      ).not.toThrow();
    });
  });

  describe("M15 readonly requirements", () => {
    test("neither readonly nor readonly surface throws", () => {
      const payload = makePayload("M15-readonly-shared", "page", "empty", {
        root: {
          selector: "myoxus-page-root",
          box: { x: 0, y: 0, w: 1024, h: 768 },
        },
        readonly: false,
      });
      expect(() =>
        assertModeSurfaceGeometry(
          payload,
          makeOptions("M15-readonly-shared", "page", "empty"),
        ),
      ).toThrow(/requires payload.readonly === true/);
    });
  });

  describe("checkModeSurfaceGeometry (non-throwing twin)", () => {
    test("returns empty array on a valid payload", () => {
      const payload = makePayload("M07-edgeless-empty", "edgeless", "empty", {
        surfaceBox: { x: 0, y: 0, w: 1024, h: 768 },
        root: {
          selector: "myoxus-edgeless-root",
          box: { x: 0, y: 0, w: 1024, h: 768 },
        },
      });
      const errors = checkModeSurfaceGeometry(
        payload,
        makeOptions("M07-edgeless-empty", "edgeless", "empty"),
      );
      expect(errors).toEqual([]);
    });

    test("returns one error per violation in a single call", () => {
      // Edgeless row with no surfaceBox AND a matrixRow-mismatch.
      // The first failure aborts the assertion; the helper returns
      // exactly one error. This is the same behaviour as
      // `assertModeSurfaceGeometry` (it throws on the first failure).
      const payload = makePayload(
        "M07-edgeless-empty",
        "edgeless",
        "empty",
        {},
      );
      const errors = checkModeSurfaceGeometry(
        payload,
        makeOptions("M01-page-empty", "edgeless", "empty"),
      );
      // matrixRow-mismatch fires first.
      expect(errors).toHaveLength(1);
      expect(errors[0]).toMatch(/matrixRow mismatch/);
    });
  });

  describe("isEdgelessMatrixRow agrees with MODE_SURFACE_CONTRACT", () => {
    test("all 15 rows match the contract", () => {
      // D-FIND-07: the test now uses the canonical
      // display id from `getMatrixRowDisplayId`
      // (the contract is the source of truth for
      // the suffix). The previous slug-of-description
      // heuristic was loose and did not always
      // match the canonical suffix.
      for (const entry of MODE_SURFACE_CONTRACT) {
        const id = getMatrixRowDisplayId(entry.matrixId) as Parameters<
          typeof isEdgelessMatrixRow
        >[0];
        const expected =
          entry.allowedScopes.includes("edgeless") ||
          entry.allowedScopes.includes("preview-edgeless") ||
          entry.allowedScopes.includes("mobile-edgeless");
        expect(isEdgelessMatrixRow(id)).toBe(expected);
      }
    });
  });
});
