// SPDX-License-Identifier: AGPL-3.0-or-later

import { parseMermaidJourneySource } from "../../engine/journey/index.js";
import {
  createMermaidFamilyDiagramTitleHook,
  parsePlainMermaidTitleLine,
} from "../runtime/diagram-title-hook.js";

export const mermaidJourneyDiagramTitle = createMermaidFamilyDiagramTitleHook({
  parseLine: (line, diagramType) => {
    if (diagramType !== "journey") return null;
    return parsePlainMermaidTitleLine(
      line,
      /^\s*title\s+(.+?)(?:\s+#.*)?\s*$/i,
    );
  },
  validate: (source, diagramType, title) => {
    if (diagramType === "journey") {
      return parseMermaidJourneySource(source)?.title === title;
    }
    return false;
  },
});
