import type { MermaidBlockModel } from "@virgultum/model";

import { detectMermaidDiagramType } from "./engine/diagram-types.js";
import { isMermaidProductDiagramType } from "./engine/product-types.js";
import {
  resolveMermaidDiagramTitle,
  writeMermaidDiagramTitle,
} from "./engine/diagram-title.js";
import { getMermaidFamilyRuntime } from "./families/runtime/registry.js";
import { resolveMermaidSourceLifecycle } from "./families/runtime/source-lifecycle.js";
import { parseMermaidSourceToGfxVisualModel } from "./mermaid-gfx-graph-adapters.js";
import { MermaidGfxThemeUnavailableError } from "./mermaid-gfx-theme.js";
import { canProjectMermaidNatively } from "./presentation/owner.js";
import {
  coerceMermaidBlockText,
  getMermaidBlockSource,
  getMermaidDiagramTypeLabel,
  hashMermaidSource,
  normalizeMermaidSourceInput,
  isMermaidAutomaticBlockTitle,
  setMermaidBlockText,
} from "./utils.js";

export type MermaidSourceWriteState = {
  diagramType: string;
  source: string;
  sourceHash: string;
};

export function resolveMermaidSourceWriteState(
  value: string,
  {
    preserveSourceBytes = false,
  }: { readonly preserveSourceBytes?: boolean } = {},
): MermaidSourceWriteState {
  const source = preserveSourceBytes
    ? value
    : normalizeMermaidSourceInput(value);
  let parsed: ReturnType<typeof parseMermaidSourceToGfxVisualModel>;
  try {
    parsed = parseMermaidSourceToGfxVisualModel(source);
  } catch (error) {
    if (!(error instanceof MermaidGfxThemeUnavailableError)) throw error;
    return {
      diagramType: detectMermaidDiagramType(source),
      source,
      sourceHash: hashMermaidSource(source),
    };
  }
  return {
    diagramType: parsed.diagramType,
    source,
    sourceHash: parsed.sourceHash,
  };
}

export function writeMermaidSourceModelState(
  model: MermaidBlockModel,
  value: string,
  options: { readonly preserveSourceBytes?: boolean } = {},
) {
  const previousSource = getMermaidBlockSource(model.props);
  const retainedSource = model.props.lastValidSource || previousSource;
  if (
    previousSource &&
    resolveMermaidSourceLifecycle(previousSource).canRetainAsLastValid
  ) {
    model.props.lastValidSource = previousSource;
  }
  let source = options.preserveSourceBytes
    ? value
    : normalizeMermaidSourceInput(value);
  const lifecycle = resolveMermaidSourceLifecycle(source);
  const retainedResolution = retainedSource
    ? resolveMermaidSourceLifecycle(retainedSource).resolution
    : null;
  const nativeOwnerRetainsProjection = Boolean(
    model.store.getParent(model.id)?.flavour === "myoxus:surface" &&
    retainedResolution &&
    canProjectMermaidNatively(retainedResolution) &&
    (!canProjectMermaidNatively(lifecycle.resolution) ||
      lifecycle.resolution.diagramType !== retainedResolution.diagramType),
  );
  const diagramType = detectMermaidDiagramType(source);
  let projectedTitle: string | null = null;
  if (
    lifecycle.canReconcileProjection &&
    isMermaidProductDiagramType(diagramType)
  ) {
    const runtime = getMermaidFamilyRuntime(diagramType);
    const currentProjection = coerceMermaidBlockText(model.props.title);
    const typeLabel = getMermaidDiagramTypeLabel(diagramType);
    const legacyTitle =
      options.preserveSourceBytes ||
      !currentProjection ||
      isMermaidAutomaticBlockTitle(currentProjection)
        ? typeLabel
        : currentProjection;
    let title = resolveMermaidDiagramTitle({
      diagramType,
      familyTitle: runtime?.diagramTitle,
      legacyTitle,
      source,
    });
    if (
      title.kind === "legacy" &&
      !options.preserveSourceBytes &&
      !runtime
        ?.sourceDiagnostics(source, diagramType)
        .some(({ severity }) => severity === "error")
    ) {
      source =
        writeMermaidDiagramTitle({
          diagramType,
          familyTitle: runtime?.diagramTitle,
          source,
          title: title.value,
        }) ?? source;
      title = resolveMermaidDiagramTitle({
        diagramType,
        familyTitle: runtime?.diagramTitle,
        source,
      });
    }
    projectedTitle = title.value || typeLabel;
  }
  const state = resolveMermaidSourceWriteState(source, options);
  setMermaidBlockText(model, "source", state.source, options);
  if (lifecycle.canRetainAsLastValid && !nativeOwnerRetainsProjection) {
    model.props.lastValidSource = state.source;
  }
  if (
    projectedTitle !== null &&
    projectedTitle !== coerceMermaidBlockText(model.props.title)
  ) {
    setMermaidBlockText(model, "title", projectedTitle);
  }
  model.props.diagramType = state.diagramType;
  return {
    ...state,
    canReconcileProjection: lifecycle.canReconcileProjection,
  };
}
