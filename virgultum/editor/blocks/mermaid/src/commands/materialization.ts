import { c4SourceSemanticFamilyData } from "../families/c4/gfx-data.js";
import { createMermaidElementIndexMaps } from "../families/runtime/gfx-layer-order.js";
export { createMermaidElementIndexMaps } from "../families/runtime/gfx-layer-order.js";
import {
  parseMermaidVisualFamilyData,
  serializeMermaidVisualFamilyData,
} from "../families/runtime/gfx-family-data.js";
import {
  readTypeOwnedMermaidSourceProjection,
  reconcileTypeOwnedMermaidVisualProjection,
} from "../families/runtime/gfx-owner-hooks.js";
import { EdgelessCRUDIdentifier } from "@virgultum/block-surface";
import { ConnectorPathGenerator } from "@virgultum/gfx-connector";
import { getMermaidGfxFamilyHooks } from "../families/runtime/gfx-family-hooks-registry.js";
import { Bound } from "@virgultum/global/gfx";
import type { MermaidVisualHistoryModel } from "../mermaid-block-constants.js";
import {
  ConnectorElementModel,
  type FrameBlockModel,
  MERMAID_BLOCK_DIAGRAM_VERSION,
  type MermaidBlockModel,
} from "@virgultum/model";
import type { Command } from "@virgultum/std";
import { GfxControllerIdentifier, type GfxModel } from "@virgultum/std/gfx";
import { type BlockModel, type Store, Text } from "@virgultum/store";
import * as Y from "yjs";
import {
  getMermaidVisualNodeDetailElementCount,
  getMermaidVisualNodeDetailElementEntries,
  resolveMermaidConnectorLabelXYWH,
  toMermaidConnectorElementProps,
  toMermaidDiagramTitleElementProps,
  getMermaidGfxTitleBandHeight,
  toMermaidNodeDetailElementProps,
  toMermaidShapeElementProps,
  toMermaidSubgraphElementProps,
} from "../families/runtime/gfx-element-projection.js";
import { createMermaidVisualModelFromGfxElements } from "../families/runtime/gfx-element-readback.js";
import {
  MERMAID_GFX_DETAIL_ROLE,
  MERMAID_GFX_EDGE_ROLE,
  MERMAID_GFX_NODE_ROLE,
  MERMAID_GFX_SUBGRAPH_ROLE,
  MERMAID_GFX_TITLE_ROLE,
} from "../families/runtime/gfx-element-roles.js";
import type {
  MermaidVisualModel,
  MermaidVisualNode,
} from "../families/runtime/gfx-model.js";
import { createMermaidGfxModelHash } from "../families/runtime/gfx-model.js";
import { resolveMermaidSourceLifecycle } from "../families/runtime/source-lifecycle.js";
import { mermaidGfxEdgeLabelOffset } from "../families/runtime/gfx-element-projection.js";
import { isMermaidProductDiagramType } from "../engine/product-types.js";
import {
  canonicalizeTypeOwnedMermaidVisualProjectionAfterSourceWrite,
  finalizeTypeOwnedMermaidProjectionOwnerGeometry,
  preserveTypeOwnedMermaidManagedNodeDimensions,
  preserveTypeOwnedMermaidManagedSubgraphDimensions,
  usesTypeOwnedMermaidSourceGeometry,
  projectTypeOwnedMermaidMaterializedNode,
  reconcileTypeOwnedMermaidProjectionOwnerGeometry,
  readTypeOwnedMermaidProjectionOwnerModel,
  typeOwnedMermaidEdgeElementProjection,
  typeOwnedMermaidProjectionOwnerAppearanceMatchesTheme,
  typeOwnedMermaidNodeDetailElementProjection,
  typeOwnedMermaidNodeElementProjection,
  typeOwnedMermaidSubgraphElementProjection,
} from "../families/runtime/gfx-owner-hooks.js";
import {
  applyMermaidGfxVisualToSource,
  mermaidGfxCommittedSource,
  mermaidGfxPreservesSourceBytes,
  parseMermaidSourceToGfxVisualModel,
  prepareMermaidGfxVisualTransfer,
} from "../mermaid-gfx-graph-adapters.js";
import { readMermaidGfxMeta } from "../mermaid-gfx-metadata.js";
import { resolveMermaidBlockInsertIdentity } from "../mermaid-insert-identity.js";
import { writeMermaidSourceModelState } from "../mermaid-source-write.js";
import { resolveMermaidEffectiveBlockTitle } from "../mermaid-title-projection.js";
import {
  cloneMermaidVisualModel as cloneVisualModel,
  syncMermaidVisualSubgraphMembership,
} from "../mermaid-visual-model-operations.js";
import { getMermaidBlockSource, hashMermaidSource } from "../utils.js";
import { getMermaidVisualModel } from "./model-resolution.js";
import {
  resolveMermaidGfxProjectionOwner,
  type MermaidGfxProjectionOwner,
} from "../presentation/gfx-projection-owner.js";
import { resolveMermaidLegacyLinkedOwner } from "../presentation/legacy-linked-owner.js";
import {
  canMutateMermaidGfxOwnerSource,
  isMermaidBlockModel,
} from "../presentation/owner.js";

export type MermaidCompoundCommandOptions = {
  blockId?: string;
  model?: BlockModel;
  selectedModels?: BlockModel[];
};
export type MermaidGfxProjectionGroup = FrameBlockModel | MermaidBlockModel;

function shouldMaterializeNativeDiagramTitle(
  projectionOwner: MermaidGfxProjectionGroup,
  visualModel: MermaidVisualModel,
) {
  return (
    projectionOwner.flavour === "myoxus:mermaid" &&
    projectionOwner.store.getParent(projectionOwner)?.flavour ===
      "myoxus:surface" &&
    Boolean(visualModel.diagramTitle?.trim())
  );
}

export function getMermaidProjectionChildModel(
  store: Store,
  owner: MermaidGfxProjectionGroup,
  id: string,
) {
  return (
    owner.surface?.getElementById(id) ??
    (store.getModelById(id) as GfxModel | null)
  );
}

/** Checked Source writes may resolve their valid candidate while the current
 * Source is invalid. Ordinary geometry mutations always check current Source. */
export function resolveMermaidProjectionGroup(
  model: MermaidBlockModel,
  source = getMermaidBlockSource(model.props),
) {
  if (
    !canMutateMermaidGfxOwnerSource({
      lastValidSource: model.props.lastValidSource,
      parent: model.store.getParent(model.id),
      source,
    })
  ) {
    return null;
  }
  const owner = resolveMermaidGfxProjectionOwner(model);
  if (!owner || resolveMermaidLegacyLinkedOwner(model)) return null;
  return owner.model;
}

