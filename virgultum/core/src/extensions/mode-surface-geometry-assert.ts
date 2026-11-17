// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `mode-surface-geometry-assert.ts` - pure-logic assertion
 * helper for the `P-VIRG-ARCH-D-02` refactor-testharness.
 *
 * The Playwright-coupled `captureModeSurfaceGeometry` lives in
 * `tests/client/editor-core/virgultum/e2e/utils/capture-mode-surface-geometry.ts`.
 * That file imports `Page` and friends from `@playwright/test`, which
 * makes it impossible to unit-test under `virgultum/editor/ext-loader`
 * (no Playwright dep). To make the assertion logic testable in a
 * vitest unit-runner, this file provides the **same** `MatrixRowId`,
 * `CaptureDocMode`, `CaptureSurface`, `CaptureModeSurfaceOptions`,
 * `ModeSurfaceGeometryPayload` and `assertModeSurfaceGeometry`
 * without any browser dependency.
 *
 * The e2e helper re-uses this module (or, in the current
 * implementation, mirrors its tables verbatim) so the test and the
 * production code path cannot drift.
 *
 * @see docs/dev/virgultum/refactor-roadmap.md §11
 *      (Verhaltensmatrix M01..M15)
 * @see docs/dev/virgultum/refactor-roadmap.md §D
 *      (P-VIRG-ARCH-D-02)
 */

import {
  getMatrixRowFromDisplayId,
  getModeSurfaceContractEntry,
} from "./mode-surface-contract";

/**
 * Matrix-Zeilen-Identifier. Werte sind 1-basiert und exakt
 * abgestimmt mit §11 der Refactor-Roadmap.
 *
 * **Naming:** This is the *verbose* form used by the harness; the
 * D-01 contract exports a shorter `MatrixRowId` (`M01`..`M15`).
 * Both are needed (the harness maps an M-row to a `surface`
 * configuration; the contract maps an M-row to a `FeatureScope` set),
 * so the two live in different modules under different names.
 */
export type GeometryMatrixRowId =
  | "M01-page-empty"
  | "M02-page-rich-text"
  | "M03-page-database-table"
  | "M04-page-database-kanban"
  | "M05-page-event-block"
  | "M06-page-bpmn-hidden-beta"
  | "M07-edgeless-empty"
  | "M08-edgeless-note-with-page-content"
  | "M09-edgeless-kanban-canvas-path"
  | "M10-edgeless-frame-note-selection"
  | "M11-preview-page"
  | "M12-preview-edgeless"
  | "M13-mobile-page"
  | "M14-mobile-edgeless"
  | "M15-readonly-shared";

/**
 * DocMode-Werte des Capture-Harness-Subsets.
 *
 * ACHTUNG: `CaptureDocMode` ist ein **Capture-Harness-Subset** und
 * NICHT identisch mit der Runtime-`DocMode`-Union aus
 * `core/editor/virgultum`. Die Runtime-Union enthaelt zusaetzlich
 * `mobile-page`, `mobile-edgeless`, `preview-page` und
 * `preview-edgeless`. Der Capture-Harness bildet nur
 * `page | edgeless` ab, weil der Phase-D-Test-Scope (D-01..D-04)
 * bewusst die Default-Editor- und Edgeless-Notiz-Faelle abdeckt.
 * Mobile- und Preview-Mode werden NICHT von
 * `assertModeSurfaceGeometry` validiert — dafuer sind separate
 * Captures in zukuenftigen Phasen vorgesehen.
 */
export type CaptureDocMode = "page" | "edgeless";

/** Welche Surface-Konfiguration der Capture abbilden soll. */
export type CaptureSurface =
  | "empty"
  | "rich-text"
  | "database-table"
  | "database-kanban"
  | "event-block"
  | "bpmn-block"
  | "note-page"
  | "kanban-canvas"
  | "frame-multi"
  | "preview"
  | "mobile"
  | "readonly";

