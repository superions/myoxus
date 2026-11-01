// SPDX-License-Identifier: AGPL-3.0-or-later
import type {
  LocalShapeElementModel,
  ShapeElementModel,
} from "@virgultum/model";
import type { ShapeTextEditDraft } from "@virgultum/gfx-shape";
import type { MermaidGfxPreview } from "./gfx-preview.js";

import type {
  MermaidVisualEdge,
  MermaidVisualModel,
  MermaidVisualNode,
  MermaidVisualNodeShape,
  MermaidVisualSemanticStyle,
  MermaidVisualSubgraph,
} from "./gfx-model.js";
import type { TemplateResult } from "lit";
import type { MermaidRuntimeTransactionOptions } from "./transaction.js";
import type {
  MermaidFamilyRenderSurface,
  MermaidPageSelectionItem,
  MermaidPageSelectionToolsContribution,
} from "./contracts.js";
import type { MermaidFamilyReactHost } from "./react-host.js";
import type {
  MermaidFamilyActionContribution,
  MermaidPageSelectionProjection,
  MermaidSelectionActionModel,
  MermaidShellNoticeReactHostProps,
  MermaidHistoryActions,
} from "./shell-contract.js";
import type { MermaidPageViewportProjection } from "../../mermaid-page-viewport-state.js";

export type MermaidHostProjectionContext = {
  readonly commitSource: (
    source: string,
    options?: MermaidRuntimeTransactionOptions,
  ) => void;
  readonly embedded?: boolean;
  readonly exportMmd?: () => void;
  readonly copySource?: () => Promise<void>;
  readonly getReactHost: () => MermaidFamilyReactHost | null;
  readonly getActionTarget: () => HTMLElement | null;
  readonly getHeaderActionTarget: () => HTMLElement | null;
  readonly getReadonly: () => boolean;
  readonly getSource: () => string;
  readonly getPageViewport: () => MermaidPageViewportProjection;
  readonly getSelectionAction: () => MermaidSelectionActionModel | null;
  readonly getSessionState: (key: string) => unknown;
  readonly getTransientState: (key: string) => unknown;
  readonly openSource: () => void;
  readonly setSelectionAction: (
    action: MermaidSelectionActionModel | null,
  ) => void;
  readonly setSessionState: (key: string, value: unknown) => void;
  readonly setTitlePresentationPreview: (
    presentation: NonNullable<
      MermaidEditorCapabilities["titlePresentation"]
    > | null,
  ) => void;
  readonly setTransientState: (key: string, value: unknown) => void;
  readonly renderGfx: (
    visualModel: MermaidVisualModel,
    options: {
      readonly displayOnly: boolean;
      readonly actionTarget?: HTMLElement | null;
      readonly embeddedFacadeSurface?: boolean;
      /** Local drawing/hit filter; retained Source children are never removed. */
      readonly hiddenObjectKeys?: readonly string[];
      /** Existing scoped pointer ownership delegates a selected-node gesture. */
      readonly onNodePointerDown?: (event: PointerEvent) => boolean;
      readonly onObjectEditIntent?: (
        intent: MermaidGfxObjectEditIntent,
      ) => boolean;
      /** A validated container gesture opens the family's checked Source form. */
      readonly onContainerActionIntent?: () => boolean;
      /** Reads the family-owned compartment selection; the viewport stores no copy. */
      readonly resolveDetailVisibilityTarget?: () => {
        ownerId: string;
        detailId: string;
      } | null;
      readonly projectActions?: (context: MermaidGfxActionContext) => unknown;
      readonly pageSelectionTools?: MermaidPageSelectionToolsContribution;
      readonly renderSurface: Exclude<
        MermaidFamilyRenderSurface,
        "source-first"
      >;
    },
  ) => MermaidEditorShellProjection;
  readonly renderSourceFirst: () => unknown;
};

export type MermaidEditorShellProjection = {
  readonly actions: MermaidFamilyActionContribution | null;
  readonly body: unknown;
  readonly notice?: MermaidShellNoticeReactHostProps;
};

export type MermaidGfxFamilyProjection = {
  readonly actions: MermaidFamilyActionContribution;
  readonly body: unknown;
};

export function isMermaidGfxFamilyProjection(
  value: unknown,
): value is MermaidGfxFamilyProjection {
  if (!value || typeof value !== "object") return false;
  const projection = value as Partial<MermaidGfxFamilyProjection>;
  return Boolean(
    projection.actions &&
    Array.isArray(projection.actions.actions) &&
    typeof projection.actions.portal === "boolean" &&
    "body" in projection,
  );
}

