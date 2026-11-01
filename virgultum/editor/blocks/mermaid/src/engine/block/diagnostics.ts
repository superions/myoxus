// SPDX-License-Identifier: AGPL-3.0-or-later
import type { BlockRange } from "./source-document.js";
export type BlockDiagnostic = {
  stage: "syntax" | "resolution" | "render";
  code:
    | "missing-header"
    | "invalid-record"
    | "incomplete-record"
    | "unclosed-composite"
    | "unexpected-end"
    | "empty-body"
    | "empty-composite"
    | "invalid-connection"
    | "unresolved-reference"
    | "unsafe-geometry"
    | "invalid-padding"
    | "zero-columns"
    | "zero-span"
    | "span-overflow"
    | "missing-grid-placement"
    | "ambiguous-record";
  range: BlockRange;
  sourceKey?: string;
  scope?: string;
  construct: string;
};

import { mermaidMessages as m } from "../../i18n.js";
export function blockSourceDiagnostic(d: BlockDiagnostic) {
  const detail =
    d.code === "missing-header"
      ? m.blockMissingHeader()
      : d.code === "invalid-connection"
        ? m.blockInvalidConnection()
        : d.code === "unexpected-end"
          ? m.blockUnexpectedEnd()
          : d.code === "incomplete-record"
            ? m.blockIncompleteRecord()
            : ["empty-body", "empty-composite"].includes(d.code)
              ? m.blockEmptyBody()
              : d.code === "unclosed-composite"
                ? m.blockUnclosedComposite()
                : d.code === "zero-columns"
                  ? m.blockZeroColumns()
                  : d.code === "zero-span"
                    ? m.blockZeroSpan()
                    : d.code === "unsafe-geometry"
                      ? m.blockUnsafeGeometry()
                      : d.code === "unresolved-reference"
                        ? m.blockUnresolvedReference()
                        : d.code === "missing-grid-placement"
                          ? m.blockMissingGridPlacement()
                          : d.code === "span-overflow"
                            ? m.blockSpanOverflow()
                            : d.code === "invalid-padding"
                              ? m.blockInvalidPadding()
                              : m.blockInvalidRecord();
  return d.stage === "syntax"
    ? m.blockDiagnosticSyntax(detail, d.range.line, d.construct)
    : d.stage === "resolution"
      ? m.blockDiagnosticResolution(detail, d.range.line, d.construct)
      : m.blockDiagnosticRender(detail, d.range.line, d.construct);
}
