// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `mermaid-block-constants.ts` — P-VIRG-ARCH-I-04a
 * extracted constants, type aliases, and shape-label
 * table for the Mermaid block.
 *
 * This file is the home of the pure-value declarations
 * that previously lived at the top of `mermaid-block.ts`
 * (lines 243-391 of the pre-I-04 file). The block class
 * consumes them via the
 * `import { ... } from "./mermaid-block-constants.js"`
 * statement that I-04a added.
 *
 * **No new runtime behaviour.** Each declaration is
 * byte-for-byte identical to its pre-I-04 source line.
 * The move is a relocation, not a reimplementation:
 * the production values are unchanged, the import
 * graph is the only thing that changes.
 *
 * **Why this is a separate file, not a partial class.**
 * The block file uses a single `MermaidBlockComponent`
 * Lit class with 371 private fields. Partial classes
 * (mixin patterns) would change the runtime shape of
 * the class and would risk subtle `this` binding bugs.
 * Pure-value modules have no runtime instance, so
 * moving the constants and types out is risk-free.
 *
 * **Dependencies of the new file.**
 * - `./families/runtime/gfx-model.js` exports the
 *   `MermaidVisualNodeShape` type alias
 *   (used by `MERMAID_FLOWCHART_CORE_SHAPES`,
 *   `MERMAID_FLOWCHART_EXPANDED_SHAPES`,
 *   `MERMAID_FLOWCHART_SHAPES`, and
 *   `MERMAID_FLOWCHART_EXPANDED_SHAPE_LABELS`).
 * No other module in the Mermaid block imports from
 * this file yet (the block file does). The new
 * shape-helper file imports the label map; the smoke
 * spec and unit tests do not import either of the new
 * files. If a future test or sibling file needs a
 * symbol that lives here, add the import there — do
 * not re-import from the block file.
 *
 * @see docs/dev/virgultum/refactor-roadmap.md §I
 *      (P-VIRG-ARCH-I-04a)
 * @see docs/dev/virgultum/closeouts/phase-i.md
 *      (P-VIRG-ARCH-I-04 closeout)
 */

import type {
  MermaidVisualModel,
  MermaidVisualNodeShape,
} from "./families/runtime/gfx-model.js";

/**
 * Render-state discriminator for the Mermaid block.
 * Tracks the lifecycle of the SVG render: empty source,
 * error, finished render, or in-flight render. See
 * `MermaidBlockComponent._renderState` for the
 * field that holds this value at runtime.
 */
export type MermaidRenderState = "empty" | "error" | "finish" | "loading";

/**
 * View-mode discriminator for the Mermaid block. The
 * user toggles between a `source` editor and a
 * `visual` GFX editor. See
 * `MermaidBlockComponent._mode` for the field that
 * holds this value at runtime.
 */
export type MermaidViewMode = "source" | "visual";

/**
 * Persistent block chrome mode. `edit` exposes the full Mermaid authoring
 * surface; `display` renders the diagram as document content with no editing
 * toolbar so it can sit naturally in text-heavy pages.
 */
export type MermaidDisplayMode = "display" | "edit";

/**
 * Session-local history for a visual Mermaid mutation. Each side is a
 * complete semantic and geometric state; replay regenerates Source from the
 * selected model instead of keeping a second Source history.
 */
export type MermaidVisualHistoryModel = MermaidVisualModel & {
  /** Session-only Surface origin for replaying owner-relative geometry. */
  projectionOrigin?: { x: number; y: number };
};

export type MermaidVisualHistoryEntry = {
  after: MermaidVisualHistoryModel;
  before: MermaidVisualHistoryModel;
  coalesceKey?: string;
  /** Guard for the Source produced by replay; never a Source payload. */
  redoSourceHash?: string;
  /** Guard for the Source produced by replay; never a Source payload. */
  undoSourceHash?: string;
};

/**
 * Slash-menu snippets the Mermaid block exposes
 * (layout direction, edge style, palette). Keys are
 * stable string identifiers; values are the actual
 * Mermaid source-fragments the snippet inserts.
 */
export const MERMAID_SNIPPETS = {
  layout: {
    topDown: "flowchart TD",
    leftRight: "flowchart LR",
  },
  edgeStyle: {
    solid: "-->",
    dotted: "-.->",
    thick: "==>",
  },
  palette: {
    neutral:
      "classDef neutral fill:#f8fafc,stroke:#334155,color:#0f172a;\nclass A,B,C,D neutral;",
    accent:
      "classDef accent fill:#eef2ff,stroke:#4f46e5,color:#111827;\nclass A,B,C,D accent;",
    success:
      "classDef success fill:#ecfdf5,stroke:#059669,color:#064e3b;\nclass A,B,C,D success;",
  },
} as const;

/**
 * The 12 flowchart shapes the Mermaid visual editor
 * surfaces in the "core" toolbar. These are the
 * shapes the slash-menu's flowchart template
 * produces by default. The expanded set is below.
 */
export const MERMAID_FLOWCHART_CORE_SHAPES: readonly MermaidVisualNodeShape[] =
  [
    "rect",
    "rounded",
    "diamond",
    "circle",
    "database",
    "subroutine",
    "stadium",
    "hexagon",
    "parallelogram",
    "trapezoid",
    "asymmetric",
    "doublecircle",
  ];

