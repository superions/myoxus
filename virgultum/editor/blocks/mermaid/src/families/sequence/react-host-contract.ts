// SPDX-License-Identifier: AGPL-3.0-or-later
import type { TemplateResult } from "lit";
import type {
  MermaidSequenceModel,
  SequenceConfig,
  SequenceImpact,
  SequenceTimelineAnchor,
} from "../../engine/sequence/index.js";
import type { MermaidGfxObjectEditIntent } from "../runtime/editor-capabilities.js";
import type { MermaidPageViewportProjection } from "../../mermaid-page-viewport-state.js";
import { defineMermaidFamilyReactRendererToken } from "../runtime/react-host.js";
import type {
  SequenceCommandName,
  SequenceCommandArgs,
  SequenceParentAction,
} from "./actions.js";
import type { SequenceCommentMarker } from "./annotation-projection.js";
export type SequenceSelection = {
  kind:
    | "participant"
    | "message"
    | "activation"
    | "fragment"
    | "branch"
    | "box"
    | "rect"
    | "note"
    | "title";
  key: string;
  visualKey?: string;
};
export type SequenceCommandFeedback = {
  changed: boolean;
  diagnostic?: string;
  impact?: SequenceImpact;
  selection?: string;
  sourceBasis?: string;
};
export type SequenceReactHostProps = {
  readonly surface: "editor" | "controls";
  readonly model: MermaidSequenceModel;
  readonly config: SequenceConfig;
  readonly sourceBasis: string;
  readonly selected: SequenceSelection | null;
  readonly selectedKeys: readonly string[];
  readonly selectedAnchor: { left: number; top: number } | null;
  readonly selectedBounds?: {
    left: number;
    top: number;
    width: number;
    height: number;
  } | null;
  readonly resolveParticipantAnchor: (
    key: string,
  ) => { left: number; top: number } | null;
  readonly resolveParticipantDropBefore: (
    point: { left: number; top: number },
    key: string,
  ) => string | null;
  readonly resolveTimelineDropAnchor: (
    point: { left: number; top: number },
    key: string,
  ) => SequenceTimelineAnchor | null;
  readonly intent: MermaidGfxObjectEditIntent | null;
  readonly parentIntent: SequenceParentAction | null;
  readonly readonly: boolean;
  readonly displayOnly: boolean;
  readonly embedded: boolean;
  readonly embeddedEditing: boolean;
  readonly actionTarget?: HTMLElement | null;
  readonly workarea: TemplateResult | null;
  readonly workareaFooter: TemplateResult | null;
  readonly pageViewport?: MermaidPageViewportProjection;
  readonly commentMarkers: readonly SequenceCommentMarker[];
  readonly markersInClientSpace?: boolean;
  readonly subscribeEditIntent?: (
    handler: (intent: MermaidGfxObjectEditIntent) => void,
  ) => () => void;
  readonly getImpact: (
    selection: SequenceSelection,
    keepContents?: boolean,
  ) => SequenceImpact;
  readonly getDeleteImpact: (keys: readonly string[]) => SequenceImpact;
  readonly onCommand: <K extends SequenceCommandName>(
    name: K,
    args: SequenceCommandArgs<K>,
    basis: string,
  ) => SequenceCommandFeedback;
  readonly onPreview: <K extends SequenceCommandName>(
    name: K,
    args: SequenceCommandArgs<K>,
    basis: string,
  ) => SequenceCommandFeedback;
  readonly onCancelPreview: () => void;
  readonly resolveTimelineAnchor: (
    anchor: SequenceTimelineAnchor,
  ) => { left: number; top: number } | null;
  readonly onParentIntent: (intent: SequenceParentAction | null) => void;
  readonly onEditIntent: (intent: MermaidGfxObjectEditIntent | null) => void;
  readonly onCloseSelection: () => void;
  readonly onWorkareaResize: () => void;
  readonly onEmbeddedActionsInsetChange: (height: number) => void;
  readonly resolveReturnFocusTarget: () => HTMLElement | null;
};
export const mermaidSequenceRendererToken =
  defineMermaidFamilyReactRendererToken<SequenceReactHostProps>("sequence");
