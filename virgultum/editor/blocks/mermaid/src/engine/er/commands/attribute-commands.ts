// SPDX-License-Identifier: AGPL-3.0-or-later
import type { MermaidErModel, MermaidErAttribute } from "../model.js";
import { nextErSourceKey } from "../source-document.js";
import { parseMermaidErAttributeSourceLine } from "../parser.js";
import {
  erEntity,
  erEntityDeclarations,
  erQuotedField,
  deleteErSelection,
} from "./entity-commands.js";
import {
  sourceMermaidErAttribute,
  erNoChange,
  erRecord,
  erRecordGroup,
  erNewRecordPatch,
  erMoveRecords,
  writeErPatches,
  type ErPatch,
  type ErWriteOptions,
} from "../writer.js";
import { mermaidMessages as m } from "../../../i18n.js";
export type ErAttributeChanges = Partial<
  Pick<MermaidErAttribute, "name" | "type" | "optional" | "keys" | "comment">
>;
export function editErAttribute(
  model: MermaidErModel,
  key: string,
  changes: ErAttributeChanges,
  options: ErWriteOptions = {},
) {
  const attribute = model.entities
      .flatMap((e) => e.attributes)
      .find((a) => a.id === key),
    record = erRecord(model, key);
  if (!attribute || !record)
    return erNoChange(model, "invalid", m.erMissingObject());
  const next = { ...attribute, ...changes };
  if (!parseMermaidErAttributeSourceLine(sourceMermaidErAttribute(next)))
    return erNoChange(model, "invalid", m.erPatchRejected());
  const patches: ErPatch[] = [];
  for (const field of [
    "name",
    "type",
    "optional",
    "keys",
    "comment",
  ] as const) {
    if (
      !Object.hasOwn(changes, field) ||
      JSON.stringify(changes[field]) === JSON.stringify(attribute[field])
    )
      continue;
    const range = record.values[field];
    if (field === "name" || field === "type") {
      if (!range) return erNoChange(model, "invalid", m.erPatchRejected());
      const value = String(changes[field]);
      const encoded = erQuotedField(
        model.sourceDocument.source,
        range,
        value,
        (v) =>
          /^[\p{L}_*][\p{L}\p{N}_()[\].,*-]*$/u.test(v) ||
          /^\S*~[^~\n]+~\S*$/u.test(v)
            ? v
            : `\`${v.replaceAll("`", "")}\``,
      );
      patches.push({ range, value: encoded });
    } else if (field === "optional") {
      const end = record.values.type!.end;
      patches.push({
        range: range ?? { start: end, end },
        value: next.optional ? "?" : "",
      });
    } else if (field === "keys") {
      const end = record.values.name!.end;
      patches.push({
        range: range ?? { start: end, end },
        value: range
          ? next.keys.join(", ")
          : next.keys.length
            ? ` ${next.keys.join(", ")}`
            : "",
      });
    } else {
      const end = record.values.keys?.end ?? record.values.name!.end;
      const value = next.comment
        ? `"${next.comment.replaceAll('"', "&quot;")}"`
        : "";
      patches.push({
        range: range ?? { start: end, end },
        value: range ? value : value ? ` ${value}` : "",
      });
    }
  }
  return writeErPatches(model, patches, {
    ...options,
    selection: key,
    focus: key,
  });
}
export function addErAttribute(
  model: MermaidErModel,
  entityKey: string,
  value: {
    name: string;
    type: string;
    optional?: boolean;
    keys?: MermaidErAttribute["keys"];
    comment?: string;
  },
  options: ErWriteOptions = {},
  before?: string,
) {
  const entity = erEntity(model, entityKey),
    signature = sourceMermaidErAttribute(value);
  if (!entity || !parseMermaidErAttributeSourceLine(signature))
    return erNoChange(model, "invalid", m.erPatchRejected());
  const target = before ? erRecord(model, before) : undefined;
  if (target && !entity.attributes.some((a) => a.id === before))
    return erNoChange(model, "invalid", m.erPatchRejected());
  const declarations = erEntityDeclarations(model, entity.id),
    opening = declarations.findLast((r) => r.closeKey),
    closing = opening?.closeKey ? erRecord(model, opening.closeKey) : undefined,
    key = nextErSourceKey();
  if (target || closing)
    return writeErPatches(
      model,
      [
        erNewRecordPatch(
          model,
          target?.range.start ?? closing!.range.start,
          `${target?.indent ?? opening!.indent + "  "}${signature}`,
          key,
        ),
      ],
      { ...options, selection: key, focus: key },
    );
  const declaration = declarations[0],
    newline = model.sourceDocument.newline;
  if (declaration) {
    const prefix = `${declaration.raw} {${newline}${declaration.indent}  `;
    return writeErPatches(
      model,
      [
        {
          range: declaration.range,
          value: prefix + signature + newline + declaration.indent + "}",
          identities: [
            [0, declaration.sourceKey],
            [prefix.length - declaration.indent.length - 2, key],
          ],
        },
      ],
      { ...options, selection: key, focus: key },
    );
  }
  const prefix = `${sourceMermaidErEntityName(entity.id)} {${newline}  `,
    patch = erNewRecordPatch(
      model,
      model.sourceDocument.source.length,
      prefix + signature + newline + "}",
    );
  const extra = patch.value.indexOf(prefix);
  patch.identities = [
    [extra, nextErSourceKey()],
    [extra + prefix.length - 2, key],
  ];
  return writeErPatches(model, [patch], {
    ...options,
    selection: key,
    focus: key,
  });
}
import { sourceMermaidErEntityName } from "../writer.js";
export function duplicateErAttribute(
  model: MermaidErModel,
  key: string,
  name: string,
  options: ErWriteOptions = {},
) {
  const entity = model.entities.find((e) =>
      e.attributes.some((a) => a.id === key),
    ),
    attribute = entity?.attributes.find((a) => a.id === key),
    record = erRecord(model, key);
  if (!entity || !attribute || !record)
    return erNoChange(model, "invalid", m.erMissingObject());
  const next = entity.attributes[entity.attributes.indexOf(attribute) + 1];
  return addErAttribute(
    model,
    entity.sourceKey,
    { ...attribute, name },
    options,
    next?.id,
  );
}
export function deleteErAttribute(
  model: MermaidErModel,
  key: string,
  options: ErWriteOptions = {},
) {
  return deleteErSelection(model, [key], options);
}
/** Move the selected lexical unit, including only comments anchored to that row. */
export function reorderErAttribute(
  model: MermaidErModel,
  key: string,
  before: string | null,
  options: ErWriteOptions = {},
) {
  const entity = model.entities.find((e) =>
      e.attributes.some((a) => a.id === key),
    ),
    group = erRecordGroup(model, key);
  if (!entity || !group || before === key) return erNoChange(model);
  if (before && !entity.attributes.some((a) => a.id === before))
    return erNoChange(model, "invalid", m.erPatchRejected());
  const target = before ? erRecordGroup(model, before) : null,
    opening = erEntityDeclarations(model, entity.id).find(
      (r) =>
        r.closeKey &&
        group.range.start > r.range.start &&
        group.range.end <= erRecord(model, r.closeKey!)!.range.start,
    ),
    close = opening?.closeKey ? erRecord(model, opening.closeKey) : undefined;
  if (!target && !close)
    return erNoChange(model, "invalid", m.erPatchRejected());
  return writeErPatches(
    model,
    erMoveRecords(
      model,
      group.records,
      target?.range.start ?? close!.range.start,
    ),
    { ...options, selection: key, focus: key },
  );
}
