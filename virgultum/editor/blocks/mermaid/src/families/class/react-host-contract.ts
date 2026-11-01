// SPDX-License-Identifier: AGPL-3.0-or-later
import type { TemplateResult } from "lit";
import type {
  MermaidClassModel,
  ClassImpact,
} from "../../engine/class/index.js";
import type { MermaidGfxObjectEditIntent } from "../runtime/editor-capabilities.js";
import type { MermaidPageViewportProjection } from "../../mermaid-page-viewport-state.js";
import { defineMermaidFamilyReactRendererToken } from "../runtime/react-host.js";
import type {
  ClassCommandArgs,
  ClassCommandName,
  ClassParentAction,
} from "./actions.js";
export type ClassSelection = {
  kind: "class" | "member" | "relation" | "note" | "namespace" | "title";
  key: string;
  ownerKey?: string;
  deleteStrategy?: "ungroup" | "delete";
};
export type ClassCommandFeedback = {
  diagnostic?: string;
  impact?: ClassImpact;
  selection?: string;
  changed: boolean;
  sourceBasis?: string;
};
export type ClassReactHostProps = {
  readonly surface: "editor" | "controls";
  readonly config: import("../../engine/class/config.js").ClassConfig;
  readonly model: MermaidClassModel;
  readonly sourceBasis: string;
  readonly selected: ClassSelection | null;
  readonly selectedKeys: readonly string[];
  readonly selectedAnchor: { left: number; top: number } | null;
  readonly intent: MermaidGfxObjectEditIntent | null;
  readonly parentIntent: ClassParentAction | null;
  readonly groupAllowed: boolean;
  readonly readonly: boolean;
  readonly displayOnly: boolean;
  readonly embedded: boolean;
  readonly embeddedEditing: boolean;
  readonly actionTarget?: HTMLElement | null;
  readonly workarea: TemplateResult | null;
  readonly workareaFooter: TemplateResult | null;
  readonly pageViewport?: MermaidPageViewportProjection;
  readonly commentMarkers: readonly import("./annotation-projection.js").ClassCommentMarker[];
  readonly markersInClientSpace?: boolean;
  readonly placementPending?: boolean;
  readonly subscribeEditIntent?: (
    handler: (intent: MermaidGfxObjectEditIntent) => void,
  ) => () => void;
  readonly requestPlacement?: (
    onPlace: (placement: { centerX: number; centerY: number }) => void,
    onCancel?: () => void,
  ) => () => void;
  readonly resolveMemberInsertAnchor: (
    key: string,
  ) => { left: number; top: number } | null;
  readonly onOpenLink: (classKey: string) => void;
  readonly getImpact: (selection: ClassSelection) => ClassImpact;
  readonly onCommand: <K extends ClassCommandName>(
    name: K,
    args: ClassCommandArgs<K>,
    basis: string,
    placement?: { centerX: number; centerY: number } | null,
  ) => ClassCommandFeedback;
  readonly onParentIntent: (intent: ClassParentAction | null) => void;
  readonly onEditIntent: (intent: MermaidGfxObjectEditIntent | null) => void;
  readonly onCloseSelection: () => void;
  readonly onWorkareaResize: () => void;
  readonly onEmbeddedActionsInsetChange: (height: number) => void;
  readonly resolveReturnFocusTarget: () => HTMLElement | null;
  readonly placement?: { centerX: number; centerY: number } | null;
};
export const mermaidClassRendererToken =
  defineMermaidFamilyReactRendererToken<ClassReactHostProps>("class");
