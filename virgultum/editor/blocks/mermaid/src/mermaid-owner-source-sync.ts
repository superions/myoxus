import { Bound } from "@virgultum/global/gfx";
import type { MermaidBlockModel } from "@virgultum/model";
import {
  getMermaidVisualNodeDetailElementEntries,
  toMermaidShapeElementProps,
} from "./families/runtime/gfx-element-projection.js";
import {
  MERMAID_GFX_EDGE_ROLE,
  MERMAID_GFX_NODE_ROLE,
  MERMAID_GFX_SUBGRAPH_ROLE,
  MERMAID_GFX_DETAIL_ROLE,
  MERMAID_GFX_TITLE_ROLE,
} from "./families/runtime/gfx-element-roles.js";
import type { MermaidVisualModel } from "./families/runtime/gfx-model.js";
import {
  finalizeTypeOwnedMermaidAdoptedNodeElementProps,
  typeOwnedMermaidNodeElementProjection,
  typeOwnedMermaidSourceSyncIncludesEndpointPositions,
} from "./families/runtime/gfx-owner-hooks.js";
import { createMermaidGfxVisualNode } from "./families/runtime/gfx-graph-operations.js";
import { mermaidLegacyProjectionFingerprint } from "./families/runtime/gfx-projection-read-migration.js";
import {
  readMermaidGfxEdgeId,
  readMermaidGfxMeta,
  readMermaidGfxNodeId,
  readMermaidGfxRole,
  readMermaidGfxSubgraphId,
} from "./mermaid-gfx-metadata.js";
import type { MermaidGfxProjection } from "./presentation/gfx-projection-owner.js";

type MermaidSourceSyncGfxLike = {
  frontEndpointStyle?: string;
  fontFamily?: string;
  fontSize?: number;
  fontStyle?: string;
  fontWeight?: string;
  id?: string;
  labelDisplay?: boolean;
  mode?: string;
  padding?: readonly number[];
  props?: Record<string, unknown> & {
    source?: { id?: string; position?: readonly unknown[] };
    target?: { id?: string; position?: readonly unknown[] };
    type?: string;
  };
  radius?: number;
  rearEndpointStyle?: string;
  shapeType?: string;
  source?: { id?: string; position?: readonly unknown[] };
  stroke?: string;
  strokeStyle?: string;
  strokeWidth?: number;
  target?: { id?: string; position?: readonly unknown[] };
  text?: { toString?: () => string } | string;
  type?: string;
  xywh?: string;
  yMap?: {
    get?: (key: string) => unknown;
    set?: (key: string, value: unknown) => void;
  };
};

export type MermaidOwnerExpectedIds = {
  details: ReadonlySet<string>;
  edges: ReadonlySet<string>;
  nodes: ReadonlySet<string>;
  subgraphs: ReadonlySet<string>;
  title?: boolean;
};

export type MermaidOwnerSourceSyncGateInput = {
  isReadonly: boolean;
  now: number;
  pausedUntil: number;
};

export type MermaidOwnerSourceDriftGateInput =
  MermaidOwnerSourceSyncGateInput & {
    currentKey: string;
    ownerHash: string;
    nextKey: string;
    storedHash: string;
  };

export type MermaidOwnerSourceScheduleGateInput =
  MermaidOwnerSourceSyncGateInput & {
    currentKey: string;
    inEdgeless: boolean;
    mode: "source" | "visual";
    nextKey: string;
  };

