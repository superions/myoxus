// SPDX-License-Identifier: AGPL-3.0-or-later

import { parseMermaidSourceToVisualModel } from "../../engine/flowchart.js";
import {
  createMermaidFamilyDiagramTitleHook,
  parsePlainMermaidTitleLine,
} from "../runtime/diagram-title-hook.js";

export const mermaidFlowchartDiagramTitle = createMermaidFamilyDiagramTitleHook(
  {
    parseLine: (line) =>
      parsePlainMermaidTitleLine(line, /^\s*title\s+(.+?)(?:\s+%%.*)?\s*$/i),
    validate: (source, _diagramType, title) =>
      parseMermaidSourceToVisualModel(source).model?.diagramTitle === title,
  },
);