export function structuredEditorProjection(
  body: unknown,
  label: string,
  disabled: boolean,
  selectionAction: MermaidSelectionActionModel | null,
) {
  return {
    actions: {
      actions: [
        {
          disabled,
          id: "structured-family-actions",
          label,
        },
      ],
      portal: true,
      selectionAction,
    },
    body,
  } satisfies MermaidEditorShellProjection;
}

export type MermaidGfxObjectEditIntent = {
  readonly action?:
    | "select"
    | "edit"
    | "delete"
    | "duplicate"
    | "create-child"
    | "create-sibling"
    | "toggle-collapse";
  /** A completed gesture may open a family draft without committing an edge. */
  readonly connection?: MermaidGfxConnectionProposal;
  readonly kind: "node" | "detail" | "edge" | "subgraph";
  readonly id: string;
  readonly ownerId?: string;
  readonly anchor?: { readonly left: number; readonly top: number };
};
export type MermaidGfxConnectionProposal = {
  /** Reconnect shares the local connection draft, without creating a new edge. */
  readonly edgeId?: string;
  readonly endpoint?: "source" | "target";
  readonly sourceNodeId: string;
  readonly targetNodeId: string;
  readonly sourcePortId?: string;
  readonly sourcePosition?: MermaidVisualEdge["sourcePosition"];
  readonly targetPortId?: string;
  readonly targetPosition?: MermaidVisualEdge["targetPosition"];
};
export type MermaidGfxActionContext = {
  readonly history?: MermaidHistoryActions;
  readonly fitViewport?: () => void;
  readonly clipboard?: import("../../clipboard.js").MermaidClipboardPort;
  readonly duplicateOwner?: () => void;
  readonly importFileSizeLimit?: number;
  /** Inserts through the existing Page/native lifecycle in one history entry. */
  readonly insertDiagram?: (
    source: string,
    visualModel: MermaidVisualModel,
    position?: { x: number; y: number },
  ) => boolean;
  readonly beginNodePlacement: (
    onPlace: (placement: { centerX: number; centerY: number }) => void,
  ) => void;
  readonly actionTarget: HTMLElement | null;
  readonly embedded: boolean;
  readonly embeddedEditing: boolean;
  readonly applyEdgePatch: (
    patch: Partial<MermaidVisualEdge>,
    options?: MermaidRuntimeTransactionOptions,
  ) => void;
  readonly applyNodePatch: (
    patch: Partial<MermaidVisualNode>,
    options?: MermaidRuntimeTransactionOptions,
  ) => void;
  readonly applySubgraphPatch: (
    patch: Partial<MermaidVisualSubgraph>,
    options?: MermaidRuntimeTransactionOptions,
  ) => void;
  readonly applyVisualModel: (
    visualModel: MermaidVisualModel,
    options?: MermaidRuntimeTransactionOptions,
  ) => { readonly applied: boolean; readonly diagnostic?: string };
  /** Transient native GFX presentation; disposing restores the owning Source projection. */
  readonly previewVisualModel?: (
    visualModel: MermaidVisualModel,
    options?: {
      readonly scopeToViewport?: boolean;
      /** Readonly exploration may exceed committed owner bounds locally. */
      readonly includeInNavigation?: boolean;
    },
  ) => MermaidGfxPreview;
  readonly getVisualModel?: () => MermaidVisualModel;
  readonly subscribeDraftInvalidation?: (invalidate: () => void) => () => void;
  readonly mountShapeDraft?: (
    shape: ShapeElementModel | LocalShapeElementModel,
    draft: ShapeTextEditDraft,
  ) => (() => void) | null;
  readonly addContainer: () => void;
  readonly addNode: (shape?: MermaidVisualNodeShape) => void;
  readonly applyLayout: () => void;
  readonly connect: () => void;
  readonly connecting: boolean;
  readonly closeInspector: () => void;
  readonly displayOnly: boolean;
  readonly editNodeLabel: () => void;
  readonly exportMmd: () => void;
  readonly inspector: MermaidGfxInspector;
  readonly inspectorSuppressed: boolean;
  readonly onEmbeddedActionsInsetChange: (height: number) => void;
  readonly pendingShape: MermaidVisualNodeShape | null;
  readonly pageSelection: MermaidPageSelectionProjection | null;
  readonly pageViewport: MermaidPageViewportProjection;
  readonly reactHost: MermaidFamilyReactHost | null;
  readonly readonly: boolean;
  readonly selectedNodeIds: readonly string[];
  readonly selectedItems: ReadonlyArray<MermaidPageSelectionItem>;
  readonly selectedAlignmentGuideId: string;
  readonly selectedNodeAnchor: {
    readonly left: number;
    readonly top: number;
  } | null;
  readonly selectedEdgeAnchor: {
    readonly left: number;
    readonly top: number;
  } | null;
  readonly selectedSubgraphAnchor: {
    readonly left: number;
    readonly top: number;
  } | null;
  readonly refreshWorkarea: () => void;
  readonly resolveReturnFocusTarget: () => HTMLElement | null;
  /** The actual active viewport owns gesture identity and client-to-model conversion. */
  readonly viewportIdentity?: object;
  readonly resolveViewportPoint?: (point: {
    left: number;
    top: number;
  }) => { x: number; y: number } | null;
  /** Desktop client coordinates for family gesture previews and portalled handles. */
  readonly resolveVisualBounds?: (
    kind: "diagram" | "node" | "edge" | "subgraph",
    id: string,
    client?: boolean,
  ) => { left: number; top: number; width: number; height: number } | null;
  readonly resolveVisualAnchor: (
    kind:
      | "alignment"
      | "diagram"
      | "detail"
      | "edge"
      | "node"
      | "subgraph"
      | "title",
    id?: string,
    /** Clamp only a floating control, preserving raw renderer/marker anchors. */
    visible?: boolean,
  ) => { readonly left: number; readonly top: number } | null;
  readonly selectionAction: MermaidSelectionActionModel;
  readonly selectContainer: (id: string) => void;
  readonly selectEdge: (id: string) => void;
  readonly selectNode: (id: string) => void;
  readonly selectAfterProjection: (
    item: Pick<MermaidPageSelectionItem, "editKey" | "kind">,
    options?: { readonly focus?: boolean },
  ) => void;
  /** Reuse the projection-ready selection queue for an atomic copied group. */
  readonly selectManyAfterProjection?: (
    items: readonly Pick<MermaidPageSelectionItem, "editKey" | "kind">[],
  ) => void;
  readonly setContainerTitle: (value: string) => void;
  readonly setEdgeLabel: (value: string) => void;
  readonly setNodeLabel: (value: string) => void;
  readonly setNodeShape: (value: unknown) => void;
  readonly setNodeStyle: (value: string | null) => void;
  readonly editSubgraphTitle: () => void;
  readonly setSubgraphDirection: (
    value: MermaidVisualModel["direction"],
  ) => void;
  readonly setEdgeLinkType: (value: unknown) => void;
  readonly setEdgeStyle: (value: unknown) => void;
  readonly setEdgeVisualStyle: (value: string | null) => void;
  readonly visualModel: MermaidVisualModel;
  readonly workarea: TemplateResult | null;
  readonly workareaFooter: TemplateResult | null;
};

