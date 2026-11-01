// SPDX-License-Identifier: AGPL-3.0-or-later

import type { MermaidArchitectureModel } from "./model.js";
import { generateCanonicalArchitectureSource } from "./writing/canonical-writer.js";
import { generateArchitectureSourcePatch } from "./writing/source-patch.js";

export function generateMermaidArchitectureSource(
  model: MermaidArchitectureModel,
) {
  return model.sourceDocument
    ? generateArchitectureSourcePatch(model, model.sourceDocument)
    : generateCanonicalArchitectureSource(model);
}
