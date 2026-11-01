// SPDX-License-Identifier: AGPL-3.0-or-later

import { parseMermaidArchitectureSource } from "../../engine/architecture/index.js";
import {
  createMermaidFamilyDiagramTitleHook,
  parsePlainMermaidTitleLine,
} from "../runtime/diagram-title-hook.js";

export const mermaidArchitectureDiagramTitle =
  createMermaidFamilyDiagramTitleHook({
    parseLine: (line) =>
      parsePlainMermaidTitleLine(line, /^\s*title\s+(.+?)(?:\s+%%.*)?\s*$/i),
    validate: (source, _diagramType, title) =>
      parseMermaidArchitectureSource(source)?.diagramTitle === title,
  });
