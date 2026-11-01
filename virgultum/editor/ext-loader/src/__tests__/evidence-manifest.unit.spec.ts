// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `evidence-manifest.unit.spec.ts` - P-VIRG-ARCH-D-04 Visual
 * Evidence Standard: pure-logic tests for `EvidenceManifestEntry`,
 * `verifyEvidenceManifestEntry`, `checkEvidenceManifestEntry`, and
 * `buildEvidenceEntryId`.
 *
 * Kein Playwright, keine Browser-Calls: alle Helper-Funktionen
 * arbeiten auf JSON-repraesentierbaren Datenstrukturen.
 *
 * @see docs/dev/virgultum/refactor-roadmap.md §D
 *      (P-VIRG-ARCH-D-04)
 * @see docs/dev/virgultum/testing-and-qa.md §Visual Evidence Standard
 */

import { describe, expect, test } from "vitest";

import {
  buildEvidenceEntryId,
  checkEvidenceManifestEntry,
  type EvidenceConsole,
  type EvidenceDocSeed,
  type EvidenceFeatureMode,
  type EvidenceManifestEntry,
  type EvidenceRoute,
  type EvidenceScreenshots,
  verifyEvidenceManifestEntry,
} from "../mode-surface-geometry-assert.js";

/** Minimum-Manifest fuer positive Tests. */
function buildMinimalEntry(
  overrides: Partial<EvidenceManifestEntry> = {},
): EvidenceManifestEntry {
  const route: EvidenceRoute = {
    url: "http://localhost:5173/?room=playwright-x",
    origin: "http://localhost:5173/",
    room: "playwright-x",
    blobSource: "idb",
  };
  const docSeed: EvidenceDocSeed = {
    label: "page with note + hello",
    steps: [
      { op: "enterPlaygroundRoom" },
      { op: "initEmptyEdgelessState" },
      { op: "focusRichText" },
      { op: "type", args: { content: "hello" } },
    ],
  };
  const featureMode: EvidenceFeatureMode = {
    theme: "light",
    surface: "note-page",
    viewport: { width: 960, height: 900 },
  };
  const screenshots: EvidenceScreenshots = {
    light: "playwright/.qa/.../harness/screenshots/M08-light.png",
  };
  const consoleCap: EvidenceConsole = {
    total: 0,
    errors: 0,
    warnings: 0,
    fatalPatterns: [],
  };
  return {
    id: buildEvidenceEntryId(
      "M08-edgeless-note-with-page-content",
      "light",
      "2026-06-10T12:00:00.000Z",
    ),
    matrixRow: "M08-edgeless-note-with-page-content",
    mode: "edgeless",
    surface: "note-page",
    theme: "light",
    capturedAt: "2026-06-10T12:00:00.000Z",
    viewport: { width: 960, height: 900 },
    root: {
      selector: "myoxus-edgeless-root",
      box: { x: 0, y: 0, w: 960, h: 900 },
    },
    surfaceBox: { x: 0, y: 0, w: 960, h: 900 },
    notes: [{ id: "note-2", xywh: [0, 0, 200, 100] }],
    testCommand:
      "BROWSER=chromium yarn playwright test e2e/edgeless/mode-switch-myoxus.spec.ts -g M08",
    route,
    docSeed,
    featureMode,
    blockIds: { notes: ["note-2"], frames: [], roots: ["0"] },
    screenshots,
    console: consoleCap,
    review: null,
    status: "draft",
    ...overrides,
  };
}

describe("P-VIRG-ARCH-D-04 evidence manifest: buildEvidenceEntryId", () => {
  test("produces deterministic id with safe filename characters", () => {
    const id = buildEvidenceEntryId(
      "M08-edgeless-note-with-page-content",
      "light",
      "2026-06-10T12:00:00.000Z",
    );
    // Doppelpunkte und Punkte muessen ersetzt sein.
    expect(id).not.toContain(":");
    expect(id).toContain("2026-06-10T12-00-00-000Z");
    // Stabil ueber mehrere Aufrufe.
    expect(id).toBe(
      buildEvidenceEntryId(
        "M08-edgeless-note-with-page-content",
        "light",
        "2026-06-10T12:00:00.000Z",
      ),
    );
  });

  test("unterscheidet themes in der id", () => {
    const a = buildEvidenceEntryId("M01-page-empty", "light", "x");
    const b = buildEvidenceEntryId("M01-page-empty", "dark", "x");
    expect(a).not.toBe(b);
    expect(a).toMatch(/^M01-page-empty-light-/);
    expect(b).toMatch(/^M01-page-empty-dark-/);
  });
});