export type MermaidMaterializationResult = {
  connectorIds: string[];
  elementIds: string[];
  projectionOwner: MermaidGfxProjectionGroup;
  ownerId: string;
  shapeIds: string[];
  sourceHash: string;
  visualModel: MermaidVisualModel;
  visualModelHash: string;
};
export function createMermaidProjectionOwnerIndexGenerator(
  ctx: Parameters<Command>[0],
) {
  const gfx = ctx.std.get(GfxControllerIdentifier) as
    | {
        layer?: {
          createIndexGenerator?: () => () => string;
        };
      }
    | undefined;
  const nextLayerIndex = gfx?.layer?.createIndexGenerator?.();
  if (nextLayerIndex) return nextLayerIndex;
  let next = 0;
  return () => `a${String(next++).padStart(4, "0")}`;
}
export function visualNodeWithDiagramDetails(
  node: MermaidVisualNode,
  diagramType: MermaidVisualModel["diagramType"],
): MermaidVisualNode {
  return projectTypeOwnedMermaidMaterializedNode(node, diagramType);
}
export function getMermaidCommandModels({
  blockId,
  model,
  selectedModels,
  std,
}: MermaidCompoundCommandOptions & {
  std: Parameters<Command>[0]["std"];
}) {
  const models: BlockModel[] = [];
  if (model) {
    models.push(model);
  } else if (blockId) {
    const found = std.store.getBlock(blockId)?.model;
    if (found) models.push(found);
  } else if (selectedModels) {
    models.push(...selectedModels);
  }
  return models.filter(isMermaidBlockModel);
}
/** Use the rendered connector geometry, including its path-attached label. */
function encloseRenderedMermaidConnectors(
  owner: MermaidGfxProjectionGroup,
  visual: MermaidVisualModel,
  initial: Bound,
) {
  if (!getMermaidGfxFamilyHooks(visual)?.includeRenderedConnectorBounds)
    return initial;
  let bound = initial;
  for (const id of owner.childIds) {
    const child = getMermaidProjectionChildModel(owner.store, owner, id);
    if (!child) continue;
    if (child instanceof ConnectorElementModel) {
      ConnectorPathGenerator.updatePath(child, null, (key) =>
        getMermaidProjectionChildModel(owner.store, owner, key),
      );
    }
    const childBound = child.elementBound;
    // Renderer geometry may be incomplete during hydration. It cannot be
    // allowed to poison the persisted owner or every sibling's next origin.
    if (
      [childBound.x, childBound.y, childBound.w, childBound.h].every(
        Number.isFinite,
      )
    )
      bound = bound.unite(childBound);
  }
  return bound;
}
export function getMermaidVisualFrameGeometry(
  visualModel: Pick<MermaidVisualModel, "nodes" | "subgraphs"> | null,
  fallback = new Bound(0, 0, 420, 260),
) {
  if (
    !visualModel ||
    (!visualModel.nodes.length && !visualModel.subgraphs?.length)
  ) {
    return {
      bound: fallback,
      offsetX: 0,
      offsetY: 0,
    };
  }
  // Family-owned subgraphs such as Sequence bands and State regions are real
  // diagram geometry, so projectionOwner sizing must include them even when they do not
  // have standalone node counterparts.
  const layoutItems = [
    ...visualModel.nodes.map((node) => {
      const angle = ((node.rotate ?? 0) * Math.PI) / 180;
      if (!angle) return node;
      const width =
        Math.abs(node.width * Math.cos(angle)) +
        Math.abs(node.height * Math.sin(angle));
      const height =
        Math.abs(node.width * Math.sin(angle)) +
        Math.abs(node.height * Math.cos(angle));
      return {
        x: node.x + (node.width - width) / 2,
        y: node.y + (node.height - height) / 2,
        width,
        height,
      };
    }),
    ...(visualModel.subgraphs ?? []).map((subgraph) => ({
      height: subgraph.height,
      width: subgraph.width,
      x: subgraph.x,
      y: subgraph.y,
    })),
  ];
  const minX = Math.min(0, ...layoutItems.map((item) => item.x));
  const minY = Math.min(0, ...layoutItems.map((item) => item.y));
  const maxX = Math.max(...layoutItems.map((item) => item.x + item.width));
  const maxY = Math.max(...layoutItems.map((item) => item.y + item.height));
  const offsetX = -minX;
  const offsetY = -minY;
  return {
    bound: new Bound(
      // Expand toward negative family extents instead of keeping the projectionOwner
      // origin fixed and translating every child. This keeps already visible
      // diagram content—and direct pointer placement—anchored in document
      // coordinates while the projection owner grows around it.
      fallback.x + minX,
      fallback.y + minY,
      Math.max(360, maxX + offsetX + 80),
      Math.max(220, maxY + offsetY + 80),
    ),
    offsetX,
    offsetY,
  };
}
export function getVisualFrameBound(
  visualModel: MermaidVisualModel | null,
  fallback = new Bound(0, 0, 420, 260),
) {
  return getMermaidVisualFrameGeometry(visualModel, fallback).bound;
}
export function getMermaidVisualElementOriginBound(
  visualModel: MermaidVisualModel,
  ownerBound: Bound,
  topInset = 0,
) {
  const { offsetX, offsetY } = getMermaidVisualFrameGeometry(
    visualModel,
    ownerBound,
  );
  return new Bound(
    ownerBound.x + offsetX,
    ownerBound.y + topInset + offsetY,
    ownerBound.w,
    ownerBound.h,
  );
}
export function getMermaidVisualElementOriginFromAnchor(
  anchorNode: Pick<MermaidVisualModel["nodes"][number], "x" | "y">,
  anchorBound: Bound,
  fallback: Bound,
) {
  return new Bound(
    anchorBound.x - anchorNode.x,
    anchorBound.y - anchorNode.y,
    fallback.w,
    fallback.h,
  );
}
export function findMermaidInsertBound(
  visualModel: MermaidVisualModel | null,
  search: (bound: Bound) => Array<{
    x: number;
    w: number;
  }>,
  padding = 80,
) {
  const bound = getVisualFrameBound(visualModel, new Bound(0, 0, 420, 260));
  let collisions = search(bound);
  let guard = 0;
  while (collisions.length > 0 && guard++ < 100) {
    const rightmost = collisions.reduce((a, b) =>
      a.x + a.w > b.x + b.w ? a : b,
    );
    bound.x = rightmost.x + rightmost.w + padding;
    collisions = search(bound);
  }
  return bound;
}
export function findMermaidDuplicateBound(
  ctx: Pick<Parameters<Command>[0], "std">,
  sourceBound: Bound,
  padding = 80,
) {
  const gfx = ctx.std.get(GfxControllerIdentifier);
  const noteCollisionBoxes = getNoteCollisionBoxes(ctx.std.store);
  const bound = new Bound(
    sourceBound.x + padding,
    sourceBound.y + padding,
    sourceBound.w,
    sourceBound.h,
  );
  const search = () => [
    ...gfx.grid.search(bound).map(({ w, x }) => ({ w, x })),
    ...noteCollisionBoxes
      .filter((noteBound) => noteBound.isIntersectWithBound(bound))
      .map(({ w, x }) => ({ w, x })),
  ];
  let collisions = search();
  let guard = 0;
  while (collisions.length > 0 && guard++ < 100) {
    const rightmost = collisions.reduce((a, b) =>
      a.x + a.w > b.x + b.w ? a : b,
    );
    bound.x = rightmost.x + rightmost.w + padding;
    collisions = search();
  }
  return bound;
}
export function getNoteCollisionBoxes(store: Store) {
  return store
    .getBlocksByFlavour("myoxus:note")
    .map(({ model }) =>
      "xywh" in model && typeof model.xywh === "string"
        ? Bound.deserialize(model.xywh)
        : null,
    )
    .filter((bound): bound is Bound => Boolean(bound));
}
export function visualFromSource(source: string) {
  const parsed = parseMermaidSourceToGfxVisualModel(source);
  return parsed.model ? parsed : null;
}
export function createMermaidBlockInsertProps({
  source,
  title,
  preserveSourceBytes = false,
}: {
  source: string;
  title?: string;
  /** Existing persisted blocks must not gain import-time title or whitespace rewrites. */
  preserveSourceBytes?: boolean;
}) {
  const identity = resolveMermaidBlockInsertIdentity({ source, title });
  const persistedSource = preserveSourceBytes ? source : identity.source;
  const parsed = parseMermaidSourceToGfxVisualModel(persistedSource);
  const lifecycle = resolveMermaidSourceLifecycle(persistedSource);
  const props = {
    flavour: "myoxus:mermaid" as const,
    diagramType: parsed.diagramType,
    diagramVersion: MERMAID_BLOCK_DIAGRAM_VERSION,
    displayMode: "edit" as const,
    lastValidSource: lifecycle.canRetainAsLastValid ? persistedSource : "",
    renderEngine: null,
    renderHash: null,
    // Text(string) normalizes CRLF. Existing clipboard source is already
    // persisted and must bypass that explicit import-time normalization.
    source: preserveSourceBytes
      ? new Text(new Y.Text(persistedSource))
      : new Text(persistedSource),
    sourceHash: preserveSourceBytes
      ? hashMermaidSource(persistedSource)
      : parsed.sourceHash,
    title: new Text(identity.title),
    viewportHeight: null,
  };
  return props;
}

export function materializeMermaidElements({
  addElement,
  projectionOwner,
  ownerBound,
  nextIndex,
  visualModel,
}: {
  addElement: (type: string, props: Record<string, unknown>) => string | void;
  projectionOwner: MermaidGfxProjectionGroup;
  ownerBound: Bound;
  nextIndex: () => string;
  visualModel: MermaidVisualModel;
}) {
  const titleBandHeight = shouldMaterializeNativeDiagramTitle(
    projectionOwner,
    visualModel,
  )
    ? getMermaidGfxTitleBandHeight(visualModel)
    : 0;
  const elementOriginBound = getMermaidVisualElementOriginBound(
    visualModel,
    ownerBound,
    titleBandHeight,
  );
  const idMap = new Map<string, string>();
  const subgraphIds: string[] = [];
  const shapeIds: string[] = [];
  const detailShapeIds: string[] = [];
  const titleShapeIds: string[] = [];
  const connectorIds: string[] = [];
  const addedSubgraphModels: GfxModel[] = [];
  const addedShapeModels: GfxModel[] = [];
  const addedDetailShapeModels: GfxModel[] = [];
  const addedTitleShapeModels: GfxModel[] = [];
  const addedConnectorModels: GfxModel[] = [];
  const addedModelProps: Array<[GfxModel, Record<string, unknown>]> = [];
  const zIndexes = createMermaidElementIndexMaps(visualModel, nextIndex);
  if (shouldMaterializeNativeDiagramTitle(projectionOwner, visualModel)) {
    const props = {
      ...toMermaidDiagramTitleElementProps(
        visualModel.diagramTitle!.trim(),
        ownerBound,
        visualModel,
      ),
      index: nextIndex(),
    };
    const id = addElement("shape", props);
    if (!id) throw new Error("failed to add Mermaid diagram title");
    titleShapeIds.push(id);
    const model = projectionOwner.surface?.getElementById(
      id,
    ) as GfxModel | null;
    if (model) {
      addedTitleShapeModels.push(model);
      addedModelProps.push([model, props]);
    }
  }
  for (const subgraph of visualModel.subgraphs ?? []) {
    const props = {
      ...toMermaidSubgraphElementProps(
        subgraph,
        elementOriginBound,
        typeOwnedMermaidSubgraphElementProjection(visualModel, subgraph),
      ),
      index: zIndexes.subgraphs.get(subgraph.id),
    };
    const id = addElement("shape", props);
    if (!id) {
      throw new Error(`failed to add Mermaid subgraph: ${subgraph.id}`);
    }
    idMap.set(subgraph.id, id);
    subgraphIds.push(id);
    const model = projectionOwner.surface?.getElementById(
      id,
    ) as GfxModel | null;
    if (model) {
      addedSubgraphModels.push(model);
      addedModelProps.push([model, props]);
    }
  }
  for (const node of visualModel.nodes) {
    const props = {
      ...toMermaidShapeElementProps(
        node,
        elementOriginBound,
        visualModel.direction,
        visualModel.diagramTitle,
        typeOwnedMermaidNodeElementProjection(visualModel, node),
      ),
      index: zIndexes.shapes.get(node.id),
    };
    const id = addElement("shape", props);
    if (!id) throw new Error(`failed to add Mermaid shape: ${node.id}`);
    idMap.set(node.id, id);
    shapeIds.push(id);
    const model = projectionOwner.surface?.getElementById(
      id,
    ) as GfxModel | null;
    if (model) {
      addedShapeModels.push(model);
      addedModelProps.push([model, props]);
    }
  }
  for (const {
    detail,
    elementId,
    node,
    rowIndex,
    edge,
    projection: annotationProjection,
  } of getMermaidVisualNodeDetailElementEntries(visualModel)) {
    const projection =
      annotationProjection ??
      typeOwnedMermaidNodeDetailElementProjection(visualModel, node, detail);
    if (!projection) {
      throw new Error(
        `Mermaid ${visualModel.diagramType} does not own detail projection`,
      );
    }
    const props = {
      ...toMermaidNodeDetailElementProps({
        detail,
        ownerBound: elementOriginBound,
        node,
        projection,
        rowIndex,
      }),
      ...(edge ? { mermaidNodeId: "", mermaidEdgeId: edge.id } : {}),
      index: zIndexes.details.get(elementId),
    };
    const id = addElement("shape", props);
    if (!id) {
      throw new Error(`failed to add Mermaid detail row: ${elementId}`);
    }
    detailShapeIds.push(id);
    const model = projectionOwner.surface?.getElementById(
      id,
    ) as GfxModel | null;
    if (model) {
      addedDetailShapeModels.push(model);
      addedModelProps.push([model, props]);
    }
  }
  for (const [index, edge] of visualModel.edges.entries()) {
    const elementProjection = typeOwnedMermaidEdgeElementProjection(
      visualModel,
      edge,
      index,
    );
    const props = {
      ...toMermaidConnectorElementProps(
        edge,
        idMap,
        resolveMermaidConnectorLabelXYWH({
          edge,
          elementProjection,
          ownerBound: elementOriginBound,
          labelOffset: mermaidGfxEdgeLabelOffset(visualModel, edge),
          visualModel,
        }),
        elementProjection,
      ),
      index: zIndexes.connectors.get(edge.id),
    };
    const id = addElement("connector", props);
    if (!id) throw new Error(`failed to add Mermaid connector: ${edge.id}`);
    idMap.set(edge.id, id);
    connectorIds.push(id);
    const model = projectionOwner.surface?.getElementById(
      id,
    ) as GfxModel | null;
    if (model) {
      addedConnectorModels.push(model);
      addedModelProps.push([model, props]);
    }
  }
  const addedModelsInZOrder = [
    ...addedSubgraphModels,
    ...addedConnectorModels,
    ...addedShapeModels,
    ...addedDetailShapeModels,
    ...addedTitleShapeModels,
  ];
  if (addedModelsInZOrder.length > 0) {
    // Native Mermaid owners validate membership from the persisted Mermaid
    // role. Surface creation returns the model before extension metadata has
    // been projected, so assign the canonical props before asking the owner to
    // accept its children.
    for (const [model, props] of addedModelProps) {
      assignGfxProps(model, props);
    }
    // Subgraphs are background containers, connectors are relationships and
    // nodes own the editable labels. This z-order keeps Edgeless hit testing
    // from selecting a connector when the user double-clicks node text on a
    // vertical State transition.
    projectionOwner.addChildren(addedModelsInZOrder);
  }
  // Surface creation returns the authoritative IDs synchronously even when a
  // corresponding model is not yet available to addChildren(). Commit the
  // complete materialization as one owner set so a missing first child (most
  // visibly an Architecture subgraph) cannot be read back as a deletion.
  const childElementIds = Object.fromEntries(
    [
      ...subgraphIds,
      ...connectorIds,
      ...shapeIds,
      ...detailShapeIds,
      ...titleShapeIds,
    ].map((id) => [id, true]),
  );
  if (
    mermaidSemanticCollectionKey(projectionOwner.props.childElementIds) !==
    mermaidSemanticCollectionKey(childElementIds)
  ) {
    projectionOwner.store.transact(() => {
      projectionOwner.props.childElementIds = childElementIds;
    });
  }
  return {
    connectorIds,
    elementIds: [
      ...subgraphIds,
      ...connectorIds,
      ...shapeIds,
      ...detailShapeIds,
      ...titleShapeIds,
    ],
    shapeIds: [...shapeIds, ...detailShapeIds],
    subgraphIds,
  };
}
export function removeMermaidProjectionOwnerChildren(
  ctx: Parameters<Command>[0],
  projectionOwner: MermaidGfxProjectionGroup,
) {
  const crud = ctx.std.get(EdgelessCRUDIdentifier);
  const childIds = [...projectionOwner.childIds];
  const childModels = childIds
    .map((id) =>
      getMermaidProjectionChildModel(ctx.std.store, projectionOwner, id),
    )
    .filter((model): model is GfxModel => Boolean(model));
  projectionOwner.removeChildren(childModels);
  for (const id of childIds.reverse()) {
    crud.removeElement(id);
  }
}
export function getMermaidProjectionOwnerChildrenByType(
  store: Store,
  projectionOwner: MermaidGfxProjectionGroup,
  type: "connector" | "shape",
) {
  return projectionOwner.childIds
    .map((id) => getMermaidProjectionChildModel(store, projectionOwner, id))
    .filter((model): model is GfxModel => {
      const raw = model as unknown as {
        type?: string;
      };
      return raw?.type === type;
    });
}
export function getMermaidProjectionOwnerChildrenByRole(
  store: Store,
  projectionOwner: MermaidGfxProjectionGroup,
  type: "connector" | "shape",
  role: string,
) {
  return getMermaidProjectionOwnerChildrenByType(
    store,
    projectionOwner,
    type,
  ).filter((model) => {
    return readMermaidGfxMeta(model, "mermaidRole") === role;
  });
}
export function assignGfxProps(
  model: GfxModel,
  props: Record<string, unknown>,
) {
  const target = model as unknown as {
    props?: Record<string, unknown>;
    yMap?: {
      doc?: unknown;
      get?: (key: string) => unknown;
      set: (key: string, value: unknown) => void;
    };
  } & Record<string, unknown>;
  const writable = target.props ?? target;
  const matches = (current: unknown, next: unknown) => {
    if (Object.is(current, next)) return true;
    if (
      current &&
      next &&
      typeof current === "object" &&
      typeof next === "object"
    ) {
      return (
        mermaidSemanticCollectionKey(current) ===
        mermaidSemanticCollectionKey(next)
      );
    }
    return false;
  };
  for (const [key, value] of Object.entries(props)) {
    if (key === "text" && typeof value === "string") {
      const currentText = target.text ?? writable.text;
      if (currentText instanceof Y.Text) {
        if (currentText.toString() !== value) {
          currentText.delete(0, currentText.length);
          currentText.insert(0, value);
        }
        continue;
      }
      if (!target.yMap?.doc) {
        if (!matches(writable[key], value)) writable[key] = value;
        if (!matches(target[key], value)) target[key] = value;
        continue;
      }
      if (currentText === value) continue;
      const text = new Y.Text();
      text.insert(0, value);
      target[key] = text;
      continue;
    }
    if (!matches(writable[key], value)) writable[key] = value;
    if (!matches(target[key], value)) target[key] = value;
    if (key.startsWith("mermaid") && !matches(target.yMap?.get?.(key), value)) {
      target.yMap?.set(key, value);
    }
  }
}

