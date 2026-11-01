import { getMermaidGfxFamilyHooks } from "../families/runtime/gfx-family-hooks-registry.js";
import type { MermaidVisualModel } from "../families/runtime/gfx-model.js";
import { prepareMermaidOwnerCopy } from "./copy-identities.js";
import {
  DefaultTool,
  EdgelessCRUDIdentifier,
  getSurfaceBlock,
} from "@virgultum/block-surface";
import { Bound } from "@virgultum/global/gfx";
import {
  NoteBlockModel,
  NoteDisplayMode,
  ParagraphBlockModel,
} from "@virgultum/model";
import { BlockSelection, type Command } from "@virgultum/std";
import { GfxControllerIdentifier } from "@virgultum/std/gfx";
import type { BlockModel } from "@virgultum/store";
import { DEFAULT_MERMAID_FLOWCHART_SOURCE } from "../families/flowchart/defaults.js";
import { resolveMermaidFamilyRuntime } from "../families/runtime/registry.js";
import { parseMermaidSourceToGfxVisualModel } from "../mermaid-gfx-graph-adapters.js";
import {
  coerceMermaidSource,
  getMermaidBlockSource,
  getMermaidBlockTitle,
} from "../utils.js";
import {
  cleanupPartialMermaidOwner,
  createMermaidBlockInsertProps,
  createMermaidOwnerDuplicatePlan,
  duplicateMermaidOwnerChildren,
  findMermaidDuplicateBound,
  findMermaidInsertBound,
  getMermaidCommandModels,
  getNoteCollisionBoxes,
  materializeMermaidVisualModelWithStd,
  type MermaidCompoundCommandOptions,
} from "./materialization.js";
import { resolveMermaidBlockInsertIdentity } from "../mermaid-insert-identity.js";
import {
  canProjectMermaidNatively,
  isMermaidBlockModel,
  resolveMermaidOwnerPresentation,
} from "../presentation/owner.js";
import { resolveMermaidGfxProjectionOwner } from "../presentation/gfx-projection-owner.js";
import { resolveMermaidLegacyLinkedOwner } from "../presentation/legacy-linked-owner.js";
export type InsertMermaidBlockOptions = {
  place?: "after" | "before";
  removeEmptyLine?: boolean;
  selectedModels?: BlockModel[];
  source?: string;
  title?: string;
  visualModel?: MermaidVisualModel;
};
export type InsertMermaidEdgelessDiagramOptions = {
  /** Creation-only cleanup. Revalidated after materialization; never moves content. */
  replaceEmptyNoteId?: string;
  position?: { x: number; y: number };
  source?: string;
  title?: string;
  visualModel?: MermaidVisualModel;
};
export type InsertedMermaidDiagram = {
  blockId: string;
  connectorIds: string[];
  elementIds: string[];
  ownerId: string;
  shapeIds: string[];
  sourceHash: string;
  visualModelHash: string | null;
};
export type DeletedMermaidDiagram = {
  blockId: string;
  elementIds: string[];
  ownerId: string;
};
export type DuplicatedMermaidDiagram = {
  blockId: string;
  connectorIds: string[];
  elementIds: string[];
  ownerId: string;
  originalBlockId: string;
  originalOwnerId: string;
  shapeIds: string[];
};
function insertVisualModel(
  ctx: {
    visualModel?: MermaidVisualModel;
    std: import("@virgultum/std").BlockStdScope;
  },
  source: string,
  fallback: MermaidVisualModel,
) {
  return (
    ctx.visualModel ??
    getMermaidGfxFamilyHooks(fallback)?.prepareInsertProjection?.(
      source,
      fallback,
      ctx.std.provider,
    ) ??
    fallback
  );
}

export const deleteMermaidBlockCommand: Command<
  MermaidCompoundCommandOptions,
  {
    deletedMermaidDiagrams: DeletedMermaidDiagram[];
  }
