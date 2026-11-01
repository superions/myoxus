// SPDX-License-Identifier: AGPL-3.0-or-later
import type { MindmapDiagnostic } from "../../engine/mindmap/index.js";
import { mermaidMessages as m } from "../../i18n.js";
const repairs = {
  "mindmap.syntax.header": m.mindmapDiagnosticHeader,
  "mindmap.syntax.node": m.mindmapDiagnosticNode,
  "mindmap.syntax.empty-class": m.mindmapDiagnosticEmptyClass,
  "mindmap.syntax.statement": m.mindmapDiagnosticStatement,
  "mindmap.tree.root": m.mindmapDiagnosticRoot,
  "mindmap.decorator.node": m.mindmapDiagnosticDecorator,
};
export function formatMindmapDiagnostic(diagnostic: MindmapDiagnostic) {
  return m.sourceDiagnostic(
    diagnostic.range.line,
    diagnostic.range.start,
    diagnostic.range.end,
    repairs[diagnostic.code](),
  );
}
