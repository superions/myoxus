// SPDX-License-Identifier: AGPL-3.0-or-later
import { parseMermaidSequenceSource } from "../../engine/sequence/index.js";
import {
  createMermaidFamilyDiagramTitleHook,
  parsePlainMermaidTitleLine,
} from "../runtime/diagram-title-hook.js";
export const sequenceDiagramTitle = createMermaidFamilyDiagramTitleHook({
  parseLine: (line) =>
    parsePlainMermaidTitleLine(
      line,
      /^\s*title\s*:?[ \t]+(.+?)(?:;\s*)?(?:%%.*)?$/i,
    ),
  validate: (source, _type, title) =>
    parseMermaidSequenceSource(source)?.diagramTitle === title,
});
