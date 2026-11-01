import {
  reconcileTypeOwnedMermaidGeometryGesture,
  usesTypeOwnedMermaidDocumentHistory,
} from "../families/runtime/gfx-owner-hooks.js";
import { editorToast } from "@virgultum/shared/utils";
import type { MermaidBlockModel } from "@virgultum/model";
import type { Command } from "@virgultum/std";
import type { MermaidVisualHistoryModel } from "../mermaid-block-constants.js";
import {
  createMermaidGfxModelHash,
  type MermaidVisualModel,
} from "../families/runtime/gfx-model.js";
import { detectMermaidDiagramType } from "../engine/diagram-types.js";
import {
  canonicalizeTypeOwnedMermaidVisualProjectionAfterSourceWrite,
  hasValidTypeOwnedMermaidGfxGeometry,
  shouldPreserveTypeOwnedProjectionOwnerForInvalidSource,
  typeOwnedMermaidVisualMutationRejectedMessage,
} from "../families/runtime/gfx-owner-hooks.js";
import { mermaidMessages } from "../i18n.js";
import {
  applyMermaidGfxVisualToSource,
  mermaidGfxCommittedSource,
  mermaidGfxPreservesSourceBytes,
  parseMermaidSourceToGfxVisualModel,
} from "../mermaid-gfx-graph-adapters.js";
import { cloneMermaidVisualModel as cloneVisualModel } from "../mermaid-visual-model-operations.js";
import { resolveMermaidEffectiveBlockTitle } from "../mermaid-title-projection.js";
import { getMermaidBlockSource } from "../utils.js";
import {
  getMermaidGfxNode,
  getMermaidGfxSubgraph,
  mermaidProjectionOwnerAppearanceMatchesTheme,
  mermaidVisualModelsHaveSameSourceSemantics,
  preserveMermaidProjectionOwnerGeometry,
  reconcileMermaidProjectionOwnerWithVisualModel,
  syncSourceFromProjectionOwner,
  updateMermaidBlockVisualProps,
  getMermaidProjectionChildModel,
  readMermaidVisualModelFromProjectionGroup,
  resolveMermaidProjectionGroup,
  resolveMermaidProjectionOwnerBoundForVisualModel,
  type MermaidGfxProjectionGroup,
} from "./materialization.js";
import { getMermaidVisualModel } from "./model-resolution.js";
import { writeMermaidSourceModelState } from "../mermaid-source-write.js";
export type MermaidGfxMutationResult = {
  sourceHash: string;
  visualModelHash: string | null;
};
export function finishMermaidGfxMutation(
  ctx: Parameters<Command>[0] & {
    model: MermaidBlockModel;
  },
  projectionOwner: MermaidGfxProjectionGroup,
  expectedVisualModel?: MermaidVisualModel,
) {
  const visualModel = syncSourceFromProjectionOwner(
    ctx,
    projectionOwner,
    expectedVisualModel,
  );
  if (!visualModel) {
    const expected = getMermaidVisualModel(ctx.model);
    const message = expected
      ? typeOwnedMermaidVisualMutationRejectedMessage(expected)
      : null;
    if (message) editorToast(ctx.std.host, message);
    return null;
  }
  return {
    sourceHash: ctx.model.props.sourceHash,
    visualModelHash: createMermaidGfxModelHash(visualModel),
  };
}
export const applyMermaidVisualModelCommand: Command<
  {
    model: MermaidBlockModel;
    projectionOrigin?: { x: number; y: number };
    transientConnectorIds?: readonly string[];
    transientNodeId?: string;
    transientNodeIds?: readonly string[];
    transientSubgraphIds?: readonly string[];
    visualModel: MermaidVisualModel;
    sourceWrite?: { readonly baseSource: string; readonly source: string };
  },
  {
    applied: boolean;
    diagnostic?: string;
    sourceHash?: string;
    visualModelHash?: string;
  }
