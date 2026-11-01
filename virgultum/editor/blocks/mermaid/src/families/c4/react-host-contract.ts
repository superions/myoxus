// SPDX-License-Identifier: AGPL-3.0-or-later

import type { MermaidC4Model } from "../../engine/c4/index.js";
import type { C4CommandArgs, C4CommandName } from "./actions.js";
import type { TemplateResult } from "lit";
import type {
  MermaidGfxActionContext,
  MermaidGfxObjectEditIntent,
} from "../runtime/editor-capabilities.js";
import type { MermaidPageViewportProjection } from "../../mermaid-page-viewport-state.js";
import type { C4CommentMarker } from "./annotation-projection.js";
import type { MermaidVisualModel } from "../runtime/gfx-model.js";
import { defineMermaidFamilyReactRendererToken } from "../runtime/react-host.js";

export type C4CommandFeedback = {
  changed: boolean;
  sourceBasis?: string;
  diagnostic?: string;
  selection?: string;
};
/** All C4 controls receive the checked Source basis and a single commit port. */
export type C4ReactHostProps = {
  readonly model: MermaidC4Model;
  readonly sourceBasis: string;
  readonly readonly: boolean;
  readonly displayOnly: boolean;
  readonly visualModel?: MermaidVisualModel;
  /** A physical record or semantic owner change invalidates its local draft. */
  readonly draftIdentity?: string;
  /** Active editor viewport owns client-to-model geometry and gesture invalidation. */
  readonly viewportIdentity?: object;
  readonly resolveViewportPoint?: (point: {
    left: number;
    top: number;
  }) => { x: number; y: number } | null;
  /** Presentation commits preserve Source and persist on the stable GFX owner. */
  readonly onBoundaryCollapsed?: (
    selectionId: string,
    collapsed: boolean,
    sourceBasis: string,
  ) => C4CommandFeedback;
  readonly onCommand: <K extends C4CommandName>(
    name: K,
    args: C4CommandArgs<K>,
    basis: string,
  ) => C4CommandFeedback;
  readonly previewCommand?: <K extends C4CommandName>(
    name: K,
    args: C4CommandArgs<K>,
    basis: string,
  ) => { feedback: C4CommandFeedback; dispose: () => void };
  readonly onCloseSelection: () => void;
  readonly resolveReturnFocusTarget: () => HTMLElement | null;
};

export type C4Selection = {
  kind: "element" | "boundary" | "relationship";
  key: string;
  recordKey?: string;
};
export type C4ParentIntent =
  | "group"
  | "more"
  | "header"
  | "addElement"
  | "emptyBoundary"
  | "relation"
  | "comments"
  | "deleteSelection";
/** Host chrome and ephemeral intent are separate from the checked Source model. */
export type C4EditorReactHostProps = C4ReactHostProps & {
  readonly surface: "editor" | "controls";
  readonly selectedKeys: readonly string[];
  readonly intent: MermaidGfxObjectEditIntent | null;
  readonly parentIntent: C4ParentIntent | null;
  readonly embedded: boolean;
  readonly embeddedEditing: boolean;
  readonly actionTarget: HTMLElement | null;
  readonly workarea: TemplateResult | null;
  readonly workareaFooter: TemplateResult | null;
  readonly pageViewport?: MermaidPageViewportProjection;
  readonly commentMarkers: readonly C4CommentMarker[];
  readonly markersInClientSpace?: boolean;
  readonly subscribeEditIntent?: (
    handler: (intent: MermaidGfxObjectEditIntent) => void,
  ) => () => void;
  readonly resolveVisualAnchor: MermaidGfxActionContext["resolveVisualAnchor"];
  readonly resolveVisualBounds?: MermaidGfxActionContext["resolveVisualBounds"];
  readonly onEditIntent: (intent: MermaidGfxObjectEditIntent | null) => void;
  readonly onParentIntent: (intent: C4ParentIntent | null) => void;
  readonly onWorkareaResize: () => void;
  readonly onEmbeddedActionsInsetChange: (height: number) => void;
};

/** All five native headers share one Core renderer registration at the cutover. */
export const mermaidC4RendererToken =
  defineMermaidFamilyReactRendererToken<C4EditorReactHostProps>("mermaid.c4");
