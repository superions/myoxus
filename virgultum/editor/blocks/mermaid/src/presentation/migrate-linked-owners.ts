// SPDX-License-Identifier: AGPL-3.0-or-later

import { getSurfaceBlock } from "@virgultum/block-surface";
import { Bound, type SerializedXYWH } from "@virgultum/global/gfx";
import {
  type FrameBlockModel,
  type MermaidBlockModel,
  type NoteBlockModel,
  NoteDisplayMode,
} from "@virgultum/model";
import type { BlockModel, Store } from "@virgultum/store";

import {
  materializeMermaidElements,
  readMermaidVisualModelFromProjectionGroup,
} from "../commands/materialization.js";
import { detectMermaidDiagramType } from "../engine/diagram-types.js";
import { isMermaidProductDiagramType } from "../engine/product-types.js";
import { getMermaidVisualNodeDetailElementEntries } from "../families/runtime/gfx-element-projection.js";
import {
  MERMAID_GFX_DETAIL_ROLE,
  MERMAID_GFX_EDGE_ROLE,
  MERMAID_GFX_NODE_ROLE,
  MERMAID_GFX_SUBGRAPH_ROLE,
} from "../families/runtime/gfx-element-roles.js";
import {
  getMermaidFamilyRuntime,
  resolveMermaidFamilyRuntime,
} from "../families/runtime/registry.js";
import type { MermaidVisualModel } from "../families/runtime/gfx-model.js";
import { readMermaidGfxMeta } from "../mermaid-gfx-metadata.js";
import {
  getMermaidBlockSource,
  normalizeMermaidSourceInput,
} from "../utils.js";
import { readMermaidLegacyReference } from "./legacy-linked-owner.js";

export type MermaidLegacyMigrationRetainCode =
  "readonly" | "unresolved-source" | "duplicate-stable-id" | "id-collision";

type LegacyElementKind = "shape" | "connector" | "subgraph" | "detail";

type ElementIdentity = {
  readonly endpointStableIds?: readonly [string, string];
  readonly kind: LegacyElementKind;
  readonly stableId: string;
};

type PlannedElement = ElementIdentity & {
  readonly id: string;
  readonly props: Record<string, unknown>;
  readonly type: string;
};

type OwnerMigrationPlan = {
  readonly childIds: readonly string[];
  readonly createElements: readonly PlannedElement[];
  readonly createNote: null | {
    readonly bound: SerializedXYWH;
    readonly id: string;
    readonly oldParent: BlockModel;
    readonly parent: BlockModel;
  };
  readonly frame: FrameBlockModel | null;
  readonly moveToSurface: boolean;
  readonly owner: MermaidBlockModel;
  readonly ownerIndex: string | null;
  readonly ownerLocked: boolean;
  readonly ownerXYWH: SerializedXYWH | null;
  readonly technicalNote: NoteBlockModel | null;
};

export type MermaidLegacyOwnerMigrationDecision =
  | { readonly kind: "migrate"; readonly plan: OwnerMigrationPlan }
  | {
      readonly code: MermaidLegacyMigrationRetainCode;
      readonly kind: "retain";
      readonly ownerId: string;
    };

export type MermaidLinkedOwnerMigrationPlan = {
  readonly applyPlan: () => void;
  readonly decisions: readonly MermaidLegacyOwnerMigrationDecision[];
  readonly hasWrites: boolean;
};