export function addMermaidProjectionOwnerChild(
  projectionOwner: MermaidGfxProjectionGroup,
  child: GfxModel,
) {
  // Create commands own this fresh element. Clear an incidental Mermaid group
  // claim before persisting the intended owner so one Surface model can never
  // become a child of two Mermaid diagrams.
  for (const group of child.groups) {
    if (
      group !== projectionOwner &&
      "flavour" in group &&
      group.flavour === "myoxus:mermaid"
    ) {
      // oxlint-disable-next-line unicorn/prefer-dom-node-remove -- GFX group API, not a DOM node.
      group.removeChild(child);
    }
  }
  projectionOwner.addChildren([child]);
  if (projectionOwner.childIds.includes(child.id)) return;
  projectionOwner.store.transact(() => {
    projectionOwner.props.childElementIds = {
      ...projectionOwner.props.childElementIds,
      [child.id]: true,
    };
  });
}

export function getGfxMeta(model: GfxModel, key: string) {
  return readMermaidGfxMeta(model, key);
}
export function getMermaidGfxNode(
  store: Store,
  projectionOwner: MermaidGfxProjectionGroup,
  nodeId: string,
) {
  return getMermaidProjectionOwnerChildrenByRole(
    store,
    projectionOwner,
    "shape",
    MERMAID_GFX_NODE_ROLE,
  ).find((model) => getGfxMeta(model, "mermaidNodeId") === nodeId);
}
export function getMermaidGfxSubgraph(
  store: Store,
  projectionOwner: MermaidGfxProjectionGroup,
  subgraphId: string,
) {
  return getMermaidProjectionOwnerChildrenByRole(
    store,
    projectionOwner,
    "shape",
    MERMAID_GFX_SUBGRAPH_ROLE,
  ).find((model) => getGfxMeta(model, "mermaidSubgraphId") === subgraphId);
}
export function getMermaidGfxConnector(
  store: Store,
  projectionOwner: MermaidGfxProjectionGroup,
  edgeId: string,
) {
  return getMermaidProjectionOwnerChildrenByType(
    store,
    projectionOwner,
    "connector",
  ).find((model) => getGfxMeta(model, "mermaidEdgeId") === edgeId);
}
export function getMermaidGfxElementIdMap(
  store: Store,
  projectionOwner: MermaidGfxProjectionGroup,
) {
  const idMap = new Map<string, string>();
  for (const node of getMermaidProjectionOwnerChildrenByRole(
    store,
    projectionOwner,
    "shape",
    MERMAID_GFX_NODE_ROLE,
  )) {
    const nodeId = getGfxMeta(node, "mermaidNodeId");
    if (nodeId) idMap.set(nodeId, node.id);
  }
  for (const subgraph of getMermaidProjectionOwnerChildrenByRole(
    store,
    projectionOwner,
    "shape",
    MERMAID_GFX_SUBGRAPH_ROLE,
  )) {
    const subgraphId = getGfxMeta(subgraph, "mermaidSubgraphId");
    if (subgraphId) idMap.set(subgraphId, subgraph.id);
  }
  for (const connector of getMermaidProjectionOwnerChildrenByRole(
    store,
    projectionOwner,
    "connector",
    MERMAID_GFX_EDGE_ROLE,
  )) {
    const edgeId = getGfxMeta(connector, "mermaidEdgeId");
    if (edgeId) idMap.set(edgeId, connector.id);
  }
  return idMap;
}
export function readMermaidVisualModelFromProjectionGroup(
  store: Store,
  projectionOwner: MermaidGfxProjectionGroup,
  previousModel: MermaidVisualModel | null,
  fallbackDiagramType?: string | null,
) {
  const direction = previousModel?.direction ?? "TD";
  const fallbackProductDiagramType = fallbackDiagramType as
    MermaidVisualModel["diagramType"] | undefined;
  const diagramType =
    previousModel?.diagramType ??
    (fallbackProductDiagramType &&
    isMermaidProductDiagramType(fallbackProductDiagramType)
      ? fallbackProductDiagramType
      : null);
  if (!diagramType) return null;
  const children = projectionOwner.childIds.map((id) =>
    getMermaidProjectionChildModel(store, projectionOwner, id),
  );
  // A partially hydrated owner is not a smaller diagram. Never feed partial
  // geometry into reconciliation or write it back as authoritative Source.
  if (children.some((model) => !model)) return null;
  const elements = children.filter((model): model is GfxModel =>
    Boolean(model),
  );
  // Presentation-hidden children are still hydrated semantic objects. Readback
  // includes them so collapse, Source edits and reload never imply deletion.
  const ownerFamilyData =
    projectionOwner.flavour === "myoxus:mermaid"
      ? parseMermaidVisualFamilyData(
          (projectionOwner as MermaidBlockModel).props.familyData,
        )
      : undefined;
  const visual = createMermaidVisualModelFromGfxElements({
    diagramType,
    direction,
    elements,
    ownerBound: Bound.deserialize(projectionOwner.xywh),
    previousModel:
      previousModel && ownerFamilyData
        ? { ...previousModel, familyData: ownerFamilyData }
        : previousModel,
  });
  if (!visual) return null;
  // A cold/invalid read has no previous semantic model. Retain the owner’s
  // Source bindings and presentation metadata independently of that cache.
  return readTypeOwnedMermaidProjectionOwnerModel(
    ownerFamilyData ? { ...visual, familyData: ownerFamilyData } : visual,
  );
}
export function restoreExpectedMermaidProjectionOwnerChildren(
  projectionOwner: MermaidGfxProjectionGroup,
  previousModel: MermaidVisualModel | null,
) {
  if (!previousModel) return;
  const childIds = new Set(projectionOwner.childIds);
  // Semantic IDs repeat across diagrams. Frames can mask the native owner in
  // an element's cached group chain, so persisted membership decides ownership.
  const foreignChildIds = new Set(
    projectionOwner.store
      .getBlocksByFlavour("myoxus:mermaid")
      .filter(({ model }) => model.id !== projectionOwner.id)
      .flatMap(({ model }) => (model as MermaidBlockModel).childIds),
  );
  const expectedNodeIds = new Set(previousModel.nodes.map((node) => node.id));
  const expectedSubgraphIds = new Set(
    (previousModel.subgraphs ?? []).map((subgraph) => subgraph.id),
  );
  const expectedEdgeIds = new Set(previousModel.edges.map((edge) => edge.id));
  const expectedDetailIds = new Set(
    getMermaidVisualNodeDetailElementEntries(previousModel).map(
      ({ elementId }) => elementId,
    ),
  );
  const surfaceElements =
    ((
      projectionOwner.surface as
        | {
            elementModels?: GfxModel[];
          }
        | null
        | undefined
    )?.elementModels as GfxModel[] | undefined) ?? [];
  const missing = surfaceElements.filter((model) => {
    if (childIds.has(model.id) || foreignChildIds.has(model.id)) return false;
    const role = getGfxMeta(model, "mermaidRole");
    if (
      role !== MERMAID_GFX_NODE_ROLE &&
      role !== MERMAID_GFX_SUBGRAPH_ROLE &&
      role !== MERMAID_GFX_EDGE_ROLE &&
      role !== MERMAID_GFX_DETAIL_ROLE &&
      role !== MERMAID_GFX_TITLE_ROLE
    ) {
      return false;
    }
    const nodeId = getGfxMeta(model, "mermaidNodeId");
    if (nodeId && expectedNodeIds.has(nodeId)) return true;
    const subgraphId = getGfxMeta(model, "mermaidSubgraphId");
    if (subgraphId && expectedSubgraphIds.has(subgraphId)) return true;
    const edgeId = getGfxMeta(model, "mermaidEdgeId");
    if (edgeId && expectedEdgeIds.has(edgeId)) return true;
    if (role === MERMAID_GFX_DETAIL_ROLE) {
      const ownerId = getGfxMeta(model, "mermaidDetailOwnerNodeId");
      const detailId = getGfxMeta(model, "mermaidDetailId");
      return expectedDetailIds.has(`${ownerId}::detail::${detailId}`);
    }
    if (role === MERMAID_GFX_TITLE_ROLE) {
      return shouldMaterializeNativeDiagramTitle(
        projectionOwner,
        previousModel,
      );
    }
    return false;
  });
  if (missing.length > 0) {
    projectionOwner.addChildren(missing);
  }
}
export function getMermaidVisualModelFromProjectionOwner(
  std: Pick<Parameters<Command>[0]["std"], "store" | "workspace">,
  model: MermaidBlockModel,
  previousModel: MermaidVisualModel | null = getMermaidVisualModel(model),
) {
  const owner = resolveMermaidGfxProjectionOwner(model);
  if (owner?.childElementIds.length) {
    const stored = readMermaidVisualModelFromProjectionGroup(
      std.store,
      owner.model,
      previousModel,
      model.props.diagramType,
    );
    return stored
      ? readTypeOwnedMermaidSourceProjection(
          getMermaidBlockSource(model.props),
          stored,
        )
      : null;
  }
  const legacyOwner = resolveMermaidLegacyLinkedOwner(model);
  if (!legacyOwner) return null;
  return readMermaidVisualModelFromProjectionGroup(
    std.store,
    legacyOwner.frame,
    previousModel,
    model.props.diagramType,
  );
}
export function getMermaidVisualModelForEditing(
  std: Pick<Parameters<Command>[0]["std"], "store" | "workspace">,
  model: MermaidBlockModel,
) {
  return (
    getMermaidVisualModelFromProjectionOwner(std, model) ??
    getMermaidVisualModel(model)
  );
}
export function getMermaidSourceAuthoritativeVisualModel(
  std: Pick<Parameters<Command>[0]["std"], "store" | "workspace">,
  model: MermaidBlockModel,
): MermaidVisualHistoryModel | null {
  const parsed = parseMermaidSourceToGfxVisualModel(
    getMermaidBlockSource(model.props),
  ).model;
  if (!parsed) return null;
  if (std.store.getParent(model)?.flavour === "myoxus:surface") {
    // Native history is Source-authoritative for semantic diagram state, but
    // its visible title is the block title projected by the Surface owner.
    // Keep that owner-owned field in gesture snapshots so undo/redo never
    // interprets a geometry edit as removal of the native title child.
    parsed.diagramTitle = resolveMermaidEffectiveBlockTitle(model.props);
  }
  const owner = resolveMermaidGfxProjectionOwner(model);
  if (owner?.childElementIds.length) {
    if (
      !readMermaidVisualModelFromProjectionGroup(std.store, owner.model, parsed)
    ) {
      return null;
    }
    const snapshot: MermaidVisualHistoryModel =
      preserveMermaidProjectionOwnerGeometry(std.store, owner.model, parsed);
    const node = snapshot.nodes[0];
    const element = node && getMermaidGfxNode(std.store, owner.model, node.id);
    if (node && element) {
      const bound = Bound.deserialize(element.xywh);
      // History outlives changes to the enclosing owner's bounds. Relative
      // coordinates alone replay at the *new* origin and move unrelated nodes.
      snapshot.projectionOrigin = { x: bound.x - node.x, y: bound.y - node.y };
    }
    return snapshot;
  }
  const legacyOwner = resolveMermaidLegacyLinkedOwner(model);
  return legacyOwner
    ? preserveMermaidProjectionOwnerGeometry(
        std.store,
        legacyOwner.frame,
        parsed,
      )
    : parsed;
}
export function updateMermaidElementsInPlaceIfCompatible({
  ctx,
  projectionOwner,
  ownerBound,
  visualModel,
}: {
  ctx: Parameters<Command>[0];
  projectionOwner: MermaidGfxProjectionGroup;
  ownerBound: Bound;
  visualModel: MermaidVisualModel;
}) {
  const titleBandHeight = shouldMaterializeNativeDiagramTitle(
    projectionOwner,
    visualModel,
  )
    ? getMermaidGfxTitleBandHeight(visualModel)
    : 0;
  const elementOriginBound = getMermaidVisualElementOriginBound(
    visualModel,
    ownerBound,
    titleBandHeight,
  );
  const subgraphs = getMermaidProjectionOwnerChildrenByRole(
    ctx.std.store,
    projectionOwner,
    "shape",
    MERMAID_GFX_SUBGRAPH_ROLE,
  );
  const shapes = getMermaidProjectionOwnerChildrenByRole(
    ctx.std.store,
    projectionOwner,
    "shape",
    MERMAID_GFX_NODE_ROLE,
  );
  const detailShapes = getMermaidProjectionOwnerChildrenByRole(
    ctx.std.store,
    projectionOwner,
    "shape",
    MERMAID_GFX_DETAIL_ROLE,
  );
  const titleShapes = getMermaidProjectionOwnerChildrenByRole(
    ctx.std.store,
    projectionOwner,
    "shape",
    MERMAID_GFX_TITLE_ROLE,
  );
  const connectors = getMermaidProjectionOwnerChildrenByType(
    ctx.std.store,
    projectionOwner,
    "connector",
  );
  const nextIndex = createMermaidProjectionOwnerIndexGenerator(ctx);
  const zIndexes = createMermaidElementIndexMaps(visualModel, nextIndex);
  const nextTitleIds: string[] = [];
  const titleShape = titleShapes[0];
  if (shouldMaterializeNativeDiagramTitle(projectionOwner, visualModel)) {
    const props = {
      ...toMermaidDiagramTitleElementProps(
        visualModel.diagramTitle!.trim(),
        ownerBound,
        visualModel,
      ),
      index: nextIndex(),
    };
    if (titleShape) {
      if (
        usesTypeOwnedMermaidSourceGeometry(visualModel) &&
        "text" in titleShape &&
        String(titleShape.text) === visualModel.diagramTitle!.trim()
      ) {
        // The unchanged caption participates in the owner's resize. Source
        // edits can change the body extents, but must not reset caption height.
        const old = Bound.deserialize(titleShape.xywh);
        const previous = Bound.deserialize(projectionOwner.xywh);
        props.xywh =
          ownerBound.serialize() === projectionOwner.xywh
            ? titleShape.xywh
            : new Bound(
                old.x + ownerBound.x - previous.x,
                old.y + ownerBound.y - previous.y,
                Math.max(1, old.w + ownerBound.w - previous.w),
                old.h,
              ).serialize();
      }
      assignGfxProps(titleShape, props);
      nextTitleIds.push(titleShape.id);
    } else {
      const crud = ctx.std.get(EdgelessCRUDIdentifier);
      const titleId = crud.addElement("shape", props);
      if (!titleId) throw new Error("failed to add Mermaid diagram title");
      const addedTitle = projectionOwner.surface?.getElementById(
        titleId,
      ) as GfxModel | null;
      if (!addedTitle) {
        throw new Error("failed to resolve Mermaid diagram title");
      }
      assignGfxProps(addedTitle, props);
      projectionOwner.addChildren([addedTitle]);
      nextTitleIds.push(titleId);
    }
  }
  const excessTitles = titleShapes.filter(
    (shape) => shape.id !== nextTitleIds[0],
  );
  if (excessTitles.length > 0) {
    projectionOwner.removeChildren(excessTitles);
    const crud = ctx.std.get(EdgelessCRUDIdentifier);
    for (const title of [...excessTitles].reverse()) {
      crud.removeElement(title.id);
    }
  }
  const idMap = new Map<string, string>();
  const nextSubgraphIds: string[] = [];
  const usedSubgraphElementIds = new Set<string>();
  for (const subgraph of visualModel.subgraphs ?? []) {
    const shape = subgraphs.find(
      (candidate) =>
        !usedSubgraphElementIds.has(candidate.id) &&
        getGfxMeta(candidate, "mermaidSubgraphId") === subgraph.id,
    );
    const props = {
      ...toMermaidSubgraphElementProps(
        subgraph,
        elementOriginBound,
        typeOwnedMermaidSubgraphElementProjection(visualModel, subgraph),
      ),
      index: zIndexes.subgraphs.get(subgraph.id),
    };
    if (shape) {
      usedSubgraphElementIds.add(shape.id);
      idMap.set(subgraph.id, shape.id);
      assignGfxProps(shape, props);
      nextSubgraphIds.push(shape.id);
      continue;
    }
    const crud = ctx.std.get(EdgelessCRUDIdentifier);
    const shapeId = crud.addElement("shape", props);
    if (!shapeId)
      throw new Error(`failed to add Mermaid subgraph: ${subgraph.id}`);
    const addedShape = projectionOwner.surface?.getElementById(
      shapeId,
    ) as GfxModel | null;
    if (!addedShape)
      throw new Error(`failed to resolve Mermaid subgraph: ${subgraph.id}`);
    assignGfxProps(addedShape, props);
    projectionOwner.addChildren([addedShape]);
    idMap.set(subgraph.id, shapeId);
    nextSubgraphIds.push(shapeId);
  }
  const excessSubgraphs = subgraphs.filter(
    (shape) => !usedSubgraphElementIds.has(shape.id),
  );
  if (excessSubgraphs.length > 0) {
    projectionOwner.removeChildren(excessSubgraphs);
    const crud = ctx.std.get(EdgelessCRUDIdentifier);
    for (const shape of [...excessSubgraphs].reverse())
      crud.removeElement(shape.id);
  }
  const nextShapeIds: string[] = [];
  const usedShapeElementIds = new Set<string>();
  for (const node of visualModel.nodes) {
    const shape = shapes.find(
      (candidate) =>
        !usedShapeElementIds.has(candidate.id) &&
        getGfxMeta(candidate, "mermaidNodeId") === node.id,
    );
    const props = {
      ...toMermaidShapeElementProps(
        node,
        elementOriginBound,
        visualModel.direction,
        visualModel.diagramTitle,
        typeOwnedMermaidNodeElementProjection(visualModel, node),
      ),
      index: zIndexes.shapes.get(node.id),
    };
    if (shape) {
      usedShapeElementIds.add(shape.id);
      idMap.set(node.id, shape.id);
      assignGfxProps(shape, props);
      nextShapeIds.push(shape.id);
      continue;
    }
    const crud = ctx.std.get(EdgelessCRUDIdentifier);
    const shapeId = crud.addElement("shape", props);
    if (!shapeId) throw new Error(`failed to add Mermaid shape: ${node.id}`);
    const addedShape = projectionOwner.surface?.getElementById(
      shapeId,
    ) as GfxModel | null;
    if (!addedShape)
      throw new Error(`failed to resolve Mermaid shape: ${node.id}`);
    assignGfxProps(addedShape, props);
    projectionOwner.addChildren([addedShape]);
    idMap.set(node.id, shapeId);
    nextShapeIds.push(shapeId);
  }
  const excessShapes = shapes.filter(
    (shape) => !usedShapeElementIds.has(shape.id),
  );
  if (excessShapes.length > 0) {
    projectionOwner.removeChildren(excessShapes);
    const crud = ctx.std.get(EdgelessCRUDIdentifier);
    for (const shape of [...excessShapes].reverse())
      crud.removeElement(shape.id);
  }
  const detailEntries = getMermaidVisualNodeDetailElementEntries(visualModel);
  const nextDetailIds: string[] = [];
  const usedDetailElementIds = new Set<string>();
  for (const {
    detail,
    elementId,
    node,
    rowIndex,
    edge,
    projection: annotationProjection,
  } of detailEntries) {
    const projection =
      annotationProjection ??
      typeOwnedMermaidNodeDetailElementProjection(visualModel, node, detail);
    if (!projection) {
      throw new Error(
        `Mermaid ${visualModel.diagramType} does not own detail projection`,
      );
    }
    const detailShape = detailShapes.find(
      (candidate) =>
        !usedDetailElementIds.has(candidate.id) &&
        getGfxMeta(candidate, "mermaidDetailOwnerNodeId") === node.id &&
        getGfxMeta(candidate, "mermaidDetailId") === detail.id,
    );
    const props = {
      ...toMermaidNodeDetailElementProps({
        detail,
        ownerBound: elementOriginBound,
        node,
        projection,
        rowIndex,
      }),
      ...(edge ? { mermaidNodeId: "", mermaidEdgeId: edge.id } : {}),
      index: zIndexes.details.get(elementId),
    };
    if (detailShape) {
      usedDetailElementIds.add(detailShape.id);
      assignGfxProps(detailShape, props);
      nextDetailIds.push(detailShape.id);
      continue;
    }
    const crud = ctx.std.get(EdgelessCRUDIdentifier);
    const detailId = crud.addElement("shape", props);
    if (!detailId) {
      throw new Error(`failed to add Mermaid detail row: ${elementId}`);
    }
    const addedDetail = projectionOwner.surface?.getElementById(
      detailId,
    ) as GfxModel | null;
    if (!addedDetail) {
      throw new Error(`failed to resolve Mermaid detail row: ${elementId}`);
    }
    assignGfxProps(addedDetail, props);
    projectionOwner.addChildren([addedDetail]);
    nextDetailIds.push(detailId);
  }
  const excessDetails = detailShapes.filter(
    (shape) => !usedDetailElementIds.has(shape.id),
  );
  if (excessDetails.length > 0) {
    projectionOwner.removeChildren(excessDetails);
    const crud = ctx.std.get(EdgelessCRUDIdentifier);
    for (const detailShape of [...excessDetails].reverse()) {
      crud.removeElement(detailShape.id);
    }
  }
  const nextConnectorIds: string[] = [];
  const usedConnectorElementIds = new Set<string>();
  for (let index = 0; index < visualModel.edges.length; index++) {
    const edge = visualModel.edges[index];
    const elementProjection = typeOwnedMermaidEdgeElementProjection(
      visualModel,
      edge,
      index,
    );
    const connector = connectors.find(
      (candidate) =>
        !usedConnectorElementIds.has(candidate.id) &&
        getGfxMeta(candidate, "mermaidEdgeId") === edge.id,
    );
    const props = {
      ...toMermaidConnectorElementProps(
        edge,
        idMap,
        resolveMermaidConnectorLabelXYWH({
          edge,
          elementProjection,
          ownerBound: elementOriginBound,
          labelOffset: mermaidGfxEdgeLabelOffset(visualModel, edge),
          visualModel,
        }),
        elementProjection,
      ),
      index: zIndexes.connectors.get(edge.id),
    };
    if (connector) {
      usedConnectorElementIds.add(connector.id);
      if (
        props.labelXYWH &&
        connector instanceof ConnectorElementModel &&
        connector.path.length >= 2
      ) {
        // The seed box estimates an edge center only before GFX has a path.
        // Replaying it over an existing connector detaches the label whenever
        // unchanged endpoints leave the native path watcher with nothing to do.
        props.labelXYWH = connector.getLabelXYWHOnPath(
          props.labelXYWH[2],
          props.labelXYWH[3],
          props.labelOffset,
        );
      }
      assignGfxProps(connector, props);
      idMap.set(edge.id, connector.id);
      nextConnectorIds.push(connector.id);
      continue;
    }
    const crud = ctx.std.get(EdgelessCRUDIdentifier);
    const connectorId = crud.addElement("connector", props);
    if (!connectorId) {
      throw new Error(`failed to add Mermaid connector: ${edge.id}`);
    }
    const addedConnector = projectionOwner.surface?.getElementById(
      connectorId,
    ) as GfxModel | null;
    if (!addedConnector) {
      throw new Error(`failed to resolve Mermaid connector: ${edge.id}`);
    }
    assignGfxProps(addedConnector, props);
    idMap.set(edge.id, connectorId);
    projectionOwner.addChildren([addedConnector]);
    nextConnectorIds.push(connectorId);
  }
  // Identity matching, not array position, owns connector reuse. Removing the
  // trailing count difference before this loop deletes the wrong sibling when
  // a non-final edge is removed (for example the first of two Decision
  // branches). Only connectors not consumed by the complete semantic match
  // are excess.
  const excessConnectors = connectors.filter(
    (connector) => !usedConnectorElementIds.has(connector.id),
  );
  if (excessConnectors.length > 0) {
    projectionOwner.removeChildren(excessConnectors);
    const crud = ctx.std.get(EdgelessCRUDIdentifier);
    for (const connector of [...excessConnectors].reverse()) {
      crud.removeElement(connector.id);
    }
  }
  const childElementIds = Object.fromEntries(
    [
      ...nextSubgraphIds,
      ...nextConnectorIds,
      ...nextShapeIds,
      ...nextDetailIds,
      ...nextTitleIds,
    ].map((id) => [id, true]),
  );
  if (
    mermaidSemanticCollectionKey(projectionOwner.props.childElementIds) !==
    mermaidSemanticCollectionKey(childElementIds)
  ) {
    projectionOwner.store.transact(() => {
      projectionOwner.props.childElementIds = childElementIds;
    });
  }
  return true;
}
export function resolveMermaidProjectionOwnerBoundForVisualModel(
  projectionOwner: MermaidGfxProjectionGroup,
  visualModel: MermaidVisualModel,
  currentModel?: MermaidVisualModel,
  coordinateOrigin?: { x: number; y: number },
) {
  const previous = Bound.deserialize(projectionOwner.xywh);
  if (
    currentModel &&
    !coordinateOrigin &&
    projectionOwner.store.getParent(projectionOwner)?.flavour ===
      "myoxus:surface" &&
    usesTypeOwnedMermaidSourceGeometry(visualModel) &&
    mermaidVisualModelsHaveSameSourceSemantics(currentModel, visualModel) &&
    visualModel.nodes.length === currentModel.nodes.length &&
    (visualModel.subgraphs?.length ?? 0) ===
      (currentModel.subgraphs?.length ?? 0) &&
    (visualModel.subgraphs ?? []).every((group) => {
      const old = currentModel.subgraphs?.find((item) => item.id === group.id);
      return (
        old &&
        group.x === old.x &&
        group.y === old.y &&
        group.width === old.width &&
        group.height === old.height
      );
    }) &&
    visualModel.nodes.every((node) => {
      const old = currentModel.nodes.find((item) => item.id === node.id);
      return (
        old &&
        node.x === old.x &&
        node.y === old.y &&
        node.width === old.width &&
        node.height === old.height
      );
    })
  ) {
    // Identical Source and restored inner geometry already have an authoritative
    // native owner bound. Fixed padding/title bands must not shrink its scale.
    return previous;
  }
  const titleBandHeight = shouldMaterializeNativeDiagramTitle(
    projectionOwner,
    visualModel,
  )
    ? getMermaidGfxTitleBandHeight(visualModel)
    : 0;
  const previousCore = new Bound(
    previous.x,
    previous.y + titleBandHeight,
    previous.w,
    Math.max(1, previous.h - titleBandHeight),
  );
  const relativeNext = getVisualFrameBound(
    visualModel,
    new Bound(0, 0, previousCore.w, previousCore.h),
  );
  if (
    !coordinateOrigin &&
    !currentModel &&
    relativeNext.w === previous.w &&
    relativeNext.h + titleBandHeight === previous.h
  ) {
    return previous;
  }
  // A projectionOwner with negative family extents has already moved left/up around its
  // materialized children. Reusing that shifted projectionOwner as the next geometry
  // origin would apply the negative delta again on every reconciliation.
  // Mutation commands can recover the stable pre-mutation diagram origin from
  // any owner child in their current model. Generic reconciliation keeps an
  // already correctly sized projectionOwner fixed, making repeated source replay
  // idempotent without guessing from changed node coordinates.
  const anchorNode =
    currentModel?.nodes.find((node) =>
      Boolean(
        getMermaidGfxNode(projectionOwner.store, projectionOwner, node.id),
      ),
    ) ??
    currentModel?.subgraphs?.find((group) =>
      Boolean(
        getMermaidGfxSubgraph(projectionOwner.store, projectionOwner, group.id),
      ),
    );
  const anchorElement = anchorNode
    ? (getMermaidGfxNode(
        projectionOwner.store,
        projectionOwner,
        anchorNode.id,
      ) ??
      getMermaidGfxSubgraph(
        projectionOwner.store,
        projectionOwner,
        anchorNode.id,
      ))
    : null;
  const anchorBound = anchorElement
    ? Bound.deserialize(anchorElement.xywh)
    : null;
  // History supplies the snapshot's origin explicitly, including when all
  // prior members were deleted. Normal edits recover the live origin instead.
  const elementOrigin = coordinateOrigin
    ? new Bound(
        coordinateOrigin.x,
        coordinateOrigin.y,
        previousCore.w,
        previousCore.h,
      )
    : anchorNode && anchorBound
      ? getMermaidVisualElementOriginFromAnchor(
          anchorNode,
          anchorBound,
          previousCore,
        )
      : previousCore;
  const nextCore = getVisualFrameBound(visualModel, elementOrigin);
  const next = new Bound(
    nextCore.x,
    nextCore.y - titleBandHeight,
    nextCore.w,
    nextCore.h + titleBandHeight,
  );
  return next;
}
export function resizeMermaidProjectionOwnerToVisualModel(
  projectionOwner: MermaidGfxProjectionGroup,
  visualModel: MermaidVisualModel,
  currentModel?: MermaidVisualModel,
) {
  const previous = Bound.deserialize(projectionOwner.xywh);
  const next = resolveMermaidProjectionOwnerBoundForVisualModel(
    projectionOwner,
    visualModel,
    currentModel,
  );
  if (next.serialize() !== previous.serialize()) {
    projectionOwner.xywh = next.serialize();
  }
  return next;
}
export function mermaidSemanticCollectionKey(value: unknown) {
  const canonicalize = (item: unknown): unknown => {
    if (Array.isArray(item)) return item.map(canonicalize);
    if (!item || typeof item !== "object") return item;
    return Object.fromEntries(
      Object.entries(item as Record<string, unknown>)
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        .map(([key, nested]) => [key, canonicalize(nested)]),
    );
  };
  return JSON.stringify(canonicalize(value ?? []));
}
export function mermaidProjectionOwnerAppearanceMatchesTheme(
  store: Store,
  projectionOwner: MermaidGfxProjectionGroup,
  visualModel: MermaidVisualModel,
) {
  const nodes = getMermaidProjectionOwnerChildrenByRole(
    store,
    projectionOwner,
    "shape",
    MERMAID_GFX_NODE_ROLE,
  );
  const subgraphs = getMermaidProjectionOwnerChildrenByRole(
    store,
    projectionOwner,
    "shape",
    MERMAID_GFX_SUBGRAPH_ROLE,
  );
  const elements = [
    ...visualModel.nodes.map((node) =>
      nodes.find((element) => getGfxMeta(element, "mermaidNodeId") === node.id),
    ),
    ...(visualModel.subgraphs ?? []).map((subgraph) =>
      subgraphs.find(
        (element) => getGfxMeta(element, "mermaidSubgraphId") === subgraph.id,
      ),
    ),
  ];
  const connectors = getMermaidProjectionOwnerChildrenByType(
    store,
    projectionOwner,
    "connector",
  );
  return (
    elements.every((element): element is GfxModel => Boolean(element)) &&
    typeOwnedMermaidProjectionOwnerAppearanceMatchesTheme(
      visualModel,
      elements,
      connectors,
    )
  );
}
/**
 * Compares only Mermaid semantics that can require a source rewrite.
 *
 * Owner geometry and renderer-local appearance deliberately stay outside this
 * contract. Surface structure is validated separately by the projection-owner
 * matcher below, so transient GFX events cannot turn equivalent source into a
 * canonical rewrite.
 */
