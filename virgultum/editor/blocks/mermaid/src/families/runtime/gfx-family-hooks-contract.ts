// SPDX-License-Identifier: AGPL-3.0-or-later

import type {
  ConnectorMode,
  PointStyle,
  ShapeType,
  ShapeElementModel,
  ShapeLabelProjection,
  StrokeStyle,
} from "@virgultum/model";

import type {
  MermaidVisualModel,
  MermaidVisualEdge,
  MermaidVisualNode,
  MermaidVisualNodeDetail,
  MermaidVisualNodeShape,
  MermaidVisualEndpointPosition,
  MermaidVisualSemanticStyle,
  MermaidVisualSubgraph,
} from "./gfx-model.js";

export type MermaidGfxNodeConnectionPort = Readonly<{
  id: string;
  position: MermaidVisualEndpointPosition;
}>;

export type MermaidGfxAlignmentGuide = Readonly<{
  direction: "column" | "row";
  id: string;
  members: readonly string[];
}>;

export type MermaidTypeOwnedInlineValue =
  | { readonly handled: false }
  | { readonly handled: true; readonly value: string };

export type MermaidTypeOwnedInlineMutation =
  | { readonly handled: false }
  | {
      readonly handled: true;
      readonly visualModel: MermaidVisualModel | null;
    };

export type MermaidGfxElementStyleProjection = Readonly<{
  /** Retained semantic children can suppress drawing/hits without being removed. */
  hidden?: boolean;
  /** Source-owned label rotation in degrees, consumed by the native GFX shape. */
  rotate?: number;
  color?: string;
  denseLabel?: boolean;
  fillColor?: string;
  filled?: boolean;
  innerCircleFilled?: boolean;
  fontFamily?: string;
  fontSize?: number;
  fontStyle?: string;
  fontWeight?: string;
  padding?: readonly [number, number];
  mermaidEdgeVisualStyle?: MermaidVisualSemanticStyle | "";
  mermaidNodeStyleClass?: MermaidVisualSemanticStyle | "";
  stroke?: string;
  strokeColor?: string;
  strokeStyle?: StrokeStyle;
  strokeWidth?: number;
  /** Native shape shadows keep the renderer's hard/soft-shadow policy. */
  shadow?: ShapeElementModel["shadow"];
  labelProjection?: ShapeLabelProjection | null;
  selectable?: boolean;
  textDisplay?: boolean;
  textDecoration?: "none" | "underline";
}>;

export type MermaidGfxDetailElementProjection =
  MermaidGfxElementStyleProjection &
    Readonly<{
      offsetY: number;
      relativeBound?: Readonly<{
        height: number;
        width: number;
        x: number;
        y: number;
      }>;
      text: string;
      textAlign?: "center" | "left" | "right";
      textVerticalAlign?: "bottom" | "center" | "top";
    }>;

export type MermaidGfxNodeElementProjection = MermaidGfxElementStyleProjection &
  Readonly<{
    /** Renderer-prewrapped content; semantic labels retain their Source metadata. */
    text?: string;
    radius: number;
    /** Measured header geometry shared by native and Page hit-testing. */
    subgraphHeaderHeight?: number;
    mermaidSubgraphCollapsible?: boolean;
    mermaidSubgraphCollapsed?: boolean;
    mermaidSubgraphCollapseControlSize?: number;
    shapeType: ShapeType;
    /** Normalized technical points; the neutral renderer does not parse Source. */
    mermaidContour?: readonly (readonly [number, number])[];
  }>;

export type MermaidGfxConnectorElementProjection =
  MermaidGfxElementStyleProjection &
    Readonly<{
      endpointScale?: number;
      frontEndpointCircle?: boolean;
      rearEndpointCircle?: boolean;
      labelOffsetDistance?: number;
      labelLineHeight?: number;
      labelTextAlign?: "left" | "center" | "right";
      /** Objects whose painted bounds must not cover a path-bound label. */
      labelObstacleKeys?: readonly string[];
      /** Semantic obstacle keys are resolved to surface IDs by materialization. */
      routingObstacleKeys?: readonly string[];
      /** Protected renderer regions relative to the named surface element. */
      routingObstacleRegions?: Readonly<
        Record<string, readonly [number, number, number, number]>
      >;
      routingClearance?: number;
      routingCornerRadius?: number;
      routingLaneOffset?: number;
      frontEndpointStyle: PointStyle;
      mode: ConnectorMode;
      rearEndpointStyle: PointStyle;
      strokeStyle: StrokeStyle;
      strokeWidth: number;
    }>;

