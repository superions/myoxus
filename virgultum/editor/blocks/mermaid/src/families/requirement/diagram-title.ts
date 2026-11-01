// SPDX-License-Identifier: AGPL-3.0-or-later
import type { MermaidFamilyDiagramTitleHook } from "../runtime/contracts.js";
/** Requirement has no native body title. The shared owner patches YAML CST. */
export const requirementDiagramTitle: MermaidFamilyDiagramTitleHook = {
  resolveAll: () => [],
  resolve: () => null,
  patch: () => null,
};