describe("P-VIRG-ARCH-D-04 evidence manifest: verifyEvidenceManifestEntry (happy path)", () => {
  test("akzeptiert vollstaendigen Eintrag", () => {
    const entry = buildMinimalEntry();
    expect(() => verifyEvidenceManifestEntry(entry)).not.toThrow();
    expect(checkEvidenceManifestEntry(entry)).toEqual([]);
  });

  test("akzeptiert Eintrag mit nur dark-screenshot", () => {
    const entry = buildMinimalEntry({
      screenshots: { dark: "playwright/.../M08-dark.png" },
      theme: "dark",
    });
    expect(() => verifyEvidenceManifestEntry(entry)).not.toThrow();
  });

  test("akzeptiert Eintrag mit nur mobile-screenshot", () => {
    const entry = buildMinimalEntry({
      screenshots: { mobile: "playwright/.../M08-mobile.png" },
      viewport: { width: 480, height: 900 },
    });
    expect(() => verifyEvidenceManifestEntry(entry)).not.toThrow();
  });

  test("akzeptiert Eintrag mit allen drei Screenshots (light+dark+mobile)", () => {
    const entry = buildMinimalEntry({
      screenshots: {
        light: "playwright/.../M08-light.png",
        dark: "playwright/.../M08-dark.png",
        mobile: "playwright/.../M08-mobile.png",
      },
    });
    expect(() => verifyEvidenceManifestEntry(entry)).not.toThrow();
  });

  test("akzeptiert console=null (captureConsole=false)", () => {
    const entry = buildMinimalEntry({ console: null });
    expect(() => verifyEvidenceManifestEntry(entry)).not.toThrow();
  });

  test("akzeptiert review=pass (post-review-Eintrag)", () => {
    const entry = buildMinimalEntry({
      review: {
        reviewer: "reviewer-a",
        reviewedAt: "2026-06-10T13:00:00.000Z",
        verdict: "pass",
        notes: "Looks good.",
      },
      status: "approved",
    });
    expect(() => verifyEvidenceManifestEntry(entry)).not.toThrow();
  });
});

describe("P-VIRG-ARCH-D-04 evidence manifest: verifyEvidenceManifestEntry (negative acceptance)", () => {
  test("wirft wenn id fehlt", () => {
    const entry = buildMinimalEntry();
    // @ts-expect-error: Test zwingend mit fehlendem Feld.
    delete entry.id;
    expect(() => verifyEvidenceManifestEntry(entry)).toThrow(
      /missing required field 'id'/,
    );
  });

  test("wirft wenn testCommand leer ist", () => {
    const entry = buildMinimalEntry({ testCommand: "  " });
    expect(() => verifyEvidenceManifestEntry(entry)).toThrow(
      /testCommand must not be empty/,
    );
  });

  test("wirft wenn route.url fehlt (Reproducibility-Gate)", () => {
    const entry = buildMinimalEntry();
    entry.route = { ...entry.route, url: "" };
    expect(() => verifyEvidenceManifestEntry(entry)).toThrow(
      /route\.url and route\.origin must be set/,
    );
  });

  test("wirft wenn route.origin fehlt", () => {
    const entry = buildMinimalEntry();
    entry.route = { ...entry.route, origin: "" };
    expect(() => verifyEvidenceManifestEntry(entry)).toThrow(
      /route\.url and route\.origin must be set/,
    );
  });

  test("wirft wenn docSeed.label leer ist (Auditability-Gate)", () => {
    const entry = buildMinimalEntry();
    entry.docSeed = { ...entry.docSeed, label: "" };
    expect(() => verifyEvidenceManifestEntry(entry)).toThrow(
      /docSeed\.label and docSeed\.steps must be set/,
    );
  });

  test("wirkt wenn docSeed.steps leer ist", () => {
    const entry = buildMinimalEntry();
    entry.docSeed = { ...entry.docSeed, steps: [] };
    expect(() => verifyEvidenceManifestEntry(entry)).toThrow(
      /docSeed\.label and docSeed\.steps must be set/,
    );
  });

  test("wirft wenn alle Screenshots fehlen (D-04 §1)", () => {
    const entry = buildMinimalEntry({ screenshots: {} });
    expect(() => verifyEvidenceManifestEntry(entry)).toThrow(
      /screenshots must contain at least one of/,
    );
  });

  test("wirft wenn status fehlt", () => {
    const entry = buildMinimalEntry();
    // @ts-expect-error: Test zwingend mit fehlendem Feld.
    delete entry.status;
    expect(() => verifyEvidenceManifestEntry(entry)).toThrow(
      /missing required field 'status'/,
    );
  });

  test("wirft wenn blockIds fehlt", () => {
    const entry = buildMinimalEntry();
    // @ts-expect-error: Test zwingend mit fehlendem Feld.
    delete entry.blockIds;
    expect(() => verifyEvidenceManifestEntry(entry)).toThrow(
      /missing required field 'blockIds'/,
    );
  });

  test("akzeptiert leere blockIds.notes (M01/M07 sind legitim leer)", () => {
    const entry = buildMinimalEntry({
      blockIds: { notes: [], frames: [], roots: ["0"] },
    });
    expect(() => verifyEvidenceManifestEntry(entry)).not.toThrow();
  });
});

describe("P-VIRG-ARCH-D-04 evidence manifest: checkEvidenceManifestEntry (sammelt Fehler)", () => {
  test("liefert leeres Array fuer valide Eintraege", () => {
    expect(checkEvidenceManifestEntry(buildMinimalEntry())).toEqual([]);
  });

  test("liefert mindestens einen Fehler fuer invalide Eintraege", () => {
    const entry = buildMinimalEntry({
      testCommand: "",
      screenshots: {},
    });
    // checkEvidenceManifestEntry folgt der D-02-Konvention
    // "erster Fehler": ein Sammel-Run ueber alle Felder ist eine
    // spaetere Erweiterung (D-FIND-13). Heute reicht der erste
    // Verstoss, um den Eintrag als nicht-evidence-faehig zu
    // markieren.
    const errors = checkEvidenceManifestEntry(entry);
    expect(errors.length).toBeGreaterThanOrEqual(1);
  });
});