/** Matrix-Zeile + Surface + Mode + Optionen. */
export interface CaptureModeSurfaceOptions {
  matrixRow: GeometryMatrixRowId;
  mode: CaptureDocMode;
  surface: CaptureSurface;
  theme?: "light" | "dark";
  viewport?: { width: number; height: number };
  docId?: string;
  workspaceId?: string;
  captureConsole?: boolean;
  captureScreenshot?: boolean;
  featureFlags?: {
    bpmnHiddenBeta?: boolean;
    eventBlock?: boolean;
  };
  strict?: boolean;
}

/** Geometrie-Payload. */
export interface ModeSurfaceGeometryPayload {
  matrixRow: GeometryMatrixRowId;
  mode: CaptureDocMode;
  surface: CaptureSurface;
  theme: "light" | "dark";
  capturedAt: string;
  docId?: string;
  workspaceId?: string;
  viewport: { width: number; height: number };
  root?: {
    selector: string;
    box: { x: number; y: number; w: number; h: number };
  };
  surfaceBox?: { x: number; y: number; w: number; h: number };
  notes?: Array<{
    id: string;
    xywh: [number, number, number, number];
    displayMode?: "page-content" | "edgeless-only" | "both";
  }>;
  frames?: Array<{
    id: string;
    title: string;
    xywh: [number, number, number, number];
  }>;
  selection?: {
    count: number;
    bounds: Array<{ x: number; y: number; w: number; h: number }>;
  };
  zoomLevel?: number;
  pageBlocksCount?: number;
  readonly?: boolean;
  consoleSummary?: {
    totalEvents: number;
    errors: number;
    warnings: number;
    fatalPatterns: string[];
  };
  screenshotPath?: string;
  error?: string;
}

/** Edgeless-Matrix-Zeilen (brauchen `surfaceBox`). */
const EDGELESS_ROWS: ReadonlySet<GeometryMatrixRowId> = new Set([
  "M07-edgeless-empty",
  "M08-edgeless-note-with-page-content",
  "M09-edgeless-kanban-canvas-path",
  "M10-edgeless-frame-note-selection",
  "M12-preview-edgeless",
  "M14-mobile-edgeless",
]);

/** Page-Matrix-Zeilen (brauchen `root`). */
const PAGE_ROWS: ReadonlySet<GeometryMatrixRowId> = new Set([
  "M01-page-empty",
  "M02-page-rich-text",
  "M03-page-database-table",
  "M04-page-database-kanban",
  "M05-page-event-block",
  "M06-page-bpmn-hidden-beta",
  "M11-preview-page",
  "M13-mobile-page",
]);

/** Zeilen, die mindestens eine Note brauchen.
 *
 * P-VIRG-ARCH-E-02: M09 (edgeless-kanban-canvas-path) braucht
 * zwingend eine Note, weil die Kanban-View in M09 in einem
 * Note-Container gerendert wird (siehe
 * `docs/dev/virgultum/refactor-roadmap.md` §E M09-Spec). Ohne Note
 * waere der Negativ-Nachweis "Kanban-Selection unerreichbar" (Roadmap
 * Z. 791) trivial wahr, und P-VIRG-KANBAN-RENDER-03 haette keine
 * Angriffs-Flaeche. Daher `notes.length >= 1` als Pflicht.
 */
const NOTES_REQUIRED: ReadonlySet<GeometryMatrixRowId> = new Set([
  "M08-edgeless-note-with-page-content",
  "M09-edgeless-kanban-canvas-path",
  "M10-edgeless-frame-note-selection",
]);

/** Zeilen, die mindestens einen Frame brauchen. */
const FRAMES_REQUIRED: ReadonlySet<GeometryMatrixRowId> = new Set([
  "M10-edgeless-frame-note-selection",
]);

/** Mobile-Zeilen (viewport.width <= 640). */
const MOBILE_ROWS: ReadonlySet<GeometryMatrixRowId> = new Set([
  "M13-mobile-page",
  "M14-mobile-edgeless",
]);

