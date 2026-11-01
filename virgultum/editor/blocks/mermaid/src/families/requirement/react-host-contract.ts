// SPDX-License-Identifier: AGPL-3.0-or-later
import type { TemplateResult } from "lit";
import type { MermaidClipboardPort } from "../../clipboard.js";
import type {
  MermaidRequirementModel,
  RequirementFieldValues,
  RequirementObjectKind,
  RequirementRelationDraft,
  RequirementTypographyValues,
  RequirementRenameReferences,
  RequirementFieldWriteOptions,
  RequirementCommentCommand,
  RequirementAccessibilityValues,
} from "../../engine/requirement/index.js";
import type { MermaidGfxObjectEditIntent } from "../runtime/editor-capabilities.js";
import type { MermaidGfxConnectionProposal } from "../runtime/editor-capabilities.js";
import type {
  MermaidHistoryActions,
  MermaidSelectionActionModel,
} from "../runtime/shell-contract.js";
import type { MermaidPageViewportProjection } from "../../mermaid-page-viewport-state.js";
import { defineMermaidFamilyReactRendererToken } from "../runtime/react-host.js";

export type RequirementReactHostProps = {
  surface: "editor" | "controls";
  model: MermaidRequirementModel;
  sourceBasis: string;
  titleSelected?: boolean;
  onTitle: (
    title: string,
    basis: string,
  ) => { changed: boolean; diagnostic?: string };
  commentMarkers: readonly import("./annotation-projection.js").RequirementCommentMarker[];
  referenceMarkers: readonly import("./reference-projection.js").RequirementReferenceMarker[];
  markersInClientSpace?: boolean;
  onComment: (
    command: RequirementCommentCommand,
    basis: string,
  ) => { changed: boolean; diagnostic?: string };
  clipboard?: MermaidClipboardPort;
  ownerIdentity: object;
  onDuplicate: (
    keys: readonly string[],
    basis: string,
  ) => { changed: boolean; diagnostic?: string };
  onPaste: (
    source: string,
    basis: string,
    geometry?: readonly {
      x: number;
      y: number;
      width: number;
      height: number;
    }[],
  ) => { changed: boolean; diagnostic?: string };
  copyGeometry: readonly {
    x: number;
    y: number;
    width: number;
    height: number;
  }[];
  selectedKey?: string;
  typography?: { fontSize: number; fontWeight: string; fontStyle: string };
  selectedKeys: readonly string[];
  deleteRequested: boolean;
  selectionKey: string;
  intent: MermaidGfxObjectEditIntent | null;
  readonly: boolean;
  displayOnly: boolean;
  embedded: boolean;
  actionTarget?: HTMLElement | null;
  workarea: TemplateResult | null;
  workareaFooter: TemplateResult | null;
  pageViewport?: MermaidPageViewportProjection;
  history?: MermaidHistoryActions;
  selectionAction?: MermaidSelectionActionModel;
  selectedAnchor: { left: number; top: number } | null;
  portal?: boolean;
  connecting: boolean;
  connectionProposal: MermaidGfxConnectionProposal | null;
  onSaveRelation: (
    draft: RequirementRelationDraft,
    basis: string,
    proposal?: MermaidGfxConnectionProposal,
  ) => {
    changed: boolean;
    diagnostic?: string;
    sourceBasis?: string;
    selection?: string;
  };
  previewRelation: (
    draft: RequirementRelationDraft,
    basis: string,
    proposal?: MermaidGfxConnectionProposal,
  ) => (() => void) | null;
  canConnect: boolean;
  onAdd: (kind: RequirementObjectKind) => void;
  onCreate: (
    kind: RequirementObjectKind,
    name: string,
    basis: string,
    placement: { centerX: number; centerY: number },
  ) => {
    changed: boolean;
    diagnostic?: string;
    sourceBasis?: string;
    selection?: string;
  };
  onClose: (edgeId?: string) => void;
  onDiagramSettings: (
    direction: NonNullable<MermaidRequirementModel["direction"]>,
    layout: boolean,
    basis: string,
    accessibility?: RequirementAccessibilityValues,
  ) => { changed: boolean; diagnostic?: string };
  onOpen: () => void;
  onRequestDelete: () => void;
  onDelete: (
    keys: readonly string[],
    basis: string,
    references: "keep" | "remove",
    confirmed: boolean,
  ) => { changed: boolean; diagnostic?: string; sourceBasis?: string };
  subscribeEditIntent?: (
    listener: (intent: MermaidGfxObjectEditIntent) => void,
  ) => () => void;
  onSave: (
    key: string,
    values: RequirementFieldValues,
    basis: string,
    typography?: RequirementTypographyValues,
    references?: RequirementRenameReferences,
    removeProperties?: RequirementFieldWriteOptions["removeProperties"],
  ) => { changed: boolean; diagnostic?: string; sourceBasis?: string };
  onWorkareaResize: () => void;
  onEmbeddedActionsInsetChange?: (height: number) => void;
  resolveReturnFocusTarget: () => HTMLElement | null;
};
export type RequirementLabelActionsProps =
  import("@virgultum/gfx-shape").ShapeTextEditDraftActions & {
    surface: "label-actions";
  };
export const mermaidRequirementRendererToken =
  defineMermaidFamilyReactRendererToken<
    RequirementReactHostProps | RequirementLabelActionsProps
  >("requirement");
