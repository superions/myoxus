import type { MermaidDiagramType } from "../../engine/diagram-types.js";
import { parseMermaidSourceToVisualModel } from "../../engine/flowchart.js";
import { generateMermaidSourceFromVisualModel } from "../../engine/flowchart-writer.js";
import {
  createMermaidGfxModelHash,
  type MermaidVisualModel,
} from "../runtime/gfx-model.js";
import type { MermaidProductDiagramType } from "../../engine/product-types.js";
import type {
  MermaidFamilyDiagnostic,
  MermaidFamilyModule,
} from "../contracts.js";
import { routeFlowchartEdges } from "./edge-routing.js";

export type MermaidFlowchartFamilyModel = MermaidVisualModel;

export type MermaidFlowchartFamilyFrameContext = {
  readonly materializeVisualModel?: (visualModel: MermaidVisualModel) => void;
  readonly readVisualModel?: () => MermaidVisualModel | null;
};

const FLOWCHART_FAMILY_TYPES = [
  "flowchart",
  "flowchart-elk",
] as const satisfies ReadonlyArray<MermaidProductDiagramType>;

export function isMermaidFlowchartFamilyDiagramType(
  diagramType: MermaidDiagramType | string,
): diagramType is (typeof FLOWCHART_FAMILY_TYPES)[number] {
  return FLOWCHART_FAMILY_TYPES.includes(
    diagramType as (typeof FLOWCHART_FAMILY_TYPES)[number],
  );
}

function diagnostic(code: string, message: string): MermaidFamilyDiagnostic {
  return {
    code,
    message,
    severity: "warning",
  };
}

export const mermaidFlowchartFamily: MermaidFamilyModule<
  MermaidFlowchartFamilyModel,
  MermaidVisualModel,
  MermaidFlowchartFamilyFrameContext
> = {
  applyVisualToSource: (visualModel) => ({
    diagnostics: [],
    source: generateMermaidSourceFromVisualModel(visualModel),
  }),
  commands: [
    { id: "flowchart.node.create", label: "Create node", role: "create" },
    { id: "flowchart.node.rename", label: "Rename node", role: "edit" },
    { id: "flowchart.node.resize", label: "Resize node", role: "resize" },
    { id: "flowchart.edge.create", label: "Create edge", role: "create" },
    {
      id: "flowchart.edge.reconnect",
      label: "Reconnect edge",
      role: "reconnect",
    },
    { id: "flowchart.edge.delete", label: "Delete edge", role: "delete" },
  ],
  diagramTypes: FLOWCHART_FAMILY_TYPES,
  id: "flowchart",
  inspector: [
    { id: "node.label", label: "Node label", valueKind: "text" },
    { id: "node.shape", label: "Node shape", valueKind: "select" },
    { id: "edge.label", label: "Edge label", valueKind: "text" },
    { id: "edge.style", label: "Edge style", valueKind: "select" },
  ],
  materializeFrame: (visualModel, context) => {
    context.materializeVisualModel?.(visualModel);
  },
  parseSource: (source, diagramType) => {
    if (!isMermaidFlowchartFamilyDiagramType(diagramType)) {
      return {
        diagnostics: [
          diagnostic(
            "flowchart.unsupported-diagram-type",
            `Flowchart family cannot parse ${diagramType}.`,
          ),
        ],
        diagramType: "flowchart",
        model: null,
        source,
      };
    }
    const parsed = parseMermaidSourceToVisualModel(source);
    return {
      diagnostics: parsed.model
        ? []
        : [
            diagnostic(
              "flowchart.unsupported-source",
              "Flowchart source contains syntax that cannot be edited visually without losing fidelity.",
            ),
          ],
      diagramType,
      model: parsed.model,
      source,
    };
  },
  readFrame: (context) => context.readVisualModel?.() ?? null,
  toolbar: [
    {
      commandId: "flowchart.node.create",
      id: "flowchart.add-node",
      label: "Node",
    },
    {
      commandId: "flowchart.edge.create",
      id: "flowchart.add-edge",
      label: "Edge",
    },
  ],
  toVisualModel: (parseResult) => {
    if (!parseResult.model) {
      return {
        diagnostics: parseResult.diagnostics,
        kind: "source-only",
        reason:
          "Source cannot be represented by the Flowchart visual model without losing unsupported syntax.",
      };
    }
    return {
      diagnostics: parseResult.diagnostics,
      kind: "editable",
      visualModel: routeFlowchartEdges(parseResult.model),
    };
  },
};

export function hashMermaidFlowchartFamilyVisualModel(
  visualModel: MermaidVisualModel,
) {
  return createMermaidGfxModelHash(visualModel);
}