const MERMAID_SOURCE_SYNC_META_KEYS = [
  "mermaidDiagramDirection",
  "mermaidDiagramTitle",
  "mermaidRole",
  "mermaidDetailId",
  "mermaidDetailKind",
  "mermaidDetailLabel",
  "mermaidDetailOrder",
  "mermaidDetailOwnerNodeId",
  "mermaidDetailSourceKey",
  "mermaidDetailValue",
  "mermaidNodeDetails",
  "mermaidNodeId",
  "mermaidNodeDisplayLabel",
  "mermaidNodeDenseLabel",
  "mermaidNodeFamilyData",
  "mermaidNodeLabel",
  "mermaidNodeLabelEditable",
  "mermaidNodeSelectable",
  "mermaidNodeShape",
  "mermaidNodeStyleClass",
  "mermaidEdgeConnectorMode",
  "mermaidEdgeDisplayLabel",
  "mermaidEdgeFamilyData",
  "mermaidEdgeId",
  "mermaidEdgeLabelEditable",
  "mermaidEdgeLabelPlacement",
  "mermaidEdgeLinkType",
  "mermaidEdgeMermaidId",
  "mermaidEdgeStyle",
  "mermaidEdgeVisualStyle",
  "mermaidSubgraphId",
  "mermaidSubgraphFamilyData",
  "mermaidSubgraphSelectable",
  "mermaidSubgraphTitle",
  "mermaidSubgraphDirection",
] as const;

const MERMAID_SOURCE_SYNC_VISUAL_KEYS = [
  "shapeType",
  "radius",
  "stroke",
  "strokeStyle",
  "strokeWidth",
  "mode",
  "frontEndpointStyle",
  "rearEndpointStyle",
  "labelDisplay",
  "fontFamily",
  "fontSize",
  "fontStyle",
  "fontWeight",
  "padding",
] as const;

export const MERMAID_OWNER_SOURCE_SYNC_DELAY_MS = 80;
export const MERMAID_OWNER_SOURCE_DRIFT_DELAY_MS = 0;
export const MERMAID_OWNER_SOURCE_SYNC_PAUSE_MS = 300;

function readVisualProp(
  model: MermaidSourceSyncGfxLike,
  key: (typeof MERMAID_SOURCE_SYNC_VISUAL_KEYS)[number],
) {
  return String(model[key] ?? model.props?.[key] ?? "");
}

function readOwnerRelativeXYWH(
  model: MermaidSourceSyncGfxLike,
  ownerXYWH: string,
) {
  const xywh = model.xywh ?? String(model.props?.xywh ?? "");
  if (!xywh) return "";
  const elementBound = Bound.deserialize(xywh);
  const ownerBound = Bound.deserialize(ownerXYWH);
  return new Bound(
    elementBound.x - ownerBound.x,
    elementBound.y - ownerBound.y,
    elementBound.w,
    elementBound.h,
  ).serialize();
}

function readEndpointId(
  model: MermaidSourceSyncGfxLike,
  key: "source" | "target",
) {
  return model[key]?.id ?? String(model.props?.[key]?.id ?? "");
}

function readEndpointPosition(
  model: MermaidSourceSyncGfxLike,
  key: "source" | "target",
) {
  const position = model[key]?.position ?? model.props?.[key]?.position;
  if (!Array.isArray(position) || position.length < 2) return "";
  return position
    .slice(0, 2)
    .map((value) => String(value))
    .join(",");
}

function readEndpointKey(
  model: MermaidSourceSyncGfxLike,
  key: "source" | "target",
  includePosition: boolean,
) {
  const id = readEndpointId(model, key);
  if (!includePosition) return id;
  const position = readEndpointPosition(model, key);
  // Connector endpoint positions are user-authored geometry for diagrams such
  // as Sequence. Include them in the drift key so a replay cannot keep stale
  // message rows while the source-sync hash looks unchanged.
  return position ? `${id}@${position}` : id;
}

function readText(model: MermaidSourceSyncGfxLike) {
  return typeof model.text === "string"
    ? model.text
    : (model.text?.toString?.() ?? "");
}

export function canScheduleMermaidOwnerSourceSync({
  isReadonly,
  now,
  pausedUntil,
}: MermaidOwnerSourceSyncGateInput) {
  return !isReadonly && now >= pausedUntil;
}

export function nextMermaidOwnerSourceSyncPauseUntil(now: number) {
  return now + MERMAID_OWNER_SOURCE_SYNC_PAUSE_MS;
}

