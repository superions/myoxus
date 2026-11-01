import { detectMermaidDiagramType } from "../../engine/diagram-types.js";
import type { MermaidVisualModel } from "./gfx-model.js";
import { MermaidGfxThemeUnavailableError } from "../../mermaid-gfx-theme.js";
import { mermaidMessages } from "../../i18n.js";
import { readMermaidNativeValidation } from "./native-validation.js";
import {
  isMermaidProductDiagramType,
  type MermaidProductDiagramType,
} from "../../engine/product-types.js";
import type {
  MermaidFamilyRuntime,
  MermaidFamilyRuntimeResolution,
} from "./contracts.js";
import { mermaidArchitectureRuntime } from "../architecture/runtime.js";
import { mermaidPieRuntime } from "../charts/pie/runtime.js";
import { mermaidQuadrantRuntime } from "../charts/quadrant/runtime.js";
import { mermaidRadarRuntime } from "../charts/radar/runtime.js";
import { mermaidSankeyRuntime } from "../charts/sankey/runtime.js";
import { mermaidTreemapRuntime } from "../charts/treemap/runtime.js";
import { mermaidXyRuntime } from "../charts/xy/runtime.js";
import { mermaidFlowchartRuntime } from "../flowchart/runtime.js";
import { mermaidTimelineRuntime } from "../timeline/runtime.js";
import { mermaidGanttRuntime } from "../gantt/runtime.js";
import { mermaidMindmapRuntime } from "../mindmap/runtime.js";
import { mermaidRequirementRuntime } from "../requirement/runtime.js";
import { mermaidKanbanRuntime } from "../kanban/runtime.js";
import { mermaidJourneyRuntime } from "../journey/runtime.js";
import { mermaidPacketRuntime } from "../packet/runtime.js";
import { mermaidClassRuntime } from "../class/runtime.js";
import { mermaidErRuntime } from "../er/runtime.js";
import { mermaidSequenceRuntime } from "../sequence/runtime.js";
import { mermaidBlockRuntime } from "../block/runtime.js";
import { mermaidGitGraphRuntime } from "../gitgraph/runtime.js";
import { mermaidC4Runtime } from "../c4/runtime.js";
import { mermaidStateRuntime } from "../state/runtime.js";

/**
 * The sole executable family registry. Parser selection, renderer selection
 * and source writing are deliberately co-located here so the block host and
 * command port cannot grow independent family switches.
 * Resolve live bindings after module initialization: a family may import a
 * neutral command consumer that in turn consults this registry at run time.
 */
export function getMermaidFamilyRuntimes(): ReadonlyArray<MermaidFamilyRuntime> {
  return [
    mermaidArchitectureRuntime,
    mermaidPieRuntime,
    mermaidQuadrantRuntime,
    mermaidRadarRuntime,
    mermaidSankeyRuntime,
    mermaidTreemapRuntime,
    mermaidXyRuntime,
    mermaidFlowchartRuntime,
    mermaidGanttRuntime,
    mermaidTimelineRuntime,
    mermaidMindmapRuntime,
    mermaidRequirementRuntime,
    mermaidKanbanRuntime,
    mermaidJourneyRuntime,
    mermaidPacketRuntime,
    mermaidClassRuntime,
    mermaidErRuntime,
    mermaidSequenceRuntime,
    mermaidStateRuntime,
    mermaidBlockRuntime,
    mermaidC4Runtime,
    mermaidGitGraphRuntime,
  ];
}

export function getMermaidFamilyRuntime(
  diagramType: MermaidProductDiagramType,
) {
  return (
    getMermaidFamilyRuntimes().find((candidate) =>
      candidate.diagramTypes.includes(diagramType),
    ) ?? null
  );
}

export async function prepareMermaidFamilySource(source: string) {
  const type = detectMermaidDiagramType(source);
  if (!isMermaidProductDiagramType(type)) return;
  const runtime = getMermaidFamilyRuntime(type);
  if (runtime) await readMermaidNativeValidation(source, runtime)?.ready;
}

