// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  parseMermaidClassMember,
  classRelationSemantics,
} from "../../engine/class/index.js";
import { nextClassSourceKey } from "../../engine/class/source-document.js";
import { classRelationProjection } from "./edge-projection.js";
import { StrokeStyle } from "@virgultum/model";
import { defineMermaidFamilyRuntime } from "../runtime/factory.js";
import { mermaidClassFamily, isClassDiagramType } from "./family.js";
import { classDiagramTitle } from "./diagram-title.js";
import { classModelToVisual } from "./visual-model.js";
import {
  applyClassGfxVisualToSource,
  canonicalizeClassVisual,
  readClassProjectionModel,
  reconcileClassVisual,
} from "./source-application.js";
import type { MermaidGfxFamilyHookRegistration } from "../runtime/gfx-family-hooks-contract.js";
import {
  projectNeutralMermaidGfxNodeElement,
  projectNeutralMermaidGfxConnectorElement,
  projectNeutralMermaidGfxSubgraphElement,
} from "../runtime/gfx-element-projection-defaults.js";
import {
  classNodeGfxData,
  classProjectionBinding,
  classEdgeGfxData,
} from "./gfx-data.js";
import { resolveMermaidGfxProjectionTheme } from "../../mermaid-gfx-theme.js";
import {
  classEdgelessToolbar,
  mermaidClassHostAdapter,
} from "./host-adapter.js";
import { classPageSelectionTools } from "./actions.js";
import { projectedClassStyle } from "./style-projection.js";
export const classGfxHooks: MermaidGfxFamilyHookRegistration = {
  owns: (m) => isClassDiagramType(m.diagramType),
  ownsDiagramType: isClassDiagramType,
  hooks: {
    graphEditor: true,
    usesDocumentHistory: true,
    objectEditsViaFamilyControls: true,
    includeRenderedConnectorBounds: true,
    nodeInlineValue: (model, id) =>
      model.nodes.find((node) => node.id === id)?.label ?? "",
    geometrySelection: (model, ids) => {
      const classes = new Set(
        model.nodes
          .filter(
            (n) => ids.includes(n.id) && classNodeGfxData(n)?.kind === "class",
          )
          .map((n) => classProjectionBinding(n)?.sourceId),
      );
      return [
        ...new Set([
          ...ids,
          ...model.nodes
            .filter(
              (n) =>
                classNodeGfxData(n)?.kind === "note" &&
                classes.has(classNodeGfxData(n)?.noteFor),
            )
            .map((n) => n.id),
        ]),
      ];
    },
    reconcileGeometryGesture: (before, after) => ({
      ...after,
      nodes: after.nodes.map((node) => {
        const data = classNodeGfxData(node);
        if (data?.kind !== "note" || !data.noteFor) return node;
        const previous = before.nodes.find((n) => n.id === node.id);
        const owner = after.nodes.find(
          (n) =>
            classProjectionBinding(n)?.sourceId === data.noteFor &&
            classNodeGfxData(n)?.kind === "class",
        );
        const oldOwner = owner && before.nodes.find((n) => n.id === owner.id);
        if (
          !owner ||
          !oldOwner ||
          !previous ||
          node.x !== previous.x ||
          node.y !== previous.y
        )
          return node;
        return {
          ...node,
          x: node.x + owner.x - oldOwner.x,
          y: node.y + owner.y - oldOwner.y,
        };
      }),
    }),
    preserveManagedNodeDimensions: (_, source, existing) => ({
      width: Math.max(source.width, existing.width),
      height: Math.max(source.height, existing.height),
    }),
    preserveManagedSubgraphDimensions: (_, source, existing) => ({
      width: Math.max(source.width, existing.width),
      height: Math.max(source.height, existing.height),
    }),
    readSourceProjection: (source, stored) => {
      const model = readClassProjectionModel(source, stored);
      return model
        ? reconcileClassVisual(classModelToVisual(model), stored)
        : null;
    },
    allowsSelfConnections: true,
    subgraphHeaderBehindContent: true,
    createEdge: (model, from, to) => {
      const fromId = classProjectionBinding(
        model.nodes.find((n) => n.id === from) ?? {},
      )?.sourceId;
      const toId = classProjectionBinding(
        model.nodes.find((n) => n.id === to) ?? {},
      )?.sourceId;
      if (!fromId || !toId) return null;
      const key = nextClassSourceKey();
      return classRelationProjection(
        {
          id: key,
          sourceKey: key,
          fromSourceId: fromId,
          toSourceId: toId,
          from,
          to,
          kind: "-->",
          ...classRelationSemantics("-->"),
          fromCardinality: "",
          toCardinality: "",
          label: "",
          order: model.edges.length,
        },
        new Map([
          [from, from],
          [to, to],
        ]),
      );
    },
    reconnectEdge: (model, edge, endpoint, key) =>
      classNodeGfxData(model.nodes.find((n) => n.id === key) ?? {})?.kind ===
        "class" && !classEdgeGfxData(edge)?.noteLink
        ? { ...edge, [endpoint]: key }
        : null,
    reparentNodes: (model, ids, parentId) => {
      // Membership follows the explicit selection, never the geometry expansion
      // for attached notes. A mixed selection remains a purely geometric move.
      if (
        !ids.length ||
        ids.some(
          (id) =>
            classNodeGfxData(model.nodes.find((node) => node.id === id) ?? {})
              ?.kind !== "class",
        ) ||
        (parentId && !model.subgraphs?.some((group) => group.id === parentId))
      )
        return null;
      return {
        ...model,
        subgraphs: model.subgraphs?.map((group) => ({
          ...group,
          nodeIds:
            group.id === parentId
              ? [...new Set([...group.nodeIds, ...ids])]
              : group.nodeIds.filter((id) => !ids.includes(id)),
        })),
      };
    },
    reparentSubgraph: (model, id, parentId) => ({
      ...model,
      subgraphs: model.subgraphs?.map((g) =>
        g.id === id ? { ...g, parentId: parentId || undefined } : g,
      ),
    }),
    reconcileNodeDragEnd: () => false,
    preserveProjectionOwnerForInvalidSource: () => true,
    shapePalette: { all: ["rect"], core: ["rect"] },
    canConnectNodes: (model, a, b) =>
      [a, b].every(
        (id) =>
          classNodeGfxData(model.nodes.find((n) => n.id === id) ?? {})?.kind ===
          "class",
      ),
    canonicalizeAfterSourceWrite: canonicalizeClassVisual,
    reconcileVisualProjection: (parsed, stored, canReuse) =>
      reconcileClassVisual(
        canonicalizeClassVisual(parsed, stored),
        stored,
        canReuse,
      ),
    projectionOnlyNodeMutation: (patch) =>
      Object.keys(patch).every((k) =>
        ["x", "y", "width", "height"].includes(k),
      ),
    projectionOnlySubgraphMutation: (patch) =>
      Object.keys(patch).every((k) =>
        ["x", "y", "width", "height"].includes(k),
      ),
    edgeReconnectable: (_, edge) => !classEdgeGfxData(edge)?.noteLink,
    projectionOwnerReadbackPolicy: {
      preserveMultilineNodeLabels: true,
      preservePreviousSubgraphMembership: true,
      strictSemanticIdentities: true,
    },
    readProjectionOwnerModel: (model) => ({
      ...model,
      edges: model.edges.map((edge) => {
        const data = classEdgeGfxData(edge);
        return data
          ? {
              ...edge,
              endpointLabels: data.noteLink
                ? undefined
                : { source: data.fromCardinality, target: data.toCardinality },
            }
          : edge;
      }),
    }),
    nodeElementProjection: (_, node) => ({
      ...projectNeutralMermaidGfxNodeElement(node),
      fontSize: resolveMermaidGfxProjectionTheme().typography.fontSize,
      strokeColor: resolveMermaidGfxProjectionTheme().secondaryTextColor,
      padding: [
        classProjectionBinding(node)?.padding ?? 0,
        classProjectionBinding(node)?.padding ?? 0,
      ],
      ...projectedClassStyle(node),
    }),
    nodeDetailElementProjection: (_, node, detail) => {
      const b = classProjectionBinding(node),
        theme = resolveMermaidGfxProjectionTheme();
      if (!b) throw new Error("Class detail has no source binding");
      const rows = node.details?.filter((d) => d.kind === detail.kind) ?? [],
        index = rows.findIndex((d) => d.id === detail.id);
      const separator = detail.kind === "separator";
      const member = parseMermaidClassMember(detail.label, {
        range: { start: 0, end: detail.label.length, line: 1 },
      });
      const classifier = member.ranges.classifier;
      const displayText =
        member.classifier && classifier
          ? detail.label.slice(0, classifier.start) +
            detail.label.slice(classifier.end)
          : detail.label;
      const y = separator
        ? detail.id.endsWith(":header")
          ? b.headerHeight
          : b.headerHeight + b.attributeHeight
        : b.headerHeight +
          (detail.kind === "operation" ? b.attributeHeight : 0) +
          index * b.rowHeight;
      return {
        offsetY: 0,
        relativeBound: {
          x: separator ? 0 : b.padding,
          y,
          width: Math.max(1, node.width - (separator ? 0 : b.padding * 2)),
          height: separator ? 1 : b.rowHeight,
        },
        text: displayText,
        textAlign: "left",
        textVerticalAlign: "center",
        fontSize: theme.typography.fontSize,
        fontWeight: theme.typography.fontWeight,
        textDecoration: member.classifier === "static" ? "underline" : "none",
        fontStyle:
          member.classifier === "abstract"
            ? "italic"
            : theme.typography.fontStyle,
        color: theme.textColor,
        filled: separator,
        ...projectedClassStyle(node),
        strokeWidth: 0,
        strokeStyle: StrokeStyle.None,
        padding: [0, 0],
        textDisplay: !separator,
        fillColor: separator ? theme.borderColor : theme.surfaceColor,
      };
    },
    edgeElementProjection: (_, edge) => ({
      ...projectNeutralMermaidGfxConnectorElement(edge),
      endpointScale: 1,
      stroke: resolveMermaidGfxProjectionTheme().secondaryTextColor,
      fontSize: resolveMermaidGfxProjectionTheme().typography.fontSize,
    }),
    subgraphElementProjection: () => ({
      ...projectNeutralMermaidGfxSubgraphElement(),
      filled: false,
    }),
  },
};
export const mermaidClassRuntime = defineMermaidFamilyRuntime({
  ...mermaidClassFamily,
  preserveSourceBytes: true,
  diagramTitle: classDiagramTitle,
  gfxHooks: classGfxHooks,
  hostAdapter: mermaidClassHostAdapter,
  edgelessToolbar: classEdgelessToolbar,
  pageSelectionTools: classPageSelectionTools,
  applyGfxVisualToSource: (source, visual) => ({
    source: applyClassGfxVisualToSource(source, visual),
    diagnostics: [],
  }),
  parseSourceToGfxVisualModel: (source) => {
    const model = readClassProjectionModel(source);
    return model ? classModelToVisual(model) : null;
  },
  sourceDiagnostics: (source, type) =>
    mermaidClassFamily.parseSource(source, type).diagnostics,
  renderSurface: () => "core-facade" as const,
});
