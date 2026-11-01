// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  c4IdentityFamilyData,
  readC4ProjectionModel,
  c4VisualWithSourceIdentities,
} from "./gfx-data.js";
import { scanC4Source } from "../../engine/c4/source-document.js";

import {
  clearMermaidC4ArgumentValue,
  generateMermaidC4SourceWithBindings,
  mermaidC4ArgumentValue,
  type MermaidC4Model,
  updateMermaidC4ArgumentValue,
} from "../../engine/c4/index.js";
import type { MermaidVisualModel } from "../runtime/gfx-model.js";
import type { MermaidVisualNode } from "../runtime/gfx-model.js";
import { hashMermaidSource } from "../../utils.js";
import {
  upsertVisualEdges,
  upsertVisualNodes,
} from "../source-application-helpers.js";
import {
  c4BoundaryGfxData,
  c4EdgeGfxData,
  c4NodeGfxData,
} from "./object-data.js";

function c4KindForNode(
  node: MermaidVisualNode,
  existing?: MermaidC4Model["elements"][number],
) {
  const data = c4NodeGfxData(node);
  if (data?.kind) return data.kind;
  if (existing?.kind) return existing.kind;
  if (node.shape === "database") return "ContainerDb";
  if (node.shape === "stadium") return "ContainerQueue";
  if (node.shape === "rounded") return "Person";
  return "System";
}

function c4ExplicitParentForNewNode(
  node: MermaidVisualNode,
  visualModel: MermaidVisualModel,
) {
  const groups = (visualModel.subgraphs ?? []).filter((g) =>
    g.nodeIds.includes(node.id),
  );
  return groups.length === 1 ? groups[0].id : "";
}

