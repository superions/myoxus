import { getMermaidGfxTitleBandHeight } from "./gfx-element-projection.js";
// SPDX-License-Identifier: AGPL-3.0-or-later

import { Bound } from "@virgultum/global/gfx";
import {
  ConnectorMode,
  LineWidth,
  ShapeType,
  StrokeStyle,
} from "@virgultum/model";

import { allowsEmptyMermaidVisualModel } from "../../engine/diagram-types.js";
import { parseMermaidVisualFamilyData } from "./gfx-family-data.js";
import {
  MERMAID_GFX_EDGE_ROLE,
  MERMAID_GFX_NODE_ROLE,
  MERMAID_GFX_SUBGRAPH_ROLE,
  MERMAID_GFX_DETAIL_ROLE,
  MERMAID_GFX_TITLE_ROLE,
} from "./gfx-element-roles.js";
import type { MermaidGfxElement } from "./gfx-element-projection.js";
import { MERMAID_VISUAL_SHAPE_TO_GFX_SHAPE } from "./gfx-element-projection-defaults.js";
import type {
  MermaidVisualConnectorMode,
  MermaidVisualDirection,
  MermaidVisualEdge,
  MermaidVisualEdgeLabelPlacement,
  MermaidVisualEdgeLinkType,
  MermaidVisualEdgeStyle,
  MermaidVisualEndpointMarker,
  MermaidVisualEndpointPosition,
  MermaidVisualModel,
  MermaidVisualNode,
  MermaidVisualNodeDetail,
  MermaidVisualNodeDetailKind,
  MermaidVisualNodeShape,
  MermaidVisualSemanticStyle,
  MermaidVisualSubgraph,
} from "./gfx-model.js";
import {
  migrateLegacyMermaidEdgeFamilyData,
  migrateLegacyMermaidModelFamilyData,
  migrateLegacyMermaidNodeFamilyData,
  migrateLegacyMermaidSubgraphFamilyData,
} from "./gfx-projection-read-migration.js";
import { getMermaidGfxFamilyHooksForDiagramType } from "./gfx-family-hooks-registry.js";

function readMermaidMeta(element: MermaidGfxElement, key: string) {
  const raw = element as unknown as {
    props?: Record<string, unknown>;
  } & Record<string, unknown>;
  return element.yMap?.get(key) ?? raw.props?.[key] ?? raw[key];
}

function hasMermaidMeta(element: MermaidGfxElement, key: string) {
  const raw = element as unknown as {
    props?: Record<string, unknown>;
  } & Record<string, unknown>;
  return (
    element.yMap?.get(key) !== undefined ||
    raw.props?.[key] !== undefined ||
    raw[key] !== undefined
  );
}

const GFX_SHAPE_TO_VISUAL_SHAPE = Object.fromEntries(
  Object.entries(MERMAID_VISUAL_SHAPE_TO_GFX_SHAPE).map(([visual, gfx]) => [
    gfx,
    visual,
  ]),
) as Record<string, MermaidVisualNodeShape>;

function nodeShapeFromGfx(shape: MermaidGfxElement): MermaidVisualNodeShape {
  const explicit = readMermaidMeta(shape, "mermaidNodeShape");
  if (
    typeof explicit === "string" &&
    Object.hasOwn(MERMAID_VISUAL_SHAPE_TO_GFX_SHAPE, explicit)
  ) {
    const visualShape = explicit as MermaidVisualNodeShape;
    const projectedShapeType = MERMAID_VISUAL_SHAPE_TO_GFX_SHAPE[visualShape];
    if (!shape.shapeType || shape.shapeType === projectedShapeType) {
      return visualShape;
    }
  }
  if (shape.shapeType && GFX_SHAPE_TO_VISUAL_SHAPE[shape.shapeType]) {
    return GFX_SHAPE_TO_VISUAL_SHAPE[shape.shapeType]!;
  }
  if (shape.shapeType === ShapeType.Ellipse) return "circle";
  if (shape.shapeType === ShapeType.Diamond) return "diamond";
  if (shape.shapeType === ShapeType.Triangle) return "tri";
  if (shape.shapeType === ShapeType.Rect) {
    return (shape.radius ?? 0) > 0 ? "rounded" : "rect";
  }
  if (
    typeof explicit === "string" &&
    Object.hasOwn(MERMAID_VISUAL_SHAPE_TO_GFX_SHAPE, explicit)
  ) {
    return explicit as MermaidVisualNodeShape;
  }
  return "rect";
}

