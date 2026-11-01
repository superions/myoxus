// SPDX-License-Identifier: AGPL-3.0-or-later
import type { TemplateResult } from "lit";
import type {
  MermaidBlockDiagramModel,
  BlockImpact,
  BlockDiagramConfig,
} from "../../engine/block/index.js";
import type { MermaidGfxObjectEditIntent } from "../runtime/editor-capabilities.js";
import type { MermaidPageViewportProjection } from "../../mermaid-page-viewport-state.js";
import { defineMermaidFamilyReactRendererToken } from "../runtime/react-host.js";
import type {
  BlockCommandArgs,
  BlockCommandName,
  BlockParentAction,
} from "./actions.js";
export type BlockSelection = {
  kind: "block" | "composite" | "space" | "connection" | "comment" | "title";
  key: string;
  ownerKey?: string;
};
export type BlockCommandFeedback = {
  changed: boolean;
  diagnostic?: string;
  impact?: BlockImpact;
  selection?: string;
  sourceBasis?: string;
};
export type BlockReactHostProps = {
  readonly surface: "editor" | "controls";
  readonly config: BlockDiagramConfig;
  readonly model: MermaidBlockDiagramModel;
  readonly sourceBasis: string;
  readonly selected: BlockSelection | null;
  readonly selectedKeys: readonly string[];
  readonly selectedAnchor: { left: number; top: number } | null;
  readonly intent: MermaidGfxObjectEditIntent | null;
  readonly parentIntent: BlockParentAction | null;
  readonly groupAllowed: boolean;
  readonly readonly: boolean;
  readonly displayOnly: boolean;
  readonly embedded: boolean;
  readonly embeddedEditing: boolean;
  readonly actionTarget?: HTMLElement | null;
  readonly workarea: TemplateResult | null;
  readonly workareaFooter: TemplateResult | null;
  readonly pageViewport?: MermaidPageViewportProjection;
  readonly commentMarkers: readonly import("./annotation-projection.js").BlockCommentMarker[];
  readonly markersInClientSpace?: boolean;
  readonly placementPending?: boolean;
  readonly placement?: { centerX: number; centerY: number } | null;
  readonly subscribeEditIntent?: (
    handler: (intent: MermaidGfxObjectEditIntent) => void,
  ) => () => void;
  /** Repaint technical overlays on the existing native camera; no model write. */
  readonly subscribeViewportChange?: (handler: () => void) => () => void;
  readonly requestPlacement?: (
    onPlace: (placement: { centerX: number; centerY: number }) => void,
    onCancel?: () => void,
  ) => () => void;
  readonly resolveVisualBounds?: import("../runtime/editor-capabilities.js").MermaidGfxActionContext["resolveVisualBounds"];
  readonly selectObject?: (
    kind: "node" | "edge" | "subgraph",
    key: string,
  ) => void;
  readonly visualModel: import("../runtime/gfx-model.js").MermaidVisualModel;
  readonly getImpact: (selection: BlockSelection) => BlockImpact;
  readonly onCommand: <K extends BlockCommandName>(
    name: K,
    args: BlockCommandArgs<K>,
    basis: string,
    placement?: { centerX: number; centerY: number } | null,
  ) => BlockCommandFeedback;
  readonly previewCommand?: <K extends BlockCommandName>(
    name: K,
    args: BlockCommandArgs<K>,
    basis: string,
  ) => { feedback: BlockCommandFeedback; dispose: () => void };
  readonly onParentIntent: (intent: BlockParentAction | null) => void;
  readonly onEditIntent: (intent: MermaidGfxObjectEditIntent | null) => void;
  readonly onCloseSelection: () => void;
  readonly onWorkareaResize: () => void;
  readonly onEmbeddedActionsInsetChange: (height: number) => void;
  readonly resolveReturnFocusTarget: () => HTMLElement | null;
};
export const mermaidBlockRendererToken =
  defineMermaidFamilyReactRendererToken<BlockReactHostProps>("block");
