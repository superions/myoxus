// SPDX-License-Identifier: AGPL-3.0-or-later
import { parseMermaidGitGraphSource } from "../../engine/gitgraph/index.js";
import {
  createMermaidFamilyDiagramTitleHook,
  parsePlainMermaidTitleLine,
} from "../runtime/diagram-title-hook.js";
/** This hook identifies the body provider; the shared diagram-title writer owns
 * effective body/frontmatter title updates and duplicate-title suppression. */
export const gitGraphDiagramTitle = createMermaidFamilyDiagramTitleHook({
  parseLine: (line, type) =>
    type === "gitGraph"
      ? parsePlainMermaidTitleLine(line, /^\s*title\s+(.+?)(?:\s+%%.*)?\s*$/)
      : null,
  validate: (source, type, title) =>
    type === "gitGraph" &&
    parseMermaidGitGraphSource(source)?.diagramTitle === title,
});
