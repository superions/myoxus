// SPDX-License-Identifier: AGPL-3.0-or-later
export type SequenceSourceDiagnostic = {
  code:
    | "missing-header"
    | "incomplete-record"
    | "invalid-record"
    | "unclosed-fragment"
    | "invalid-branch"
    | "activation-balance"
    | "lifecycle"
    | "box-membership";
  line: number;
  column: number;
  sourceKey?: string;
  construct: string;
};

import { mermaidMessages as m } from "../../i18n.js";
export function sequenceSourceDiagnostic(issue: SequenceSourceDiagnostic) {
  const reason = {
    "missing-header": m.sequenceMissingHeader,
    "incomplete-record": m.classIncomplete,
    "invalid-record": m.sequenceInvalidRecord,
    "unclosed-fragment": m.sequenceUnclosedFragment,
    "invalid-branch": m.sequenceInvalidBranch,
    "activation-balance": m.sequenceActivationBalance,
    lifecycle: m.sequenceLifecycle,
    "box-membership": m.sequenceBoxMembership,
  }[issue.code]();
  return m.sequenceDiagnostic(
    issue.line,
    issue.column,
    issue.construct,
    reason,
  );
}