export type MermaidGfxProjectionOwnerSemanticStyles = Readonly<{
  edges: ReadonlyArray<{
    edgeIndex: number;
    styleName: MermaidVisualSemanticStyle;
  }>;
  nodes: ReadonlyArray<{
    nodeId: string;
    styleName: MermaidVisualSemanticStyle;
  }>;
}>;

export type MermaidGfxLegacyReader = (key: string) => unknown;

export type MermaidGfxSelectionDescriptor = {
  readonly edgeId?: string;
  readonly edgeIds?: readonly string[];
  readonly nodeId?: string;
  readonly nodeIds?: readonly string[];
  readonly subgraphId?: string;
  readonly subgraphIds?: readonly string[];
};

export type MermaidGfxDuplicateSelectionResult = {
  readonly nodeIds: readonly string[];
  readonly visualModel: MermaidVisualModel;
};

export type MermaidGfxProjectionOwnerReadbackPolicy = Readonly<{
  /** Source-owned hierarchy must not be inferred from spatial containment. */
  preserveSourceMembership?: boolean;
  preserveMultilineNodeLabels?: boolean;
  preservePreviousSubgraphMembership?: boolean;
  strictSemanticIdentities?: boolean;
}>;

export type MermaidGfxFamilyHooks = {
  /** Opt-in semantic bookmarks use the existing session port, not document data. */
  readonly sessionSelectionKinds?: readonly ("edge" | "node" | "subgraph")[];
  /** Apply family defaults only to a new projection without an explicit candidate. */
  readonly prepareInsertProjection?: (
    source: string,
    visual: MermaidVisualModel,
    provider: import("@virgultum/global/di").ServiceProvider,
  ) => MermaidVisualModel;

  readonly semanticClipboard?: boolean;
  readonly remapCopiedIdentities?: (
    source: string,
    familyData: string,
  ) => {
    identityMap: ReadonlyMap<string, string>;
    familyData: string;
    remapElement: (
      props: Readonly<Record<string, unknown>>,
    ) => Record<string, unknown>;
  } | null;
  /** Source dividers share the native shape primitive but paint below content. */
  readonly nodePaintLayer?: (
    model: MermaidVisualModel,
    node: MermaidVisualNode,
  ) => "background" | "content";
  /** Atomic Source/geometry writes replay through the existing document history. */
  readonly usesDocumentHistory?: boolean;
  /** Native details and double-clicks use the family controls instead of the shape text editor. */
  readonly objectEditsViaFamilyControls?: boolean;
  /** Completed connection gestures open a local family confirmation draft. */
  readonly connectionsViaFamilyControls?: boolean;
  /** Family navigation and edit intents precede generic shape key handling. */
  readonly nodeKeyboardIntent?: (
    model: MermaidVisualModel,
    nodeId: string,
    key: string,
  ) => import("./editor-capabilities.js").MermaidGfxObjectEditIntent | null;
  /** Broad timeline headers edit at their label edge; ordinary objects retain
   * the existing right-side anchor. Visibility and floating controls agree. */
  readonly objectEditAnchorSide?: (
    model: MermaidVisualModel,
    kind: "node" | "subgraph",
    id: string,
  ) => "start" | "end";
  /** Include the generated native connector path and label bounds in the owner. */
  readonly includeRenderedConnectorBounds?: boolean;
  readonly alignmentGuides?: (
    model: MermaidVisualModel,
  ) => readonly MermaidGfxAlignmentGuide[];
  readonly allowsSelfConnections?:
    boolean | ((model: MermaidVisualModel) => boolean);
  readonly applyCreatedSubgraphMembership?: (
    model: MermaidVisualModel,
    subgraphId: string,
    selectedNodeIds: readonly string[],
  ) => MermaidVisualModel;
  readonly canConnectNodes?: (
    model: MermaidVisualModel,
    sourceId: string,
    targetId: string,
  ) => boolean;
  readonly canonicalizeAfterSourceWrite?: (
    reparsed: MermaidVisualModel,
    requested: MermaidVisualModel,
    source: string,
  ) => MermaidVisualModel;
  readonly descendantSubgraphIds?: (
    model: MermaidVisualModel,
    subgraphId: string,
  ) => ReadonlySet<string> | null;
  readonly createEdge?: (
    model: MermaidVisualModel,
    sourceId: string,
    targetId: string,
  ) => MermaidVisualEdge | null;
  readonly createNode?: (
    model: MermaidVisualModel,
    requestedShape?: MermaidVisualNodeShape,
    placement?: { readonly centerX: number; readonly centerY: number },
  ) => MermaidVisualNode | null;
  readonly createSubgraph?: (
    model: MermaidVisualModel,
    selectedNodeIds: readonly string[],
  ) => MermaidVisualSubgraph | null;
  readonly deleteSelection?: (
    model: MermaidVisualModel,
    selection: MermaidGfxSelectionDescriptor,
  ) => MermaidVisualModel | null;
  readonly duplicateSelection?: (
    model: MermaidVisualModel,
    nodeIds: readonly string[],
    offset: Readonly<{ x: number; y: number }>,
  ) => MermaidGfxDuplicateSelectionResult | null;
  readonly deleteSubgraph?: (
    model: MermaidVisualModel,
    subgraphId: string,
  ) => MermaidVisualModel | null;
  readonly finalizeProjectionOwnerGeometry?: (
    model: MermaidVisualModel,
  ) => MermaidVisualModel;
  readonly finalizeAdoptedNodeElementProps?: (
    model: MermaidVisualModel,
    existingElement: unknown,
    projectedProps: Readonly<Record<string, unknown>>,
  ) => Record<string, unknown>;
  readonly hasValidGeometry?: (model: MermaidVisualModel) => boolean;
  readonly graphEditor?: boolean;
  readonly geometrySelection?: (
    model: MermaidVisualModel,
    ids: readonly string[],
  ) => readonly string[];
  readonly reconcileGeometryGesture?: (
    before: MermaidVisualModel,
    after: MermaidVisualModel,
  ) => MermaidVisualModel;
  readonly keepsFamilyDisplaySurface?: boolean;
  readonly projectionOwnerAppearanceMatchesTheme?: (
    model: MermaidVisualModel,
    elements: readonly unknown[],
    connectors: readonly unknown[],
  ) => boolean;
  readonly projectionOwnerReadbackPolicy?:
    | MermaidGfxProjectionOwnerReadbackPolicy
    | ((
        diagramType: string,
      ) => MermaidGfxProjectionOwnerReadbackPolicy | undefined);
  readonly legacyProjectionFingerprint?: (
    read: MermaidGfxLegacyReader,
  ) => string;
  readonly readLegacyNodeFamilyData?: (
    diagramType: MermaidVisualModel["diagramType"],
    read: MermaidGfxLegacyReader,
  ) => MermaidVisualModel["familyData"];
  readonly readLegacyEdgeFamilyData?: (
    diagramType: MermaidVisualModel["diagramType"],
    read: MermaidGfxLegacyReader,
  ) => MermaidVisualModel["familyData"];
  readonly readLegacySubgraphFamilyData?: (
    diagramType: MermaidVisualModel["diagramType"],
    read: MermaidGfxLegacyReader,
  ) => MermaidVisualModel["familyData"];
  readonly readLegacyModelFamilyData?: (
    model: MermaidVisualModel,
  ) => MermaidVisualModel["familyData"];
  readonly finalizeProjectionOwnerReadback?: (
    model: MermaidVisualModel,
    previousModel: MermaidVisualModel | null | undefined,
    semanticStyles: MermaidGfxProjectionOwnerSemanticStyles,
  ) => MermaidVisualModel;
  readonly minimumReadableZoom?: (
    model: MermaidVisualModel,
    sharedMinimum: number,
  ) => number;
  readonly nodeDimensionsAreValid?: (
    height: number | undefined,
    width: number | undefined,
  ) => boolean;
  readonly nodeMutationIsValid?: (
    mutation: Readonly<Record<string, unknown>>,
  ) => boolean;
  readonly nodeInlineRename?: (
    model: MermaidVisualModel,
    nodeId: string,
    value: string,
    source?: string,
  ) => MermaidVisualModel | null;
  readonly nodeInlineValue?: (
    model: MermaidVisualModel,
    nodeId: string,
  ) => string;
  readonly nodeConnectionPorts?: (
    model: MermaidVisualModel,
    node: MermaidVisualNode,
  ) => readonly MermaidGfxNodeConnectionPort[];
  /** Detail selection uses the owning family's controls instead of generic shape text editing. */
  readonly detailSelectionViaFamilyControls?: boolean;
  /** Derived content compartments follow live body geometry without a Source record. */
  readonly nodeDetailGeometryFollowsBody?: boolean;
  /** Additional Source-authored space above the native diagram title. */
  readonly diagramTitleTopMargin?: (model: MermaidVisualModel) => number;
  readonly nodeElementProjection: (
    model: MermaidVisualModel,
    node: MermaidVisualNode,
  ) => MermaidGfxNodeElementProjection;
  readonly nodeDetailElementProjection?: (
    model: MermaidVisualModel,
    node: MermaidVisualNode,
    detail: MermaidVisualNodeDetail,
  ) => MermaidGfxDetailElementProjection;
  readonly nodeSemanticStyleProps?: (
    styleName: MermaidVisualSemanticStyle | "",
  ) => Readonly<Record<string, unknown>>;
  readonly readNodeSemanticStyle?: (
    model: MermaidVisualModel,
    node: MermaidVisualNode,
  ) => MermaidVisualSemanticStyle | "";
  readonly normalizeNodeDimensions?: (
    node: MermaidVisualNode,
    model: MermaidVisualModel,
  ) => MermaidVisualNode;
  readonly edgeInlineRename?: (
    model: MermaidVisualModel,
    edgeId: string,
    value: string,
    source?: string,
  ) => MermaidVisualModel | null;
  readonly edgeHitTestIncludesSubgraphs?: boolean;
  /** Source-owned composites may be connection endpoints. Only their headers
   * participate in connection hit-testing; child selection remains unchanged. */
  readonly connectionTargetsIncludeSubgraphs?: boolean;
  readonly edgeElementProjection: (
    model: MermaidVisualModel,
    edge: MermaidVisualEdge,
    edgeIndex: number,
  ) => MermaidGfxConnectorElementProjection;
  readonly edgeSemanticStyleProps?: (
    styleName: MermaidVisualSemanticStyle | "",
  ) => Readonly<Record<string, unknown>>;
  readonly readEdgeSemanticStyle?: (
    model: MermaidVisualModel,
    edge: MermaidVisualEdge,
  ) => MermaidVisualSemanticStyle | "";
  readonly edgeLabelOffset?: (
    model: MermaidVisualModel,
    edge: MermaidVisualEdge,
  ) => { readonly x: number; readonly y: number } | null;
  readonly edgeReconnectable?: (
    model: MermaidVisualModel,
    edge: MermaidVisualEdge,
  ) => boolean;
  readonly patchEdge?: (
    model: MermaidVisualModel,
    edge: MermaidVisualEdge,
    patch: Readonly<{
      familyData?: MermaidVisualEdge["familyData"];
      label?: string;
    }>,
  ) => MermaidVisualEdge;
  readonly preserveManagedNodeDimensions?: (
    model: MermaidVisualModel,
    source: MermaidVisualNode,
    existing: MermaidVisualNode,
  ) => { readonly height: number; readonly width: number } | null;
  /** Inner coordinates and sizes are derived from Source; owner placement and
   * the host camera remain persisted geometry. */
  readonly sourceDerivedGeometry?: boolean;
  readonly preserveManagedSubgraphDimensions?: (
    model: MermaidVisualModel,
    source: MermaidVisualSubgraph,
    existing: MermaidVisualSubgraph,
  ) => { readonly height: number; readonly width: number } | null;
  readonly preserveProjectionOwnerForInvalidSource?: () => boolean;
  readonly projectMaterializedNode?: (
    node: MermaidVisualNode,
    diagramType: MermaidVisualModel["diagramType"],
  ) => MermaidVisualNode;
  readonly reconcileProjectionOwnerGeometry?: (
    model: MermaidVisualModel,
    sourceModel: MermaidVisualModel,
  ) => MermaidVisualModel;
  readonly readSourceProjection?: (
    source: string,
    stored: MermaidVisualModel,
  ) => MermaidVisualModel | null;
  readonly readProjectionOwnerModel?: (
    model: MermaidVisualModel,
  ) => MermaidVisualModel;
  /** Receives the actual diagram when one temporary owner serves multiple families. */
  readonly projectionOnlyNodeMutation?: (
    mutation: Readonly<Record<string, unknown>>,
    model: MermaidVisualModel,
  ) => boolean;
  readonly projectionOnlySubgraphMutation?: (
    mutation: Readonly<Record<string, unknown>>,
    model: MermaidVisualModel,
  ) => boolean;
  readonly reconcileNodeDragEnd?: (model: MermaidVisualModel) => boolean;
  readonly reconnectEdge?: (
    model: MermaidVisualModel,
    edge: MermaidVisualEdge,
    endpoint: "source" | "target",
    nodeId: string,
  ) => MermaidVisualEdge | null;
  readonly reparentNodes?: (
    model: MermaidVisualModel,
    nodeIds: readonly string[],
    subgraphId: string,
  ) => MermaidVisualModel | null;
  readonly reparentSubgraph?: (
    model: MermaidVisualModel,
    subgraphId: string,
    parentId: string,
  ) => MermaidVisualModel | null;
  readonly reconcileVisualProjection?: (
    parsed: MermaidVisualModel,
    stored: MermaidVisualModel,
    canReuseStored: boolean,
  ) => MermaidVisualModel;
  readonly subgraphDimension?: (
    model: MermaidVisualModel,
    value: number,
  ) => number;
  readonly subgraphHeaderBehindContent?: boolean;
  readonly subgraphDimensionsAreValid?: (
    height: number | undefined,
    width: number | undefined,
  ) => boolean;
  readonly subgraphInlineRename?: (
    model: MermaidVisualModel,
    subgraphId: string,
    value: string,
    source?: string,
  ) => MermaidVisualModel | null;
  readonly subgraphInlineValue?: (
    model: MermaidVisualModel,
    subgraphId: string,
  ) => string;
  readonly subgraphMutationIsValid?: (
    mutation: Readonly<Record<string, unknown>>,
  ) => boolean;
  readonly subgraphElementProjection: (
    model: MermaidVisualModel,
    subgraph: MermaidVisualSubgraph,
  ) => MermaidGfxNodeElementProjection;
  readonly subgraphUsesTemporalRangeGeometry?: (
    subgraph: MermaidVisualSubgraph,
  ) => boolean;
  readonly syncSubgraphMembership?: (
    model: MermaidVisualModel,
  ) => MermaidVisualModel;
  readonly shapePalette?:
    | {
        readonly all: readonly MermaidVisualNodeShape[];
        readonly core: readonly MermaidVisualNodeShape[];
      }
    | ((diagramType: MermaidVisualModel["diagramType"]) => {
        readonly all: readonly MermaidVisualNodeShape[];
        readonly core: readonly MermaidVisualNodeShape[];
      });
  readonly sourceSyncIncludesEndpointPositions?: (
    diagramType: MermaidVisualModel["diagramType"],
  ) => boolean;
  readonly usesGenericNodeShapeMinimums?: (
    model: MermaidVisualModel,
  ) => boolean;
  readonly visualMutationRejectedMessage?: () => string;
};

export type MermaidGfxFamilyHookRegistration = {
  readonly hooks: MermaidGfxFamilyHooks;
  readonly owns: (model: MermaidVisualModel) => boolean;
  readonly ownsDiagramType: (diagramType: string) => boolean;
};
