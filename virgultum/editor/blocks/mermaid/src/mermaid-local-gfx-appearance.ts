// SPDX-License-Identifier: AGPL-3.0-or-later

import { Bound } from "@virgultum/global/gfx";
import * as Y from "yjs";
import { getMermaidGfxFamilyHooks } from "./families/runtime/gfx-family-hooks-registry.js";

import {
  getMermaidVisualNodeDetailElementEntries,
  resolveMermaidConnectorLabelXYWH,
  toMermaidConnectorElementProps,
  toMermaidDiagramTitleElementProps,
  toMermaidNodeDetailElementProps,
  toMermaidShapeElementProps,
  toMermaidSubgraphElementProps,
} from "./families/runtime/gfx-element-projection.js";
import {
  MERMAID_GFX_DETAIL_ROLE,
  MERMAID_GFX_EDGE_ROLE,
  MERMAID_GFX_NODE_ROLE,
  MERMAID_GFX_SUBGRAPH_ROLE,
  MERMAID_GFX_TITLE_ROLE,
} from "./families/runtime/gfx-element-roles.js";
import type { MermaidVisualModel } from "./families/runtime/gfx-model.js";
import {
  typeOwnedMermaidEdgeElementProjection,
  typeOwnedMermaidNodeDetailElementProjection,
  typeOwnedMermaidNodeElementProjection,
  typeOwnedMermaidSubgraphElementProjection,
} from "./families/runtime/gfx-owner-hooks.js";
import {
  readMermaidGfxEdgeId,
  readMermaidGfxMeta,
  readMermaidGfxNodeId,
  readMermaidGfxRole,
  readMermaidGfxSubgraphId,
} from "./mermaid-gfx-metadata.js";

type LocalAppearanceElement = Record<string, unknown> & {
  id: string;
  stash?: (prop: string) => void;
  xywh?: string;
  path?: readonly unknown[];
  getLabelXYWHOnPath?: (
    width: number,
    height: number,
    offset: unknown,
  ) => readonly number[];
};

const SHAPE_APPEARANCE_KEYS = [
  "color",
  "fillColor",
  "filled",
  "fontFamily",
  "fontSize",
  "fontStyle",
  "fontWeight",
  "padding",
  "shadow",
  "labelProjection",
  "radius",
  "roughness",
  "shapeStyle",
  "shapeType",
  "strokeColor",
  "strokeStyle",
  "strokeWidth",
  "textAlign",
  "textDisplay",
  "textVerticalAlign",
] as const;

const CONNECTOR_APPEARANCE_KEYS = [
  "endpointScale",
  "frontEndpointStyle",
  "frontEndpointCircle",
  "rearEndpointCircle",
  "labelConstraints",
  "labelDisplay",
  "labelOffset",
  "labelObstacleIds",
  "labelXYWH",
  "labelStyle",
  "mode",
  "rearEndpointStyle",
  "rough",
  "roughness",
  "routingObstacleIds",
  "routingObstacleRegions",
  "routingClearance",
  "routingCornerRadius",
  "routingLaneOffset",
  "rotate",
  "stroke",
  "strokeStyle",
  "strokeWidth",
] as const;

function appearanceValuesEqual(left: unknown, right: unknown) {
  if (Object.is(left, right)) return true;
  if (
    (Array.isArray(left) && Array.isArray(right)) ||
    (left && right && typeof left === "object" && typeof right === "object")
  ) {
    return JSON.stringify(left) === JSON.stringify(right);
  }
  return false;
}

const localContentTexts = new WeakMap<LocalAppearanceElement, Y.Text>();

function applyLocalAppearance(
  element: LocalAppearanceElement,
  expected: Record<string, unknown>,
  keys: readonly string[],
) {
  if (!element.stash) return;
  for (const key of keys) {
    if (!(key in expected)) continue;
    element.stash(key);
    if (key === "text" && typeof expected[key] === "string") {
      if (element[key]?.toString() !== expected[key]) {
        let text = localContentTexts.get(element);
        if (!text) {
          // Y.Text reads require an integrated document. This detached renderer
          // document never joins the workspace or its history/synchronization.
          text = new Y.Doc().getText("content");
          localContentTexts.set(element, text);
        }
        text.delete(0, text.length);
        text.insert(0, expected[key]);
        element[key] = text;
      }
    } else if (!appearanceValuesEqual(element[key], expected[key])) {
      element[key] = expected[key];
    }
  }
}

