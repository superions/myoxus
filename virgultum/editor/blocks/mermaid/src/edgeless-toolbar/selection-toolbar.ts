// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  editorMessage,
  type ToolbarAction,
  type ToolbarActionGenerator,
  type ToolbarContext,
  type ToolbarGenericAction,
  type ToolbarModuleConfig,
  ToolbarModuleExtension,
} from "@virgultum/shared/services";
import { getMermaidFamilyRuntime } from "../families/runtime/registry.js";
import type { MermaidFamilyEdgelessToolbarContribution } from "../families/runtime/contracts.js";
import { detectMermaidDiagramType } from "../engine/diagram-types.js";
import { isMermaidProductDiagramType } from "../engine/product-types.js";
import { getMermaidBlockSource } from "../utils.js";
import { BlockFlavourIdentifier, type BlockStdScope } from "@virgultum/std";

import {
  deleteMermaidBlockCommand,
  duplicateMermaidBlockCommand,
} from "../commands.js";
import { getMermaidFamilyRuntimes } from "../families/runtime/registry.js";
import { mermaidMessages } from "../i18n.js";
import { resolveNativeMermaidOwnerForSelection } from "../presentation/edgeless-owner-resolution.js";
import {
  resolveMermaidEdgelessOwnerSelection,
  resolveMermaidEdgelessExportOwner,
  resolveMermaidEdgelessSelection,
} from "./selection-context.js";
import {
  GfxBlockElementModel,
  GfxControllerIdentifier,
  GfxPrimitiveElementModel,
} from "@virgultum/std/gfx";
import { mermaidMmdExportAction } from "./mmd-file-actions.js";

type MermaidFamilyToolbarLeaf = ToolbarAction | ToolbarActionGenerator;

function isFamilyToolbarLeaf(
  action: ToolbarGenericAction,
): action is MermaidFamilyToolbarLeaf {
  return !("actions" in action);
}

const turnFamilyConfigs = new WeakMap<
  ToolbarContext,
  {
    owner: object;
    source: string;
    lastValidSource: string | undefined;
    config: MermaidFamilyEdgelessToolbarContribution | null;
  }
>();

function selectedFamilyConfig(context: ToolbarContext) {
  const owner = resolveMermaidEdgelessOwnerSelection(context)?.model;
  if (!owner) return null;
  const source = getMermaidBlockSource(owner.props);
  const lastValidSource = owner.props.lastValidSource;
  const cached = turnFamilyConfigs.get(context);
  if (
    cached?.owner === owner &&
    cached.source === source &&
    cached.lastValidSource === lastValidSource
  )
    return cached.config;
  // One toolbar render resolves many immutable catalogue leaves. Reuse their
  // checked contribution for this turn, never an editor/geometry model. Source
  // changes within the same transaction invalidate it immediately.
  const selection = resolveMermaidEdgelessSelection(context);
  const diagramType = detectMermaidDiagramType(source);
  const retained = isMermaidProductDiagramType(diagramType)
    ? getMermaidFamilyRuntime(diagramType)?.edgelessToolbar
    : null;
  const config =
    selection?.runtime.edgelessToolbar ??
    (retained?.invalidSourceSelection ? retained : null);
  turnFamilyConfigs.set(context, { owner, source, lastValidSource, config });
  queueMicrotask(() => turnFamilyConfigs.delete(context));
  return config;
}

function selectedFamilyAction(context: ToolbarContext, id: string) {
  const action = selectedFamilyConfig(context)?.actions.find(
    (candidate): candidate is MermaidFamilyToolbarLeaf =>
      isFamilyToolbarLeaf(candidate) && candidate.id === id,
  );
  return action ?? null;
}

function selectedOwnerOnly(context: ToolbarContext) {
  const selectedModels = context.getSurfaceModels();
  const projection = resolveNativeMermaidOwnerForSelection(
    context.store,
    selectedModels,
    context.getCurrentModel(),
  );
  return projection &&
    selectedModels.length === 1 &&
    selectedModels[0]?.id === projection.model.id
    ? projection.model
    : null;
}

