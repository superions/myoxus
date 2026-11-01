// SPDX-License-Identifier: AGPL-3.0-or-later

import type { MermaidDiagramType } from "../../engine/diagram-types.js";
import type { MermaidVisualModel } from "./gfx-model.js";
import type {
  MermaidProductDiagramType,
  MermaidProductFamilyId,
} from "../../engine/product-types.js";
import type {
  MermaidFamilyCommandDescriptor,
  MermaidFamilyDiagnostic,
  MermaidFamilyInspectorField,
  MermaidFamilySourceApplyResult,
  MermaidFamilyToolbarAction,
} from "../contracts.js";
import type { MermaidEditorCapabilities } from "./editor-capabilities.js";
import type { MermaidGfxFamilyHookRegistration } from "./gfx-family-hooks-contract.js";
import type {
  ToolbarContext,
  ToolbarGenericAction,
} from "@virgultum/shared/services";

export type MermaidFamilyRenderSurface = "core-facade" | "gfx" | "source-first";

export type MermaidDiagramTitleSourceRange = {
  readonly end: number;
  readonly start: number;
};

export type MermaidNativeDiagramTitle = {
  readonly range: MermaidDiagramTitleSourceRange;
  readonly value: string;
};

export type MermaidFamilyDiagramTitleHook = {
  readonly patch: (
    source: string,
    diagramType: MermaidProductDiagramType,
    title: string,
  ) => string | null;
  readonly resolve: (
    source: string,
    diagramType: MermaidProductDiagramType,
  ) => MermaidNativeDiagramTitle | null;
  readonly resolveAll: (
    source: string,
    diagramType: MermaidProductDiagramType,
  ) => ReadonlyArray<MermaidNativeDiagramTitle>;
};

export type MermaidGfxRuntimeProjection = {
  readonly diagramType: MermaidProductDiagramType;
  readonly renderSurface: Exclude<MermaidFamilyRenderSurface, "source-first">;
  readonly source: string;
  readonly visualModel: MermaidVisualModel;
};

export type MermaidPageSelectionItem = {
  readonly editKey: string;
  readonly kind: "edge" | "node" | "subgraph";
  /** Family-owned accessible name for derived objects without visible text. */
  readonly label?: string;
  /** Directly editable derived objects may be excluded from Box and Select All. */
  readonly boxSelectable?: boolean;
  readonly selectAllSelectable?: boolean;
};

export type MermaidPageSelectionValidation =
  { readonly valid: true } | { readonly code: string; readonly valid: false };

export type MermaidPageSelectionContainerActionDescriptor = {
  readonly eligibleKinds: ReadonlyArray<string>;
  readonly id: string;
  readonly label: () => string;
  readonly minimumSelectionCount: number;
  readonly validationMessage: (code: string) => string;
  readonly validate: (context: {
    readonly items: ReadonlyArray<MermaidPageSelectionItem>;
    readonly visualModel: MermaidVisualModel;
  }) => MermaidPageSelectionValidation;
};

export function validateMermaidPageSelectionContainerAction(
  action: MermaidPageSelectionContainerActionDescriptor,
  items: ReadonlyArray<MermaidPageSelectionItem>,
  visualModel: MermaidVisualModel,
) {
  return action.validate({
    // The action owns rejection of ineligible items. Filtering here made a
    // mixed completed selection look valid and let container creation consume
    // only an implicit subset instead of the exact user selection.
    items,
    visualModel,
  });
}

export type MermaidPageSelectionToolsContribution = {
  readonly boxSelectableKinds: ReadonlyArray<string>;
  readonly containerAction?: MermaidPageSelectionContainerActionDescriptor;
  readonly operations: {
    readonly deleteSelection: boolean;
    readonly duplicateSelection: boolean;
    readonly moveSelection: boolean;
  };
  readonly resolveItems: (
    visualModel: MermaidVisualModel,
  ) => ReadonlyArray<MermaidPageSelectionItem>;
  readonly selectableKinds: ReadonlyArray<string>;
  readonly selectAllKinds: ReadonlyArray<string>;
};

export type MermaidFamilyHostAdapter = {
  readonly projectGfx: (
    projection: MermaidGfxRuntimeProjection,
  ) => MermaidEditorCapabilities;
  /** Current-Source diagnostics and explicit repair controls are independent of
   * retained readonly geometry. They may never write from last-valid objects. */
  readonly projectInvalidSource?: (
    source: string,
    lastValidVisualModel: MermaidVisualModel | null,
  ) => MermaidEditorCapabilities;
  readonly projectPreview?: (
    visualModel: MermaidVisualModel,
    source: string,
  ) => MermaidEditorCapabilities;
};

