// SPDX-License-Identifier: AGPL-3.0-or-later
import type { MermaidRequirementModel } from "../model.js";
import { REQUIREMENT_DIRECTIONS } from "../runtime-contract.js";
import {
  requirementNoChange,
  writeRequirementPatches,
  type RequirementWriteOptions,
} from "../writer.js";

/** The last native direction record is effective. Replace only its token;
 * earlier records and the surrounding byte form are not normalized. */
export function editRequirementDirection(
  model: MermaidRequirementModel,
  direction: NonNullable<MermaidRequirementModel["direction"]>,
  options: RequirementWriteOptions = {},
) {
  const document = model.sourceDocument;
  if (
    !document ||
    !(REQUIREMENT_DIRECTIONS as readonly string[]).includes(direction)
  )
    return requirementNoChange(model, "invalid");
  if ((model.direction ?? "TB") === direction)
    return requirementNoChange(model);
  const record = document.records
    .filter((record) => record.kind === "direction")
    .at(-1);
  if (record) {
    const match = /^(\s*direction\s+)(TB|BT|LR|RL)/i.exec(record.raw);
    if (!match) return requirementNoChange(model, "invalid");
    const start = record.range.start + match[1].length;
    return writeRequirementPatches(
      model,
      [{ range: { start, end: start + match[2].length }, value: direction }],
      options,
    );
  }
  const header = document.records.find((record) => record.kind === "header");
  if (!header) return requirementNoChange(model, "invalid");
  const start = header.range.end + header.eol.length;
  return writeRequirementPatches(
    model,
    [
      {
        range: { start, end: start },
        value: `${header.eol ? "" : document.newline}direction ${direction}${document.newline}`,
      },
    ],
    options,
  );
}
