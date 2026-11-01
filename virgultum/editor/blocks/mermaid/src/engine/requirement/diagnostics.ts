// SPDX-License-Identifier: AGPL-3.0-or-later

import type { RequirementRange } from "./source-document.js";

export type RequirementSourceDiagnostic = {
  code:
    | "missing-header"
    | "incomplete-record"
    | "invalid-record"
    | "invalid-property"
    | "invalid-value"
    | "unclosed-object"
    | "missing-reference"
    | "ambiguous-reference";
  severity: "error" | "warning";
  sourceKey?: string;
  range: RequirementRange;
  construct: string;
  allowed?: readonly string[];
};
