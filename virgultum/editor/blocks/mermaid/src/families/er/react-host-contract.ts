// SPDX-License-Identifier: AGPL-3.0-or-later
import type { TemplateResult } from "lit";
import type { MermaidErModel, ErImpact } from "../../engine/er/index.js";
import type { MermaidGfxObjectEditIntent } from "../runtime/editor-capabilities.js";
import type { MermaidPageViewportProjection } from "../../mermaid-page-viewport-state.js";
import { defineMermaidFamilyReactRendererToken } from "../runtime/react-host.js";
import type {
  ErCommandArgs,
  ErCommandName,
  ErParentAction,
} from "./actions.js";
export type ErSelection = {
  kind: "entity" | "attribute" | "relation" | "subgraph" | "title";
  key: string;
  ownerKey?: string;
  deleteStrategy?: "ungroup" | "delete";
};
export type ErCommandFeedback = {
  diagnostic?: string;
  impact?: ErImpact;
  selection?: string;
  changed: boolean;
  sourceBasis?: string;
};
export type ErReactHostProps = {
  readonly surface: "editor" | "controls";
  readonly config: import("../../engine/er/config.js").ErConfig;
  readonly model: MermaidErModel;
  readonly sourceBasis: string;
  readonly selected: ErSelection | null;
  readonly selectedKeys: readonly string[];
  readonly selectedAnchor: { left: number; top: number } | null;
  readonly intent: MermaidGfxObjectEditIntent | null;
  readonly parentIntent: ErParentAction | null;
  readonly groupAllowed: boolean;
  readonly readonly: boolean;
  readonly displayOnly: boolean;
  readonly embedded: boolean;
  readonly embeddedEditing: boolean;
  readonly actionTarget?: HTMLElement | null;
  readonly workarea: TemplateResult | null;
  readonly workareaFooter: TemplateResult | null;
  readonly pageViewport?: MermaidPageViewportProjection;
  readonly commentMarkers: readonly import("./annotation-projection.js").ErCommentMarker[];
  readonly markersInClientSpace?: boolean;
  readonly placementPending?: boolean;
  readonly subscribeEditIntent?: (
    handler: (intent: MermaidGfxObjectEditIntent) => void,
  ) => () => void;
  readonly requestPlacement?: (
    onPlace: (placement: { centerX: number; centerY: number }) => void,
    onCancel?: () => void,
  ) => () => void;
  readonly resolveAttributeInsertAnchor: (
    key: string,
  ) => { left: number; top: number } | null;
  readonly getImpact: (selection: ErSelection) => ErImpact;
  readonly onCommand: <K extends ErCommandName>(
    name: K,
    args: ErCommandArgs<K>,
    basis: string,
    placement?: { centerX: number; centerY: number } | null,
  ) => ErCommandFeedback;
  readonly onParentIntent: (intent: ErParentAction | null) => void;
  readonly onEditIntent: (intent: MermaidGfxObjectEditIntent | null) => void;
  readonly onCloseSelection: () => void;
  readonly onWorkareaResize: () => void;
  readonly onEmbeddedActionsInsetChange: (height: number) => void;
  readonly resolveReturnFocusTarget: () => HTMLElement | null;
  readonly placement?: { centerX: number; centerY: number } | null;
};
export const mermaidErRendererToken =
  defineMermaidFamilyReactRendererToken<ErReactHostProps>("er");