const mermaidSelectionToolbarConfig = {
  replaceBase: true,
  readonlySelection: (std: BlockStdScope) => {
    const gfx = std.get(GfxControllerIdentifier);
    const models = gfx.selection.selectedIds.flatMap((id) => {
      const model = gfx.getElementById(id);
      return model instanceof GfxBlockElementModel ||
        model instanceof GfxPrimitiveElementModel
        ? [model]
        : [];
    });
    const owner = resolveNativeMermaidOwnerForSelection(
      std.store,
      models,
    )?.model;
    if (!owner) return false;
    const diagramType = detectMermaidDiagramType(
      getMermaidBlockSource(owner.props),
    );
    return (
      isMermaidProductDiagramType(diagramType) &&
      getMermaidFamilyRuntime(diagramType)?.edgelessToolbar
        ?.readonlySelection === true
    );
  },
  get actions(): NonNullable<ToolbarModuleConfig["actions"]> {
    const familyActionIds = Array.from(
      new Set(
        getMermaidFamilyRuntimes().flatMap(
          (runtime) =>
            runtime.edgelessToolbar?.actions
              .filter(isFamilyToolbarLeaf)
              .map((action) => action.id) ?? [],
        ),
      ),
    );

    const suppressedBaseActionIds = Array.from(
      new Set(
        getMermaidFamilyRuntimes().flatMap(
          (runtime) => runtime.edgelessToolbar?.suppressBaseActionIds ?? [],
        ),
      ),
    );

    return [
      {
        id: "mermaid-owner.duplicate",
        icon: "DuplicateIcon",
        label: editorMessage(
          "com.myoxus.editor.keyboard.duplicate",
          "Duplicate",
        ),
        when: (context) =>
          !context.readonly && Boolean(selectedOwnerOnly(context)),
        run(context) {
          const owner = selectedOwnerOnly(context);
          if (!owner) return;
          const [, result] = context.command.exec(
            duplicateMermaidBlockCommand,
            {
              model: owner,
            },
          );
          const duplicated = result?.duplicatedMermaidDiagrams?.at(-1);
          if (duplicated) {
            context.gfx.selection.set({
              editing: false,
              elements: [duplicated.blockId],
            });
          }
        },
      },
      mermaidMmdExportAction,
      {
        id: "mermaid-owner.lock",
        icon: "LockIcon",
        label: editorMessage("com.myoxus.editor.toolbar.lock", "Lock"),
        when: (context) =>
          !context.readonly &&
          Boolean(selectedOwnerOnly(context)) &&
          !selectedOwnerOnly(context)!.isLocked(),
        run(context) {
          const owner = selectedOwnerOnly(context);
          if (!owner || context.readonly || owner.isLocked()) return;
          // Only the complete owner uses the existing native single-object lock;
          // never the generic multiselection action that releases/groups children.
          context.store.captureSync();
          owner.lock();
          context.store.captureSync();
        },
      },
      {
        id: "mermaid-owner.delete",
        icon: "DeleteIcon",
        label: mermaidMessages.visualDelete(),
        variant: "destructive",
        when: (context) =>
          !context.readonly && Boolean(selectedOwnerOnly(context)),
        run(context) {
          const owner = selectedOwnerOnly(context);
          if (!owner) return;
          const [, result] = context.command.exec(deleteMermaidBlockCommand, {
            model: owner,
          });
          if (result?.deletedMermaidDiagrams?.length) {
            context.gfx.selection.set({ editing: false, elements: [] });
          }
        },
      },
      ...suppressedBaseActionIds.map(
        (id) =>
          ({
            id,
            when(context) {
              return !selectedFamilyConfig(
                context,
              )?.suppressBaseActionIds?.includes(id);
            },
          }) satisfies ToolbarAction,
      ),
      ...familyActionIds.map(
        (id) =>
          ({
            id,
            generate(context) {
              const action = selectedFamilyAction(context, id);
              if (!action) return null;
              if ("generate" in action) {
                // Generated leaves inherit their family's primary/More placement.
                const generated = action.generate(context);
                return generated
                  ? {
                      ...generated,
                      placement: generated.placement ?? action.placement,
                    }
                  : { when: false };
              }
              const { id: _id, ...generated } = action;
              return generated;
            },
            when(context) {
              return selectedFamilyAction(context, id) !== null;
            },
          }) satisfies ToolbarGenericAction,
      ),
    ];
  },
  when(context) {
    // The native locked-object toolbar owns Unlock and blocks authoring.
    if (selectedOwnerOnly(context)?.isLocked()) return false;
    const config = selectedFamilyConfig(context);
    if (!config) {
      return Boolean(resolveMermaidEdgelessExportOwner(context));
    }
    return typeof config.when === "function"
      ? config.when(context)
      : (config.when ?? true);
  },
} satisfies ToolbarModuleConfig;

const embeddedMermaidNoteExportToolbarConfig = {
  actions: [mermaidMmdExportAction],
  when: (context) => Boolean(resolveMermaidEdgelessExportOwner(context)),
} satisfies ToolbarModuleConfig;

export const mermaidSelectionToolbarExtensions = [
  "custom:myoxus:surface:shape",
  "custom:myoxus:surface:connector",
  "custom:myoxus:surface:mermaid",
  "custom:myoxus:mermaid",
]
  .map((flavour) =>
    ToolbarModuleExtension({
      config: mermaidSelectionToolbarConfig,
      id: BlockFlavourIdentifier(flavour),
    }),
  )
  .concat(
    ToolbarModuleExtension({
      config: embeddedMermaidNoteExportToolbarConfig,
      id: BlockFlavourIdentifier("custom:myoxus:surface:note"),
    }),
  );