> = (ctx, next) => {
  if (ctx.std.store.readonly) return;
  const models = getMermaidCommandModels(ctx);
  if (models.length === 0) return;
  const targets = models.map((model) => {
    const direct = resolveMermaidGfxProjectionOwner(model);
    const legacy = resolveMermaidLegacyLinkedOwner(model);
    return direct && !legacy
      ? {
          block: model,
          childIds: [...direct.childElementIds],
        }
      : null;
  });
  if (targets.some((target) => !target)) {
    console.warn(
      "[mermaid:block] delete blocked: retained legacy-linked owner is display-only",
    );
    return;
  }
  const ready = targets.filter(
    (target): target is NonNullable<(typeof targets)[number]> =>
      Boolean(target),
  );
  const deletedMermaidDiagrams: DeletedMermaidDiagram[] = ready.map(
    ({ block, childIds }) => ({
      blockId: block.id,
      elementIds: childIds,
      ownerId: block.id,
    }),
  );
  const crud = ctx.std.get(EdgelessCRUDIdentifier);
  ctx.std.store.captureSync();
  ctx.std.store.transact(() => {
    for (const { block, childIds } of ready) {
      for (const childId of [...childIds].reverse()) {
        crud.removeElement(childId);
      }
      ctx.std.store.deleteBlock(block);
    }
  });
  ctx.std.selection.clear();
  ctx.std.store.captureSync();
  next({
    deletedMermaidDiagrams,
  });
};
export const duplicateMermaidBlockCommand: Command<
  MermaidCompoundCommandOptions,
  {
    duplicatedMermaidDiagrams: DuplicatedMermaidDiagram[];
  }
> = (ctx, next) => {
  if (ctx.std.store.readonly) return;
  const models = getMermaidCommandModels(ctx);
  if (models.length === 0) return;
  const plans = models.map((sourceBlock) => {
    const parent = ctx.std.store.getParent(sourceBlock);
    if (
      parent?.flavour === "myoxus:surface" &&
      resolveMermaidOwnerPresentation({
        lastValidSource: sourceBlock.props.lastValidSource,
        parent,
        source: getMermaidBlockSource(sourceBlock.props),
      }) !== "native-edgeless"
    ) {
      return null;
    }
    const direct = resolveMermaidGfxProjectionOwner(sourceBlock);
    const legacy = resolveMermaidLegacyLinkedOwner(sourceBlock);
    const projectionOwner = legacy?.frame ?? direct?.model ?? null;
    const childPlan = projectionOwner
      ? createMermaidOwnerDuplicatePlan(projectionOwner)
      : { snapshots: [] };
    const copy =
      childPlan &&
      prepareMermaidOwnerCopy(
        getMermaidBlockSource(sourceBlock.props),
        sourceBlock.props.familyData,
        sourceBlock.props.comments,
      );
    return childPlan && copy
      ? {
          childPlan: {
            snapshots: childPlan.snapshots.map((snapshot) => ({
              ...snapshot,
              ...copy.remapElement(snapshot),
            })),
          },
          copy,
          projectionOwner,
          sourceBlock,
        }
      : null;
  });
  const missingPlan = plans.findIndex((plan) => !plan);
  if (missingPlan !== -1) {
    console.warn(
      `[mermaid:block] duplicate blocked: block=${models[missingPlan].id}, reason=invalid owner parent/source contract or non-serializable foreign child`,
    );
    return;
  }
  const duplicatedMermaidDiagrams: DuplicatedMermaidDiagram[] = [];
  ctx.std.store.captureSync();
  for (const candidate of plans) {
    if (!candidate) continue;
    const { childPlan, copy, projectionOwner, sourceBlock } = candidate;
    const source = getMermaidBlockSource(sourceBlock.props);
    let blockId: string | null = null;
    let elementIds: string[] = [];
    try {
      const parent = ctx.std.store.getParent(sourceBlock);
      if (!parent) throw new Error("Mermaid duplicate requires a parent");
      const sourceBound = Bound.deserialize(
        projectionOwner?.xywh ?? sourceBlock.xywh,
      );
      const targetBound =
        parent.flavour === "myoxus:surface"
          ? findMermaidDuplicateBound(ctx, sourceBound)
          : sourceBound;
      const insertProps = createMermaidBlockInsertProps({
        source,
        title: getMermaidBlockTitle(sourceBlock.props),
      });
      const result = ctx.std.store.addSiblingBlocks(
        sourceBlock,
        [
          {
            ...insertProps,
            comments: copy.comments,
            familyData: copy.familyData,
            diagramType: sourceBlock.props.diagramType,
            index:
              parent.flavour === "myoxus:surface"
                ? ctx.std.get(GfxControllerIdentifier).layer.generateIndex(true)
                : sourceBlock.index,
            lastValidSource:
              sourceBlock.props.lastValidSource ?? insertProps.lastValidSource,
            lockedBySelf: sourceBlock.props.lockedBySelf,
            rotate: sourceBlock.rotate,
            source: sourceBlock.props.source.clone(),
            sourceHash: sourceBlock.props.sourceHash,
            templateId: sourceBlock.props.templateId,
            title: sourceBlock.props.title.clone(),
            xywh: targetBound.serialize(),
          },
        ],
        "after",
      );
      blockId = result[0] ?? null;
      const target = blockId ? ctx.std.store.getBlock(blockId)?.model : null;
      if (!isMermaidBlockModel(target)) {
        throw new Error("failed to add duplicated Mermaid owner");
      }
      const dx = targetBound.x - sourceBound.x;
      const dy = targetBound.y - sourceBound.y;
      const duplicated = duplicateMermaidOwnerChildren({
        ctx,
        dx,
        dy,
        plan: childPlan,
        targetOwner: target,
      });
      elementIds = duplicated.elementIds;
      duplicatedMermaidDiagrams.push({
        blockId,
        connectorIds: duplicated.connectorIds,
        elementIds,
        ownerId: blockId,
        originalBlockId: sourceBlock.id,
        originalOwnerId: sourceBlock.id,
        shapeIds: duplicated.shapeIds,
      });
    } catch (error) {
      cleanupPartialMermaidOwner(ctx, { elementIds, ownerId: blockId });
      console.error(
        `[mermaid:block] duplicate rolled back: sourceBlock=${sourceBlock.id}`,
        error,
      );
    }
  }
  const lastBlockId = duplicatedMermaidDiagrams.at(-1)?.blockId;
  if (lastBlockId) {
    ctx.std.selection.set([
      ctx.std.selection.create(BlockSelection, {
        blockId: lastBlockId,
      }),
    ]);
  }
  ctx.std.store.captureSync();
  if (duplicatedMermaidDiagrams.length === 0) return;
  next({
    duplicatedMermaidDiagrams,
  });
};
export const insertMermaidBlockCommand: Command<
  InsertMermaidBlockOptions,
  {
    insertedMermaidBlockId: string;
    insertedMermaidDiagram: InsertedMermaidDiagram;
  }
