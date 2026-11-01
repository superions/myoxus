import { getSurfaceBlock } from "@virgultum/block-surface";
import type { MermaidBlockModel } from "@virgultum/model";
import type { Command } from "@virgultum/std";
import { resolveMermaidSourceLifecycle } from "../families/runtime/source-lifecycle.js";
import {
  MermaidGfxThemeUnavailableError,
  resolveMermaidGfxTheme,
} from "../mermaid-gfx-theme.js";
import { prepareMermaidGfxVisualTransfer } from "../mermaid-gfx-graph-adapters.js";
import { getMermaidVisualModel } from "./model-resolution.js";
import { resolveMermaidEffectiveBlockTitle } from "../mermaid-title-projection.js";
import { getMermaidBlockSource, hashMermaidSource } from "../utils.js";
import {
  materializeMermaidVisualModelWithStd,
  mermaidProjectionOwnerAppearanceMatchesTheme,
  mermaidProjectionOwnerMatchesVisualModel,
  preserveMermaidProjectionOwnerGeometry,
  readMermaidVisualModelFromProjectionGroup,
  reconcileMermaidProjectionOwnerWithVisualModel,
  removeMermaidProjectionOwnerChildren,
  type MermaidMaterializationResult,
  updateMermaidBlockVisualProps,
} from "./materialization.js";
import { resolveMermaidGfxProjectionOwner } from "../presentation/gfx-projection-owner.js";
import { readMermaidLegacyReference } from "../presentation/legacy-linked-owner.js";
import { canProjectMermaidNatively } from "../presentation/owner.js";
export const ensureMermaidProjectionOwnerCommand: Command<
  {
    capture?: boolean;
    model: MermaidBlockModel;
    preferSource?: boolean;
  },
  {
    changed: boolean;
  }
> = (ctx, next) => {
  const source = getMermaidBlockSource(ctx.model.props);
  if (!source.trim() || !getSurfaceBlock(ctx.std.store)) return;
  try {
    resolveMermaidGfxTheme();
  } catch (error) {
    if (!(error instanceof MermaidGfxThemeUnavailableError)) throw error;
    next({
      changed: false,
    });
    return;
  }
  const sourceHash = hashMermaidSource(source);
  const sourceChanged = ctx.model.props.sourceHash !== sourceHash;
  const directOwner = resolveMermaidGfxProjectionOwner(ctx.model);
  const usesDirectOwner = Boolean(
    directOwner &&
    (directOwner.childElementIds.length > 0 ||
      !readMermaidLegacyReference(ctx.model)),
  );
  if (directOwner && usesDirectOwner) {
    const lifecycle = resolveMermaidSourceLifecycle(source);
    const parent = ctx.std.store.getParent(ctx.model);
    const nativeOwner = parent?.flavour === "myoxus:surface";
    const retainedLifecycle = ctx.model.props.lastValidSource
      ? resolveMermaidSourceLifecycle(ctx.model.props.lastValidSource)
      : null;
    const changesNativeFamily = Boolean(
      nativeOwner &&
      retainedLifecycle &&
      canProjectMermaidNatively(retainedLifecycle.resolution) &&
      (!canProjectMermaidNatively(lifecycle.resolution) ||
        lifecycle.resolution.diagramType !==
          retainedLifecycle.resolution.diagramType),
    );
    if (!lifecycle.canReconcileProjection || changesNativeFamily) {
      next({ changed: false });
      return;
    }
    if (!canProjectMermaidNatively(lifecycle.resolution)) {
      if (nativeOwner) {
        next({ changed: false });
        return;
      }
      const changed = directOwner.childElementIds.length > 0;
      if (changed) {
        if (ctx.capture !== false) ctx.std.store.captureSync();
        removeMermaidProjectionOwnerChildren(ctx, directOwner.model);
        ctx.model.props.lastValidSource = source;
        updateMermaidBlockVisualProps(ctx.model, source, null);
        if (ctx.capture !== false) ctx.std.store.captureSync();
      }
      next({ changed });
      return;
    }
    // A scheduled ensure follows semantic edits and reloads. Resolve persisted
    // bindings before matching children; a cold parse would replace retained
    // C4 objects and discard their manually positioned geometry.
    const resolvedVisualModel = getMermaidVisualModel(ctx.model);
    const visualModel = resolvedVisualModel
      ? prepareMermaidGfxVisualTransfer(source, resolvedVisualModel)
      : null;
    if (!visualModel) {
      next({ changed: false });
      return;
    }
    // Page and native owners share title semantics. Only title rendering is
    // native-only; otherwise a Page edit writes a title that every subsequent
    // ensure mistakes for a Source change and reflows user geometry.
    visualModel.diagramTitle = resolveMermaidEffectiveBlockTitle(
      ctx.model.props,
    );
    const run = (fn: () => void) => {
      // Derived reconciliation uses one untracked Y.Doc transaction, including
      // nested child updates from other Store wrappers of the same document.
      if (ctx.capture === false) ctx.std.store.transact(fn, false);
      else fn();
    };
    if (directOwner.childElementIds.length === 0) {
      let materialized: MermaidMaterializationResult | null = null;
      run(() => {
        if (ctx.capture !== false) ctx.std.store.captureSync();
        materialized = materializeMermaidVisualModelWithStd(
          ctx,
          source,
          visualModel,
          directOwner,
        );
        if (materialized) {
          ctx.model.props.lastValidSource = source;
          updateMermaidBlockVisualProps(
            ctx.model,
            source,
            materialized.visualModel,
          );
        }
        if (ctx.capture !== false) ctx.std.store.captureSync();
      });
      next({ changed: Boolean(materialized) });
      return;
    }
    const ownerAnchorModel = readMermaidVisualModelFromProjectionGroup(
      ctx.std.store,
      directOwner.model,
      visualModel,
    );
    if (!ownerAnchorModel) {
      next({ changed: false });
      return;
    }
    const projectedVisualModel = preserveMermaidProjectionOwnerGeometry(
      ctx.std.store,
      directOwner.model,
      visualModel,
    );
    const ownerMatchesSource = mermaidProjectionOwnerMatchesVisualModel(
      ctx.std.store,
      directOwner.model,
      projectedVisualModel,
    );
    const themeChanged = !mermaidProjectionOwnerAppearanceMatchesTheme(
      ctx.std.store,
      directOwner.model,
      projectedVisualModel,
    );
    const shouldReconcile = Boolean(
      ctx.preferSource || sourceChanged || themeChanged || !ownerMatchesSource,
    );
    run(() => {
      if (shouldReconcile) {
        if (ctx.capture !== false) ctx.std.store.captureSync();
        reconcileMermaidProjectionOwnerWithVisualModel(
          ctx,
          directOwner.model,
          projectedVisualModel,
          ownerAnchorModel,
        );
      }
      ctx.model.props.lastValidSource = source;
      updateMermaidBlockVisualProps(ctx.model, source, projectedVisualModel);
      if (shouldReconcile && ctx.capture !== false) {
        ctx.std.store.captureSync();
      }
    });
    next({ changed: shouldReconcile });
    return;
  }
  next({ changed: false });
};
