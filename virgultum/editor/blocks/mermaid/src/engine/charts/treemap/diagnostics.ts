// SPDX-License-Identifier: AGPL-3.0-or-later

import type { TreemapRange } from "./source-document.js";

export type TreemapDiagnosticCode =
  | "ambiguous-source"
  | "class-def"
  | "conflict"
  | "invalid-class"
  | "invalid-config"
  | "invalid-number"
  | "leaf-parent"
  | "malformed-node"
  | "multiple-roots"
  | "orphan"
  | "unknown-statement"
  | "unresolved-class";

export type TreemapDiagnostic = {
  readonly code: TreemapDiagnosticCode;
  readonly recordId: string;
  readonly field?: "class" | "indent" | "label" | "parent" | "value";
  readonly range: TreemapRange;
  readonly parentRange?: TreemapRange;
  readonly impact: "document" | "hierarchy" | "record" | "style";
};
