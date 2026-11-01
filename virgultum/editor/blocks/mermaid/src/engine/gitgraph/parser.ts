// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  scanGitGraphSource,
  type GitGraphSourceBindings,
} from "./source-document.js";
import { deriveGitGraph } from "./derived-graph.js";
/** Diagnostics retain syntax, execution and render boundaries separately. */
export function resolveMermaidGitGraphSource(
  source: string,
  bindings: GitGraphSourceBindings = {},
) {
  const document = scanGitGraphSource(source, bindings),
    result = deriveGitGraph(document);
  return {
    ...result,
    document,
    source,
    /** Current Source semantics remain available to the checked repair owner.
     * This is never a retained drawing or a successful editable parse. */
    currentModel: result.model,
    model: result.diagnostics.some(
      (d) => d.stage !== "render" && d.severity === "error",
    )
      ? null
      : result.model,
  };
}
export function parseMermaidGitGraphSource(source: string) {
  return resolveMermaidGitGraphSource(source).model;
}
