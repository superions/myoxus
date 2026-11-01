// SPDX-License-Identifier: AGPL-3.0-or-later
import type { TemplateResult } from "lit";
import type {
  MermaidStateModel,
  StateImpact,
  StateConfig,
} from "../../engine/state/index.js";
import type { MermaidGfxObjectEditIntent } from "../runtime/editor-capabilities.js";
import type { MermaidPageViewportProjection } from "../../mermaid-page-viewport-state.js";
import { defineMermaidFamilyReactRendererToken } from "../runtime/react-host.js";
import type {
  StateCommandArgs,
  StateCommandName,
  StateParentAction,
} from "./actions.js";
export type StateSelection = {
  kind:
    | "state"
    | "description"
    | "transition"
    | "composite"
    | "region"
    | "note"
    | "comment"
    | "title";
  key: string;
  ownerKey?: string;
};
export type StateCommandFeedback = {
  changed: boolean;
  diagnostic?: string;
  impact?: StateImpact;
  selection?: string;
  sourceBasis?: string;
};
export type StateReactHostProps = {
  readonly surface: "editor" | "controls";
  readonly config: StateConfig;
  readonly model: MermaidStateModel;
  readonly sourceBasis: string;
  readonly selected: StateSelection | null;
  readonly selectedKeys: readonly string[];
  readonly selectedAnchor: { left: number; top: number } | null;
  readonly intent: MermaidGfxObjectEditIntent | null;
  readonly parentIntent: StateParentAction | null;
  readonly groupAllowed: boolean;
  readonly readonly: boolean;
  readonly displayOnly: boolean;
  readonly embedded: boolean;
  readonly embeddedEditing: boolean;
  readonly actionTarget?: HTMLElement | null;
  readonly workarea: TemplateResult | null;
  readonly workareaFooter: TemplateResult | null;
  readonly pageViewport?: MermaidPageViewportProjection;
  readonly commentMarkers: readonly import("./annotation-projection.js").StateCommentMarker[];
  readonly markersInClientSpace?: boolean;
  readonly placementPending?: boolean;
  readonly placement?: { centerX: number; centerY: number } | null;
  readonly subscribeEditIntent?: (
    handler: (intent: MermaidGfxObjectEditIntent) => void,
  ) => () => void;
  readonly requestPlacement?: (
    onPlace: (placement: { centerX: number; centerY: number }) => void,
    onCancel?: () => void,
  ) => () => void;
  readonly resolveDescriptionAnchor: (
    key: string,
  ) => { left: number; top: number } | null;
  readonly getImpact: (selection: StateSelection) => StateImpact;
  readonly onCommand: <K extends StateCommandName>(
    name: K,
    args: StateCommandArgs<K>,
    basis: string,
    placement?: { centerX: number; centerY: number } | null,
  ) => StateCommandFeedback;
  readonly previewCommand?: <K extends StateCommandName>(
    name: K,
    args: StateCommandArgs<K>,
    basis: string,
  ) => { feedback: StateCommandFeedback; dispose: () => void };
  readonly onParentIntent: (intent: StateParentAction | null) => void;
  readonly onEditIntent: (intent: MermaidGfxObjectEditIntent | null) => void;
  readonly onCloseSelection: () => void;
  readonly onWorkareaResize: () => void;
  readonly onEmbeddedActionsInsetChange: (height: number) => void;
  readonly resolveReturnFocusTarget: () => HTMLElement | null;
};
export const mermaidStateRendererToken =
  defineMermaidFamilyReactRendererToken<StateReactHostProps>("state");