/**
 * Projects renderer-only Mermaid appearance into the current GFX wrappers.
 *
 * Semantic source and genuine user geometry remain collaborative. Theme and
 * typography are client-local render projections: persisting them as Yjs
 * authority lets clients with different themes or renderer generations keep
 * overwriting each other even while the document is idle.
 */
export function projectMermaidLocalGfxAppearance({
  changedElementId,
  elements,
  frameXYWH,
  visualModel,
}: {
  changedElementId?: string;
  elements: readonly unknown[];
  frameXYWH: string;
  visualModel: MermaidVisualModel;
}) {
  const ownerBound = Bound.deserialize(frameXYWH);
  const detailGeometryFollowsBody =
    getMermaidGfxFamilyHooks(visualModel)?.nodeDetailGeometryFollowsBody;
  const gfxElements = elements as LocalAppearanceElement[];
  const nodeBounds = new Map(
    gfxElements.flatMap((element) => {
      if (readMermaidGfxRole(element) !== MERMAID_GFX_NODE_ROLE) return [];
      const id = readMermaidGfxNodeId(element);
      return id && element.xywh
        ? ([[id, Bound.deserialize(element.xywh)]] as const)
        : [];
    }),
  );
  const subgraphBounds = new Map(
    gfxElements.flatMap((element) => {
      if (readMermaidGfxRole(element) !== MERMAID_GFX_SUBGRAPH_ROLE) return [];
      const id = readMermaidGfxSubgraphId(element);
      return id && element.xywh
        ? ([[id, Bound.deserialize(element.xywh)]] as const)
        : [];
    }),
  );
  // The source owns appearance semantics, while the live owner owns user
  // geometry. Font fitting needs the latter without reading any persisted
  // renderer typography back as authority.
  const projectionModel: MermaidVisualModel = {
    ...visualModel,
    nodes: visualModel.nodes.map((node) => {
      const bound = nodeBounds.get(node.id);
      return bound
        ? {
            ...node,
            height: bound.h,
            width: bound.w,
            ...(detailGeometryFollowsBody
              ? { x: bound.x - ownerBound.x, y: bound.y - ownerBound.y }
              : {}),
          }
        : node;
    }),
    subgraphs: (visualModel.subgraphs ?? []).map((subgraph) => {
      const bound = subgraphBounds.get(subgraph.id);
      return bound
        ? { ...subgraph, height: bound.h, width: bound.w }
        : subgraph;
    }),
  };
  const idMap = new Map<string, string>();
  for (const element of gfxElements) {
    // Details share their semantic owner's node ID, but are neither endpoint
    // cards nor routing obstacles. They must not replace the owner's bounds.
    const role = readMermaidGfxRole(element);
    if (role === MERMAID_GFX_EDGE_ROLE) {
      const edgeId = readMermaidGfxEdgeId(element);
      if (edgeId) idMap.set(edgeId, element.id);
      continue;
    }
    if (role !== MERMAID_GFX_NODE_ROLE && role !== MERMAID_GFX_SUBGRAPH_ROLE)
      continue;
    const endpointId =
      readMermaidGfxNodeId(element) || readMermaidGfxSubgraphId(element);
    if (endpointId) idMap.set(endpointId, element.id);
  }

  const nodes = new Map(projectionModel.nodes.map((node) => [node.id, node]));
  const subgraphs = new Map(
    (projectionModel.subgraphs ?? []).map((subgraph) => [
      subgraph.id,
      subgraph,
    ]),
  );
  const edges = new Map(
    projectionModel.edges.map((edge, index) => [edge.id, { edge, index }]),
  );
  const details = new Map(
    getMermaidVisualNodeDetailElementEntries(projectionModel).map((entry) => [
      `${entry.node.id}:${entry.detail.id}`,
      entry,
    ]),
  );

  for (const element of gfxElements) {
    if (changedElementId && element.id !== changedElementId) continue;
    const role = readMermaidGfxRole(element);
    if (role === MERMAID_GFX_TITLE_ROLE) {
      if (!projectionModel.diagramTitle) continue;
      applyLocalAppearance(
        element,
        toMermaidDiagramTitleElementProps(
          projectionModel.diagramTitle,
          ownerBound,
          projectionModel,
        ),
        SHAPE_APPEARANCE_KEYS,
      );
      continue;
    }
    if (role === MERMAID_GFX_NODE_ROLE) {
      const node = nodes.get(readMermaidGfxNodeId(element));
      if (!node) continue;
      applyLocalAppearance(
        element,
        toMermaidShapeElementProps(
          node,
          ownerBound,
          projectionModel.direction,
          projectionModel.diagramTitle,
          typeOwnedMermaidNodeElementProjection(projectionModel, node),
        ),
        SHAPE_APPEARANCE_KEYS,
      );
      continue;
    }
    if (role === MERMAID_GFX_SUBGRAPH_ROLE) {
      const subgraph = subgraphs.get(readMermaidGfxSubgraphId(element));
      if (!subgraph) continue;
      applyLocalAppearance(
        element,
        toMermaidSubgraphElementProps(
          subgraph,
          ownerBound,
          typeOwnedMermaidSubgraphElementProjection(projectionModel, subgraph),
        ),
        SHAPE_APPEARANCE_KEYS,
      );
      continue;
    }
    if (role === MERMAID_GFX_DETAIL_ROLE) {
      const detail = details.get(
        `${readMermaidGfxMeta(element, "mermaidDetailOwnerNodeId")}:${readMermaidGfxMeta(element, "mermaidDetailId")}`,
      );
      if (!detail) continue;
      const projection =
        detail.projection ??
        typeOwnedMermaidNodeDetailElementProjection(
          projectionModel,
          detail.node,
          detail.detail,
        );
      if (!projection) continue;
      applyLocalAppearance(
        element,
        toMermaidNodeDetailElementProps({
          ...detail,
          ownerBound,
          projection,
        }),
        // Derived compartments are renderer projections of the live body.
        // Keep their geometry and wrapping local, including native resize preview.
        detailGeometryFollowsBody && !detail.detail.sourceKey
          ? [...SHAPE_APPEARANCE_KEYS, "xywh", "text"]
          : SHAPE_APPEARANCE_KEYS,
      );
      continue;
    }
    if (role === MERMAID_GFX_EDGE_ROLE) {
      const edgeEntry = edges.get(readMermaidGfxEdgeId(element));
      if (!edgeEntry) continue;
      if (
        !idMap.has(edgeEntry.edge.sourceAttachment ?? edgeEntry.edge.source) ||
        !idMap.has(edgeEntry.edge.targetAttachment ?? edgeEntry.edge.target)
      ) {
        continue;
      }
      const projection = typeOwnedMermaidEdgeElementProjection(
        projectionModel,
        edgeEntry.edge,
        edgeEntry.index,
      );
      const label = resolveMermaidConnectorLabelXYWH({
        edge: edgeEntry.edge,
        elementProjection: projection,
        ownerBound,
        visualModel: projectionModel,
      });
      const props = toMermaidConnectorElementProps(
        edgeEntry.edge,
        idMap,
        label,
        projection,
      );
      if (
        label &&
        (element.path?.length ?? 0) >= 2 &&
        element.getLabelXYWHOnPath
      ) {
        props.labelXYWH = element.getLabelXYWHOnPath(
          label[2],
          label[3],
          props.labelOffset,
        ) as [number, number, number, number];
      }
      applyLocalAppearance(element, props, CONNECTOR_APPEARANCE_KEYS);
    }
  }
}