export type MermaidGfxInspector = {
  readonly selectedEdge: MermaidVisualEdge | undefined;
  readonly selectedEdgeStyleStatement: MermaidVisualSemanticStyle | "";
  readonly selectedNode: MermaidVisualNode | undefined;
  readonly selectedNodeStyleClass: string;
  readonly selectedSubgraph: MermaidVisualSubgraph | undefined;
  readonly shapePalette: {
    readonly all: readonly MermaidVisualNodeShape[];
  };
};

export type MermaidEditorCapabilities = {
  /** Families may choose the native renderer for display and last-valid preview. */
  readonly displayMode?: "native-preview";
  /** Source may show native output even when View reuses the structured body. */
  readonly sourcePreview?: "native-preview";
  /** Permit local, write-free Visual/Source exploration in a readonly Page host. */
  readonly readonlyExploration?: boolean;
  readonly kind: "gfx" | "structured";
  /** Source-owned renderer typography for the one global diagram title. */
  readonly titlePresentation?: {
    readonly fontSize?: number;
    readonly padding?: number;
    readonly visible: boolean;
  };
  readonly pageSelectionTools?: MermaidPageSelectionToolsContribution;
  readonly project: (
    context: MermaidHostProjectionContext,
    displayOnly: boolean,
  ) => MermaidEditorShellProjection;
  readonly renderSurface: MermaidFamilyRenderSurface;
};

export function gfxEditorCapabilities(
  visualModel: MermaidVisualModel,
  renderSurface: Exclude<MermaidFamilyRenderSurface, "source-first">,
  {
    embeddedFacadeSurface = false,
    pageSelectionTools,
    projectActions,
  }: {
    readonly embeddedFacadeSurface?: boolean;
    readonly pageSelectionTools?: MermaidPageSelectionToolsContribution;
    readonly projectActions: (
      context: MermaidGfxActionContext,
    ) => MermaidGfxFamilyProjection | unknown;
  },
): MermaidEditorCapabilities {
  return {
    kind: "gfx",
    pageSelectionTools,
    project: (context, displayOnly) =>
      context.renderGfx(visualModel, {
        displayOnly,
        embeddedFacadeSurface,
        pageSelectionTools,
        renderSurface,
        projectActions,
      }),
    renderSurface,
  };
}