export function applyC4GfxVisualToSource(
  source: string,
  visualModel: MermaidVisualModel,
) {
  const requestedVisual = visualModel;
  const parsed = readC4ProjectionModel(source, visualModel);
  if (!parsed && source.length)
    throw new Error(
      "Cannot rewrite unresolved C4 Source through a visual projection",
    );
  const base = parsed ?? {
    accessibilityDescription: "",
    accessibilityTitle: "",
    boundaries: [],
    diagramType: "c4" as const,
    direction: "TB" as const,
    directives: [],
    elements: [],
    headerLine: "C4Context",
    layoutBoundaryInRow: 2,
    layoutShapeInRow: 4,
    sourceDocument: scanC4Source(""),
    occurrences: [],
    relationships: [],
    sourceHash: hashMermaidSource(source),
    title: "",
    updateStatements: [],
    version: 1 as const,
  };
  visualModel = c4VisualWithSourceIdentities(base, visualModel);
  const boundaryById = new Map(
    base.boundaries.map((boundary) => [boundary.id, boundary]),
  );
  const elementsById = new Map(
    base.elements.map((element) => [element.id, element]),
  );
  const changedElementKinds = new Map(
    visualModel.nodes.flatMap((node) => {
      const existing = elementsById.get(node.id);
      const kind = c4KindForNode(node, existing);
      return existing && existing.kind !== kind
        ? [[node.id, kind] as const]
        : [];
    }),
  );
  const visualElementIds = new Set([
    ...visualModel.nodes.map(({ id }) => id),
    ...(visualModel.subgraphs ?? []).map(({ id }) => id),
  ]);
  const deletedElementIds = new Set(
    [...base.elements, ...base.boundaries]
      .map(({ id }) => id)
      .filter((id) => !visualElementIds.has(id)),
  );
  const relationshipKey = (from: string, to: string) => `${from}\0${to}`;
  const visualRelationshipKeys = new Set(
    visualModel.edges.map(({ source, target }) =>
      relationshipKey(source, target),
    ),
  );
  const deletedRelationshipKeys = new Set(
    base.relationships
      .filter(
        ({ id, from, to }) =>
          !visualModel.edges.some((edge) => edge.id === id) &&
          !visualRelationshipKeys.has(relationshipKey(from, to)),
      )
      .map(({ from, to }) => relationshipKey(from, to)),
  );
  const relationshipEndpointChanges = base.relationships.flatMap(
    (relationship) => {
      const visual = visualModel.edges.find(
        (edge) => edge.id === relationship.id,
      );
      return visual &&
        (visual.source !== relationship.from ||
          visual.target !== relationship.to)
        ? [
            {
              from: relationship.from,
              nextFrom: visual.source,
              nextTo: visual.target,
              to: relationship.to,
            },
          ]
        : [];
    },
  );
  type StyleEdit = { argumentIndex: number; value: string };
  const technologyStyleEdits = new Map<number, StyleEdit>();
  const technologyStyleOwnerByElementId = new Map<string, number>();
  const spriteStyleEdits = new Map<number, StyleEdit>();
  const clearedSpriteOverrideElementIds = new Set<string>();
  const clearedTechnologyOverrideElementIds = new Set<string>();
  const updateRecords = base.sourceDocument.records.filter((r) =>
    r.kind.endsWith("-update"),
  );
  // Interleaved declarations can shadow an update. Edit the actual field
  // provider, including a named value redirected from another optional slot.
  const styleProvider = (
    existing:
      | MermaidC4Model["elements"][number]
      | MermaidC4Model["boundaries"][number]
      | undefined,
    field: string,
  ) => {
    const provider = existing?.resolution?.providers[field];
    if (provider?.argumentIndex === undefined) return null;
    const index = updateRecords.findIndex(
      (r) =>
        r.sourceKey === provider.sourceKey &&
        r.callKind === "UpdateElementStyle",
    );
    return index < 0 ? null : { index, argumentIndex: provider.argumentIndex };
  };
  const collectSpriteStyleEdit = (
    elementId: string,
    c4: ReturnType<typeof c4NodeGfxData> | ReturnType<typeof c4BoundaryGfxData>,
  ) => {
    if (!c4?.spriteOverridden) return;
    const provider = styleProvider(
      elementsById.get(elementId) ?? boundaryById.get(elementId),
      "sprite",
    );
    if (!provider) return;
    spriteStyleEdits.set(provider.index, {
      argumentIndex: provider.argumentIndex,
      value: c4.effectiveSprite,
    });
    if (!c4.effectiveSprite) clearedSpriteOverrideElementIds.add(elementId);
  };
  for (const node of visualModel.nodes) {
    const c4 = c4NodeGfxData(node);
    collectSpriteStyleEdit(node.id, c4);
    const existing = elementsById.get(node.id);
    if (!c4 || c4.effectiveTechnology === existing?.technology) continue;
    const provider = styleProvider(existing, "techn");
    if (!provider) continue;
    technologyStyleEdits.set(provider.index, {
      argumentIndex: provider.argumentIndex,
      value: c4.effectiveTechnology,
    });
    technologyStyleOwnerByElementId.set(node.id, provider.index);
    if (!c4.effectiveTechnology)
      clearedTechnologyOverrideElementIds.add(node.id);
  }
  for (const subgraph of visualModel.subgraphs ?? []) {
    collectSpriteStyleEdit(subgraph.id, c4BoundaryGfxData(subgraph));
  }
  const written = generateMermaidC4SourceWithBindings({
    ...base,
    boundaries: (visualModel.subgraphs ?? [])
      .map((subgraph, index) => {
        const existing = boundaryById.get(subgraph.id);
        const c4 = c4BoundaryGfxData(subgraph);
        const kind = c4?.boundaryKind ?? existing?.kind ?? "System_Boundary";
        return {
          ...existing,
          alias: subgraph.id,
          boundaryType: c4?.boundaryType ?? existing?.boundaryType ?? "system",
          callArguments: existing?.kind === kind ? existing.callArguments : [],
          description: c4?.description ?? existing?.description ?? "",
          height: subgraph.height,
          id: subgraph.id,
          kind,
          label: c4?.label ?? existing?.label ?? subgraph.title ?? subgraph.id,
          link: c4?.link ?? existing?.link ?? "",
          order: existing?.order ?? index,
          parentId: existing?.parentId ?? "",
          sprite: clearedSpriteOverrideElementIds.has(subgraph.id)
            ? ""
            : (c4?.sprite ?? existing?.sprite ?? ""),
          tags: c4?.tags ?? existing?.tags ?? "",
          width: subgraph.width,
          x: subgraph.x,
          y: subgraph.y,
        };
      })
      .sort((a, b) => a.order - b.order),
    directives: base.directives.length
      ? base.directives
      : (visualModel.sourcePreamble ?? []),
    elements: upsertVisualNodes(base.elements, visualModel, (node, order) => {
      const c4 = c4NodeGfxData(node);
      return {
        alias: node.id,
        boundaryId: c4ExplicitParentForNewNode(node, visualModel),
        callArguments: [],
        description: c4?.description ?? "",
        id: node.id,
        kind: c4KindForNode(node),
        label: node.label,
        link: c4?.link ?? "",
        order,
        sprite: c4?.sprite ?? "",
        tags: c4?.tags ?? "",
        technology: c4?.sourceTechnology ?? "",
        width: node.width,
        x: node.x,
        y: node.y,
      };
    })
      .map((element, index) => {
        const visual = visualModel.nodes[index];
        const existing = visual ? elementsById.get(visual.id) : undefined;
        const c4 = visual ? c4NodeGfxData(visual) : undefined;
        if (!visual) return element;
        const kind = c4KindForNode(visual, existing);
        return {
          ...element,
          callArguments: existing?.kind === kind ? element.callArguments : [],
          description:
            c4?.description ??
            element.description ??
            existing?.description ??
            "",
          boundaryId: existing?.boundaryId ?? element.boundaryId,
          order: existing?.order ?? element.order,
          kind,
          label: visual.label,
          link: c4?.link ?? element.link,
          sprite: clearedSpriteOverrideElementIds.has(visual.id)
            ? ""
            : (c4?.sprite ?? element.sprite),
          tags: c4?.tags ?? element.tags,
          technology: clearedTechnologyOverrideElementIds.has(visual.id)
            ? ""
            : technologyStyleOwnerByElementId.has(visual.id)
              ? (c4?.effectiveTechnology ?? element.technology)
              : (c4?.effectiveTechnology ??
                element.technology ??
                existing?.technology ??
                ""),
        };
      })
      .sort((a, b) => a.order - b.order),
    relationships: upsertVisualEdges(
      base.relationships,
      visualModel,
      (edge, order) => {
        const c4 = c4EdgeGfxData(edge);
        return {
          callArguments: [],
          description: c4?.description ?? "",
          from: edge.source,
          id: edge.id,
          index: c4?.index ?? null,
          kind: c4?.relationshipKind ?? "Rel",
          label: edge.label,
          link: c4?.link ?? "",
          order,
          sprite: c4?.sprite ?? "",
          tags: c4?.tags ?? "",
          technology: c4?.technology ?? "",
          to: edge.target,
        };
      },
    )
      .map((relationship, index) => {
        const visual = visualModel.edges[index];
        const c4 = visual ? c4EdgeGfxData(visual) : undefined;
        if (!visual) return relationship;
        const kind = c4?.relationshipKind ?? relationship.kind ?? "Rel";
        return {
          ...relationship,
          callArguments:
            relationship.kind === kind ? relationship.callArguments : [],
          from: visual.source,
          order:
            base.relationships.find((r) => r.id === visual.id)?.order ??
            relationship.order,
          description: c4?.description ?? relationship.description,
          index: c4?.index ?? relationship.index,
          kind,
          label: visual.label,
          link: c4?.link ?? relationship.link,
          sprite: c4?.sprite ?? relationship.sprite,
          tags: c4?.tags ?? relationship.tags,
          technology: c4?.technology ?? relationship.technology,
          to: visual.target,
        };
      })
      .sort((a, b) => a.order - b.order),
    accessibilityDescription:
      visualModel.accessibilityDescription ?? base.accessibilityDescription,
    accessibilityTitle:
      visualModel.accessibilityTitle ?? base.accessibilityTitle,
    direction: visualModel.direction === "TD" ? "TB" : visualModel.direction,
    // The global title hook owns authored titles; owner-chrome fallbacks must
    // never become source statements during a move, resize or field edit.
    title: base.title,
    updateStatements: base.updateStatements
      .map((statement, index) => {
        const technology = technologyStyleEdits.get(index);
        const sprite = spriteStyleEdits.get(index);
        let callArguments = statement.callArguments;
        if (statement.kind === "UpdateElementStyle") {
          const elementId = mermaidC4ArgumentValue(callArguments, 0, [
            "elementName",
          ]);
          const changedKind = changedElementKinds.get(elementId);
          if (changedKind) {
            callArguments = clearMermaidC4ArgumentValue(callArguments, 5, [
              "shape",
            ]);
            if (!/^(?:Component|Container)/.test(changedKind)) {
              callArguments = clearMermaidC4ArgumentValue(callArguments, 7, [
                "techn",
                "technology",
              ]);
            }
          }
        } else if (statement.kind === "UpdateRelStyle") {
          const from = mermaidC4ArgumentValue(callArguments, 0, ["from"]);
          const to = mermaidC4ArgumentValue(callArguments, 1, ["to"]);
          const changedEndpoints = relationshipEndpointChanges.find(
            (change) => change.from === from && change.to === to,
          );
          if (changedEndpoints) {
            callArguments = updateMermaidC4ArgumentValue(
              callArguments,
              0,
              ["from"],
              changedEndpoints.nextFrom,
            );
            callArguments = updateMermaidC4ArgumentValue(
              callArguments,
              1,
              ["to"],
              changedEndpoints.nextTo,
            );
          }
        }
        if (technology !== undefined) {
          callArguments = updateMermaidC4ArgumentValue(
            callArguments,
            technology.argumentIndex,
            ["techn", "technology"],
            technology.value,
          );
        }
        if (sprite !== undefined) {
          callArguments = updateMermaidC4ArgumentValue(
            callArguments,
            sprite.argumentIndex,
            ["sprite"],
            sprite.value,
          );
        }
        return callArguments === statement.callArguments
          ? statement
          : { ...statement, callArguments };
      })
      .filter((statement) => {
        if (statement.kind === "UpdateElementStyle") {
          return !deletedElementIds.has(
            mermaidC4ArgumentValue(statement.callArguments, 0, ["elementName"]),
          );
        }
        if (statement.kind === "UpdateRelStyle") {
          return !deletedRelationshipKeys.has(
            relationshipKey(
              mermaidC4ArgumentValue(statement.callArguments, 0, ["from"]),
              mermaidC4ArgumentValue(statement.callArguments, 1, ["to"]),
            ),
          );
        }
        return true;
      }),
  });
  // Commit consumers receive advanced bindings on a new candidate, never on
  // their stored projection or on stale gesture-basis record ranges.
  return {
    source: written.source,
    visualModel: {
      ...requestedVisual,
      familyData: c4IdentityFamilyData(written.model),
    },
  };
}