function isNodeDetailKind(
  value: unknown,
): value is MermaidVisualNodeDetailKind {
  return (
    value === "field" ||
    value === "metadata" ||
    value === "operation" ||
    value === "separator" ||
    value === "endpoint" ||
    value === "requirement-property"
  );
}

function normalizeNumberMeta(value: unknown) {
  const number =
    typeof value === "number"
      ? value
      : typeof value === "string" && value.trim()
        ? Number(value)
        : Number.NaN;
  return Number.isFinite(number) ? number : undefined;
}

function normalizeNodeDetailsMeta(
  value: unknown,
): MermaidVisualNodeDetail[] | undefined {
  const raw =
    typeof value === "string" && value.trim()
      ? (() => {
          try {
            return JSON.parse(value) as unknown;
          } catch {
            return null;
          }
        })()
      : value;
  if (!Array.isArray(raw)) return undefined;
  const details = raw
    .map((item, index): MermaidVisualNodeDetail | null => {
      if (!item || typeof item !== "object") return null;
      const record = item as Record<string, unknown>;
      if (!isNodeDetailKind(record.kind)) return null;
      const label =
        typeof record.label === "string" && record.label.trim()
          ? record.label.trim()
          : null;
      if (!label && record.kind !== "separator") return null;
      return {
        id:
          typeof record.id === "string" && record.id.trim()
            ? record.id.trim()
            : `${record.kind}-${index + 1}`,
        kind: record.kind,
        label: label ?? "",
        order: normalizeNumberMeta(record.order) ?? index,
        sourceKey:
          typeof record.sourceKey === "string" && record.sourceKey.trim()
            ? record.sourceKey.trim()
            : undefined,
        value:
          typeof record.value === "string" && record.value.trim()
            ? record.value.trim()
            : undefined,
      };
    })
    .filter((detail): detail is MermaidVisualNodeDetail => detail !== null)
    .sort((a, b) => a.order - b.order);
  return details.length ? details : undefined;
}

function textToString(value: MermaidGfxElement["text"]) {
  if (!value) return "";
  return typeof value === "string" ? value : value.toString();
}

function parseDetailDisplayText(
  text: string,
  fallback: MermaidVisualNodeDetail,
): MermaidVisualNodeDetail {
  const normalized = text.replace(/\r/g, "").trim();
  if (!normalized) return fallback;
  if (
    (fallback.kind === "field" && fallback.value === undefined) ||
    fallback.kind === "operation" ||
    fallback.kind === "metadata"
  ) {
    return { ...fallback, label: normalized, value: undefined };
  }
  const separator = normalized.indexOf(":");
  if (separator < 0) return { ...fallback, label: normalized };
  return {
    ...fallback,
    label: normalized.slice(0, separator).trim() || fallback.label,
    value: normalized.slice(separator + 1).trim() || undefined,
  };
}

function detailRowsFromGfxShape(shape: MermaidGfxElement) {
  const ownerId = String(
    readMermaidMeta(shape, "mermaidDetailOwnerNodeId") ?? "",
  );
  const kind = readMermaidMeta(shape, "mermaidDetailKind");
  if (!ownerId || !isNodeDetailKind(kind)) return null;
  const order = normalizeNumberMeta(
    readMermaidMeta(shape, "mermaidDetailOrder"),
  );
  const fallback: MermaidVisualNodeDetail = {
    id:
      String(readMermaidMeta(shape, "mermaidDetailId") ?? "") ||
      `${kind}-${order ?? 0}`,
    kind,
    label: String(readMermaidMeta(shape, "mermaidDetailLabel") ?? ""),
    order: order ?? 0,
    sourceKey:
      String(readMermaidMeta(shape, "mermaidDetailSourceKey") ?? "") ||
      undefined,
    value:
      String(readMermaidMeta(shape, "mermaidDetailValue") ?? "") || undefined,
  };
  return {
    // Presentation may hide lexical classifiers while retaining the semantic signature.
    detail:
      textToString(shape.text) ===
      readMermaidMeta(shape, "mermaidDetailDisplayLabel")
        ? fallback
        : parseDetailDisplayText(textToString(shape.text), fallback),
    ownerId,
  };
}

function normalizeTextAlignMeta(
  value: unknown,
): MermaidVisualNode["textAlign"] {
  return value === "left" || value === "right" || value === "center"
    ? value
    : undefined;
}