export function mermaidVisualModelsHaveSameSourceSemantics(
  ownerModel: MermaidVisualModel,
  sourceModel: MermaidVisualModel,
) {
  if (
    ownerModel.nodes.length !== sourceModel.nodes.length ||
    ownerModel.edges.length !== sourceModel.edges.length ||
    (ownerModel.subgraphs?.length ?? 0) !== (sourceModel.subgraphs?.length ?? 0)
  ) {
    return false;
  }
  // Surface insertion order survives edits and need not match parser traversal
  // order. Match semantic identities, not array positions (including members).
  const ownerNodes = new Map(ownerModel.nodes.map((node) => [node.id, node]));
  const ownerEdges = new Map(ownerModel.edges.map((edge) => [edge.id, edge]));
  const ownerSubgraphs = new Map(
    (ownerModel.subgraphs ?? []).map((group) => [group.id, group]),
  );
  if (
    ownerNodes.size !== ownerModel.nodes.length ||
    ownerEdges.size !== ownerModel.edges.length ||
    ownerSubgraphs.size !== (ownerModel.subgraphs?.length ?? 0)
  )
    return false;
  const c4Presentation =
    ownerModel.diagramType === "c4" && sourceModel.diagramType === "c4";
  const sourceDerivedPresentation =
    usesTypeOwnedMermaidSourceGeometry(ownerModel) &&
    usesTypeOwnedMermaidSourceGeometry(sourceModel);
  const nodesMatch = sourceModel.nodes.every((node) => {
    const ownerNode = ownerNodes.get(node.id);
    return (
      ownerNode?.id === node.id &&
      ownerNode.label === node.label &&
      // Wrapping is renderer layout for Source-derived carriers. Font hydration
      // may change it without changing the authored label or its occurrence.
      (sourceDerivedPresentation ||
        (ownerNode.displayLabel ?? ownerNode.label) ===
          (node.displayLabel ?? node.label)) &&
      // Detail order belongs to each record. Renderer traversal interleaves
      // header, separator and field compartments that share order values;
      // that array order must not turn a native move into a Source mutation.
      mermaidSemanticCollectionKey(
        [...(ownerNode.details ?? [])].sort((a, b) =>
          a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
        ),
      ) ===
        mermaidSemanticCollectionKey(
          [...(node.details ?? [])].sort((a, b) =>
            a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
          ),
        ) &&
      mermaidSemanticCollectionKey(ownerNode.familyData) ===
        mermaidSemanticCollectionKey(node.familyData) &&
      ownerNode.shape === node.shape
    );
  });
  const edgesMatch = sourceModel.edges.every((edge) => {
    const ownerEdge = ownerEdges.get(edge.id);
    // Port identity and relative endpoint positions are owner geometry.
    // Mermaid source cannot encode the positions, so comparing them here would
    // replace a chosen port with the parser's inferred default on the next
    // ensure pass. Attachments remain semantic endpoint ownership.
    return (
      ownerEdge?.id === edge.id &&
      ownerEdge.source === edge.source &&
      (c4Presentation ||
        ownerEdge.sourceAttachment === edge.sourceAttachment) &&
      ownerEdge.target === edge.target &&
      (c4Presentation ||
        ownerEdge.targetAttachment === edge.targetAttachment) &&
      ownerEdge.label === edge.label &&
      (sourceDerivedPresentation ||
        (ownerEdge.displayLabel ?? ownerEdge.label) ===
          (edge.displayLabel ?? edge.label)) &&
      mermaidSemanticCollectionKey(ownerEdge.familyData) ===
        mermaidSemanticCollectionKey(edge.familyData) &&
      (ownerEdge.labelPlacement ?? "center") ===
        (edge.labelPlacement ?? "center") &&
      (ownerEdge.connectorMode ?? "orthogonal") ===
        (edge.connectorMode ?? "orthogonal") &&
      (ownerEdge.linkType ?? "arrow") === (edge.linkType ?? "arrow") &&
      ownerEdge.mermaidId === edge.mermaidId &&
      ownerEdge.style === edge.style
    );
  });
  const subgraphsMatch = (sourceModel.subgraphs ?? []).every((subgraph) => {
    const ownerSubgraph = ownerSubgraphs.get(subgraph.id);
    return (
      ownerSubgraph?.id === subgraph.id &&
      mermaidSemanticCollectionKey(
        c4SourceSemanticFamilyData(ownerSubgraph.familyData),
      ) ===
        mermaidSemanticCollectionKey(
          c4SourceSemanticFamilyData(subgraph.familyData),
        ) &&
      ownerSubgraph.title === subgraph.title &&
      mermaidSemanticCollectionKey([...ownerSubgraph.nodeIds].sort()) ===
        mermaidSemanticCollectionKey([...subgraph.nodeIds].sort()) &&
      ownerSubgraph.parentId === subgraph.parentId &&
      ownerSubgraph.direction === subgraph.direction
    );
  });
  return (
    ownerModel.diagramType === sourceModel.diagramType &&
    ownerModel.accessibilityDescription ===
      sourceModel.accessibilityDescription &&
    ownerModel.accessibilityTitle === sourceModel.accessibilityTitle &&
    (ownerModel.diagramTitle ?? "") === (sourceModel.diagramTitle ?? "") &&
    ownerModel.direction === sourceModel.direction &&
    mermaidSemanticCollectionKey(ownerModel.styleStatements) ===
      mermaidSemanticCollectionKey(sourceModel.styleStatements) &&
    nodesMatch &&
    edgesMatch &&
    subgraphsMatch
  );
}
export function mermaidProjectionOwnerMatchesVisualModel(
  store: Store,
  projectionOwner: MermaidGfxProjectionGroup,
  visualModel: MermaidVisualModel,
) {
  const expectedTitleCount = shouldMaterializeNativeDiagramTitle(
    projectionOwner,
    visualModel,
  )
    ? 1
    : 0;
  if (
    projectionOwner.childIds.length !==
      visualModel.nodes.length +
        visualModel.edges.length +
        getMermaidVisualNodeDetailElementCount(visualModel) +
        (visualModel.subgraphs?.length ?? 0) +
        expectedTitleCount ||
    getMermaidProjectionOwnerChildrenByRole(
      store,
      projectionOwner,
      "shape",
      MERMAID_GFX_NODE_ROLE,
    ).length !== visualModel.nodes.length ||
    getMermaidProjectionOwnerChildrenByRole(
      store,
      projectionOwner,
      "shape",
      MERMAID_GFX_DETAIL_ROLE,
    ).length !== getMermaidVisualNodeDetailElementCount(visualModel) ||
    getMermaidProjectionOwnerChildrenByType(store, projectionOwner, "connector")
      .length !== visualModel.edges.length ||
    getMermaidProjectionOwnerChildrenByRole(
      store,
      projectionOwner,
      "shape",
      MERMAID_GFX_SUBGRAPH_ROLE,
    ).length !== (visualModel.subgraphs?.length ?? 0) ||
    getMermaidProjectionOwnerChildrenByRole(
      store,
      projectionOwner,
      "shape",
      MERMAID_GFX_TITLE_ROLE,
    ).length !== expectedTitleCount
  ) {
    return false;
  }
  if (expectedTitleCount === 1) {
    const ownerBound = Bound.deserialize(projectionOwner.xywh);
    const semanticShapes = [
      ...getMermaidProjectionOwnerChildrenByRole(
        store,
        projectionOwner,
        "shape",
        MERMAID_GFX_NODE_ROLE,
      ),
      ...getMermaidProjectionOwnerChildrenByRole(
        store,
        projectionOwner,
        "shape",
        MERMAID_GFX_SUBGRAPH_ROLE,
      ),
      ...getMermaidProjectionOwnerChildrenByRole(
        store,
        projectionOwner,
        "shape",
        MERMAID_GFX_DETAIL_ROLE,
      ),
    ];
    if (
      semanticShapes.some(
        (shape) =>
          Bound.deserialize(shape.xywh).y <
          ownerBound.y + getMermaidGfxTitleBandHeight(visualModel),
      )
    ) {
      return false;
    }
  }
  const ownerModel = readMermaidVisualModelFromProjectionGroup(
    store,
    projectionOwner,
    visualModel,
  );
  if (!ownerModel) {
    return false;
  }

  return (
    mermaidVisualModelsHaveSameSourceSemantics(ownerModel, visualModel) &&
    (!usesTypeOwnedMermaidSourceGeometry(visualModel) ||
      visualModel.nodes.every((node) => {
        const old = ownerModel.nodes.find((item) => item.id === node.id);
        return (old?.rotate ?? 0) === (node.rotate ?? 0);
      })) &&
    mermaidProjectionOwnerAppearanceMatchesTheme(
      store,
      projectionOwner,
      visualModel,
    )
  );
}
export function reconcileMermaidProjectionOwnerWithVisualModel(
  ctx: Parameters<Command>[0],
  projectionOwner: MermaidGfxProjectionGroup,
  visualModel: MermaidVisualModel,
  ownerAnchorModel: MermaidVisualModel = visualModel,
  coordinateOrigin?: { x: number; y: number },
) {
  // The anchor model must describe the coordinates currently materialized in
  // the projection owner. Page pointer previews intentionally move only their
  // scoped projection, so the requested model can already contain the drop
  // geometry while the projection owner still contains the pre-gesture geometry.
  // Using the requested model as that anchor would shift the projectionOwner origin by
  // the dragged node's delta and move every other node during pointerup.
  // Resolve the next owner bound before moving children, but commit it only
  // after every child has reached its target geometry. Shrinking or moving a
  // GFX group around stale children makes the group immediately re-enclose
  // those old bounds; the following readback then treats that transient union
  // as user geometry and repeated layout grows the owner and its subgraphs.
  const ownerBound = resolveMermaidProjectionOwnerBoundForVisualModel(
    projectionOwner,
    visualModel,
    ownerAnchorModel,
    coordinateOrigin,
  );
  const updatedInPlace = updateMermaidElementsInPlaceIfCompatible({
    ctx,
    projectionOwner,
    ownerBound,
    visualModel,
  });
  if (!updatedInPlace) {
    removeMermaidProjectionOwnerChildren(ctx, projectionOwner);
    const crud = ctx.std.get(EdgelessCRUDIdentifier);
    materializeMermaidElements({
      addElement: (type, props) => crud.addElement(type, props),
      projectionOwner,
      ownerBound,
      nextIndex: createMermaidProjectionOwnerIndexGenerator(ctx),
      visualModel,
    });
  }
  const renderedBound = encloseRenderedMermaidConnectors(
    projectionOwner,
    visualModel,
    ownerBound,
  );
  if (projectionOwner.xywh !== renderedBound.serialize()) {
    projectionOwner.xywh = renderedBound.serialize();
  }
}
export function preserveMermaidProjectionOwnerGeometry(
  store: Store,
  projectionOwner: MermaidGfxProjectionGroup,
  visualModel: MermaidVisualModel,
) {
  const ownerModel = readMermaidVisualModelFromProjectionGroup(
    store,
    projectionOwner,
    visualModel,
  );
  if (!ownerModel) return visualModel;
  const next = cloneVisualModel(
    reconcileTypeOwnedMermaidVisualProjection(visualModel, ownerModel, true) ??
      visualModel,
  );
  if (usesTypeOwnedMermaidSourceGeometry(next)) {
    if (
      typeof next.familyData?.payload.sourceHash === "string" &&
      mermaidSemanticCollectionKey(next.familyData) ===
        mermaidSemanticCollectionKey(ownerModel.familyData) &&
      mermaidVisualModelsHaveSameSourceSemantics(ownerModel, next)
    ) {
      // The same Source/projection state may have a whole-owner transform.
      // Reuse its display geometry, including bands, without allowing former
      // inner XY to override a changed Source or layout state.
      for (const node of next.nodes) {
        const old = ownerModel.nodes.find((item) => item.id === node.id)!;
        Object.assign(node, {
          x: old.x,
          y: old.y,
          width: old.width,
          height: old.height,
        });
      }
      for (const group of next.subgraphs ?? []) {
        const old = ownerModel.subgraphs!.find((item) => item.id === group.id)!;
        Object.assign(group, {
          x: old.x,
          y: old.y,
          width: old.width,
          height: old.height,
        });
      }
    }
    // Reuse semantic identities, not obsolete inner XY from a former Source.
    // Otherwise one retained participant/lifeline makes a temporal row diagonal.
    return finalizeTypeOwnedMermaidProjectionOwnerGeometry(
      syncMermaidVisualSubgraphMembership(
        reconcileTypeOwnedMermaidProjectionOwnerGeometry(next, visualModel),
      ),
    );
  }
  const directionChanged = ownerModel.direction !== visualModel.direction;
  const frameNodesById = new Map(
    ownerModel.nodes.map((node) => [node.id, node]),
  );
  for (const node of next.nodes) {
    const existing = frameNodesById.get(node.id);
    if (!existing) continue;
    // Source replay must update semantic Mermaid state, but existing native
    // Edgeless geometry is user-authored state and must survive connector or
    // label undo/redo. Only an actual semantic Source change may request the
    // family reconciliation below; remounting an unchanged Source must never
    // reinterpret persisted user geometry.
    if (!directionChanged) {
      node.x = existing.x;
      node.y = existing.y;
    }
    const dimensions = preserveTypeOwnedMermaidManagedNodeDimensions(
      next,
      node,
      existing,
    );
    node.width = dimensions?.width ?? existing.width;
    node.height = dimensions?.height ?? existing.height;
  }
  const frameSubgraphsById = new Map(
    (ownerModel.subgraphs ?? []).map((subgraph) => [subgraph.id, subgraph]),
  );
  for (const subgraph of next.subgraphs ?? []) {
    const existing = frameSubgraphsById.get(subgraph.id);
    if (!existing) continue;
    if (!directionChanged) {
      subgraph.x = existing.x;
      subgraph.y = existing.y;
      const dimensions = preserveTypeOwnedMermaidManagedSubgraphDimensions(
        next,
        subgraph,
        existing,
      );
      subgraph.width = dimensions?.width ?? existing.width;
      subgraph.height = dimensions?.height ?? existing.height;
    }
  }
  const reconciled = mermaidVisualModelsHaveSameSourceSemantics(
    ownerModel,
    visualModel,
  )
    ? next
    : reconcileTypeOwnedMermaidProjectionOwnerGeometry(next, visualModel);
  const synchronized = syncMermaidVisualSubgraphMembership(reconciled);
  return finalizeTypeOwnedMermaidProjectionOwnerGeometry(synchronized);
}
export type MermaidOwnedElementSnapshot = Record<string, unknown> & {
  id: string;
  index?: string;
  labelXYWH?: readonly number[];
  source?: { id?: string; position?: unknown };
  target?: { id?: string; position?: unknown };
  type: string;
  xywh?: string;
};