export function shouldSyncKnownMermaidOwnerDrift({
  currentKey,
  ownerHash,
  isReadonly,
  nextKey,
  now,
  pausedUntil,
  storedHash,
}: MermaidOwnerSourceDriftGateInput) {
  if (isReadonly || now < pausedUntil || !nextKey) return false;
  return nextKey !== currentKey || ownerHash !== storedHash;
}

export function shouldScheduleMermaidOwnerSourceSync({
  currentKey,
  inEdgeless: _inEdgeless,
  isReadonly,
  mode,
  nextKey,
  now,
  pausedUntil,
}: MermaidOwnerSourceScheduleGateInput) {
  // Edgeless is a first-class owner editing host. It must schedule the
  // same source-sync path as page-scoped visual editing so keyboard undo/redo
  // can replay native GFX mutations while the user remains in Edgeless mode.
  void _inEdgeless;
  if (isReadonly || mode !== "visual" || now < pausedUntil) {
    return false;
  }
  return Boolean(nextKey && nextKey !== currentKey);
}

/**
 * Owns only scheduling state for owner source sync.
 * The block host still executes commands and records source history so timer
 * replay cannot become a hidden second mutation pipeline.
 */
export class MermaidOwnerSourceSyncController {
  private _pausedUntil = 0;
  private _sourceSyncKey = "";
  private _timer: ReturnType<typeof setTimeout> | null = null;

  get currentKey() {
    return this._sourceSyncKey;
  }

  get pausedUntil() {
    return this._pausedUntil;
  }

  acceptKey(key: string) {
    this._sourceSyncKey = key;
  }

  clearPause() {
    this._pausedUntil = 0;
  }

  dispose() {
    this._clearTimer();
  }

  pause(now: number) {
    this._pausedUntil = nextMermaidOwnerSourceSyncPauseUntil(now);
    this._clearTimer();
  }

  schedule({
    isReadonly,
    now,
    syncNow,
  }: {
    readonly isReadonly: boolean;
    readonly now: number;
    readonly syncNow: () => void;
  }) {
    if (
      !canScheduleMermaidOwnerSourceSync({
        isReadonly,
        now,
        pausedUntil: this._pausedUntil,
      })
    ) {
      return false;
    }
    this._setTimer(syncNow, MERMAID_OWNER_SOURCE_SYNC_DELAY_MS);
    return true;
  }

  scheduleIfDrifted({
    inEdgeless,
    isReadonly,
    mode,
    nextKey,
    now,
    syncNow,
  }: {
    readonly inEdgeless: boolean;
    readonly isReadonly: boolean;
    readonly mode: "source" | "visual";
    readonly nextKey: string;
    readonly now: number;
    readonly syncNow: () => void;
  }) {
    if (
      !shouldScheduleMermaidOwnerSourceSync({
        currentKey: this._sourceSyncKey,
        inEdgeless,
        isReadonly,
        mode,
        nextKey,
        now,
        pausedUntil: this._pausedUntil,
      })
    ) {
      return false;
    }
    this._sourceSyncKey = nextKey;
    this._setTimer(syncNow, MERMAID_OWNER_SOURCE_SYNC_DELAY_MS);
    return true;
  }

  syncKnownDriftBeforeEnsure({
    ownerHash,
    isReadonly,
    nextKey,
    now,
    storedHash,
    syncNow,
  }: {
    readonly ownerHash: string;
    readonly isReadonly: boolean;
    readonly nextKey: string;
    readonly now: number;
    readonly storedHash: string;
    readonly syncNow: () => void;
  }) {
    if (
      !shouldSyncKnownMermaidOwnerDrift({
        currentKey: this._sourceSyncKey,
        ownerHash,
        isReadonly,
        nextKey,
        now,
        pausedUntil: this._pausedUntil,
        storedHash,
      })
    ) {
      return false;
    }
    this._sourceSyncKey = nextKey;
    this._setTimer(syncNow, MERMAID_OWNER_SOURCE_DRIFT_DELAY_MS);
    return true;
  }

  private _clearTimer() {
    if (!this._timer) return;
    clearTimeout(this._timer);
    this._timer = null;
  }

