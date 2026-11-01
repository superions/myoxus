import type { MermaidVisualHistoryEntry } from "./mermaid-block-constants.js";
import {
  createMermaidGfxModelHash,
  type MermaidVisualModel,
} from "./families/runtime/gfx-model.js";
import { cloneMermaidVisualModel } from "./mermaid-visual-model-operations.js";

export type MermaidVisualHistoryStacks = {
  redoStack: MermaidVisualHistoryEntry[];
  undoStack: MermaidVisualHistoryEntry[];
};

const mermaidVisualHistoryByOwner = new WeakMap<
  object,
  MermaidVisualHistoryStacks
>();
const mermaidVisualHistoryByStore = new WeakMap<
  object,
  Map<string, MermaidVisualHistoryStacks>
>();

export function getMermaidVisualHistoryStacks(
  owner: object,
): MermaidVisualHistoryStacks {
  const stableOwner = owner as {
    id?: unknown;
    store?: unknown;
    yBlock?: unknown;
  };
  // BlockModel and Store wrappers may be recreated when Source is projected
  // after history replay. The underlying Y.Map is the stable identity of this
  // Mermaid block for the document session.
  if (typeof stableOwner.yBlock === "object" && stableOwner.yBlock !== null) {
    const existing = mermaidVisualHistoryByOwner.get(stableOwner.yBlock);
    if (existing) return existing;
    const created = { redoStack: [], undoStack: [] };
    mermaidVisualHistoryByOwner.set(stableOwner.yBlock, created);
    return created;
  }
  if (
    typeof stableOwner.id === "string" &&
    stableOwner.id &&
    typeof stableOwner.store === "object" &&
    stableOwner.store !== null
  ) {
    const store = stableOwner.store as { doc?: unknown };
    const historyScope =
      typeof store.doc === "object" && store.doc !== null ? store.doc : store;
    let storeHistories = mermaidVisualHistoryByStore.get(historyScope);
    if (!storeHistories) {
      storeHistories = new Map();
      mermaidVisualHistoryByStore.set(historyScope, storeHistories);
    }
    const existing = storeHistories.get(stableOwner.id);
    if (existing) return existing;
    const created = { redoStack: [], undoStack: [] };
    storeHistories.set(stableOwner.id, created);
    return created;
  }
  const existing = mermaidVisualHistoryByOwner.get(owner);
  if (existing) return existing;
  const created = {
    redoStack: [],
    undoStack: [],
  };
  mermaidVisualHistoryByOwner.set(owner, created);
  return created;
}

function visualModelKey(model: MermaidVisualModel) {
  return createMermaidGfxModelHash(model);
}

function visualModelSemanticKey(model: MermaidVisualModel) {
  // Replay guards compare the user-owned graph, not parser/materializer
  // projection details. Canonical Source generation may make implicit edge
  // ids explicit and may add display metadata without changing that graph.
  return JSON.stringify({
    diagramType: model.diagramType,
    direction: model.direction,
    edges: model.edges.map((edge) => ({
      connectorMode: edge.connectorMode,
      id: edge.id,
      label: edge.label,
      labelPlacement: edge.labelPlacement,
      linkType: edge.linkType,
      source: edge.source,
      sourceMarker: edge.sourceMarker,
      style: edge.style,
      target: edge.target,
      targetMarker: edge.targetMarker,
    })),
    nodes: model.nodes.map((node) => ({
      details: node.details,
      id: node.id,
      label: node.label,
      shape: node.shape,
      textAlign: node.textAlign,
      textVerticalAlign: node.textVerticalAlign,
    })),
    subgraphs: (model.subgraphs ?? []).map((subgraph) => ({
      direction: subgraph.direction,
      id: subgraph.id,
      nodeIds: subgraph.nodeIds,
      parentId: subgraph.parentId,
      title: subgraph.title,
    })),
    version: model.version,
  });
}

export function isMermaidVisualHistoryModelCurrent(
  current: MermaidVisualModel | null,
  expected: MermaidVisualModel,
) {
  return (
    current !== null &&
    (visualModelKey(current) === visualModelKey(expected) ||
      visualModelSemanticKey(current) === visualModelSemanticKey(expected))
  );
}

export function pushMermaidVisualHistory({
  after,
  before,
  coalesceKey,
  redoStack,
  undoSourceHash,
  undoStack,
}: {
  after: MermaidVisualModel;
  before: MermaidVisualModel;
  coalesceKey?: string;
  redoStack: MermaidVisualHistoryEntry[];
  undoSourceHash?: string;
  undoStack: MermaidVisualHistoryEntry[];
}) {
  const beforeKey = visualModelKey(before);
  const afterKey = visualModelKey(after);
  if (beforeKey === afterKey) {
    return false;
  }
  const previous = undoStack.at(-1);
  if (
    coalesceKey &&
    previous?.coalesceKey === coalesceKey &&
    visualModelKey(previous.after) === beforeKey
  ) {
    previous.after = cloneMermaidVisualModel(after);
    previous.redoSourceHash = undefined;
    previous.undoSourceHash = undoSourceHash;
  } else {
    undoStack.push({
      after: cloneMermaidVisualModel(after),
      before: cloneMermaidVisualModel(before),
      coalesceKey,
      undoSourceHash,
    });
  }
  redoStack.length = 0;
  return true;
}

export function pushMermaidVisualHistoryForOwner({
  after,
  before,
  coalesceKey,
  owner,
  undoSourceHash,
}: {
  after: MermaidVisualModel;
  before: MermaidVisualModel;
  coalesceKey?: string;
  owner: object;
  undoSourceHash?: string;
}) {
  const { redoStack, undoStack } = getMermaidVisualHistoryStacks(owner);
  return pushMermaidVisualHistory({
    after,
    before,
    coalesceKey,
    redoStack,
    undoSourceHash,
    undoStack,
  });
}

export function takeMermaidVisualUndoEntry({
  current,
  currentSourceHash,
  undoStack,
}: {
  current: MermaidVisualModel | null;
  currentSourceHash?: string;
  undoStack: MermaidVisualHistoryEntry[];
}) {
  const entry = undoStack.at(-1);
  const matches = entry?.undoSourceHash
    ? entry.undoSourceHash === currentSourceHash
    : entry && isMermaidVisualHistoryModelCurrent(current, entry.after);
  return entry && matches ? (undoStack.pop() ?? null) : null;
}

export function takeMermaidVisualRedoEntry({
  current,
  currentSourceHash,
  redoStack,
}: {
  current: MermaidVisualModel | null;
  currentSourceHash?: string;
  redoStack: MermaidVisualHistoryEntry[];
}) {
  const entry = redoStack.at(-1);
  const matches = entry?.redoSourceHash
    ? entry.redoSourceHash === currentSourceHash
    : entry && isMermaidVisualHistoryModelCurrent(current, entry.before);
  return entry && matches ? (redoStack.pop() ?? null) : null;
}