export type MermaidOwnerDuplicatePlan = {
  readonly snapshots: readonly MermaidOwnedElementSnapshot[];
};

export function createMermaidOwnerDuplicatePlan(
  owner: MermaidGfxProjectionGroup,
): MermaidOwnerDuplicatePlan | null {
  const snapshots: MermaidOwnedElementSnapshot[] = [];
  for (const id of owner.childIds) {
    const model = getMermaidProjectionChildModel(owner.store, owner, id) as
      (GfxModel & { serialize?: () => unknown }) | null;
    const type = (model as { type?: string } | null)?.type;
    if (
      !model ||
      (type !== "shape" && type !== "connector") ||
      !readMermaidGfxMeta(model, "mermaidRole") ||
      typeof model.serialize !== "function"
    ) {
      return null;
    }
    const serialized = structuredClone(model.serialize());
    if (!serialized || typeof serialized !== "object") return null;
    snapshots.push(serialized as MermaidOwnedElementSnapshot);
  }
  return { snapshots };
}

function offsetMermaidDuplicateXYWH(
  xywh: string | undefined,
  dx: number,
  dy: number,
) {
  if (!xywh) return xywh;
  const bound = Bound.deserialize(xywh);
  return new Bound(bound.x + dx, bound.y + dy, bound.w, bound.h).serialize();
}