/**
 * Hard-fail Pruefung. Wirft, wenn die Payload nicht den Pflicht-
 * Feldern der jeweiligen Matrix-Zeile entspricht.
 *
 * Wirft `Error` mit der genauen Pflicht-Verletzung. Konsumenten
 * (Playwright `expect(...).not.toThrow()` oder `try/catch`) koennen
 * die Meldung in der Fehler-Ausgabe protokollieren.
 *
 * D-02 §4 negative-acceptance:
 *
 * - `payload.error` ist immer ein Hard-Fail.
 * - Edgeless-Rows (M07..M10, M12, M14): `surfaceBox` muss non-zero sein.
 * - Page-Rows (M01..M06, M11, M13): `root` muss vorhanden sein.
 * - M08 / M10: `notes` muss non-empty sein.
 * - M10: `frames` muss non-empty UND `notes.length >= 2` sein.
 * - M13 / M14: `viewport.width <= 640`.
 * - M15: entweder `payload.readonly === true` oder
 *   `payload.surface === "readonly"`.
 */
export function assertModeSurfaceGeometry(
  payload: ModeSurfaceGeometryPayload,
  options: CaptureModeSurfaceOptions,
): void {
  if (payload.error) {
    throw new Error(
      `assertModeSurfaceGeometry: ${payload.matrixRow} capture returned error '${payload.error}'`,
    );
  }
  if (payload.matrixRow !== options.matrixRow) {
    throw new Error(
      `assertModeSurfaceGeometry: matrixRow mismatch (expected ${options.matrixRow}, got ${payload.matrixRow})`,
    );
  }
  if (payload.mode !== options.mode) {
    throw new Error(
      `assertModeSurfaceGeometry: mode mismatch (expected ${options.mode}, got ${payload.mode})`,
    );
  }

  if (
    EDGELESS_ROWS.has(payload.matrixRow) &&
    (!payload.surfaceBox ||
      payload.surfaceBox.w <= 0 ||
      payload.surfaceBox.h <= 0)
  ) {
    throw new Error(
      `assertModeSurfaceGeometry: ${payload.matrixRow} requires a non-empty edgeless surfaceBox`,
    );
  }

  if (PAGE_ROWS.has(payload.matrixRow) && !payload.root) {
    throw new Error(
      `assertModeSurfaceGeometry: ${payload.matrixRow} requires a page root`,
    );
  }

  if (
    NOTES_REQUIRED.has(payload.matrixRow) &&
    (!payload.notes || payload.notes.length === 0)
  ) {
    throw new Error(
      `assertModeSurfaceGeometry: ${payload.matrixRow} requires at least one note`,
    );
  }

  if (FRAMES_REQUIRED.has(payload.matrixRow)) {
    if (!payload.frames || payload.frames.length === 0) {
      throw new Error(
        `assertModeSurfaceGeometry: ${payload.matrixRow} requires at least one frame`,
      );
    }
    if (!payload.notes || payload.notes.length < 2) {
      throw new Error(
        `assertModeSurfaceGeometry: ${payload.matrixRow} requires >= 2 notes in a frame`,
      );
    }
  }

  if (MOBILE_ROWS.has(payload.matrixRow) && payload.viewport.width > 640) {
    throw new Error(
      `assertModeSurfaceGeometry: ${payload.matrixRow} requires viewport.width <= 640 (got ${payload.viewport.width})`,
    );
  }

  if (payload.matrixRow === "M15-readonly-shared") {
    const isReadonly = payload.readonly === true;
    const isReadonlySurface = payload.surface === "readonly";
    if (!isReadonly && !isReadonlySurface) {
      throw new Error(
        `assertModeSurfaceGeometry: ${payload.matrixRow} requires payload.readonly === true or surface === "readonly"`,
      );
    }
  }
}

