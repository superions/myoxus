// SPDX-License-Identifier: AGPL-3.0-or-later

import type { TemplateResult } from "lit";
import type { MermaidPageViewportProjection } from "../../mermaid-page-viewport-state.js";

import type { MermaidArchitectureGfxControl } from "./control-contract.js";
import type { MermaidArchitectureConfig } from "../../engine/architecture/index.js";
import {
  defineMermaidFamilyReactRendererToken,
  type MermaidFamilyReactRendererToken,
} from "../runtime/react-host.js";
import type { MermaidVisualModel } from "../runtime/gfx-model.js";
import type { MermaidSelectionActionModel } from "../runtime/shell-contract.js";

export type MermaidArchitectureCommentAnchor = {
  readonly anchorId?: string;
  readonly anchorKind:
    | "alignment"
    | "diagram"
    | "edge"
    | "group"
    | "junction"
    | "metadata"
    | "service";
};

export type MermaidArchitectureCommentProjection =
  MermaidArchitectureCommentAnchor & {
    readonly anchor: string;
    readonly id: string;
    readonly text: string;
  };

export type MermaidArchitectureCommentMarkerProjection = {
  readonly anchor: MermaidArchitectureCommentAnchor;
  readonly comments: readonly MermaidArchitectureCommentProjection[];
  readonly key: string;
  readonly left: number;
  readonly top: number;
};

export type MermaidArchitectureEditorReactHostProps = {
  readonly surface: "editor";
  readonly pageViewport: MermaidPageViewportProjection;
  readonly embedded: boolean;
  readonly embeddedEditing: boolean;
  readonly onEmbeddedActionsInsetChange: (height: number) => void;
  readonly actionTarget?: HTMLElement | null;
  readonly accessibilityDescription?: string;
  readonly accessibilityTitle?: string;
  readonly alignDisabledReason: string;
  readonly canAlign: boolean;
  readonly canDeleteAlignment: boolean;
  readonly canAddGroup: boolean;
  readonly addGroupDisabledReason: string;
  readonly canConnect: boolean;
  readonly connectDisabledReason: string;
  readonly commentMarkers: readonly MermaidArchitectureCommentMarkerProjection[];
  readonly comments: readonly MermaidArchitectureCommentProjection[];
  readonly connecting: boolean;
  readonly diagramTitle?: string;
  readonly diagramConfig: MermaidArchitectureConfig;
  readonly displayOnly: boolean;
  readonly fields: ReadonlyArray<{
    readonly control: MermaidArchitectureGfxControl;
    readonly label: string;
    readonly options?: ReadonlyArray<{
      readonly label: string;
      readonly value: string;
    }>;
    readonly value: string;
  }>;
  readonly iconDiagnostic: string;
  readonly labels: {
    readonly add: string;
    readonly apply: string;
    readonly addGroup: string;
    readonly addJunction: string;
    readonly addService: string;
    readonly serviceToJunctionWarning: string;
    readonly junctionToServiceNotice: string;
    readonly alignColumn: string;
    readonly alignRow: string;
    readonly connect: string;
    readonly connecting: string;
    readonly connectingHint: string;
    readonly deleteComment: string;
    readonly deleteAlignment: string;
    readonly invalidProperties: string;
    readonly properties: string;
    readonly diagramSettings: string;
    readonly accessibility: string;
    readonly accessibilityTitle: string;
    readonly accessibilityDescription: string;
    readonly padding: string;
    readonly iconSize: string;
    readonly fontSize: string;
    readonly randomize: string;
    readonly nodeSeparation: string;
    readonly idealEdgeLengthMultiplier: string;
    readonly layout: string;
    readonly edgeElasticity: string;
    readonly exportMmd: string;
    readonly numIter: string;
    readonly seed: string;
    readonly toolbar: string;
  };
  readonly onAddComment: (
    value: string,
    anchor?: MermaidArchitectureCommentAnchor,
  ) => string | null;
  readonly onAddGroup: () => void;
  readonly onAddJunction: () => void;
  readonly onAddService: () => void;
  readonly onAlign: (direction: "column" | "row") => void;
  readonly onDeleteAlignment: () => void;
  readonly onCloseSelection: () => void;
  readonly onCommentChange: (commentId: string, value: string) => string | null;
  readonly onCommentDelete: (commentId: string) => string | null;
  readonly onConnect: () => void;
  readonly onLayoutApply: (visualModel: MermaidVisualModel) => string | null;
  readonly onLayoutPreview: () => MermaidVisualModel | null;
  readonly onDiagramSettingsApply: (values: {
    readonly accessibilityDescription: string;
    readonly accessibilityTitle: string;
    readonly config: MermaidArchitectureConfig;
  }) => string | null;
  readonly onExportMmd: () => void;
  readonly onPropertiesApply: (
    values: ReadonlyArray<{
      readonly control: MermaidArchitectureGfxControl;
      readonly value: string;
    }>,
  ) => string | null;
  readonly onWorkareaResize: () => void;
  readonly readonly: boolean;
  readonly resolveReturnFocusTarget: () => HTMLElement | null;
  readonly selectionKey: string;
  readonly selectionCount: number;
  readonly selectionAction: MermaidSelectionActionModel;
  readonly selectionAnchor: {
    readonly left: number;
    readonly top: number;
  } | null;
  readonly selectionCommentAnchor: MermaidArchitectureCommentAnchor;
  readonly workarea: TemplateResult | string | null;
  readonly workareaFooter?: TemplateResult | string | null;
};