function offsetMermaidDuplicateLabelXYWH(
  xywh: readonly number[] | undefined,
  dx: number,
  dy: number,
) {
  if (!xywh || xywh.length !== 4) return xywh;
  return [xywh[0] + dx, xywh[1] + dy, xywh[2], xywh[3]];
}

export function duplicateMermaidOwnerChildren({
  ctx,
  dx,
  dy,
  plan,
  targetOwner,
}: {
  ctx: Pick<Parameters<Command>[0], "std">;
  dx: number;
  dy: number;
  plan: MermaidOwnerDuplicatePlan;
  targetOwner: MermaidBlockModel;
}) {
  const crud = ctx.std.get(EdgelessCRUDIdentifier);
  const nextIndex = createMermaidProjectionOwnerIndexGenerator(ctx);
  const idMap = new Map<string, string>();
  const elementIds: string[] = [];
  const connectorIds: string[] = [];
  const shapeIds: string[] = [];
  const indexBySourceId = new Map(
    plan.snapshots.map(({ id }) => [id, nextIndex()] as const),
  );
  const ordered = [
    ...plan.snapshots.filter(({ type }) => type !== "connector"),
    ...plan.snapshots.filter(({ type }) => type === "connector"),
  ];

  try {
    for (const snapshot of ordered) {
      const cloned = structuredClone(snapshot);
      const sourceId = cloned.source?.id;
      const targetId = cloned.target?.id;
      const { id: _id, type: _type, ...props } = cloned;
      props.index = indexBySourceId.get(snapshot.id);
      const xywh = offsetMermaidDuplicateXYWH(props.xywh, dx, dy);
      if (xywh) props.xywh = xywh;
      const labelXYWH = offsetMermaidDuplicateLabelXYWH(
        props.labelXYWH,
        dx,
        dy,
      );
      if (labelXYWH) props.labelXYWH = labelXYWH;

      if (snapshot.type === "connector") {
        const mappedSourceId = sourceId ? idMap.get(sourceId) : null;
        const mappedTargetId = targetId ? idMap.get(targetId) : null;
        if (!mappedSourceId || !mappedTargetId) {
          throw new Error(`Mermaid connector endpoint missing: ${snapshot.id}`);
        }
        props.source = { ...props.source, id: mappedSourceId };
        props.target = { ...props.target, id: mappedTargetId };
      }

      const id = crud.addElement(snapshot.type, props);
      if (!id) throw new Error(`failed to duplicate Mermaid ${snapshot.type}`);
      elementIds.push(id);
      const element = targetOwner.surface?.getElementById(id);
      if (!element) throw new Error("failed to resolve copied Mermaid child");
      // Surface creation accepts schema fields only. Replay the existing
      // Mermaid namespace before owner adoption, as native clipboard does.
      assignGfxProps(
        element,
        Object.fromEntries(
          Object.entries(props).filter(([key]) => key.startsWith("mermaid")),
        ),
      );
      idMap.set(snapshot.id, id);
      if (snapshot.type === "connector") connectorIds.push(id);
      else shapeIds.push(id);
    }

    const children = plan.snapshots
      .map(({ id }) => idMap.get(id))
      .filter((id): id is string => Boolean(id))
      .map((id) => targetOwner.surface?.getElementById(id))
      .filter(Boolean) as GfxModel[];
    if (children.length !== elementIds.length) {
      throw new Error("failed to resolve duplicated Mermaid children");
    }
    // Duplication owns these fresh elements just like insertion. Surface
    // watchers can temporarily claim them while their metadata is replayed.
    for (const child of children) {
      addMermaidProjectionOwnerChild(targetOwner, child);
    }
    if (children.some((child) => !targetOwner.hasChild(child))) {
      throw new Error("duplicated Mermaid child was rejected by its owner");
    }
    return { connectorIds, elementIds, shapeIds };
  } catch (error) {
    for (const id of [...elementIds].reverse()) crud.removeElement(id);
    throw error;
  }
}