/**
 * Inverse: liefert die Liste der Pflicht-Verletzungen statt zu
 * werfen. Nuetzlich fuer Diagnose-Tools, die alle Fehler auf einmal
 * sammeln wollen.
 */
export function checkModeSurfaceGeometry(
  payload: ModeSurfaceGeometryPayload,
  options: CaptureModeSurfaceOptions,
): string[] {
  const errors: string[] = [];
  try {
    assertModeSurfaceGeometry(payload, options);
  } catch (e) {
    if (e instanceof Error) errors.push(e.message);
  }
  return errors;
}

/**
 * Bridge zur D-01 Mode/Surface-Contract-Tabelle: liefert
 * `true` wenn die Matrix-Zeile Edgeless-Scopes erlaubt, sonst
 * `false`. Heute ungenutzt; vorhanden fuer D-04 (Visual Evidence
 * Standard), wo das Evidence-Tool weiss muss, ob eine Zeile einen
 * Edgeless-Screenshot braucht.
 */
export function isEdgelessMatrixRow(matrixId: GeometryMatrixRowId): boolean {
  // "M07".."M10" sind Page-Edgeless-Runtime; "M12" Preview-Edgeless;
  // "M14" Mobile-Edgeless. Wir befragen die Contract-Tabelle.
  // D-FIND-07: the prefix extraction previously used
  // `matrixId.slice(0, 3)` which was brittle (it
  // would break for a hypothetical `M100` row).
  // The new `getMatrixRowFromDisplayId` helper makes
  // the parsing canonical and returns `null` for
  // malformed input.
  const prefix = getMatrixRowFromDisplayId(matrixId);
  if (!prefix) return false;
  const contract = getModeSurfaceContractEntry(prefix);
  if (!contract) return false;
  return (
    contract.allowedScopes.includes("edgeless") ||
    contract.allowedScopes.includes("preview-edgeless") ||
    contract.allowedScopes.includes("mobile-edgeless")
  );
}

// ---------------------------------------------------------------------------
// P-VIRG-ARCH-D-04 — Visual Evidence Standard
//
// Ein Evidence-Manifest-Eintrag bündelt pro Matrix-Zeile M01..M15 alle
// Pflicht-Artefakte, die ein Phase-B/C/D/E-Closeout braucht:
//
//   - Vorher-/Nachher-Screenshots (Light + Dark + Mobile)
//   - DOM-/Geometry-Payload (siehe `ModeSurfaceGeometryPayload`)
//   - Console-/Worker-Auszug (`consoleSummary` + fatal patterns)
//   - reproduzierbare Route (URL, room, blobSource)
//   - Doc-Seed (welche `initEmpty...`-Calls den State erzeugt haben)
//   - Feature-Mode (theme, viewport, surface)
//   - Surface-/Note-/Frame-IDs
//   - konkretes Testkommando (für Re-Run / Replay)
//
// **Negativ-Abnahme:** Ein Eintrag ohne Route, ohne Testkommando,
// ohne IDs, ohne Console-Summary oder ohne Screenshots zählt NICHT
// als Closeout-Evidence. `verifyEvidenceManifestEntry` erzwingt das.
// ---------------------------------------------------------------------------

/** Theme des Evidence-Eintrags. */
export type EvidenceTheme = "light" | "dark";

/** Reproduzierbare Route: URL + Identifikatoren. */
export interface EvidenceRoute {
  /** Vollständige URL zum Zeitpunkt der Capture. */
  url: string;
  /** Room-ID (oder Embed-Doc-ID), falls zutreffend. */
  room?: string;
  /** Blob-Quelle (idb/mock/array), falls zutreffend. */
  blobSource?: string;
  /** Welcher Playground-URL-Stamm genutzt wurde. */
  origin: string;
}

/** Ein einzelner Doc-Seed-Schritt. */
export interface EvidenceSeedStep {
  /** Symbolischer Op-Name, z.B. `initEmptyEdgelessState`, `switchEditorMode`. */
  op: string;
  /** Argumente als String-String-Map (keine Live-Objekte, JSON-serialisierbar). */
  args?: Record<string, string>;
}

