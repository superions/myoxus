import { mermaidRuntimePreservesSourceBytes } from "./families/runtime/factory.js";
import { canonicalizeTypeOwnedMermaidVisualProjectionAfterSourceWrite } from "./families/runtime/gfx-owner-hooks.js";
import {
  createMermaidGfxModelHash,
  normalizeMermaidVisualModel,
  type MermaidVisualModel,
} from "./families/runtime/gfx-model.js";
import { parseMermaidVisualFamilyData } from "./families/runtime/gfx-family-data.js";
import {
  detectMermaidDiagramType,
  type MermaidDiagramType,
} from "./engine/diagram-types.js";
import type { MermaidProductDiagramType } from "./engine/product-types.js";
import {
  getMermaidFamilyRuntime,
  resolveMermaidFamilyRuntime,
} from "./families/runtime/registry.js";
import { hashMermaidSource, normalizeMermaidSourceInput } from "./utils.js";

export type MermaidVisualParseResult =
  | {
      diagramType: MermaidProductDiagramType;
      model: MermaidVisualModel;
      sourceHash: string;
      visualModelHash: string;
    }
  | {
      diagramType: MermaidDiagramType;
      model: null;
      sourceHash: string;
      visualModelHash: null;
    };

function parseResult(
  source: string,
  diagramType: MermaidDiagramType,
  model: MermaidVisualModel | null,
): MermaidVisualParseResult {
  const sourceHash = hashMermaidSource(source);
  return model
    ? {
        diagramType: model.diagramType,
        model,
        sourceHash,
        visualModelHash: createMermaidGfxModelHash(model),
      }
    : { diagramType, model: null, sourceHash, visualModelHash: null };
}

export function parseMermaidSourceToGfxVisualModel(
  source: string,
): MermaidVisualParseResult {
  const resolution = resolveMermaidFamilyRuntime(source);
  return parseResult(
    source,
    resolution.kind === "resolved"
      ? resolution.diagramType
      : detectMermaidDiagramType(source),
    resolution.kind === "resolved" ? (resolution.gfxVisualModel ?? null) : null,
  );
}

export function generateMermaidSourceFromGfxVisualModel(
  previousSource: string,
  visualModel: MermaidVisualModel,
) {
  return applyMermaidGfxVisualToSource(previousSource, visualModel).source;
}

/** Keep checked Source and its advanced identity bindings together until commit. */
export function applyMermaidGfxVisualToSource(
  previousSource: string,
  visualModel: MermaidVisualModel,
) {
  const runtime = getMermaidFamilyRuntime(visualModel.diagramType);
  if (!runtime) {
    throw new Error(
      `Mermaid ${visualModel.diagramType} has no registered source owner`,
    );
  }
  return runtime.applyGfxVisualToSource(previousSource, visualModel);
}

/** Normalize only generator-owned source; minimal-patch families retain bytes. */
export function mermaidGfxCommittedSource(
  source: string,
  model: MermaidVisualModel,
) {
  return mermaidGfxPreservesSourceBytes(model)
    ? source
    : normalizeMermaidSourceInput(source);
}
export function mermaidGfxPreservesSourceBytes(model: MermaidVisualModel) {
  return mermaidRuntimePreservesSourceBytes(
    getMermaidFamilyRuntime(model.diagramType),
    model.diagramType,
  );
}

function validFamilyData(value: unknown) {
  return value === undefined || Boolean(parseMermaidVisualFamilyData(value));
}

function sameFamily(
  candidate: MermaidVisualModel["familyData"],
  parsed: MermaidVisualModel["familyData"],
) {
  return candidate?.family === parsed?.family;
}

function sameIds(
  candidate: readonly { readonly id: string }[],
  parsed: readonly { readonly id: string }[],
) {
  if (candidate.length !== parsed.length) return false;
  const parsedIds = new Set(parsed.map((item) => item.id));
  return candidate.every((item) => item.id && parsedIds.has(item.id));
}

/**
 * The sole neutral validation boundary before a persisted/replayed Mermaid
 * model may be materialized. Family payload meaning remains owned by the
 * source runtime; Common verifies only the versioned JSON envelope, identity
 * graph, finite geometry and a lossless owner write/reparse.
 */
