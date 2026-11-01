// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  resolveMermaidGitGraphSource,
  gitGraphDocument,
  type MermaidGitGraphModel,
} from "../../engine/gitgraph/index.js";
import type { MermaidFamilyModule } from "../contracts.js";
import { formatGitGraphDiagnostic } from "./diagnostics.js";
export const isGitGraphDiagramType = (type: string): type is "gitGraph" =>
  type === "gitGraph";
export const mermaidGitGraphFamily: MermaidFamilyModule<
  MermaidGitGraphModel,
  MermaidGitGraphModel,
  Record<string, never>
> = {
  id: "gitgraph",
  diagramTypes: ["gitGraph"],
  commands: [],
  inspector: [],
  toolbar: [],
  parseSource: (source) => {
    const result = resolveMermaidGitGraphSource(source);
    return {
      source,
      diagramType: "gitGraph",
      model: result.model,
      diagnostics: result.diagnostics.map((d) => ({
        code: d.code,
        message: formatGitGraphDiagnostic(d, source),
        severity: d.severity,
      })),
    };
  },
  toVisualModel: (result) =>
    result.model
      ? {
          kind: "editable",
          visualModel: result.model,
          diagnostics: result.diagnostics,
        }
      : {
          kind: "source-only",
          diagnostics: result.diagnostics,
          reason:
            result.diagnostics.find((d) => d.severity === "error")?.message ??
            "",
        },
  applyVisualToSource: (model) => ({
    source: gitGraphDocument(model).source,
    diagnostics: [],
  }),
  materializeFrame: () => undefined,
  readFrame: () => null,
};
