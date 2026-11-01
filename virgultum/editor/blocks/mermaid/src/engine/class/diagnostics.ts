// SPDX-License-Identifier: AGPL-3.0-or-later

export type ClassSourceDiagnostic = {
  code:
    | "missing-header"
    | "incomplete-record"
    | "invalid-record"
    | "unclosed-class"
    | "unclosed-namespace";
  line: number;
  sourceKey?: string;
  construct: string;
};

import { mermaidMessages as messages } from "../../i18n.js";
export function classSourceDiagnostic(issue: ClassSourceDiagnostic) {
  const reason = {
    "missing-header": messages.classMissingHeader,
    "incomplete-record": messages.classIncomplete,
    "invalid-record": messages.classInvalidRecord,
    "unclosed-class": messages.classUnclosedClass,
    "unclosed-namespace": messages.classUnclosedNamespace,
  }[issue.code]();
  return messages.classDiagnostic(issue.line, issue.construct, reason);
}