function utf8Hex(value: string) {
  return [...new TextEncoder().encode(value)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export function createMermaidLegacyTargetId(
  blockId: string,
  kind: LegacyElementKind | "note",
  stableId: string,
) {
  return `myoxus-mermaid-legacy-${kind}-${utf8Hex(blockId)}-${utf8Hex(stableId)}`;
}

function readValue(model: unknown, key: string): unknown {
  const raw = model as {
    [key: string]: unknown;
    props?: Record<string, unknown>;
    yMap?: { get?: (name: string) => unknown };
  };
  return raw?.yMap?.get?.(key) ?? raw?.props?.[key] ?? raw?.[key];
}

function elementIdentity(model: unknown): ElementIdentity | null {
  const role = readMermaidGfxMeta(model, "mermaidRole");
  if (role === MERMAID_GFX_NODE_ROLE) {
    const stableId = readMermaidGfxMeta(model, "mermaidNodeId");
    return stableId ? { kind: "shape", stableId } : null;
  }
  if (role === MERMAID_GFX_SUBGRAPH_ROLE) {
    const stableId = readMermaidGfxMeta(model, "mermaidSubgraphId");
    return stableId ? { kind: "subgraph", stableId } : null;
  }
  if (role === MERMAID_GFX_DETAIL_ROLE) {
    const ownerId = readMermaidGfxMeta(model, "mermaidDetailOwnerNodeId");
    const detailId = readMermaidGfxMeta(model, "mermaidDetailId");
    return ownerId && detailId
      ? { kind: "detail", stableId: `${ownerId}::detail::${detailId}` }
      : null;
  }
  if (role === MERMAID_GFX_EDGE_ROLE) {
    const stableId = readMermaidGfxMeta(model, "mermaidEdgeId");
    const source = readMermaidGfxMeta(model, "mermaidEdgeSemanticSource");
    const target = readMermaidGfxMeta(model, "mermaidEdgeSemanticTarget");
    return stableId && source && target
      ? {
          endpointStableIds: [source, target],
          kind: "connector",
          stableId,
        }
      : null;
  }
  return null;
}

function identityKey(identity: ElementIdentity) {
  return `${identity.kind}\u0000${identity.stableId}`;
}

function sameIdentity(left: ElementIdentity, right: ElementIdentity) {
  return (
    identityKey(left) === identityKey(right) &&
    (left.kind !== "connector" ||
      (left.endpointStableIds?.[0] === right.endpointStableIds?.[0] &&
        left.endpointStableIds?.[1] === right.endpointStableIds?.[1]))
  );
}

function deterministicIndexes() {
  let index = 0;
  return () => `a${String(index++).padStart(8, "0")}`;
}

function projectElements(
  owner: MermaidBlockModel,
  visualModel: MermaidVisualModel,
  ownerBound: Bound,
): PlannedElement[] | MermaidLegacyMigrationRetainCode {
  const projected: PlannedElement[] = [];
  const identities = new Set<string>();
  let duplicateIdentity = false;
  try {
    materializeMermaidElements({
      addElement: (type, props) => {
        const identity = elementIdentity(props);
        if (!identity) throw new Error("unresolved Mermaid element identity");
        const key = identityKey(identity);
        if (identities.has(key)) {
          duplicateIdentity = true;
          throw new Error("duplicate Mermaid identity");
        }
        identities.add(key);
        const id = createMermaidLegacyTargetId(
          owner.id,
          identity.kind,
          identity.stableId,
        );
        projected.push({ id, props: { ...props, id }, type, ...identity });
        return id;
      },
      projectionOwner: {
        addChildren() {},
        surface: null,
      } as unknown as MermaidBlockModel,
      ownerBound: ownerBound,
      nextIndex: deterministicIndexes(),
      visualModel,
    });
  } catch {
    return duplicateIdentity ? "duplicate-stable-id" : "unresolved-source";
  }
  return projected;
}

function transferGeometry(projected: PlannedElement, oldElement: unknown) {
  if (!oldElement) return projected;
  const oldIdentity = elementIdentity(oldElement);
  if (!oldIdentity || !sameIdentity(projected, oldIdentity)) return projected;

  const props = { ...projected.props };
  for (const key of ["xywh", "rotate"] as const) {
    const value = readValue(oldElement, key);
    if (value !== undefined) props[key] = structuredClone(value);
  }
  if (projected.kind === "connector") {
    for (const key of ["controllers", "mode"] as const) {
      const value = readValue(oldElement, key);
      if (value !== undefined) props[key] = structuredClone(value);
    }
    for (const key of ["source", "target"] as const) {
      const oldEndpoint = readValue(oldElement, key);
      const newEndpoint = props[key];
      if (
        oldEndpoint &&
        newEndpoint &&
        typeof oldEndpoint === "object" &&
        typeof newEndpoint === "object"
      ) {
        props[key] = {
          ...(structuredClone(oldEndpoint) as Record<string, unknown>),
          id: (newEndpoint as { id?: unknown }).id,
        };
      }
    }
  }
  return { ...projected, props };
}

function isTechnicalNote(parent: BlockModel | null, owner: BlockModel) {
  return parent?.flavour === "myoxus:note" &&
    (parent as NoteBlockModel).props.displayMode === NoteDisplayMode.DocOnly &&
    parent.children.length === 1 &&
    parent.children[0]?.id === owner.id
    ? (parent as NoteBlockModel)
    : null;
}

function resolvedOwnerSource(
  owner: MermaidBlockModel,
  legacyVisualModel: MermaidVisualModel | null,
) {
  const sources = [
    getMermaidBlockSource(owner.props),
    owner.props.lastValidSource ?? "",
  ].filter((source, index, all) => source && all.indexOf(source) === index);
  for (const source of sources) {
    try {
      const diagramType = detectMermaidDiagramType(source);
      if (
        legacyVisualModel &&
        diagramType === legacyVisualModel.diagramType &&
        isMermaidProductDiagramType(diagramType)
      ) {
        const runtime = getMermaidFamilyRuntime(diagramType);
        const diagnostics = runtime?.sourceDiagnostics(source, diagramType);
        const reconstructedSource = runtime?.applyGfxVisualToSource(
          source,
          legacyVisualModel,
        ).source;
        if (
          runtime?.hostAdapter &&
          diagnostics?.every((diagnostic) => diagnostic.severity !== "error") &&
          reconstructedSource !== undefined &&
          normalizeMermaidSourceInput(reconstructedSource) ===
            normalizeMermaidSourceInput(source)
        ) {
          // Store extensions run before the server theme projection is
          // guaranteed to be present. A complete legacy frame already owns
          // the typed visual model needed for a lossless direct adoption, so
          // migration must not depend on a later DOM/theme lifecycle.
          return legacyVisualModel;
        }
      }
      const resolution = resolveMermaidFamilyRuntime(source);
      if (resolution.kind === "resolved") return resolution.gfxVisualModel;
    } catch {
      // Runtime/theme availability is an inventory decision, never an apply error.
    }
  }
  return null;
}

function visualModelIdentities(
  visualModel: MermaidVisualModel,
): ElementIdentity[] {
  return [
    ...visualModel.nodes.map((node): ElementIdentity => ({
      kind: "shape",
      stableId: node.id,
    })),
    ...(visualModel.subgraphs ?? []).map((subgraph): ElementIdentity => ({
      kind: "subgraph",
      stableId: subgraph.id,
    })),
    ...getMermaidVisualNodeDetailElementEntries(visualModel).map(
      ({ detail, node }): ElementIdentity => ({
        kind: "detail",
        stableId: `${node.id}::detail::${detail.id}`,
      }),
    ),
    ...visualModel.edges.map((edge): ElementIdentity => ({
      endpointStableIds: [edge.source, edge.target],
      kind: "connector",
      stableId: edge.id,
    })),
  ];
}

function occupiedTarget(
  store: Store,
  surface: NonNullable<ReturnType<typeof getSurfaceBlock>>,
  id: string,
) {
  return store.hasBlock(id) || surface.hasElementById(id);
}

export function planLinkedMermaidOwnerMigration(
  store: Store,
): MermaidLinkedOwnerMigrationPlan {
  const surface = getSurfaceBlock(store);
  const owners = store
    .getBlocksByFlavour("myoxus:mermaid")
    .map(({ model }) => model as MermaidBlockModel)
    .map((owner) => ({ owner, reference: readMermaidLegacyReference(owner) }))
    .filter((entry): entry is { owner: MermaidBlockModel; reference: string } =>
      Boolean(entry.reference),
    );
  const decisions: MermaidLegacyOwnerMigrationDecision[] = [];
  if (owners.length === 0) {
    return { applyPlan() {}, decisions, hasWrites: false };
  }
  if (!surface) {
    return {
      applyPlan() {},
      decisions: owners.map(({ owner }) => ({
        code: "unresolved-source",
        kind: "retain",
        ownerId: owner.id,
      })),
      hasWrites: false,
    };
  }
  if (store.readonly) {
    return {
      applyPlan() {},
      decisions: owners.map(({ owner }) => ({
        code: "readonly",
        kind: "retain",
        ownerId: owner.id,
      })),
      hasWrites: false,
    };
  }

  const referenceCounts = new Map<string, number>();
  for (const { reference } of owners) {
    referenceCounts.set(reference, (referenceCounts.get(reference) ?? 0) + 1);
  }
  const migratingByFrame = new Map<string, OwnerMigrationPlan[]>();

  for (const { owner, reference } of owners) {
    const ownerModel = store.getBlock(reference)?.model ?? null;
    const frame =
      ownerModel?.flavour === "myoxus:frame"
        ? (ownerModel as FrameBlockModel)
        : null;
    const parent = store.getParent(owner);
    const technicalNote = isTechnicalNote(parent, owner);
    const source =
      getMermaidBlockSource(owner.props) || owner.props.lastValidSource || "";
    const diagramType = detectMermaidDiagramType(source);
    const legacyVisualModel =
      frame && isMermaidProductDiagramType(diagramType)
        ? readMermaidVisualModelFromProjectionGroup(
            store,
            frame,
            null,
            diagramType,
          )
        : null;
    const visualModel = resolvedOwnerSource(owner, legacyVisualModel);
    const ownerBound = frame
      ? Bound.deserialize(String(readValue(frame, "xywh") ?? "[0,0,100,100]"))
      : technicalNote
        ? Bound.deserialize(technicalNote.xywh)
        : Bound.deserialize(owner.xywh);

    if (!visualModel && frame) {
      decisions.push({
        code: "unresolved-source",
        kind: "retain",
        ownerId: owner.id,
      });
      continue;
    }

    const oldChildren = frame
      ? frame.childIds
          .map((id) => surface.getElementById(id))
          .filter((item) => item !== null)
      : [];
    const oldByIdentity = new Map<string, unknown>();
    let oldHasDuplicate = false;
    for (const child of oldChildren) {
      const identity = elementIdentity(child);
      if (!identity) continue;
      const key = identityKey(identity);
      if (oldByIdentity.has(key)) oldHasDuplicate = true;
      oldByIdentity.set(key, child);
    }
    if (oldHasDuplicate) {
      decisions.push({
        code: "duplicate-stable-id",
        kind: "retain",
        ownerId: owner.id,
      });
      continue;
    }

    const expectedIdentities = visualModel
      ? visualModelIdentities(visualModel)
      : [];
    const soleOwned =
      Boolean(frame && visualModel) &&
      referenceCounts.get(reference) === 1 &&
      oldChildren.length === frame?.childIds.length &&
      oldChildren.length === expectedIdentities.length &&
      oldChildren.every((child) => {
        const identity = elementIdentity(child);
        return Boolean(
          identity &&
          expectedIdentities.some((item) => sameIdentity(item, identity)),
        );
      });
    let projected: PlannedElement[] = [];
    if (visualModel && !soleOwned) {
      const result = projectElements(owner, visualModel, ownerBound);
      if (!Array.isArray(result)) {
        decisions.push({ code: result, kind: "retain", ownerId: owner.id });
        continue;
      }
      projected = result;
    }
    const createElements = soleOwned
      ? []
      : projected.map((item) =>
          transferGeometry(item, oldByIdentity.get(identityKey(item))),
        );
    const childIds = soleOwned
      ? [...(frame?.childIds ?? [])]
      : createElements.map((item) => item.id);

    const needsNote =
      !visualModel && (!parent || parent.flavour === "myoxus:surface");
    const noteId = needsNote
      ? createMermaidLegacyTargetId(owner.id, "note", "note")
      : null;
    const targetIds = [
      ...createElements.map((item) => item.id),
      ...(noteId ? [noteId] : []),
    ];
    if (targetIds.some((id) => occupiedTarget(store, surface, id))) {
      decisions.push({
        code: "id-collision",
        kind: "retain",
        ownerId: owner.id,
      });
      continue;
    }

    const root = store.root;
    if (needsNote && (!root || !parent)) {
      decisions.push({
        code: "unresolved-source",
        kind: "retain",
        ownerId: owner.id,
      });
      continue;
    }
    const plan: OwnerMigrationPlan = {
      childIds,
      createElements,
      createNote:
        noteId && root && parent
          ? {
              bound: ownerBound.serialize(),
              id: noteId,
              oldParent: parent,
              parent: root,
            }
          : null,
      frame,
      moveToSurface: Boolean(visualModel && technicalNote),
      owner,
      ownerIndex:
        frame && technicalNote
          ? String(readValue(frame, "index") ?? owner.index)
          : null,
      ownerLocked:
        frame && technicalNote
          ? Boolean(readValue(frame, "lockedBySelf"))
          : Boolean(owner.lockedBySelf),
      ownerXYWH: frame ? ownerBound.serialize() : null,
      technicalNote,
    };
    decisions.push({ kind: "migrate", plan });
    if (frame) {
      const plans = migratingByFrame.get(frame.id) ?? [];
      plans.push(plan);
      migratingByFrame.set(frame.id, plans);
    }
  }

  const migrations = decisions.flatMap((decision) =>
    decision.kind === "migrate" ? [decision.plan] : [],
  );
  const framesToClean = [...migratingByFrame.entries()].flatMap(
    ([frameId, plans]) => {
      const frame = plans[0]?.frame;
      if (!frame || plans.length !== referenceCounts.get(frameId)) return [];
      const adoptedIds = new Set(
        plans.flatMap((plan) =>
          plan.createElements.length === 0 ? [...plan.childIds] : [],
        ),
      );
      const deleteIds: string[] = [];
      const foreignIds: string[] = [];
      for (const childId of frame.childIds) {
        const child = surface.getElementById(childId);
        if (!child || adoptedIds.has(childId)) continue;
        if (elementIdentity(child)) deleteIds.push(childId);
        else foreignIds.push(childId);
      }
      return [{ deleteIds, foreignIds, frame, frameId }];
    },
  );

  const applyPlan = () => {
    for (const plan of migrations) {
      for (const element of plan.createElements) {
        // This is deterministic migration, not duplication: connector targets
        // already reference these planned IDs on every collaborating client.
        surface.addElement(
          { ...element.props, type: element.type },
          { id: element.id },
        );
      }
      if (plan.createNote) {
        store.addBlock(
          "myoxus:note",
          {
            children: [plan.owner],
            displayMode: NoteDisplayMode.DocAndEdgeless,
            id: plan.createNote.id,
            xywh: plan.createNote.bound,
          },
          plan.createNote.parent,
        );
        store.updateBlock(plan.createNote.oldParent, {
          children: plan.createNote.oldParent.children.filter(
            (child) => child.id !== plan.owner.id,
          ),
        });
      } else if (plan.moveToSurface) {
        store.moveBlocks([plan.owner], surface);
      } else if (
        plan.technicalNote &&
        !plan.createElements.length &&
        !plan.childIds.length
      ) {
        plan.technicalNote.props.displayMode = NoteDisplayMode.DocAndEdgeless;
        plan.technicalNote.xywh = plan.ownerXYWH ?? plan.technicalNote.xywh;
      }
      if (plan.ownerXYWH) plan.owner.xywh = plan.ownerXYWH;
      if (plan.ownerIndex) plan.owner.index = plan.ownerIndex;
      plan.owner.lockedBySelf = plan.ownerLocked;
      plan.owner.props.childElementIds = Object.fromEntries(
        plan.childIds.map((id) => [id, true]),
      );
      plan.owner.yBlock.delete("prop:reference");
      if (plan.moveToSurface && plan.technicalNote) {
        store.deleteBlock(plan.technicalNote, { deleteChildren: false });
      }
    }

    for (const { deleteIds, foreignIds, frame, frameId } of framesToClean) {
      for (const childId of deleteIds) surface.deleteElement(childId);
      frame.props.childElementIds = Object.fromEntries(
        foreignIds.map((id) => [id, true]),
      );
      if (foreignIds.length === 0) {
        store.deleteBlock(frameId, { deleteChildren: false });
      }
    }
  };

  return { applyPlan, decisions, hasWrites: migrations.length > 0 };
}

export function migrateLinkedMermaidOwners(store: Store) {
  const plan = planLinkedMermaidOwnerMigration(store);
  if (plan.hasWrites) store.transact(plan.applyPlan, false);
  return plan.decisions;
}
