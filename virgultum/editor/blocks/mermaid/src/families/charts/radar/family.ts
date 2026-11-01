// SPDX-License-Identifier: AGPL-3.0-or-later

import type { MermaidDiagramType } from "../../../engine/diagram-types.js";
import type { MermaidRadarDiagnostic } from "../../../engine/charts/radar/diagnostics.js";
import type { MermaidRadarModel } from "../../../engine/charts/radar/model.js";
import { parseMermaidRadarSourceResult } from "../../../engine/charts/radar/parser.js";
import { mermaidMessages } from "../../../i18n.js";
import type {
  MermaidFamilyDiagnostic,
  MermaidFamilyModule,
} from "../../contracts.js";
import { mermaidRadarEmbeddedActions } from "./edgeless-actions.js";

export type MermaidRadarFrameContext = {
  readonly readRadarModel?: () => MermaidRadarModel | null;
};

export function localizedRadarDiagnostic(diagnostic: MermaidRadarDiagnostic) {
  const line = diagnostic.range.startLine + 1;
  const detail = {
    "ambiguous-source": mermaidMessages.radarDiagnosticAmbiguousSource,
    "duplicate-name": mermaidMessages.radarDiagnosticDuplicateName,
    "duplicate-reference": mermaidMessages.radarDiagnosticDuplicateReference,
    "invalid-config": mermaidMessages.radarDiagnosticInvalidConfig,
    "invalid-header": mermaidMessages.radarDiagnosticInvalidHeader,
    "invalid-number": mermaidMessages.radarDiagnosticInvalidNumber,
    "invalid-option": mermaidMessages.radarDiagnosticInvalidOption,
    "invalid-range": mermaidMessages.radarDiagnosticInvalidRange,
    "invalid-statement": mermaidMessages.radarDiagnosticInvalidStatement,
    "length-mismatch": mermaidMessages.radarDiagnosticLengthMismatch,
    "missing-reference": mermaidMessages.radarDiagnosticMissingReference,
    "mixed-value-form": mermaidMessages.radarDiagnosticMixedValueForm,
    "unknown-reference": mermaidMessages.radarDiagnosticUnknownReference,
  } satisfies Record<MermaidRadarDiagnostic["code"], () => string>;
  const message = mermaidMessages.radarDiagnostic(
    detail[diagnostic.code](),
    line,
  );
  return { ...diagnostic, message };
}

function unsupportedDiagnostic(
  _diagramType: MermaidDiagramType,
): MermaidFamilyDiagnostic {
  return {
    code: "radar.unsupported-diagram-type",
    message: mermaidMessages.radarCommandInvalid(),
    severity: "error",
  };
}

export const mermaidRadarFamily: MermaidFamilyModule<
  MermaidRadarModel,
  MermaidRadarModel,
  MermaidRadarFrameContext
> = {
  applyVisualToSource: (_model, previousSource) => ({
    diagnostics: [
      {
        code: "radar.command-required",
        message: mermaidMessages.radarCommandInvalid(),
        severity: "error",
      },
    ],
    source: previousSource,
  }),
  commands: [
    {
      id: "radar.axis.add",
      label: mermaidMessages.chartAddAxis(),
      role: "create",
    },
    {
      id: "radar.curve.add",
      label: mermaidMessages.chartAddCurve(),
      role: "create",
    },
    { id: "radar.data.toggle", label: mermaidMessages.pieData(), role: "edit" },
    {
      id: "radar.comments.open",
      label: mermaidMessages.visualComments(),
      role: "edit",
    },
    {
      id: "radar.appearance.open",
      label: mermaidMessages.visualAppearance(),
      role: "edit",
    },
    {
      id: "radar.more.open",
      label: mermaidMessages.visualMoreActions(),
      role: "edit",
    },
  ],
  diagramTypes: ["radar"],
  id: "radar",
  inspector: [],
  materializeFrame: () => undefined,
  parseSource: (source, diagramType) => {
    if (diagramType !== "radar")
      return {
        diagnostics: [unsupportedDiagnostic(diagramType)],
        diagramType: "radar",
        model: null,
        source,
      };
    const parsed = parseMermaidRadarSourceResult(source);
    const diagnostics = parsed.model
      ? parsed.model.diagnostics.map(localizedRadarDiagnostic)
      : [localizedRadarDiagnostic(parsed.diagnostic)];
    return { diagnostics, diagramType, model: parsed.model, source };
  },
  readFrame: (context) => context.readRadarModel?.() ?? null,
  toolbar: mermaidRadarEmbeddedActions,
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
            mermaidMessages.previewEmpty(),
        },
};