/**
 * The 39 flowchart shapes the Mermaid visual editor
 * surfaces in the "expanded" toolbar. These are the
 * shapes the user picks when the core set is not
 * expressive enough. Together with the core set this
 * is the full Mermaid flowchart shape vocabulary.
 */
export const MERMAID_FLOWCHART_EXPANDED_SHAPES: readonly MermaidVisualNodeShape[] =
  [
    "doc",
    "docs",
    "lin-doc",
    "tag-doc",
    "notch-rect",
    "div-rect",
    "lin-rect",
    "st-rect",
    "tag-rect",
    "bow-rect",
    "datastore",
    "h-cyl",
    "lin-cyl",
    "lean-r",
    "lean-l",
    "trap-b",
    "trap-t",
    "notch-pent",
    "delay",
    "fork",
    "f-circ",
    "fr-circ",
    "sm-circ",
    "cross-circ",
    "tri",
    "flip-tri",
    "hourglass",
    "cloud",
    "bolt",
    "flag",
    "curv-trap",
    "brace",
    "brace-r",
    "braces",
    "bang",
    "odd",
    "text",
    "win-pane",
    "sl-rect",
  ];

/**
 * The full flowchart shape vocabulary, as a
 * concatenation of the core and expanded sets.
 * Used by the shape-picker menu to render the
 * "All shapes" view.
 */
export const MERMAID_FLOWCHART_SHAPES: readonly MermaidVisualNodeShape[] = [
  ...MERMAID_FLOWCHART_CORE_SHAPES,
  ...MERMAID_FLOWCHART_EXPANDED_SHAPES,
];

/**
 * Minimum allowed viewport height (CSS pixels) for
 * the Mermaid page-mode scoped GFX viewport. Below
 * this height the viewport switches to a "fit"
 * rendering and disables manual pan/zoom.
 */
export const MERMAID_SCOPED_GFX_PAGE_MIN_VIEWPORT_HEIGHT = 360;

/**
 * Minimum display-only viewport height for compact document figures. Display
 * mode has no toolbar, resize handles or edit affordances, so it can use less
 * canvas chrome while preserving the same readable-frame fit calculation.
 */
export const MERMAID_SCOPED_GFX_DISPLAY_MIN_VIEWPORT_HEIGHT = 240;

/**
 * Maximum allowed viewport height (CSS pixels) for
 * the Mermaid page-mode scoped GFX viewport. Above
 * this height the viewport caps the renderable
 * area to avoid over-scaling on tall windows.
 */
export const MERMAID_SCOPED_GFX_PAGE_MAX_VIEWPORT_HEIGHT = 1800;

/**
 * Keyboard resize step for the block-level Mermaid viewport handle. This is
 * intentionally larger than shape-resize steps because it controls the reading
 * area, not diagram geometry.
 */
export const MERMAID_SCOPED_GFX_PAGE_VIEWPORT_RESIZE_STEP = 80;

/**
 * Human-readable labels for the expanded flowchart
 * shape vocabulary. Used by the shape-picker menu
 * to render the tooltip / aria-label / "Insert
 * shape" button text. Maps each shape to its
 * flowchart-design-language meaning (e.g. `rounded`
 * is "Terminal", `diamond` is "Decision").
 */
export const MERMAID_FLOWCHART_EXPANDED_SHAPE_LABELS: Partial<
  Record<MermaidVisualNodeShape, string>
> = {
  asymmetric: "Manual input",
  bang: "Alert",
  bolt: "Communication link",
  "bow-rect": "Stored data",
  brace: "Comment",
  "brace-r": "Comment right",
  braces: "Comment block",
  circle: "Connector",
  cloud: "Cloud service",
  "cross-circ": "Summary",
  "curv-trap": "Display",
  database: "Database",
  datastore: "Data store",
  delay: "Delay",
  diam: "Decision",
  diamond: "Decision",
  "div-rect": "Divided process",
  doc: "Document",
  docs: "Multiple documents",
  doublecircle: "End state",
  "f-circ": "Junction",
  flag: "Paper tape",
  "flip-tri": "Manual file",
  fork: "Fork or join",
  "fr-circ": "Stop",
  "fr-rect": "Subprocess",
  "h-cyl": "Direct access storage",
  hexagon: "Preparation",
  hourglass: "Collate",
  "lean-l": "Output",
  "lean-r": "Input",
  "lin-cyl": "Disk storage",
  "lin-doc": "Lined document",
  "lin-rect": "Lined process",
  "notch-pent": "Loop limit",
  "notch-rect": "Card",
  odd: "Odd-page connector",
  parallelogram: "Input or output",
  rect: "Process",
  rounded: "Terminal",
  "sl-rect": "Manual input",
  "sm-circ": "Start",
  "st-rect": "Multiple processes",
  stadium: "Start or end",
  subroutine: "Subroutine",
  "tag-doc": "Tagged document",
  "tag-rect": "Tagged process",
  text: "Text annotation",
  "trap-b": "Priority action",
  "trap-t": "Manual operation",
  trapezoid: "Manual operation",
  tri: "Extract",
  "win-pane": "Internal storage",
};