> = (ctx, next) => {
  if (
    ctx.std.store.readonly ||
    (ctx.sourceWrite &&
      getMermaidBlockSource(ctx.model.props) !== ctx.sourceWrite.baseSource)
  ) {
    next({
      applied: false,
      diagnostic: mermaidMessages.visualMutationSourceRejected(
        ctx.visualModel.diagramType,
      ),
    });
    return;
  }
  const visualModel = cloneVisualModel(ctx.visualModel);
  // Snapshot coordinates are session-local history metadata, never part of
  // Source, the persisted projection hash, or a normal semantic mutation.
  delete (visualModel as MermaidVisualHistoryModel).projectionOrigin;
  visualModel.diagramTitle = resolveMermaidEffectiveBlockTitle(ctx.model.props);
  if (
    !hasValidTypeOwnedMermaidGfxGeometry(visualModel) ||
    (ctx.projectionOrigin &&
      (!Number.isFinite(ctx.projectionOrigin.x) ||
        !Number.isFinite(ctx.projectionOrigin.y)))
  ) {
    next({
      applied: false,
      diagnostic: mermaidMessages.visualMutationInvalidGeometry(
        visualModel.diagramType,
      ),
    });
    return;
  }
  let source: string;
  let checkedVisualModel = visualModel;
  let reparsed: ReturnType<typeof parseMermaidSourceToGfxVisualModel>;
  try {
    if (ctx.sourceWrite) source = ctx.sourceWrite.source;
    else {
      const checked = applyMermaidGfxVisualToSource(
        getMermaidBlockSource(ctx.model.props),
        visualModel,
      );
      source = mermaidGfxCommittedSource(checked.source, visualModel);
      checkedVisualModel = checked.visualModel ?? visualModel;
      checkedVisualModel.diagramTitle = visualModel.diagramTitle;
    }
    reparsed = parseMermaidSourceToGfxVisualModel(source);
  } catch {
    next({
      applied: false,
      diagnostic: mermaidMessages.visualMutationSourceRejected(
        visualModel.diagramType,
      ),
    });
    return;
  }
  if (!reparsed.model || reparsed.diagramType !== visualModel.diagramType) {
    next({
      applied: false,
      diagnostic: mermaidMessages.visualMutationSourceReparseRejected(
        visualModel.diagramType,
      ),
    });
    return;
  }
  const projectionOwner = resolveMermaidProjectionGroup(
    ctx.model,
    ctx.sourceWrite ? source : undefined,
  );
  if (!projectionOwner) {
    next({
      applied: false,
      diagnostic: mermaidMessages.visualMutationOwnerUnavailable(
        visualModel.diagramType,
      ),
    });
    return;
  }
  const committedVisualModel =
    canonicalizeTypeOwnedMermaidVisualProjectionAfterSourceWrite(
      reparsed.model,
      checkedVisualModel,
      source,
    );
  const currentVisualModel = getMermaidVisualModel(ctx.model);
  // The parsed Source model is deliberately cold geometry. Compare the
  // candidate with the live projection owner so an explicit layout can never
  // be mistaken for a no-op merely because it equals the parser's fresh layout.
  const ownerAnchorModel = readMermaidVisualModelFromProjectionGroup(
    ctx.std.store,
    projectionOwner,
    currentVisualModel,
    ctx.model.props.diagramType,
  );
  // A populated owner is authoritative. Cold parser coordinates must never
  // replace it while its persisted children are still loading.
  if (projectionOwner.childIds.length > 0 && !ownerAnchorModel) {
    next({ applied: false });
    return;
  }
  const activeVisualModel =
    ownerAnchorModel ??
    (projectionOwner.childIds.length === 0 ? currentVisualModel : null);
  if (
    !ctx.projectionOrigin &&
    activeVisualModel &&
    createMermaidGfxModelHash(activeVisualModel) ===
      createMermaidGfxModelHash(committedVisualModel) &&
    mermaidGfxCommittedSource(
      getMermaidBlockSource(ctx.model.props),
      committedVisualModel,
    ) === source
  ) {
    next({
      applied: false,
    });
    return;
  }
  ctx.std.store.captureSync();
  ctx.std.store.transact(() => {
    const transientNodeIds = new Set([
      ...(ctx.transientNodeIds ?? []),
      ...(ctx.transientNodeId ? [ctx.transientNodeId] : []),
    ]);
    for (const transientNodeId of transientNodeIds) {
      const transientNode = getMermaidGfxNode(
        ctx.std.store,
        projectionOwner,
        transientNodeId,
      ) as { pop?: (prop: string) => void } | undefined;
      transientNode?.pop?.("xywh");
    }
    for (const connectorId of ctx.transientConnectorIds ?? []) {
      const connector = getMermaidProjectionChildModel(
        ctx.std.store,
        projectionOwner,
        connectorId,
      ) as { pop?: (prop: string) => void } | null;
      connector?.pop?.("labelXYWH");
      connector?.pop?.("xywh");
    }
    for (const subgraphId of ctx.transientSubgraphIds ?? []) {
      const subgraph = getMermaidGfxSubgraph(
        ctx.std.store,
        projectionOwner,
        subgraphId,
      ) as { pop?: (prop: string) => void } | undefined;
      subgraph?.pop?.("xywh");
    }
    reconcileMermaidProjectionOwnerWithVisualModel(
      ctx,
      projectionOwner,
      committedVisualModel,
      ownerAnchorModel ?? currentVisualModel ?? committedVisualModel,
      ctx.projectionOrigin,
    );
    // The checked writer has already advanced record bindings to this Source.
    // A second generation against the old Source would treat an edited record
    // as a new relation and append it instead of committing the checked patch.
    const state = writeMermaidSourceModelState(ctx.model, source, {
      preserveSourceBytes:
        Boolean(ctx.sourceWrite) ||
        mermaidGfxPreservesSourceBytes(committedVisualModel),
    });
    updateMermaidBlockVisualProps(
      ctx.model,
      state.source,
      committedVisualModel,
    );
  });
  ctx.std.store.captureSync();
  next({
    applied: true,
    sourceHash: ctx.model.props.sourceHash,
    visualModelHash: createMermaidGfxModelHash(committedVisualModel),
  });
};
export const syncMermaidVisualModelFromProjectionOwnerCommand: Command<
  {
    model: MermaidBlockModel;
    gestureBefore?: MermaidVisualModel | null;
  },
  {
    sourceHash: string;
    synced: boolean;
    visualModelHash: string | null;
    visualsReprojected?: boolean;
  }