export function cleanupPartialMermaidOwner(
  ctx: Pick<Parameters<Command>[0], "std">,
  {
    elementIds,
    noteId,
    ownerId,
  }: {
    elementIds: readonly string[];
    noteId?: string | null;
    ownerId?: string | null;
  },
) {
  const crud = ctx.std.get(EdgelessCRUDIdentifier);
  for (const id of [...elementIds].reverse()) crud.removeElement(id);
  const owner = ownerId ? ctx.std.store.getBlock(ownerId)?.model : null;
  if (owner) ctx.std.store.deleteBlock(owner);
  const note = noteId ? ctx.std.store.getBlock(noteId)?.model : null;
  if (note && note.children.length === 0) ctx.std.store.deleteBlock(note);
}
export function updateMermaidBlockVisualProps(
  block: MermaidBlockModel,
  source: string,
  visualModel: MermaidVisualModel | null,
) {
  const diagramType =
    visualModel?.diagramType ??
    parseMermaidSourceToGfxVisualModel(source).diagramType;
  const sourceHash = hashMermaidSource(source);
  const familyData = serializeMermaidVisualFamilyData(visualModel?.familyData);
  if (visualModel && block.props.familyData !== familyData)
    block.props.familyData = familyData;
  if (block.props.diagramType !== diagramType) {
    block.props.diagramType = diagramType;
  }
  if (block.props.sourceHash !== sourceHash) {
    block.props.sourceHash = sourceHash;
  }
}
export function syncSourceFromVisualModel(
  block: MermaidBlockModel,
  visualModel: MermaidVisualModel,
) {
  const sourceOwnedVisualModel = cloneVisualModel(visualModel);
  sourceOwnedVisualModel.diagramTitle = resolveMermaidEffectiveBlockTitle(
    block.props,
  );
  // Generator-owned families use canonical Source; minimal writers keep exact
  // bytes for owner state and history through the runtime policy below.
  const checked = applyMermaidGfxVisualToSource(
    getMermaidBlockSource(block.props),
    sourceOwnedVisualModel,
  );
  const source = mermaidGfxCommittedSource(
    checked.source,
    sourceOwnedVisualModel,
  );
  const state = writeMermaidSourceModelState(block, source, {
    preserveSourceBytes: mermaidGfxPreservesSourceBytes(visualModel),
  });
  updateMermaidBlockVisualProps(
    block,
    state.source,
    checked.visualModel ?? sourceOwnedVisualModel,
  );
}
export function syncSourceFromProjectionOwner(
  ctx: Parameters<Command>[0] & {
    model: MermaidBlockModel;
  },
  projectionOwner: MermaidGfxProjectionGroup,
  expectedVisualModel?: MermaidVisualModel,
) {
  const expected = expectedVisualModel ?? getMermaidVisualModel(ctx.model);
  restoreExpectedMermaidProjectionOwnerChildren(projectionOwner, expected);
  const visualModel = readMermaidVisualModelFromProjectionGroup(
    ctx.std.store,
    projectionOwner,
    expected,
    ctx.model.props.diagramType,
  );
  if (!visualModel) {
    // Missing children mean the persisted projection is not ready, not that
    // its geometry is invalid. A source parse cannot supply a rollback anchor
    // here; the next complete owner update will retry the normal readback.
    return null;
  }
  visualModel.diagramTitle = resolveMermaidEffectiveBlockTitle(ctx.model.props);
  let source: string;
  let reparsed: ReturnType<typeof parseMermaidSourceToGfxVisualModel>;
  let committedVisualModel: MermaidVisualModel;
  try {
    const checked = applyMermaidGfxVisualToSource(
      getMermaidBlockSource(ctx.model.props),
      visualModel,
    );
    source = mermaidGfxCommittedSource(checked.source, visualModel);
    const checkedVisualModel = checked.visualModel ?? visualModel;
    checkedVisualModel.diagramTitle = visualModel.diagramTitle;
    reparsed = parseMermaidSourceToGfxVisualModel(source);
    if (!reparsed.model || reparsed.diagramType !== visualModel.diagramType) {
      throw new Error("Mermaid visual source did not reparse.");
    }
    committedVisualModel =
      canonicalizeTypeOwnedMermaidVisualProjectionAfterSourceWrite(
        reparsed.model,
        checkedVisualModel,
        source,
      );
  } catch {
    if (expected)
      reconcileMermaidProjectionOwnerWithVisualModel(
        ctx,
        projectionOwner,
        expected,
      );
    return null;
  }
  if (
    createMermaidGfxModelHash(committedVisualModel) !==
      createMermaidGfxModelHash(visualModel) ||
    resolveMermaidProjectionOwnerBoundForVisualModel(
      projectionOwner,
      committedVisualModel,
      visualModel,
    ).serialize() !== projectionOwner.xywh
  ) {
    // Native drags already write child geometry. Refit a changed owner bound
    // (including its title) from that live anchor, without relaying out nodes.
    reconcileMermaidProjectionOwnerWithVisualModel(
      ctx,
      projectionOwner,
      committedVisualModel,
      visualModel,
    );
  }
  // Commit the already checked Source once; its identity bindings describe
  // this result, so rerunning the writer against the old Source is unsafe.
  const state = writeMermaidSourceModelState(ctx.model, source, {
    preserveSourceBytes: mermaidGfxPreservesSourceBytes(committedVisualModel),
  });
  updateMermaidBlockVisualProps(ctx.model, state.source, committedVisualModel);
  return committedVisualModel;
}
export function materializeMermaidVisualModelWithStd(
  ctx: Pick<Parameters<Command>[0], "std">,
  source: string,
  visualModel: MermaidVisualModel,
  projection: MermaidGfxProjectionOwner,
  position?: { x: number; y: number },
): MermaidMaterializationResult | null {
  const preparedVisualModel = prepareMermaidGfxVisualTransfer(
    source,
    visualModel,
  );
  if (!preparedVisualModel) return null;
  visualModel = preparedVisualModel;
  const parent = ctx.std.store.getParent(projection.model);
  if (
    parent?.flavour === "myoxus:surface" &&
    isMermaidBlockModel(projection.model)
  ) {
    // Frontmatter titles are block identity. Family parsers intentionally own
    // only their native body syntax, so the freshly parsed transfer model may
    // not carry that title until a later ensure pass. Native materialization
    // must project the owner title immediately in the same insertion history
    // transaction instead of relying on mount reconciliation to add it later.
    visualModel.diagramTitle = resolveMermaidEffectiveBlockTitle(
      projection.model.props,
    );
  }
  const coreOwnerBound =
    parent?.flavour === "myoxus:surface"
      ? findMermaidProjectionInsertBound(ctx, visualModel, projection.model.id)
      : getVisualFrameBound(visualModel, new Bound(0, 0, 420, 260));
  if (position && parent?.flavour === "myoxus:surface") {
    coreOwnerBound.x = position.x;
    coreOwnerBound.y = position.y;
  }
  const titleBandHeight = shouldMaterializeNativeDiagramTitle(
    projection.model,
    visualModel,
  )
    ? getMermaidGfxTitleBandHeight(visualModel)
    : 0;
  const ownerBound = new Bound(
    coreOwnerBound.x,
    coreOwnerBound.y,
    coreOwnerBound.w,
    coreOwnerBound.h + titleBandHeight,
  );
  const projectionOwner = projection.model;
  if (projectionOwner.xywh !== ownerBound.serialize()) {
    projectionOwner.xywh = ownerBound.serialize();
  }
  const crud = ctx.std.get(EdgelessCRUDIdentifier);
  let added: ReturnType<typeof materializeMermaidElements>;
  const createdElementIds: string[] = [];
  try {
    added = materializeMermaidElements({
      addElement: (type, props) => {
        const id = crud.addElement(type, props);
        if (id) createdElementIds.push(id);
        return id;
      },
      projectionOwner,
      ownerBound,
      nextIndex: createMermaidProjectionOwnerIndexGenerator(ctx),
      visualModel,
    });
  } catch (error) {
    const crud = ctx.std.get(EdgelessCRUDIdentifier);
    for (const elementId of [...createdElementIds].reverse()) {
      crud.removeElement(elementId);
    }
    console.error(
      `[mermaid:block] materialization rolled back: projectionOwner=${projectionOwner.id}, reason=${error instanceof Error ? error.message : String(error)}`,
      error,
    );
    return null;
  }
  const renderedBound = encloseRenderedMermaidConnectors(
    projectionOwner,
    visualModel,
    ownerBound,
  );
  if (projectionOwner.xywh !== renderedBound.serialize())
    projectionOwner.xywh = renderedBound.serialize();
  // Persist the bindings of the transferred children in the insertion transaction.
  // Re-parsing without them assigns new occurrence IDs and disconnects controls.
  updateMermaidBlockVisualProps(projection.model, source, visualModel);
  return {
    ...added,
    projectionOwner,
    ownerId: projectionOwner.id,
    sourceHash: hashMermaidSource(source),
    visualModel,
    visualModelHash: createMermaidGfxModelHash(visualModel),
  };
}

function findMermaidProjectionInsertBound(
  ctx: Pick<Parameters<Command>[0], "std">,
  visualModel: MermaidVisualModel,
  excludedOwnerId?: string,
) {
  const gfx = ctx.std.get(GfxControllerIdentifier);
  const noteCollisionBoxes = getNoteCollisionBoxes(ctx.std.store);
  return findMermaidInsertBound(visualModel, (bound) => {
    const gridCollisions = gfx.grid
      .search(bound)
      .filter((collision) => collision.id !== excludedOwnerId)
      .map((collision) => ({
        w: collision.w,
        x: collision.x,
      }));
    return gridCollisions.concat(
      noteCollisionBoxes
        .filter((noteBound) => noteBound.isIntersectWithBound(bound))
        .map((noteBound) => ({
          w: noteBound.w,
          x: noteBound.x,
        })),
    );
  });
}
