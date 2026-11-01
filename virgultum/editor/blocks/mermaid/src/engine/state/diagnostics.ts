// SPDX-License-Identifier: AGPL-3.0-or-later
export type StateSourceDiagnostic = {
  code:
    | "missing-header"
    | "incomplete-record"
    | "invalid-record"
    | "unclosed-composite"
    | "unclosed-note"
    | "composite-description"
    | "invalid-region"
    | "ambiguous-record";
  line: number;
  column: number;
  sourceKey?: string;
  scope?: string;
  construct: string;
};

import { mermaidMessages as m } from "../../i18n.js";
export function stateSourceDiagnostic(issue: StateSourceDiagnostic) {
  const reason = {
    "missing-header": m.stateMissingHeader,
    "incomplete-record": m.classIncomplete,
    "invalid-record": m.stateInvalidRecord,
    "unclosed-composite": m.stateUnclosedComposite,
    "unclosed-note": m.stateUnclosedNote,
    "composite-description": m.stateCompositeDescription,
    "invalid-region": m.stateInvalidRegion,
    "ambiguous-record": m.stateAmbiguousRecord,
  }[issue.code]();
  return m.stateDiagnostic(issue.line, issue.column, issue.construct, reason);
}