> = (ctx, next) => {
  // Owner-projection events are debounced. An undo can delete the owner before a
  // queued event runs, leaving the callback with a detached model whose Y.Text
  // has already been cleared. Only the model currently owned by the store may
  // write source state or create a history transaction.
  if (ctx.std.store.getBlock(ctx.model.id)?.model !== ctx.model) return;
  const projectionOwner = resolveMermaidProjectionGroup(ctx.model);
  if (!projectionOwner) return;
  const currentSource = getMermaidBlockSource(ctx.model.props);
  const previousModel = getMermaidVisualModel(ctx.model);
  const currentDiagramType = detectMermaidDiagramType(currentSource);
  if (
    shouldPreserveTypeOwnedProjectionOwnerForInvalidSource(
      currentDiagramType,
    ) &&
    previousModel?.diagramType !== currentDiagramType
  ) {
    next({
      sourceHash: ctx.model.props.sourceHash,
      synced: false,
      visualModelHash: previousModel
        ? createMermaidGfxModelHash(previousModel)
        : null,
    });
    return;
  }
  let visualModel = readMermaidVisualModelFromProjectionGroup(
    ctx.std.store,
    projectionOwner,
    previousModel,
    ctx.model.props.diagramType,
  );
  if (!visualModel) return;
  const liveHash = createMermaidGfxModelHash(visualModel);
  if (ctx.gestureBefore)
    visualModel = reconcileTypeOwnedMermaidGeometryGesture(
      ctx.gestureBefore,
      visualModel,
    );
  const geometryAdjusted = liveHash !== createMermaidGfxModelHash(visualModel);
  if (
    !mermaidProjectionOwnerAppearanceMatchesTheme(
      ctx.std.store,
      projectionOwner,
      previousModel ?? visualModel,
    )
  ) {
    const source = currentSource;
    const projectedModel = previousModel
      ? preserveMermaidProjectionOwnerGeometry(
          ctx.std.store,
          projectionOwner,
          previousModel,
        )
      : visualModel;
    ctx.std.store.transact(() => {
      reconcileMermaidProjectionOwnerWithVisualModel(
        ctx,
        projectionOwner,
        projectedModel,
        visualModel,
      );
      updateMermaidBlockVisualProps(ctx.model, source, projectedModel);
    }, false);
    next({
      sourceHash: ctx.model.props.sourceHash,
      synced: false,
      visualModelHash: createMermaidGfxModelHash(projectedModel),
      visualsReprojected: true,
    });
    return;
  }
  // Geometry is owner state, but it is not Mermaid source syntax. Surface
  // observers also report renderer-local appearance and selection-adjacent
  // updates. When the existing type-owned comparison proves that source
  // semantics are unchanged, persist only genuine owner-model drift and keep
  // the user's source byte-for-byte intact instead of canonicalizing it.
  if (
    previousModel &&
    mermaidVisualModelsHaveSameSourceSemantics(visualModel, previousModel)
  ) {
    const previousVisualModelHash = createMermaidGfxModelHash(previousModel);
    const visualModelHash = createMermaidGfxModelHash(visualModel);
    if (visualModelHash !== previousVisualModelHash) {
      const documentHistory =
        usesTypeOwnedMermaidDocumentHistory(currentDiagramType);
      // Native GFX already committed the geometry gesture. Source-owned
      // families derive owner/compartment state from that entry; recording this
      // readback separately would require two undos and clear redo on replay.
      if (!documentHistory) ctx.std.store.captureSync();
      ctx.std.store.transact(() => {
        if (
          geometryAdjusted ||
          resolveMermaidProjectionOwnerBoundForVisualModel(
            projectionOwner,
            visualModel,
            visualModel,
          ).serialize() !== projectionOwner.xywh
        ) {
          // Geometry-only native edits keep Source untouched but still need
          // the enclosing owner/title to follow the live child extents.
          reconcileMermaidProjectionOwnerWithVisualModel(
            ctx,
            projectionOwner,
            visualModel,
            visualModel,
          );
        }
        updateMermaidBlockVisualProps(ctx.model, currentSource, visualModel);
      }, !documentHistory);
      if (!documentHistory) ctx.std.store.captureSync();
    }
    next({
      sourceHash: ctx.model.props.sourceHash,
      synced: visualModelHash !== previousVisualModelHash,
      visualModelHash,
    });
    return;
  }
  const previousSource = getMermaidBlockSource(ctx.model.props);
  const previousSourceHash = ctx.model.props.sourceHash;
  const previousVisualModelHash = previousModel
    ? createMermaidGfxModelHash(previousModel)
    : null;
  let committedVisualModel: MermaidVisualModel | null = null;
  ctx.std.store.captureSync();
  ctx.std.store.transact(() => {
    // Native Edgeless text editing changes the visible node label before its
    // family-owned metadata. Reparse and reconcile the generated source so a
    // semantic label such as a GitGraph commit message is persisted in both
    // the source and the owner familyData before cold reload.
    committedVisualModel = syncSourceFromProjectionOwner(ctx, projectionOwner);
  });
  ctx.std.store.captureSync();
  if (!committedVisualModel) return;
  const synced =
    getMermaidBlockSource(ctx.model.props) !== previousSource ||
    ctx.model.props.sourceHash !== previousSourceHash ||
    createMermaidGfxModelHash(committedVisualModel) !== previousVisualModelHash;
  next({
    sourceHash: ctx.model.props.sourceHash,
    synced,
    visualModelHash: createMermaidGfxModelHash(committedVisualModel),
  });
};
export { getMermaidVisualModel } from "./model-resolution.js";
