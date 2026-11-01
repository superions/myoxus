// SPDX-License-Identifier: AGPL-3.0-or-later
import type { MermaidFamilyDiagramTitleHook } from "../runtime/contracts.js";
// State has no native body title. A statement named title remains State data.
export const stateDiagramTitle: MermaidFamilyDiagramTitleHook = {
  resolveAll: () => [],
  resolve: () => null,
  patch: () => null,
};
