// SPDX-License-Identifier: AGPL-3.0-or-later
import type { MermaidRequirementModel } from "../model.js";
import { sourceRequirementString } from "../runtime-contract.js";
import {
  requirementNoChange,
  writeRequirementPatches,
  type RequirementWriteOptions,
  type RequirementPatch,
} from "../writer.js";

export type RequirementTypographyValues = Partial<
  Record<"font-size" | "font-weight" | "font-style", string>
>;

/** Typography never edits shared classes or target lists. A final singleton
 * override isolates the chosen alias while preserving every other declaration's
 * cascade position. Subsequent edits patch that singleton's value spans. */
export function editRequirementTypography(
  model: MermaidRequirementModel,
  key: string,
  values: RequirementTypographyValues,
  options: RequirementWriteOptions = {},
) {
  const objects = [...model.requirements, ...model.elements],
    object = objects.find((object) => object.sourceKey === key),
    document = model.sourceDocument;
  if (
    !object ||
    !document ||
    objects.filter((candidate) => candidate.name === object.name).length !== 1
  )
    return requirementNoChange(model, "invalid");
  const entries = Object.entries(values);
  if (
    entries.some(([name, value]) =>
      name === "font-size"
        ? !/^\d+(?:\.\d+)?px$/.test(value) || parseFloat(value) <= 0
        : name === "font-weight"
          ? !/^(?:normal|bold|[1-9]00)$/.test(value)
          : name !== "font-style" || !/^(?:normal|italic)$/.test(value),
    )
  )
    return requirementNoChange(model, "invalid");
  const patches: RequirementPatch[] = [],
    appended: string[] = [];
  // Only the final style-producing record can be changed in place without
  // moving a declaration ahead of a later ClassDef/assignment/style effect.
  const last = document.records
    .filter((record) =>
      [
        "style",
        "style-definition",
        "style-assignment",
        "inline-class",
        "object-close",
      ].includes(record.kind),
    )
    .at(-1);
  for (const [name, value] of entries) {
    const current = object.cssStyles
      ?.flatMap((declaration) => declaration.split(";"))
      .map((declaration) => {
        const colon = declaration.indexOf(":");
        return [
          declaration.slice(0, colon).trim().toLowerCase(),
          declaration.slice(colon + 1).trim(),
        ];
      })
      .findLast(([property]) => property === name)?.[1];
    if (current === value) continue;
    const target =
      last?.kind === "style" &&
      last.references.length === 1 &&
      last.references[0].id === object.name
        ? last
        : undefined;
    const end = target?.references[0].range.end;
    const raw =
      end === undefined ? "" : document.source.slice(end, target!.range.end);
    const matches = [
      ...raw.matchAll(
        new RegExp(
          `(?:^|[,;])\\s*${name}\\s*:\\s*([^,;]*?)(?=\\s*(?:[,;]|$))`,
          "gi",
        ),
      ),
    ];
    const match = matches.at(-1);
    if (match && end !== undefined) {
      const start = end + match.index! + match[0].length - match[1].length;
      patches.push({ range: { start, end: start + match[1].length }, value });
    } else appended.push(`${name}:${value}`);
  }
  if (appended.length) {
    const end = document.source.length;
    patches.push({
      range: { start: end, end },
      value: `${end && !/[\r\n]$/.test(document.source) ? document.newline : ""}style ${sourceRequirementString(object.name)} ${appended.join(",")}${document.newline}`,
    });
  }
  return writeRequirementPatches(model, patches, {
    ...options,
    selection: object.id,
  });
}