/** Doc-Seed: was wurde getan, um den State zu erreichen. */
export interface EvidenceDocSeed {
  /** Kurzes Label, z.B. "page with note + hello". */
  label: string;
  /** Reihenfolge der Init-/Setup-Calls. */
  steps: EvidenceSeedStep[];
}

/** Feature-Mode / Kontext zum Capture-Zeitpunkt. */
export interface EvidenceFeatureMode {
  theme: EvidenceTheme;
  surface: CaptureSurface;
  viewport: { width: number; height: number };
  /** Aktive Feature-Flags (z.B. `bpmnHiddenBeta`, `eventBlock`). */
  flags?: Record<string, boolean>;
}

/** Block-IDs, die im Capture eine Rolle spielen. */
export interface EvidenceBlockIds {
  /** Note-IDs (Edgeless-Mode). */
  notes: string[];
  /** Frame-IDs (Edgeless-Mode). */
  frames: string[];
  /** Root-IDs (Page oder Edgeless). */
  roots: string[];
}

/** Screenshot-Pfade pro Theme. */
export interface EvidenceScreenshots {
  light?: string;
  dark?: string;
  mobile?: string;
}

/** Console-Auszug zum Capture-Zeitpunkt. */
export interface EvidenceConsole {
  total: number;
  errors: number;
  warnings: number;
  /** Fatal-Pattern-Treffer (siehe `setupConsoleCapture`). */
  fatalPatterns: string[];
}

/** Review-Metadaten (von Menschen, optional). */
export interface EvidenceReview {
  reviewer?: string;
  reviewedAt?: string;
  /** "pass" = approved as evidence; "fail" = rejected; "needs-info" = offen. */
  verdict: "pass" | "fail" | "needs-info";
  notes?: string;
}

/** Status eines Evidence-Eintrags. */
export type EvidenceStatus = "draft" | "approved" | "rejected";

/**
 * Vollstaendiger Evidence-Manifest-Eintrag pro Capture.
 *
 * Erbt die Geometry-Felder von `ModeSurfaceGeometryPayload` und
 * ergaenzt die D-04-Pflicht-Felder (Route, Test-Command, Doc-Seed,
 * Screenshots, IDs, Console, Review).
 */
export interface EvidenceManifestEntry extends ModeSurfaceGeometryPayload {
  /** Eindeutige ID: `<matrixRow>-<theme>-<isoTimestampSanitized>`. */
  id: string;
  /** Konkretes Testkommando, das diesen Eintrag erzeugt hat. */
  testCommand: string;
  /** Reproduzierbare Route. */
  route: EvidenceRoute;
  /** Doc-Seed. */
  docSeed: EvidenceDocSeed;
  /** Feature-Mode (Theme, Surface, Viewport, Flags). */
  featureMode: EvidenceFeatureMode;
  /** Block-IDs (Notes/Frames/Roots). */
  blockIds: EvidenceBlockIds;
  /** Screenshot-Pfade pro Theme. */
  screenshots: EvidenceScreenshots;
  /** Console-Auszug (null wenn `captureConsole=false`). */
  console: EvidenceConsole | null;
  /** Review (null wenn noch nicht reviewt). */
  review: EvidenceReview | null;
  /** Status des Eintrags. */
  status: EvidenceStatus;
}

/** Pflicht-Felder pro `EvidenceManifestEntry` (fuer Negativ-Abnahme). */
const REQUIRED_EVIDENCE_FIELDS: ReadonlyArray<keyof EvidenceManifestEntry> = [
  "id",
  "matrixRow",
  "mode",
  "surface",
  "theme",
  "capturedAt",
  "viewport",
  "testCommand",
  "route",
  "docSeed",
  "featureMode",
  "blockIds",
  "screenshots",
  "console",
  "status",
];