> = (ctx, next) => {
  const { place = "after", removeEmptyLine = false, selectedModels, std } = ctx;
  if (!selectedModels?.length) return;
  const targetModel =
    place === "before"
      ? selectedModels[0]
      : selectedModels[selectedModels.length - 1];
  const parent = std.store.getParent(targetModel);
  if (!parent) return;
  const identity = resolveMermaidBlockInsertIdentity({
    source: ctx.source ?? DEFAULT_MERMAID_FLOWCHART_SOURCE,
    title: ctx.title,
  });
  const source = identity.source;
  const parsed = parseMermaidSourceToGfxVisualModel(source);
  const runtimeResolution = resolveMermaidFamilyRuntime(source);
  if (runtimeResolution.kind !== "resolved") {
    console.warn(
      `[mermaid:block] insert blocked: source has no resolved runtime (${runtimeResolution.kind})`,
    );
    return;
  }
  std.store.captureSync();
  let blockId: string | null = null;
  let materialized: ReturnType<typeof materializeMermaidVisualModelWithStd> =
    null;
  try {
    const result = std.store.addSiblingBlocks(
      targetModel,
      [
        createMermaidBlockInsertProps({
          source,
          title: identity.title,
        }),
      ],
      place,
    );
    blockId = result[0] ?? null;
    if (!blockId) throw new Error("failed to add Mermaid document block");
    if (runtimeResolution.capabilities.kind === "gfx") {
      const block = std.store.getBlock(blockId)?.model;
      if (!isMermaidBlockModel(block)) {
        throw new Error("failed to resolve Mermaid projection owner");
      }
      const projectionOwner = resolveMermaidGfxProjectionOwner(block);
      if (!projectionOwner) {
        throw new Error("failed to resolve Mermaid projection surface");
      }
      materialized = materializeMermaidVisualModelWithStd(
        ctx,
        source,
        insertVisualModel(
          ctx,
          source,
          runtimeResolution.gfxVisualModel ?? parsed.model!,
        ),
        projectionOwner,
      );
      if (!materialized) throw new Error("failed to materialize Mermaid owner");
    }
    if (removeEmptyLine && targetModel.text?.length === 0) {
      std.store.deleteBlock(targetModel);
    }
  } catch (error) {
    cleanupPartialMermaidOwner(ctx, {
      elementIds: materialized?.elementIds ?? [],
      ownerId: blockId,
    });
    std.store.captureSync();
    console.error("[mermaid:block] insert rolled back", error);
    return;
  }
  std.selection.set([
    std.selection.create(BlockSelection, {
      blockId,
    }),
  ]);
  std.store.captureSync();
  next({
    insertedMermaidBlockId: blockId,
    insertedMermaidDiagram: {
      blockId,
      connectorIds: materialized?.connectorIds ?? [],
      elementIds: materialized?.elementIds ?? [],
      ownerId: blockId,
      shapeIds: materialized?.shapeIds ?? [],
      sourceHash: materialized?.sourceHash ?? parsed.sourceHash,
      visualModelHash: materialized?.visualModelHash ?? parsed.visualModelHash,
    },
  });
};
export const insertMermaidEdgelessDiagramCommand: Command<
  InsertMermaidEdgelessDiagramOptions,
  {
    insertedMermaidBlockId: string;
    insertedMermaidDiagram: InsertedMermaidDiagram;
  }
