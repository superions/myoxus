// SPDX-License-Identifier: AGPL-3.0-or-later
import type { MermaidFamilyDiagramTitleHook } from "../runtime/contracts.js";
/** Class has no body title. The global title owner patches Frontmatter. */
export const classDiagramTitle: MermaidFamilyDiagramTitleHook = {
  resolveAll: () => [],
  resolve: () => null,
  patch: () => null,
};
