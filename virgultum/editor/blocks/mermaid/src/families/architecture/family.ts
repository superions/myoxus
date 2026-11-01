// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  diagnoseMermaidArchitectureSource,
  generateMermaidArchitectureSource,
  type MermaidArchitectureModel,
  parseMermaidArchitectureSource,
} from "../../engine/architecture/index.js";
import type { MermaidDiagramType } from "../../engine/diagram-types.js";
import { mermaidMessages } from "../../i18n.js";
import type {
  MermaidFamilyDiagnostic,
  MermaidFamilyModule,
} from "../contracts.js";

export type MermaidArchitectureFrameContext = {
  readonly materializeArchitectureModel?: (
    model: MermaidArchitectureModel,
  ) => void;
  readonly readArchitectureModel?: () => MermaidArchitectureModel | null;
};

function diagnostic(
  code: string,
  message: string,
  severity: MermaidFamilyDiagnostic["severity"] = "warning",
): MermaidFamilyDiagnostic {
  return { code, message, severity };
}

export const mermaidArchitectureFamily: MermaidFamilyModule<
  MermaidArchitectureModel,
  MermaidArchitectureModel,
  MermaidArchitectureFrameContext
> = {
  applyVisualToSource: (visualModel) => ({
    diagnostics: [],
    source: generateMermaidArchitectureSource(visualModel),
  }),
  commands: [
    {
      id: "architecture.service.create",
      label: mermaidMessages.architectureAddService(),
      role: "create",
    },
    {
      id: "architecture.junction.create",
      label: mermaidMessages.architectureAddJunction(),
      role: "create",
    },
    {
      id: "architecture.group.create",
      label: mermaidMessages.architectureAddGroup(),
      role: "create",
    },
    {
      id: "architecture.object.rename",
      label: mermaidMessages.selectedNodeLabel(),
      role: "edit",
    },
    {
      id: "architecture.service.icon-kind",
      label: mermaidMessages.selectedArchitectureServiceIconKind(),
      role: "edit",
    },
    {
      id: "architecture.service.icon",
      label: mermaidMessages.selectedArchitectureServiceIcon(),
      role: "edit",
    },
    {
      id: "architecture.group.icon",
      label: mermaidMessages.selectedArchitectureGroupIcon(),
      role: "edit",
    },
    {
      id: "architecture.relationship.create",
      label: mermaidMessages.visualConnect(),
      role: "create",
    },
    {
      id: "architecture.relationship.reconnect",
      label: mermaidMessages.visualReconnectSource(),
      role: "reconnect",
    },
    {
      id: "architecture.relationship.ports",
      label: mermaidMessages.selectedArchitectureFromPort(),
      role: "edit",
    },
    {
      id: "architecture.relationship.kind",
      label: mermaidMessages.selectedEdgeType(),
      role: "edit",
    },
    {
      id: "architecture.service.reparent",
      label: mermaidMessages.chartParent(),
      role: "reorder",
    },
    {
      id: "architecture.group.reparent",
      label: mermaidMessages.chartParent(),
      role: "reorder",
    },
    {
      id: "architecture.align.row",
      label: mermaidMessages.architectureAlignRow(),
      role: "reorder",
    },
    {
      id: "architecture.align.column",
      label: mermaidMessages.architectureAlignColumn(),
      role: "reorder",
    },
    {
      id: "architecture.object.delete",
      label: mermaidMessages.visualDelete(),
      role: "delete",
    },
    {
      id: "architecture.relationship.delete",
      label: mermaidMessages.visualDelete(),
      role: "delete",
    },
    {
      id: "architecture.comment.create",
      label: mermaidMessages.architectureAddComment(),
      role: "create",
    },
    {
      id: "architecture.comment.update",
      label: mermaidMessages.architectureComments(),
      role: "edit",
    },
    {
      id: "architecture.comment.delete",
      label: mermaidMessages.architectureDeleteComment(),
      role: "delete",
    },
  ],
  diagramTypes: ["architecture"],
  id: "architecture",
  inspector: [
    {
      id: "object.label",
      label: mermaidMessages.selectedNodeLabel(),
      valueKind: "text",
    },
    {
      id: "object.kind",
      label: mermaidMessages.selectedArchitectureNodeKind(),
      valueKind: "select",
    },
    {
      id: "object.group",
      label: mermaidMessages.chartParent(),
      valueKind: "select",
    },
    {
      id: "group.parent",
      label: mermaidMessages.chartParent(),
      valueKind: "select",
    },
    {
      id: "service.icon-kind",
      label: mermaidMessages.selectedArchitectureServiceIconKind(),
      valueKind: "select",
    },
    {
      id: "service.icon",
      label: mermaidMessages.selectedArchitectureServiceIcon(),
      valueKind: "text",
    },
    {
      id: "group.icon",
      label: mermaidMessages.selectedArchitectureGroupIcon(),
      valueKind: "text",
    },
    {
      id: "relationship.label",
      label: mermaidMessages.selectedEdgeLabel(),
      valueKind: "text",
    },
    {
      id: "relationship.from-port",
      label: mermaidMessages.selectedArchitectureFromPort(),
      valueKind: "select",
    },
    {
      id: "relationship.to-port",
      label: mermaidMessages.selectedArchitectureToPort(),
      valueKind: "select",
    },
    {
      id: "relationship.kind",
      label: mermaidMessages.selectedEdgeType(),
      valueKind: "select",
    },
    {
      id: "comments",
      label: mermaidMessages.architectureComments(),
      valueKind: "text",
    },
  ],
  materializeFrame: (visualModel, context) => {
    context.materializeArchitectureModel?.(visualModel);
  },
  parseSource: (source, diagramType: MermaidDiagramType) => {
    if (diagramType !== "architecture") {
      return {
        diagnostics: [
          diagnostic(
            "architecture.unsupported-diagram-type",
            `Architecture owner cannot parse ${diagramType}.`,
          ),
        ],
        diagramType: "architecture",
        model: null,
        source,
      };
    }
    const model = parseMermaidArchitectureSource(source);
    const sourceDiagnostic = model
      ? null
      : diagnoseMermaidArchitectureSource(source);
    return {
      diagnostics: model
        ? []
        : [
            diagnostic(
              "architecture.invalid-source",
              sourceDiagnostic
                ? mermaidMessages.architectureInvalidSource(
                    sourceDiagnostic.line,
                    sourceDiagnostic.construct,
                  )
                : mermaidMessages.architectureInvalidSource(
                    1,
                    "architecture-beta",
                  ),
              "error",
            ),
          ],
      diagramType,
      model,
      source,
    };
  },
  readFrame: (context) => context.readArchitectureModel?.() ?? null,
  toolbar: [
    {
      commandId: "architecture.service.create",
      id: "architecture.add-service",
      label: mermaidMessages.architectureService(),
    },
    {
      commandId: "architecture.junction.create",
      id: "architecture.add-junction",
      label: mermaidMessages.architectureJunction(),
    },
    {
      commandId: "architecture.group.create",
      id: "architecture.add-group",
      label: mermaidMessages.architectureAddGroup(),
    },
    {
      commandId: "architecture.relationship.create",
      id: "architecture.add-relationship",
      label: mermaidMessages.visualConnect(),
    },
    {
      commandId: "architecture.comment.create",
      id: "architecture.add-comment",
      label: mermaidMessages.architectureComments(),
    },
  ],
  toVisualModel: (parseResult) =>
    parseResult.model
      ? {
          diagnostics: parseResult.diagnostics,
          kind: "editable",
          visualModel: parseResult.model,
        }
      : {
          diagnostics: parseResult.diagnostics,
          kind: "source-only",
          reason:
            parseResult.diagnostics[0]?.message ??
            mermaidMessages.architectureInvalidSource(1, "architecture-beta"),
        },
};
