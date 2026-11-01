// SPDX-License-Identifier: AGPL-3.0-or-later
export type ErSourceDiagnostic = {
  code:
    | "missing-header"
    | "incomplete-record"
    | "invalid-record"
    | "unclosed-entity"
    | "unclosed-subgraph";
  line: number;
  column: number;
  sourceKey?: string;
  construct: string;
};
import { mermaidMessages as m } from "../../i18n.js";
export function erSourceDiagnostic(issue: ErSourceDiagnostic) {
  const reason = {
    "missing-header": m.erMissingHeader,
    "incomplete-record": m.erIncomplete,
    "invalid-record": m.erInvalidRecord,
    "unclosed-entity": m.erUnclosedEntity,
    "unclosed-subgraph": m.erUnclosedSubgraph,
  }[issue.code]();
  return m.erDiagnostic(issue.line, issue.column, issue.construct, reason);
}