  private _setTimer(syncNow: () => void, delay: number) {
    this._clearTimer();
    this._timer = setTimeout(() => {
      this._timer = null;
      syncNow();
    }, delay);
  }
}

export function createMermaidProjectionOwnerSourceSyncKey(
  block: MermaidBlockModel,
  projection: MermaidGfxProjection | null,
) {
  if (!projection || projection.displayOnly) return "";

  const includeEndpointPositions =
    typeOwnedMermaidSourceSyncIncludesEndpointPositions(
      block.props.diagramType as MermaidVisualModel["diagramType"],
    );
  const elementParts = projection.childElementIds.map((id) => {
    const model = projection.getElementById(
      id,
    ) as MermaidSourceSyncGfxLike | null;
    if (!model) return `${id}:missing`;
    const metadata = MERMAID_SOURCE_SYNC_META_KEYS.map(
      (key) => `${key}=${readMermaidGfxMeta(model, key)}`,
    ).join(",");
    const legacyMetadata = mermaidLegacyProjectionFingerprint(
      block.props.diagramType as MermaidVisualModel["diagramType"],
      (key) => readMermaidGfxMeta(model, key),
    );
    const visualProps = MERMAID_SOURCE_SYNC_VISUAL_KEYS.map(
      (key) => `${key}=${readVisualProp(model, key)}`,
    ).join(",");
    return [
      id,
      model.id ?? "",
      model.type ?? String(model.props?.type ?? ""),
      model.type === "connector" || model.props?.type === "connector"
        ? ""
        : readOwnerRelativeXYWH(model, projection.ownerXYWH),
      readEndpointKey(model, "source", includeEndpointPositions),
      readEndpointKey(model, "target", includeEndpointPositions),
      readText(model),
      metadata,
      legacyMetadata,
      visualProps,
    ].join(";");
  });
  return [
    projection.ownerId,
    projection.childElementIds.length,
    ...elementParts,
  ].join("|");
}

export function isExpectedMermaidOwnerCandidate(
  model: unknown,
  expectedIds: MermaidOwnerExpectedIds,
) {
  const role = readMermaidGfxRole(model);
  if (role === MERMAID_GFX_NODE_ROLE) {
    return expectedIds.nodes.has(readMermaidGfxNodeId(model));
  }
  if (role === MERMAID_GFX_EDGE_ROLE) {
    return expectedIds.edges.has(readMermaidGfxEdgeId(model));
  }
  if (role === MERMAID_GFX_SUBGRAPH_ROLE) {
    return expectedIds.subgraphs.has(readMermaidGfxSubgraphId(model));
  }
  if (role === MERMAID_GFX_DETAIL_ROLE) {
    const ownerId = readMermaidGfxMeta(model, "mermaidDetailOwnerNodeId");
    const detailId = readMermaidGfxMeta(model, "mermaidDetailId");
    return expectedIds.details.has(`${ownerId}::detail::${detailId}`);
  }
  if (role === MERMAID_GFX_TITLE_ROLE) {
    return expectedIds.title === true;
  }
  return false;
}

export function restoreExpectedMermaidOwnerChildrenFromActiveGfx({
  candidates,
  projectionOwner,
  visualModel,
}: {
  candidates: readonly MermaidSourceSyncGfxLike[];
  projectionOwner: Pick<MermaidBlockModel, "childIds"> & {
    addChildren?: (models: never[]) => void;
  };
  visualModel: MermaidVisualModel;
}) {
  const expectedNodeIds = new Set(visualModel.nodes.map((node) => node.id));
  const expectedSubgraphIds = new Set(
    (visualModel.subgraphs ?? []).map((subgraph) => subgraph.id),
  );
  const expectedEdgeIds = new Set(visualModel.edges.map((edge) => edge.id));
  const expectedDetailIds = new Set(
    getMermaidVisualNodeDetailElementEntries(visualModel).map(
      ({ elementId }) => elementId,
    ),
  );
  const childIds = new Set(projectionOwner.childIds);
  const missing = candidates.filter((model) => {
    if (!model.id || childIds.has(model.id)) return false;
    return isExpectedMermaidOwnerCandidate(model, {
      edges: expectedEdgeIds,
      details: expectedDetailIds,
      nodes: expectedNodeIds,
      subgraphs: expectedSubgraphIds,
      title: Boolean(visualModel.diagramTitle?.trim()),
    });
  });

  if (missing.length > 0) {
    projectionOwner.addChildren?.(missing as never[]);
  }

  return missing.map((model) => model.id!);
}