function normalizeTextVerticalAlignMeta(
  value: unknown,
): MermaidVisualNode["textVerticalAlign"] {
  return value === "top" || value === "bottom" || value === "center"
    ? value
    : undefined;
}

function stringMeta(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function flattenedDisplayText(value: string) {
  return value.replace(/\r/g, "").replace(/\n/g, "").trim();
}

function normalizedEditableText(value: string) {
  return value.replaceAll("\r\n", "\n").replaceAll("\r", "\n");
}

function firstDisplayLabelLine(value: string) {
  return value
    .replace(/\r/g, "")
    .split("\n")
    .map((line) => line.trim())
    .find(Boolean);
}

function edgeStyleFromGfx(
  connector: MermaidGfxElement,
): MermaidVisualEdgeStyle {
  const explicit = readMermaidMeta(connector, "mermaidEdgeStyle");
  if (explicit === "dotted" || explicit === "solid" || explicit === "thick") {
    return explicit;
  }
  if (connector.strokeStyle === StrokeStyle.Dash) return "dotted";
  if ((connector.strokeWidth ?? 0) >= LineWidth.Four) return "thick";
  return "solid";
}

function edgeLinkTypeFromGfx(
  connector: MermaidGfxElement,
): MermaidVisualEdgeLinkType {
  const explicit = readMermaidMeta(connector, "mermaidEdgeLinkType");
  if (
    explicit === "arrow" ||
    explicit === "bidirectional" ||
    explicit === "circle" ||
    explicit === "cross" ||
    explicit === "dotted" ||
    explicit === "open" ||
    explicit === "reverse" ||
    explicit === "thick"
  ) {
    return explicit;
  }
  const style = edgeStyleFromGfx(connector);
  return style === "dotted" ? "dotted" : style === "thick" ? "thick" : "arrow";
}

function normalizeConnectorModeMeta(
  value: unknown,
): MermaidVisualConnectorMode | undefined {
  if (value === ConnectorMode.Curve) return "curve";
  if (value === ConnectorMode.Straight) return "straight";
  if (value === ConnectorMode.Orthogonal) return "orthogonal";
  const raw = String(value ?? "");
  return raw === "curve" || raw === "straight" || raw === "orthogonal"
    ? raw
    : undefined;
}

function normalizeEndpointMarkerMeta(
  value: unknown,
): MermaidVisualEndpointMarker | undefined {
  return value === "arrow" ||
    value === "bar" ||
    value === "double-bar" ||
    value === "bar-crow-foot" ||
    value === "circle" ||
    value === "circle-bar" ||
    value === "circle-crow-foot" ||
    value === "cross" ||
    value === "crow-foot" ||
    value === "diamond" ||
    value === "hollow-circle" ||
    value === "circle-cross" ||
    value === "hollow-diamond" ||
    value === "hollow-triangle" ||
    value === "triangle" ||
    value === "half-filled-top" ||
    value === "half-filled-bottom" ||
    value === "half-open-top" ||
    value === "half-open-bottom" ||
    value === "none"
    ? value
    : undefined;
}

function normalizeEdgeLabelPlacementMeta(
  value: unknown,
): MermaidVisualEdgeLabelPlacement | undefined {
  const raw = String(value ?? "");
  return raw === "bottom" || raw === "center" || raw === "top"
    ? raw
    : undefined;
}

function normalizeEndpointPosition(
  value: unknown,
): MermaidVisualEndpointPosition | undefined {
  if (!Array.isArray(value) || value.length < 2) return undefined;
  const x = Number(value[0]);
  const y = Number(value[1]);
  return Number.isFinite(x) && Number.isFinite(y) ? [x, y] : undefined;
}

function isSemanticStyleName(
  value: unknown,
): value is MermaidVisualSemanticStyle {
  return (
    value === "accent" ||
    value === "error" ||
    value === "neutral" ||
    value === "processing" ||
    value === "success" ||
    value === "warning"
  );
}

export function createMermaidVisualModelFromGfxElements({
  diagramType,
  direction,
  elements,
  ownerBound,
  previousModel,
}: {
  diagramType: MermaidVisualModel["diagramType"];
  direction: MermaidVisualModel["direction"];
  elements: MermaidGfxElement[];
  ownerBound: Bound;
  previousModel?: MermaidVisualModel | null;
}): MermaidVisualModel | null {
  const titleElement =
    elements.find(
      (element) =>
        readMermaidMeta(element, "mermaidRole") === MERMAID_GFX_TITLE_ROLE,
    ) ??
    elements.find((element) => hasMermaidMeta(element, "mermaidDiagramTitle"));
  const materializedTitle =
    titleElement &&
    readMermaidMeta(titleElement, "mermaidRole") === MERMAID_GFX_TITLE_ROLE
      ? stringMeta(readMermaidMeta(titleElement, "mermaidDiagramTitle"))
      : (previousModel?.diagramTitle ??
        (titleElement
          ? stringMeta(readMermaidMeta(titleElement, "mermaidDiagramTitle"))
          : undefined));
  const semanticShapeBounds = elements
    .filter((element) => {
      const role = readMermaidMeta(element, "mermaidRole");
      return (
        element.type === "shape" &&
        role !== MERMAID_GFX_TITLE_ROLE &&
        Boolean(element.xywh)
      );
    })
    .map((element) => Bound.deserialize(element.xywh!));
  const hasReservedTitleBand = Boolean(
    titleElement &&
    readMermaidMeta(titleElement, "mermaidRole") === MERMAID_GFX_TITLE_ROLE &&
    materializedTitle?.trim() &&
    semanticShapeBounds.every(
      (bound) =>
        bound.y >= ownerBound.y + getMermaidGfxTitleBandHeight(previousModel),
    ),
  );
  // Title metadata on ordinary shapes does not reserve a band. Embedded
  // owners retain the same title semantics but paint it in their block header.
  // Only the dedicated native title child establishes an inset. A direct
  // Surface owner reserves a title band above its semantic diagram
  // geometry. Read back node and subgraph positions from that geometry origin,
  // not from the outer owner bound, so Source/visual roundtrips never absorb
  // the presentation-only title inset.
  const geometryOwnerBound = hasReservedTitleBand
    ? new Bound(
        ownerBound.x,
        ownerBound.y + getMermaidGfxTitleBandHeight(previousModel),
        ownerBound.w,
        Math.max(1, ownerBound.h - getMermaidGfxTitleBandHeight(previousModel)),
      )
    : ownerBound;
  const materializedDirection = elements
    .map((element) => readMermaidMeta(element, "mermaidDiagramDirection"))
    .find(
      (value): value is MermaidVisualDirection =>
        value === "BT" ||
        value === "LR" ||
        value === "RL" ||
        value === "TB" ||
        value === "TD",
    );
  const nodes: MermaidVisualNode[] = [];
  const nodeIdByElementId = new Map<string, string>();
  const nodeStyleClasses: Array<{
    nodeId: string;
    styleName: MermaidVisualSemanticStyle;
  }> = [];
  const endpointIdByElementId = new Map<string, string>();
  const subgraphs: MermaidVisualSubgraph[] = [];
  const seenEdgeIds = new Set<string>();
  const seenMermaidEdgeIds = new Set<string>();
  const seenNodeIds = new Set<string>();
  const seenSubgraphIds = new Set<string>();
  let hasIdentityConflict = false;
  const hooks = getMermaidGfxFamilyHooksForDiagramType(diagramType);
  const policy = hooks?.projectionOwnerReadbackPolicy;
  const readbackPolicy =
    typeof policy === "function" ? policy(diagramType) : policy;
  const detailRowsByOwnerId = new Map<string, MermaidVisualNodeDetail[]>();

  if (
    elements.some((element) => {
      const role = readMermaidMeta(element, "mermaidRole");
      return element.type === "connector"
        ? role !== MERMAID_GFX_EDGE_ROLE
        : element.type === "shape" &&
            role !== MERMAID_GFX_NODE_ROLE &&
            role !== MERMAID_GFX_SUBGRAPH_ROLE &&
            role !== MERMAID_GFX_DETAIL_ROLE &&
            role !== MERMAID_GFX_TITLE_ROLE;
    })
  ) {
    return null;
  }

  elements
    .filter(
      (element) =>
        element.type === "shape" &&
        readMermaidMeta(element, "mermaidRole") === MERMAID_GFX_DETAIL_ROLE,
    )
    .forEach((shape) => {
      const row = detailRowsFromGfxShape(shape);
      if (!row) {
        hasIdentityConflict = true;
        return;
      }
      const rows = detailRowsByOwnerId.get(row.ownerId) ?? [];
      rows.push(row.detail);
      detailRowsByOwnerId.set(row.ownerId, rows);
    });

  elements
    .filter(
      (element) =>
        element.type === "shape" &&
        readMermaidMeta(element, "mermaidRole") === MERMAID_GFX_SUBGRAPH_ROLE,
    )
    .forEach((shape, index) => {
      if (!shape.xywh) {
        hasIdentityConflict = true;
        return;
      }
      const bound = Bound.deserialize(shape.xywh);
      const direction = readMermaidMeta(shape, "mermaidSubgraphDirection");
      const subgraphId = String(
        readMermaidMeta(shape, "mermaidSubgraphId") ?? "",
      );
      if (!subgraphId) {
        hasIdentityConflict = true;
        return;
      }
      const previousSubgraph = previousModel?.subgraphs?.find(
        (candidate) => candidate.id === subgraphId,
      );
      endpointIdByElementId.set(shape.id, subgraphId);
      if (seenSubgraphIds.has(subgraphId)) {
        hasIdentityConflict = true;
        return;
      }
      seenSubgraphIds.add(subgraphId);
      subgraphs.push({
        direction:
          direction === "BT" ||
          direction === "LR" ||
          direction === "RL" ||
          direction === "TB" ||
          direction === "TD"
            ? direction
            : undefined,
        height: bound.h,
        id: subgraphId,
        familyData: migrateLegacyMermaidSubgraphFamilyData(
          diagramType,
          parseMermaidVisualFamilyData(
            readMermaidMeta(shape, "mermaidSubgraphFamilyData"),
          ) ?? previousSubgraph?.familyData,
          (key) => readMermaidMeta(shape, key),
        ),
        nodeIds: [],
        ...(readbackPolicy?.preserveSourceMembership
          ? { parentId: previousSubgraph?.parentId }
          : {}),
        title: hasMermaidMeta(shape, "mermaidSubgraphTitle")
          ? String(readMermaidMeta(shape, "mermaidSubgraphTitle") ?? "")
          : textToString(shape.text) || `Subgraph ${index + 1}`,
        displayLabel: hasMermaidMeta(shape, "mermaidSubgraphDisplayLabel")
          ? String(readMermaidMeta(shape, "mermaidSubgraphDisplayLabel") ?? "")
          : textToString(shape.text) || undefined,
        width: bound.w,
        x: bound.x - geometryOwnerBound.x,
        y: bound.y - geometryOwnerBound.y,
      });
    });

  elements
    .filter(
      (element) =>
        element.type === "shape" &&
        readMermaidMeta(element, "mermaidRole") === MERMAID_GFX_NODE_ROLE,
    )
    .forEach((shape) => {
      if (!shape.xywh) {
        hasIdentityConflict = true;
        return;
      }
      const bound = Bound.deserialize(shape.xywh);
      const nodeId = String(readMermaidMeta(shape, "mermaidNodeId") ?? "");
      if (!nodeId) {
        hasIdentityConflict = true;
        return;
      }
      nodeIdByElementId.set(shape.id, nodeId);
      endpointIdByElementId.set(shape.id, nodeId);
      if (
        seenNodeIds.has(nodeId) ||
        (readbackPolicy?.strictSemanticIdentities &&
          seenSubgraphIds.has(nodeId))
      ) {
        hasIdentityConflict = true;
        return;
      }
      seenNodeIds.add(nodeId);
      const styleClass = readMermaidMeta(shape, "mermaidNodeStyleClass");
      const previousNode = previousModel?.nodes.find(
        (candidate) => candidate.id === nodeId,
      );
      const textLabel = textToString(shape.text);
      const metaDisplayLabel = String(
        readMermaidMeta(shape, "mermaidNodeDisplayLabel") ?? "",
      );
      const hasMetaDisplayLabel = hasMermaidMeta(
        shape,
        "mermaidNodeDisplayLabel",
      );
      const metaLabel = String(
        readMermaidMeta(shape, "mermaidNodeLabel") ?? "",
      );
      const hasMetaLabel = hasMermaidMeta(shape, "mermaidNodeLabel");
      // Renderer-local appearance is not hydrated during cold readback. The
      // persisted empty display lexeme still identifies an unlabelled helper;
      // its empty Y.Text must not replace the semantic label.
      const isProjectionHelper =
        shape.textDisplay === false ||
        (hasMetaDisplayLabel && metaDisplayLabel === "" && textLabel === "");
      const previousDisplayLabel = previousNode?.displayLabel ?? "";
      const matchesVisibleText = readbackPolicy?.preserveMultilineNodeLabels
        ? (left: string, right: string) =>
            normalizedEditableText(left) === normalizedEditableText(right)
        : (left: string, right: string) =>
            flattenedDisplayText(left) === flattenedDisplayText(right);
      // Native GFX text editors can update the visible Y.Text before Mermaid's
      // metadata mirror observes the same edit; source sync must still honor
      // that committed canvas text instead of replaying stale semantic labels.
      const textMatchesMetadataDisplay = Boolean(
        metaDisplayLabel && matchesVisibleText(textLabel, metaDisplayLabel),
      );
      const textMatchesPreviousDisplay = Boolean(
        previousDisplayLabel &&
        matchesVisibleText(textLabel, previousDisplayLabel),
      );
      const explicitEmptyDisplayLabel =
        hasMetaDisplayLabel && metaDisplayLabel === "" && isProjectionHelper;
      const visibleTextChangedOutsideMetadata = Boolean(
        (readbackPolicy?.preserveMultilineNodeLabels || textLabel) &&
        !explicitEmptyDisplayLabel &&
        !textMatchesMetadataDisplay &&
        !textMatchesPreviousDisplay,
      );
      const displayLabel = visibleTextChangedOutsideMetadata
        ? textLabel
        : hasMetaDisplayLabel
          ? metaDisplayLabel
          : textLabel;
      const hasDisplayDetailLines = Boolean(
        previousDisplayLabel.includes("\n") || displayLabel.includes("\n"),
      );
      const shouldPreferMetaLabel = Boolean(
        metaLabel &&
        !visibleTextChangedOutsideMetadata &&
        hasDisplayDetailLines,
      );
      const label = isProjectionHelper
        ? metaLabel
        : shouldPreferMetaLabel
          ? metaLabel
          : visibleTextChangedOutsideMetadata
            ? readbackPolicy?.preserveMultilineNodeLabels
              ? textLabel
              : (firstDisplayLabelLine(textLabel) ?? nodeId)
            : textLabel && textLabel !== previousNode?.displayLabel
              ? textLabel
              : readbackPolicy?.preserveMultilineNodeLabels && hasMetaLabel
                ? metaLabel
                : metaLabel || textLabel || previousNode?.label || nodeId;
      if (isSemanticStyleName(styleClass)) {
        nodeStyleClasses.push({ nodeId, styleName: styleClass });
      }
      const details =
        detailRowsByOwnerId.get(nodeId)?.sort((a, b) => a.order - b.order) ??
        normalizeNodeDetailsMeta(readMermaidMeta(shape, "mermaidNodeDetails"));
      const node: MermaidVisualNode = {
        details,
        displayLabel:
          isProjectionHelper || hasMetaDisplayLabel
            ? displayLabel
            : displayLabel || undefined,
        familyData: migrateLegacyMermaidNodeFamilyData(
          diagramType,
          parseMermaidVisualFamilyData(
            readMermaidMeta(shape, "mermaidNodeFamilyData"),
          ) ?? previousNode?.familyData,
          (key) => readMermaidMeta(shape, key),
        ),
        height: bound.h,
        id: nodeId,
        labelEditable:
          readMermaidMeta(shape, "mermaidNodeLabelEditable") === false
            ? false
            : previousNode?.labelEditable,
        label,
        rotate: normalizeNumberMeta(readMermaidMeta(shape, "rotate")),
        shape: nodeShapeFromGfx(shape),
        textAlign:
          normalizeTextAlignMeta(readMermaidMeta(shape, "textAlign")) ??
          normalizeTextAlignMeta(shape.textAlign),
        textVerticalAlign:
          normalizeTextVerticalAlignMeta(
            readMermaidMeta(shape, "textVerticalAlign"),
          ) ?? normalizeTextVerticalAlignMeta(shape.textVerticalAlign),
        width: bound.w,
        x: bound.x - geometryOwnerBound.x,
        y: bound.y - geometryOwnerBound.y,
      };
      nodes.push(node);
    });

  if (readbackPolicy?.preserveSourceMembership) {
    const nodeIds = new Set(nodes.map((n) => n.id));
    for (const group of subgraphs) {
      const previous = previousModel?.subgraphs?.find((g) => g.id === group.id);
      group.nodeIds = previous?.nodeIds.filter((id) => nodeIds.has(id)) ?? [];
    }
  } else if (readbackPolicy?.preservePreviousSubgraphMembership) {
    const previousSubgraphOwnerByNodeId = new Map<string, string>();
    for (const subgraph of previousModel?.subgraphs ?? []) {
      for (const nodeId of subgraph.nodeIds) {
        if (!previousSubgraphOwnerByNodeId.has(nodeId)) {
          previousSubgraphOwnerByNodeId.set(nodeId, subgraph.id);
        }
      }
    }
    for (const subgraph of subgraphs) subgraph.nodeIds = [];
    for (const node of nodes) {
      const centerX = geometryOwnerBound.x + node.x + node.width / 2;
      const centerY = geometryOwnerBound.y + node.y + node.height / 2;
      const candidates = subgraphs
        .filter((subgraph) => {
          const subgraphBound = new Bound(
            geometryOwnerBound.x + subgraph.x,
            geometryOwnerBound.y + subgraph.y,
            subgraph.width,
            subgraph.height,
          );
          return (
            centerX >= subgraphBound.x &&
            centerX <= subgraphBound.x + subgraphBound.w &&
            centerY >= subgraphBound.y &&
            centerY <= subgraphBound.y + subgraphBound.h
          );
        })
        .sort((a, b) => a.width * a.height - b.width * b.height);
      const previousOwnerId = previousSubgraphOwnerByNodeId.get(node.id);
      const owner = candidates.find(
        (subgraph) => subgraph.id === previousOwnerId,
      );
      owner?.nodeIds.push(node.id);
    }
  } else {
    for (const subgraph of subgraphs) {
      const subgraphBound = new Bound(
        geometryOwnerBound.x + subgraph.x,
        geometryOwnerBound.y + subgraph.y,
        subgraph.width,
        subgraph.height,
      );
      subgraph.nodeIds = nodes
        .filter((node) => {
          const centerX = geometryOwnerBound.x + node.x + node.width / 2;
          const centerY = geometryOwnerBound.y + node.y + node.height / 2;
          return (
            centerX >= subgraphBound.x &&
            centerX <= subgraphBound.x + subgraphBound.w &&
            centerY >= subgraphBound.y &&
            centerY <= subgraphBound.y + subgraphBound.h
          );
        })
        .map((node) => node.id);
    }
  }

  const edges: MermaidVisualEdge[] = [];
  const edgeVisualStyles: Array<{
    edgeIndex: number;
    styleName: MermaidVisualSemanticStyle;
  }> = [];
  elements
    .filter(
      (element) =>
        element.type === "connector" &&
        readMermaidMeta(element, "mermaidRole") === MERMAID_GFX_EDGE_ROLE,
    )
    .forEach((connector) => {
      const physicalSource = connector.source?.id
        ? endpointIdByElementId.get(connector.source.id)
        : undefined;
      const physicalTarget = connector.target?.id
        ? endpointIdByElementId.get(connector.target.id)
        : undefined;
      if (!physicalSource || !physicalTarget) {
        hasIdentityConflict = true;
        return;
      }
      const storedSourceAttachment = stringMeta(
        readMermaidMeta(connector, "mermaidEdgeSourceAttachment"),
      );
      const storedTargetAttachment = stringMeta(
        readMermaidMeta(connector, "mermaidEdgeTargetAttachment"),
      );
      const sourceAttachedToStoredBoundary =
        Boolean(storedSourceAttachment) &&
        physicalSource === storedSourceAttachment;
      const targetAttachedToStoredBoundary =
        Boolean(storedTargetAttachment) &&
        physicalTarget === storedTargetAttachment;
      const source = sourceAttachedToStoredBoundary
        ? (stringMeta(
            readMermaidMeta(connector, "mermaidEdgeSemanticSource"),
          ) ?? physicalSource)
        : physicalSource;
      const target = targetAttachedToStoredBoundary
        ? (stringMeta(
            readMermaidMeta(connector, "mermaidEdgeSemanticTarget"),
          ) ?? physicalTarget)
        : physicalTarget;
      const visualStyle = readMermaidMeta(connector, "mermaidEdgeVisualStyle");
      const edgeId = String(readMermaidMeta(connector, "mermaidEdgeId") ?? "");
      if (!edgeId) {
        hasIdentityConflict = true;
        return;
      }
      const mermaidId =
        String(readMermaidMeta(connector, "mermaidEdgeMermaidId") ?? "") ||
        undefined;
      if (
        seenEdgeIds.has(edgeId) ||
        (readbackPolicy?.strictSemanticIdentities &&
          mermaidId &&
          (seenMermaidEdgeIds.has(mermaidId) ||
            seenNodeIds.has(mermaidId) ||
            seenSubgraphIds.has(mermaidId)))
      ) {
        hasIdentityConflict = true;
        return;
      }
      seenEdgeIds.add(edgeId);
      if (mermaidId) seenMermaidEdgeIds.add(mermaidId);
      if (isSemanticStyleName(visualStyle)) {
        edgeVisualStyles.push({
          edgeIndex: edges.length,
          styleName: visualStyle,
        });
      }
      const visibleEdgeLabel = textToString(connector.text);
      const storedEdgeLabel = String(
        readMermaidMeta(connector, "mermaidEdgeLabel") ?? "",
      );
      const storedEdgeDisplayLabel = String(
        readMermaidMeta(connector, "mermaidEdgeDisplayLabel") ?? "",
      );
      const semanticEdgeLabel =
        storedEdgeDisplayLabel && visibleEdgeLabel === storedEdgeDisplayLabel
          ? storedEdgeLabel
          : visibleEdgeLabel;
      edges.push({
        displayLabel:
          String(readMermaidMeta(connector, "mermaidEdgeDisplayLabel") ?? "") ||
          undefined,
        familyData: migrateLegacyMermaidEdgeFamilyData(
          diagramType,
          parseMermaidVisualFamilyData(
            readMermaidMeta(connector, "mermaidEdgeFamilyData"),
          ) ??
            previousModel?.edges.find((edge) => edge.id === edgeId)?.familyData,
          (key) => readMermaidMeta(connector, key),
        ),
        id: edgeId,
        label: semanticEdgeLabel,
        labelEditable:
          readMermaidMeta(connector, "mermaidEdgeLabelEditable") === false
            ? false
            : previousModel?.edges.find((edge) => edge.id === edgeId)
                ?.labelEditable,
        labelPlacement: normalizeEdgeLabelPlacementMeta(
          readMermaidMeta(connector, "mermaidEdgeLabelPlacement"),
        ),
        linkType: edgeLinkTypeFromGfx(connector),
        mermaidId,
        connectorMode:
          normalizeConnectorModeMeta(
            readMermaidMeta(connector, "mermaidEdgeConnectorMode"),
          ) ?? normalizeConnectorModeMeta(readMermaidMeta(connector, "mode")),
        source,
        sourceAttachment: sourceAttachedToStoredBoundary
          ? physicalSource
          : undefined,
        sourceMarker: normalizeEndpointMarkerMeta(
          readMermaidMeta(connector, "mermaidEdgeSourceMarker"),
        ),
        sourcePortId: stringMeta(
          readMermaidMeta(connector, "mermaidEdgeSourcePortId"),
        ),
        sourcePosition: normalizeEndpointPosition(connector.source?.position),
        style: edgeStyleFromGfx(connector),
        target,
        targetAttachment: targetAttachedToStoredBoundary
          ? physicalTarget
          : undefined,
        targetMarker: normalizeEndpointMarkerMeta(
          readMermaidMeta(connector, "mermaidEdgeTargetMarker"),
        ),
        targetPortId: stringMeta(
          readMermaidMeta(connector, "mermaidEdgeTargetPortId"),
        ),
        targetPosition: normalizeEndpointPosition(connector.target?.position),
      });
    });

  if (
    hasIdentityConflict ||
    (nodes.length === 0 && !allowsEmptyMermaidVisualModel(diagramType))
  ) {
    return null;
  }
  const visualModel: MermaidVisualModel = {
    accessibilityDescription: previousModel?.accessibilityDescription,
    accessibilityTitle: previousModel?.accessibilityTitle,
    diagramTitle: materializedTitle,
    diagramType,
    direction: materializedDirection ?? direction,
    edges,
    familyData: previousModel
      ? migrateLegacyMermaidModelFamilyData(previousModel)
      : undefined,
    nodes,
    sourceAnnotations: previousModel?.sourceAnnotations,
    sourcePreamble: previousModel?.sourcePreamble,
    styleStatements: [...(previousModel?.styleStatements ?? [])],
    subgraphs,
    version: 1,
  };
  return (
    hooks?.finalizeProjectionOwnerReadback?.(visualModel, previousModel, {
      edges: edgeVisualStyles,
      nodes: nodeStyleClasses,
    }) ?? visualModel
  );
}