> = (ctx, next) => {
  const { std } = ctx;
  if (std.store.readonly) return;
  const identity = resolveMermaidBlockInsertIdentity({
    source: ctx.source ?? DEFAULT_MERMAID_FLOWCHART_SOURCE,
    title: ctx.title,
  });
  const source = identity.source;
  const parsed = parseMermaidSourceToGfxVisualModel(source);
  const resolution = resolveMermaidFamilyRuntime(source);
  if (resolution.kind !== "resolved") {
    console.warn(
      `[mermaid:block] edgeless insert blocked: source has no resolved runtime (${resolution.kind})`,
    );
    return;
  }
  if (
    ctx.position &&
    (!Number.isFinite(ctx.position.x) || !Number.isFinite(ctx.position.y))
  )
    return;
  const root = std.store.root;
  const surface = getSurfaceBlock(std.store);
  if (!root || !surface) return;
  const crud = std.get(EdgelessCRUDIdentifier);
  const gfx = std.get(GfxControllerIdentifier);
  std.store.captureSync();
  let blockId: string | null = null;
  let noteId: string | null = null;
  let materialized: ReturnType<typeof materializeMermaidVisualModelWithStd> =
    null;
  try {
    if (canProjectMermaidNatively(resolution)) {
      const visualModel = insertVisualModel(
        ctx,
        source,
        resolution.gfxVisualModel ?? parsed.model!,
      );
      if (!visualModel) throw new Error("missing Mermaid GFX visual model");
      blockId = crud.addBlock(
        "myoxus:mermaid",
        createMermaidBlockInsertProps({ source, title: identity.title }),
        surface,
      );
      const owner = blockId ? std.store.getBlock(blockId)?.model : null;
      if (!isMermaidBlockModel(owner)) {
        throw new Error("failed to add native Mermaid owner");
      }
      const projectionOwner = resolveMermaidGfxProjectionOwner(owner);
      if (!projectionOwner) {
        throw new Error("failed to resolve native Mermaid owner");
      }
      materialized = materializeMermaidVisualModelWithStd(
        ctx,
        source,
        visualModel,
        projectionOwner,
        ctx.position,
      );
      if (!materialized) {
        throw new Error("failed to materialize native Mermaid owner");
      }
      const bootstrap = ctx.replaceEmptyNoteId
        ? std.store.getModelById(ctx.replaceEmptyNoteId)
        : null;
      const paragraph = bootstrap?.children[0];
      // The caller supplies the original provisioning identity. An edited or
      // replaced Note survives; only its untouched empty text shell is removed
      // inside the same insert/history boundary, after the native owner exists.
      if (
        bootstrap instanceof NoteBlockModel &&
        std.store.getParent(bootstrap)?.id === root.id &&
        !bootstrap.props.lockedBySelf &&
        !Object.keys(bootstrap.props.comments ?? {}).length &&
        bootstrap.children.length === 1 &&
        paragraph instanceof ParagraphBlockModel &&
        paragraph.props.type === "text" &&
        paragraph.isEmpty() &&
        !paragraph.props.repeat &&
        !paragraph.props.markdownAnchor &&
        !Object.keys(paragraph.props.comments ?? {}).length
      ) {
        std.store.deleteBlock(bootstrap);
      }
    } else {
      const noteBound = findMermaidInsertBound(null, (bound) => [
        ...gfx.grid.search(bound).map(({ w, x }) => ({ w, x })),
        ...getNoteCollisionBoxes(std.store)
          .filter((noteBound) => noteBound.isIntersectWithBound(bound))
          .map(({ w, x }) => ({ w, x })),
      ]);
      noteId = crud.addBlock(
        "myoxus:note",
        {
          displayMode: NoteDisplayMode.DocAndEdgeless,
          hidden: false,
          xywh: noteBound.serialize(),
        },
        root,
      );
      if (!noteId) throw new Error("failed to add Mermaid note");
      blockId = std.store.addBlock(
        "myoxus:mermaid",
        createMermaidBlockInsertProps({ source, title: identity.title }),
        noteId,
      );
      if (!blockId) throw new Error("failed to add embedded Mermaid owner");
    }
  } catch (error) {
    cleanupPartialMermaidOwner(ctx, {
      elementIds: materialized?.elementIds ?? [],
      noteId,
      ownerId: blockId,
    });
    std.store.captureSync();
    console.error("[mermaid:block] edgeless insert rolled back", error);
    return;
  }
  if (!blockId) return;
  gfx.tool.setTool(DefaultTool);
  gfx.selection.set({
    elements: [noteId ?? blockId],
    editing: Boolean(noteId),
  });
  // Native owners keep the SurfaceSelection just established by GFX. A
  // content BlockSelection would replace it and hide the owner file/actions.
  if (noteId) {
    std.selection.set([
      std.selection.create(BlockSelection, {
        blockId,
      }),
    ]);
  }
  std.store.captureSync();
  next({
    insertedMermaidBlockId: blockId,
    insertedMermaidDiagram: {
      blockId,
      connectorIds: materialized?.connectorIds ?? [],
      elementIds: materialized?.elementIds ?? [],
      ownerId: blockId,
      shapeIds: materialized?.shapeIds ?? [],
      sourceHash: materialized?.sourceHash ?? parsed.sourceHash,
      visualModelHash: materialized?.visualModelHash ?? null,
    },
  });
};
export const convertMermaidCodeBlockCommand: Command<
  {
    model: BlockModel;
  },
  {
    convertedBlockId: string | null;
  }
> = (ctx, next) => {
  const raw = ctx.model as unknown as {
    props?: {
      language?: string | null;
      text?: unknown;
    };
  };
  const language = raw.props?.language?.toLowerCase();
  if (ctx.model.flavour !== "myoxus:code" || language !== "mermaid") {
    next({
      convertedBlockId: null,
    });
    return;
  }
  const source = coerceMermaidSource(raw.props?.text);
  const parent = ctx.std.store.getParent(ctx.model);
  if (!parent) return;
  const [, result] = ctx.std.command.exec(insertMermaidBlockCommand, {
    place: "after",
    removeEmptyLine: false,
    selectedModels: [ctx.model],
    source,
    title: getMermaidBlockTitle({
      title: undefined,
    }),
  });
  const blockId = result?.insertedMermaidBlockId ?? null;
  if (blockId) {
    ctx.std.store.deleteBlock(ctx.model);
  }
  next({
    convertedBlockId: blockId,
  });
};