export function isMermaidOwnerAdoptionCandidate(
  model: unknown,
  ownerXywh: string,
) {
  const raw = model as MermaidSourceSyncGfxLike | null | undefined;
  if (!raw) return false;
  const role = readMermaidGfxRole(raw);
  if (
    role === MERMAID_GFX_NODE_ROLE ||
    role === MERMAID_GFX_EDGE_ROLE ||
    role === MERMAID_GFX_SUBGRAPH_ROLE ||
    role === MERMAID_GFX_TITLE_ROLE
  ) {
    return false;
  }
  if (
    readMermaidGfxNodeId(raw) ||
    readMermaidGfxEdgeId(raw) ||
    readMermaidGfxSubgraphId(raw)
  ) {
    return false;
  }
  // Managed Mermaid identities already belong to the owner that materialized
  // them. Every Page block observes the shared Surface, so adopting such an
  // element by overlap would let one block steal a sibling block's projection.
  // Only an ordinary, as-yet unowned native shape may enter this owner path.
  return (
    raw.type === "shape" &&
    Boolean(raw.xywh) &&
    Bound.deserialize(raw.xywh!).isOverlapWithBound(
      Bound.deserialize(ownerXywh),
    )
  );
}

function inferMermaidShapeFromGfxShape(model: MermaidSourceSyncGfxLike) {
  const shapeType = String(model.shapeType ?? "");
  if (shapeType === "diamond") return "diamond";
  if (shapeType === "ellipse") return "circle";
  if (shapeType === "triangle") return "tri";
  if (shapeType === "rect" && (model.radius ?? 0) > 0) return "rounded";
  return "rect";
}

export function projectTypeOwnedAdoptedMermaidOwnerShape(
  model: unknown,
  {
    ownerBound,
    visualModel,
  }: {
    ownerBound: Bound;
    visualModel: MermaidVisualModel;
  },
) {
  const raw = model as MermaidSourceSyncGfxLike | null | undefined;
  if (raw?.type !== "shape" || !raw.yMap?.set) return null;
  if (
    readMermaidGfxRole(raw) === MERMAID_GFX_SUBGRAPH_ROLE ||
    readMermaidGfxSubgraphId(raw)
  ) {
    return null;
  }

  const hadMermaidRole = Boolean(readMermaidGfxRole(raw));
  const existingNodeId = readMermaidGfxNodeId(raw);
  if (hadMermaidRole || existingNodeId || !raw.xywh) return null;

  const sourceBound = Bound.deserialize(raw.xywh);
  const node = createMermaidGfxVisualNode(
    visualModel,
    inferMermaidShapeFromGfxShape(raw),
    {
      centerX: sourceBound.x - ownerBound.x + sourceBound.w / 2,
      centerY: sourceBound.y - ownerBound.y + sourceBound.h / 2,
    },
  );
  if (!node) return null;
  node.height = sourceBound.h;
  node.width = sourceBound.w;
  node.x = sourceBound.x - ownerBound.x;
  node.y = sourceBound.y - ownerBound.y;
  const text = readText(raw);
  if (text) {
    node.label = text;
    node.displayLabel = text;
  }
  return finalizeTypeOwnedMermaidAdoptedNodeElementProps(
    visualModel,
    raw,
    toMermaidShapeElementProps(
      node,
      ownerBound,
      visualModel.direction,
      visualModel.diagramTitle,
      typeOwnedMermaidNodeElementProjection(visualModel, node),
    ),
  );
}
