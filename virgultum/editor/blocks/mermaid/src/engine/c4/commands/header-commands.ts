// SPDX-License-Identifier: AGPL-3.0-or-later

import type { MermaidC4Model } from "../model.js";
import { C4_HEADERS, type MermaidC4Header } from "../runtime-contract.js";
import { C4WriteError, writeC4Patches } from "../patches.js";
import { c4CommandResult, c4NoChange } from "./model.js";
import { mermaidMessages as m } from "../../../i18n.js";

/** Change only the native header token. Reparse advances bindings and Dynamic
 * effects while retaining every still-valid physical declaration and comment. */
export function changeC4Header(model: MermaidC4Model, header: MermaidC4Header) {
  if (!C4_HEADERS.includes(header))
    return c4NoChange(model, m.classPatchRejected());
  if (model.headerLine === header) return c4NoChange(model);
  const record = model.sourceDocument.records.find((r) => r.kind === "header");
  if (!record) return c4NoChange(model, m.classPatchRejected());
  try {
    return c4CommandResult(
      model,
      writeC4Patches(model, [
        {
          start: record.range.start + record.indent.length,
          end: record.range.end,
          text: header,
        },
      ]),
    );
  } catch (error) {
    if (!(error instanceof C4WriteError)) throw error;
    return c4NoChange(model, m.classPatchRejected());
  }
}
