import { mermaidRuntimePreservesSourceBytes } from "../families/runtime/factory.js";
// SPDX-License-Identifier: AGPL-3.0-or-later

import type { MermaidBlockModel } from "@virgultum/model";
import type { ToolbarContext } from "@virgultum/shared/services";

import { detectMermaidDiagramType } from "../engine/diagram-types.js";
import { isMermaidProductDiagramType } from "../engine/product-types.js";
import type { MermaidVisualModel } from "../families/runtime/gfx-model.js";
import type { MermaidFamilyRuntime } from "../families/runtime/contracts.js";
import { getMermaidFamilyRuntime } from "../families/runtime/registry.js";
import { resolveMermaidSourceLifecycle } from "../families/runtime/source-lifecycle.js";
import {
  beginMermaidRuntimeTransaction,
  commitMermaidRuntimeTransaction,
} from "../families/runtime/transaction.js";
import {
  getMermaidSourceAuthoritativeVisualModel,
  getMermaidVisualModelForEditing,
} from "../commands.js";
import {
  resolveNativeMermaidOwnerForSelection,
  type MermaidNativeEdgelessOwner,
} from "../presentation/edgeless-owner-resolution.js";
import {
  canMutateMermaidGfxOwnerSource,
  canProjectMermaidNatively,
  isMermaidBlockModel,
} from "../presentation/owner.js";
import { getMermaidBlockSource } from "../utils.js";

export type MermaidEdgelessSelectionContext = {
  readonly diagramType: ReturnType<typeof detectMermaidDiagramType>;
  readonly owner: MermaidBlockModel;
  readonly runtime: MermaidFamilyRuntime;
  readonly projection: MermaidNativeEdgelessOwner;
  readonly selectedModels: ReturnType<ToolbarContext["getSurfaceModels"]>;
  readonly visualModel: MermaidVisualModel | null;
};

export function resolveMermaidEdgelessOwnerSelection(context: ToolbarContext) {
  return resolveNativeMermaidOwnerForSelection(
    context.store,
    context.getSurfaceModels(),
    context.getCurrentModel(),
  );
}

export function resolveMermaidEdgelessExportOwner(context: ToolbarContext) {
  const native = resolveMermaidEdgelessOwnerSelection(context)?.model;
  if (native) return native;

  const current = context.getCurrentModel();
  if (
    isMermaidBlockModel(current) &&
    current.store.getParent(current.id)?.flavour === "myoxus:note"
  ) {
    // The embedded React action slot owns export while the Mermaid child is
    // actively edited. Keeping the root Note export visible here would project
    // the same owner action twice.
    return null;
  }

  const selectedModels = context.getSurfaceModels();
  const selectedModel = selectedModels[0];
  const selectedNote =
    selectedModels.length === 1 &&
    selectedModel &&
    "flavour" in selectedModel &&
    selectedModel.flavour === "myoxus:note"
      ? selectedModel
      : null;
  if (!selectedNote) return null;

  const embeddedOwners = context.store
    .getBlocksByFlavour("myoxus:mermaid")
    .map(({ model }) => model)
    .filter(
      (model): model is MermaidBlockModel =>
        isMermaidBlockModel(model) &&
        model.store.getParent(model.id)?.id === selectedNote.id,
    );
  return embeddedOwners.length === 1 ? embeddedOwners[0] : null;
}

export function resolveMermaidEdgelessSelection(
  context: ToolbarContext,
): MermaidEdgelessSelectionContext | null {
  const selectedModels = context.getSurfaceModels();
  const projection = resolveMermaidEdgelessOwnerSelection(context);
  if (!projection) return null;
  const owner = projection.model;

  const source = getMermaidBlockSource(owner.props);
  const lifecycle = resolveMermaidSourceLifecycle(source);
  if (
    !lifecycle.canReconcileProjection ||
    !canProjectMermaidNatively(lifecycle.resolution) ||
    !canMutateMermaidGfxOwnerSource({
      lastValidSource: owner.props.lastValidSource,
      parent: owner.store.getParent(owner.id),
      source,
    })
  ) {
    return null;
  }
  const diagramType = detectMermaidDiagramType(source);
  if (!isMermaidProductDiagramType(diagramType)) return null;
  const runtime = getMermaidFamilyRuntime(diagramType);
  if (!runtime) return null;
  let visualModel: MermaidVisualModel | null | undefined;
  return {
    diagramType,
    owner,
    projection,
    runtime,
    selectedModels,
    // Toolbar family/visibility resolution needs the owner, not a complete
    // geometry readback for every candidate action. Resolve it only for an
    // action that actually consumes the current graph; never cache across
    // selection resolution calls or source/Surface changes.
    get visualModel() {
      return visualModel === undefined
        ? (visualModel = getMermaidVisualModelForEditing(context.std, owner))
        : visualModel;
    },
  };
}

export function runMermaidEdgelessMutation(
  context: ToolbarContext,
  owner: MermaidBlockModel,
  run: () => boolean,
  sourceWrite?: { readonly baseSource: string; readonly source: string },
) {
  if (context.readonly || owner.isLocked()) return false;
  const currentSource = getMermaidBlockSource(owner.props);
  if (sourceWrite && sourceWrite.baseSource !== currentSource) return false;
  const lifecycle = resolveMermaidSourceLifecycle(
    sourceWrite?.source ?? currentSource,
  );
  if (
    !lifecycle.canReconcileProjection ||
    !canProjectMermaidNatively(lifecycle.resolution) ||
    !canMutateMermaidGfxOwnerSource({
      lastValidSource: owner.props.lastValidSource,
      parent: owner.store.getParent(owner.id),
      source: sourceWrite?.source ?? currentSource,
    })
  ) {
    return false;
  }
  const beforeVisualModel = getMermaidSourceAuthoritativeVisualModel(
    context.std,
    owner,
  );
  const transaction = beginMermaidRuntimeTransaction({
    currentSource: getMermaidBlockSource(owner.props),
    currentVisualModel: beforeVisualModel,
    readonly: context.readonly,
    options: {
      sourceWrite,
      preserveSourceBytes:
        !!sourceWrite ||
        mermaidRuntimePreservesSourceBytes(
          lifecycle.resolution.runtime,
          lifecycle.resolution.diagramType,
        ),
    },
  });
  if (!transaction) return false;
  const applied = run();
  return Boolean(
    commitMermaidRuntimeTransaction({
      applied,
      currentSource: getMermaidBlockSource(owner.props),
      currentVisualModel: applied
        ? getMermaidSourceAuthoritativeVisualModel(context.std, owner)
        : beforeVisualModel,
      owner,
      transaction,
    }),
  );
}