export function prepareMermaidGfxVisualTransfer(
  source: string,
  value: unknown,
): MermaidVisualModel | null {
  try {
    const cloned = JSON.parse(JSON.stringify(value)) as unknown;
    const model = normalizeMermaidVisualModel(cloned);
    if (!source.trim() || !model || !validFamilyData(model.familyData)) {
      return null;
    }

    const nodeIds = new Set<string>();
    for (const node of model.nodes) {
      if (
        !node.id ||
        nodeIds.has(node.id) ||
        !Number.isFinite(node.x) ||
        !Number.isFinite(node.y) ||
        !Number.isFinite(node.width) ||
        !Number.isFinite(node.height) ||
        node.width <= 0 ||
        node.height <= 0 ||
        !validFamilyData(node.familyData)
      ) {
        return null;
      }
      const detailIds = new Set<string>();
      for (const detail of node.details ?? []) {
        if (
          !detail.id ||
          detailIds.has(detail.id) ||
          !Number.isFinite(detail.order)
        ) {
          return null;
        }
        detailIds.add(detail.id);
      }
      nodeIds.add(node.id);
    }

    const subgraphIds = new Set<string>();
    for (const subgraph of model.subgraphs ?? []) {
      if (
        !subgraph.id ||
        subgraphIds.has(subgraph.id) ||
        nodeIds.has(subgraph.id) ||
        !Number.isFinite(subgraph.x) ||
        !Number.isFinite(subgraph.y) ||
        !Number.isFinite(subgraph.width) ||
        !Number.isFinite(subgraph.height) ||
        subgraph.width <= 0 ||
        subgraph.height <= 0 ||
        !validFamilyData(subgraph.familyData) ||
        subgraph.nodeIds.some((nodeId) => !nodeIds.has(nodeId))
      ) {
        return null;
      }
      subgraphIds.add(subgraph.id);
    }

    const endpointIds = new Set([...nodeIds, ...subgraphIds]);
    const edgeIds = new Set<string>();
    const mermaidIds = new Set<string>();
    for (const edge of model.edges) {
      if (
        !edge.id ||
        edgeIds.has(edge.id) ||
        !endpointIds.has(edge.source) ||
        !endpointIds.has(edge.target) ||
        !validFamilyData(edge.familyData) ||
        (edge.mermaidId &&
          (mermaidIds.has(edge.mermaidId) || endpointIds.has(edge.mermaidId)))
      ) {
        return null;
      }
      edgeIds.add(edge.id);
      if (edge.mermaidId) mermaidIds.add(edge.mermaidId);
    }

    const coldParsed = parseMermaidSourceToGfxVisualModel(source).model;
    const parsed = coldParsed
      ? canonicalizeTypeOwnedMermaidVisualProjectionAfterSourceWrite(
          coldParsed,
          model,
          source,
        )
      : null;
    if (
      !parsed ||
      parsed.diagramType !== model.diagramType ||
      !sameIds(model.nodes, parsed.nodes) ||
      !sameIds(model.edges, parsed.edges) ||
      !sameIds(model.subgraphs ?? [], parsed.subgraphs ?? []) ||
      !sameFamily(model.familyData, parsed.familyData)
    ) {
      return null;
    }
    const parsedNodes = new Map(parsed.nodes.map((node) => [node.id, node]));
    const parsedEdges = new Map(parsed.edges.map((edge) => [edge.id, edge]));
    const parsedSubgraphs = new Map(
      (parsed.subgraphs ?? []).map((subgraph) => [subgraph.id, subgraph]),
    );
    if (
      model.nodes.some(
        (node) =>
          !sameFamily(node.familyData, parsedNodes.get(node.id)?.familyData),
      ) ||
      model.edges.some(
        (edge) =>
          !sameFamily(edge.familyData, parsedEdges.get(edge.id)?.familyData),
      ) ||
      (model.subgraphs ?? []).some(
        (subgraph) =>
          !sameFamily(
            subgraph.familyData,
            parsedSubgraphs.get(subgraph.id)?.familyData,
          ),
      )
    ) {
      return null;
    }

    const regenerated = normalizeMermaidSourceInput(
      generateMermaidSourceFromGfxVisualModel(source, model),
    );
    const canonicalParsedSource = normalizeMermaidSourceInput(
      generateMermaidSourceFromGfxVisualModel(source, parsed),
    );
    if (regenerated !== canonicalParsedSource) return null;
    const reparsed = parseMermaidSourceToGfxVisualModel(regenerated);
    if (!reparsed.model || reparsed.diagramType !== model.diagramType) {
      return null;
    }
    return model;
  } catch {
    return null;
  }
}