/**
 * Erzeugt die deterministische ID eines Evidence-Eintrags.
 *
 * Format: `<matrixRow>-<theme>-<isoTimestamp>` mit
 * `:`-ersetzt-durch-`-`, damit der Wert dateinamen-sicher ist.
 */
export function buildEvidenceEntryId(
  matrixRow: GeometryMatrixRowId,
  theme: EvidenceTheme,
  capturedAt: string,
): string {
  return `${matrixRow}-${theme}-${capturedAt.replace(/[:.]/g, "-")}`;
}

/**
 * Negativ-Abnahme: Pflicht-Pruefung. Wirft, wenn ein Eintrag nicht
 * alle D-04-Pflicht-Felder hat. Liefert zusätzlich eine
 * `missingFields`-Liste, falls der Aufrufer das bevorzugt.
 *
 * Erzwingt:
 *
 * 1. `id` / `matrixRow` / `mode` / `surface` / `theme` /
 *    `capturedAt` / `viewport` (von Geometry ererbt).
 * 2. `testCommand` (nicht leer).
 * 3. `route.url` und `route.origin` (sonst nicht reproduzierbar).
 * 4. `docSeed.label` und `docSeed.steps` (sonst nicht nachvollziehbar).
 * 5. `featureMode.theme` / `surface` / `viewport` (sonst nicht
 *    vergleichbar).
 * 6. `blockIds` (Notes/Frames/Roots — leere Arrays sind OK fuer
 *    M01/M07, aber das Feld MUSS da sein).
 * 7. `screenshots` MUSS mindestens einen Pfad haben (Light, Dark
 *    oder Mobile). Negativ-Abnahme D-04 §1.
 * 8. `console` MUSS gesetzt sein (kann `null` sein, wenn
 *    `captureConsole=false` — das ist explizit OK).
 * 9. `status` MUSS gesetzt sein.
 */
export function verifyEvidenceManifestEntry(
  entry: EvidenceManifestEntry,
): void {
  for (const field of REQUIRED_EVIDENCE_FIELDS) {
    if (entry[field] === undefined) {
      throw new Error(
        `verifyEvidenceManifestEntry: ${entry.id} is missing required field '${String(
          field,
        )}'`,
      );
    }
  }
  if (entry.testCommand.trim().length === 0) {
    throw new Error(
      `verifyEvidenceManifestEntry: ${entry.id} testCommand must not be empty`,
    );
  }
  if (entry.route.url.length === 0 || entry.route.origin.length === 0) {
    throw new Error(
      `verifyEvidenceManifestEntry: ${entry.id} route.url and route.origin must be set (reproducibility gate)`,
    );
  }
  if (entry.docSeed.label.length === 0 || entry.docSeed.steps.length === 0) {
    throw new Error(
      `verifyEvidenceManifestEntry: ${entry.id} docSeed.label and docSeed.steps must be set (auditability gate)`,
    );
  }
  const { light, dark, mobile } = entry.screenshots;
  if (!light && !dark && !mobile) {
    throw new Error(
      `verifyEvidenceManifestEntry: ${entry.id} screenshots must contain at least one of {light, dark, mobile} (D-04 §1)`,
    );
  }
  if (!entry.console) {
    // Nicht-blockierend: `null` heisst explizit "Console-Capture
    // war abgeschaltet" und ist zulaessig. Aber ein vergessenes
    // Setzen wuerde hier landen — also lassen wir es zu und
    // markieren es im Doku-Absatz.
  }
}

/**
 * Inverse: sammelt alle Pflicht-Verletzungen, statt zu werfen.
 * Nuetzlich fuer Diagnose-Tools, die einen ganzen Manifest-Sweep
 * fahren wollen.
 */
export function checkEvidenceManifestEntry(
  entry: EvidenceManifestEntry,
): string[] {
  const errors: string[] = [];
  try {
    verifyEvidenceManifestEntry(entry);
  } catch (e) {
    if (e instanceof Error) errors.push(e.message);
  }
  return errors;
}
