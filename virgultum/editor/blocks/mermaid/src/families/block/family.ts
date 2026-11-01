// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  resolveMermaidBlockSource,
  blockSourceDiagnostic,
  type MermaidBlockDiagramModel,
} from "../../engine/block/index.js";
import type { MermaidFamilyModule } from "../contracts.js";
import type { MermaidFamilyDiagramTitleHook } from "../runtime/contracts.js";
export const BLOCK_DIAGRAM_TYPES = ["block"] as const;
export const isBlockDiagramType = (type: string): type is "block" =>
  type === "block";
// Block has no body title or accessibility production. Frontmatter is global.
export const blockDiagramTitle: MermaidFamilyDiagramTitleHook = {
  resolveAll: () => [],
  resolve: () => null,
  patch: () => null,
};
export const mermaidBlockFamily: MermaidFamilyModule<
  MermaidBlockDiagramModel,
  MermaidBlockDiagramModel,
  Record<string, never>
> = {
  id: "block",
  diagramTypes: BLOCK_DIAGRAM_TYPES,
  commands: [],
  inspector: [],
  toolbar: [],
  parseSource: (source) => {
    const r = resolveMermaidBlockSource(source);
    return {
      source,
      diagramType: "block",
      model: r.model,
      diagnostics: r.diagnostics.map((d) => ({
        code: d.code,
        message: blockSourceDiagnostic(d),
        severity:
          d.stage === "syntax" ? ("error" as const) : ("warning" as const),
      })),
    };
  },
  toVisualModel: (r) =>
    r.model
      ? { kind: "editable", visualModel: r.model, diagnostics: r.diagnostics }
      : {
          kind: "source-only",
          diagnostics: r.diagnostics,
          reason: r.diagnostics[0]?.message ?? "Invalid Block Source",
        },
  applyVisualToSource: (m) => ({
    source: m.sourceDocument.source,
    diagnostics: [],
  }),
  materializeFrame: () => undefined,
  readFrame: () => null,
};