export type MermaidArchitecturePropertiesProps = Pick<
  MermaidArchitectureEditorReactHostProps,
  | "fields"
  | "iconDiagnostic"
  | "labels"
  | "onPropertiesApply"
  | "readonly"
  | "selectionKey"
>;
export type MermaidArchitecturePropertiesReactHostProps =
  MermaidArchitecturePropertiesProps & {
    readonly surface: "properties";
  };

export type MermaidArchitectureCommentsProps = Pick<
  MermaidArchitectureEditorReactHostProps,
  | "comments"
  | "labels"
  | "onAddComment"
  | "onCommentChange"
  | "onCommentDelete"
  | "readonly"
  | "selectionKey"
>;
export type MermaidArchitectureCommentsReactHostProps =
  MermaidArchitectureCommentsProps & {
    readonly anchor: MermaidArchitectureCommentAnchor;
    readonly surface: "comments";
  };

export type MermaidArchitectureSettingsProps = Pick<
  MermaidArchitectureEditorReactHostProps,
  | "accessibilityDescription"
  | "accessibilityTitle"
  | "comments"
  | "diagramConfig"
  | "labels"
  | "onAddComment"
  | "onCommentChange"
  | "onCommentDelete"
  | "onDiagramSettingsApply"
  | "readonly"
  | "selectionKey"
>;
export type MermaidArchitectureSettingsReactHostProps =
  MermaidArchitectureSettingsProps & {
    readonly surface: "settings";
  };

export type MermaidArchitectureDeleteConfirmationReactHostProps = Pick<
  MermaidArchitectureEditorReactHostProps,
  "resolveReturnFocusTarget" | "selectionAction"
> & {
  readonly surface: "delete-confirmation";
};

export type MermaidArchitectureReactHostProps =
  | MermaidArchitectureCommentsReactHostProps
  | MermaidArchitectureDeleteConfirmationReactHostProps
  | MermaidArchitectureEditorReactHostProps
  | MermaidArchitecturePropertiesReactHostProps
  | MermaidArchitectureSettingsReactHostProps;
export const mermaidArchitectureRendererToken: MermaidFamilyReactRendererToken<MermaidArchitectureReactHostProps> =
  defineMermaidFamilyReactRendererToken("architecture");