export function resolveMermaidFamilyRuntime(
  source: string,
  frameVisualModel: MermaidVisualModel | null = null,
  previousStructuredModel?: unknown,
): MermaidFamilyRuntimeResolution {
  const diagramType = source.trim()
    ? detectMermaidDiagramType(source)
    : "unknown";
  if (!source.trim()) {
    return { diagramType, kind: "empty", runtime: null, source };
  }
  if (!isMermaidProductDiagramType(diagramType)) {
    return {
      diagnostics: [],
      diagramType,
      kind: "source-first",
      reason: "Diagram type has no registered visual family runtime.",
      runtime: null,
      source,
    };
  }
  const familyRuntime = getMermaidFamilyRuntime(diagramType);
  if (!familyRuntime) {
    return {
      diagnostics: [],
      diagramType,
      kind: "source-first",
      reason: "Diagram type has no registered visual family runtime.",
      runtime: null,
      source,
    };
  }
  const diagnostics = familyRuntime.sourceDiagnostics(source, diagramType);
  const validation = readMermaidNativeValidation(source, familyRuntime);
  if (validation?.status === "invalid") {
    const reason = validation.message ?? mermaidMessages.mmdImportInvalid();
    return {
      diagnostics: [
        ...diagnostics,
        { code: "mermaid.native-source", message: reason, severity: "error" },
      ],
      diagramType,
      kind: "source-first",
      reason: diagnostics[0]?.message ?? reason,
      runtime: familyRuntime,
      source,
    };
  }
  const surface = familyRuntime.renderSurface(diagramType);
  const structuredResolution = familyRuntime.resolveStructured?.({
    diagnostics,
    diagramType,
    runtime: familyRuntime,
    source,
    previousStructuredModel,
  });
  if (structuredResolution) return structuredResolution;
  let parsedVisualModel: MermaidVisualModel | null;
  try {
    parsedVisualModel = familyRuntime.parseSourceToGfxVisualModel(
      source,
      diagramType,
    );
  } catch (error) {
    if (!(error instanceof MermaidGfxThemeUnavailableError)) throw error;
    const message = mermaidMessages.gfxThemeUnavailable(error.property);
    const themeDiagnostic = {
      code: "mermaid.gfx-theme-unavailable",
      message,
      severity: "error" as const,
    };
    return {
      diagnostics: [...diagnostics, themeDiagnostic],
      diagramType,
      kind: "pending",
      reason: message,
      runtime: familyRuntime,
      source,
    };
  }
  if (!parsedVisualModel) {
    return {
      diagnostics,
      diagramType,
      kind: "source-first",
      reason:
        diagnostics[0]?.message ??
        "Source cannot be represented without losing unsupported syntax.",
      runtime: familyRuntime,
      source,
    };
  }
  if (surface === "source-first") {
    return {
      diagnostics,
      diagramType,
      kind: "source-first",
      reason: "Diagram type has no visual render surface.",
      runtime: familyRuntime,
      source,
    };
  }
  const visualModel =
    frameVisualModel?.diagramType === diagramType
      ? frameVisualModel
      : parsedVisualModel;
  if (!familyRuntime.hostAdapter) {
    return {
      diagnostics,
      diagramType,
      kind: "source-first",
      reason: "Diagram type has no registered GFX host projection.",
      runtime: familyRuntime,
      source,
    };
  }
  const projection = {
    diagramType,
    renderSurface: surface,
    source,
    visualModel,
  } as const;
  const capabilities = familyRuntime.hostAdapter.projectGfx(projection);
  return {
    capabilities:
      validation?.status === "pending"
        ? {
            ...capabilities,
            project: (host) => capabilities.project(host, true),
          }
        : capabilities,
    diagnostics,
    diagramType,
    gfxVisualModel: visualModel,
    kind: "resolved",
    nativeValidationPending: validation?.status === "pending",
    runtime: familyRuntime,
    source,
  };
}