export type MermaidFamilyEdgelessToolbarContribution = {
  /** Keep a family-owned diagnostic visible for invalid native Source. Mutation
   * resolution remains separately guarded by the Source lifecycle. */
  readonly invalidSourceSelection?: boolean;
  /** The existing root toolbar can expose selection/readback/export in readonly. */
  readonly readonlySelection?: boolean;
  /** Semantic actions or existing native family views; no selection-owned Lit panels. */
  readonly actions: ReadonlyArray<ToolbarGenericAction>;
  readonly suppressBaseActionIds?: ReadonlyArray<string>;
  readonly when?: ((context: ToolbarContext) => boolean) | boolean;
};

export const MERMAID_MANAGED_ELEMENT_UNSAFE_BASE_ACTION_IDS = [
  "Z.a.selection",
  "Z.b.reordering",
  "a.clipboard",
  "d.conversions",
  "a.release-from-group",
  "b.add-frame",
  "c.add-group",
  "d.alignment",
  "a.draw-connector",
  "b.lock",
  "c.comment",
] as const;

export type MermaidFamilyRuntime = {
  readonly preserveSourceBytes?: boolean | ((diagramType: string) => boolean);
  /** Public native grammar/DB preflight, memoized per Source revision. */
  readonly validateSource?: (source: string) => Promise<void>;
  readonly commands: ReadonlyArray<MermaidFamilyCommandDescriptor>;
  readonly diagramTypes: ReadonlyArray<MermaidProductDiagramType>;
  readonly id: MermaidProductFamilyId;
  readonly inspector: ReadonlyArray<MermaidFamilyInspectorField>;
  readonly toolbar: ReadonlyArray<MermaidFamilyToolbarAction>;
  readonly gfxHooks?: MermaidGfxFamilyHookRegistration;
  readonly hostAdapter?: MermaidFamilyHostAdapter;
  readonly pageSelectionTools?: MermaidPageSelectionToolsContribution;
  readonly diagramTitle?: MermaidFamilyDiagramTitleHook;
  readonly edgelessToolbar?: MermaidFamilyEdgelessToolbarContribution;
  readonly applyGfxVisualToSource: (
    previousSource: string,
    visualModel: MermaidVisualModel,
  ) => MermaidFamilySourceApplyResult & {
    /** Checked record writers return the projection with advanced bindings.
     * Commit consumers must not canonicalize against pre-write offsets. */
    readonly visualModel?: MermaidVisualModel;
  };
  readonly parseSourceToGfxVisualModel: (
    source: string,
    diagramType: MermaidProductDiagramType,
  ) => MermaidVisualModel | null;
  readonly sourceDiagnostics: (
    source: string,
    diagramType: MermaidProductDiagramType,
  ) => ReadonlyArray<MermaidFamilyDiagnostic>;
  readonly renderSurface: (
    diagramType: MermaidProductDiagramType,
  ) => MermaidFamilyRenderSurface;
  readonly resolveStructured?: (
    context: MermaidFamilyStructuredResolutionContext,
  ) => MermaidFamilyRuntimeResolution | null;
};

export type MermaidFamilyStructuredResolutionContext = {
  readonly diagnostics: ReadonlyArray<MermaidFamilyDiagnostic>;
  readonly diagramType: MermaidProductDiagramType;
  readonly runtime: MermaidFamilyRuntime;
  readonly source: string;
  readonly previousStructuredModel?: unknown;
};

export type MermaidFamilyResolvedRuntimeResolution = {
  readonly nativeValidationPending?: boolean;
  readonly capabilities: MermaidEditorCapabilities;
  readonly diagnostics: ReadonlyArray<MermaidFamilyDiagnostic>;
  readonly diagramType: MermaidProductDiagramType;
  readonly gfxVisualModel?: MermaidVisualModel;
  readonly structuredModel?: unknown;
  readonly kind: "resolved";
  readonly runtime: MermaidFamilyRuntime;
  readonly source: string;
};

export type MermaidFamilySourceFirstRuntimeResolution = {
  readonly diagnostics: ReadonlyArray<MermaidFamilyDiagnostic>;
  readonly diagramType: MermaidDiagramType;
  readonly kind: "source-first";
  readonly reason: string;
  readonly runtime: MermaidFamilyRuntime | null;
  readonly source: string;
};

export type MermaidFamilyRuntimeResolution =
  | MermaidFamilyResolvedRuntimeResolution
  | MermaidFamilySourceFirstRuntimeResolution
  | {
      readonly diagramType: MermaidDiagramType;
      readonly kind: "empty";
      readonly runtime: null;
      readonly source: string;
    }
  | {
      readonly diagnostics: ReadonlyArray<MermaidFamilyDiagnostic>;
      readonly diagramType: MermaidDiagramType;
      readonly kind: "pending";
      readonly reason: string;
      readonly runtime: MermaidFamilyRuntime;
      readonly source: string;
    };
