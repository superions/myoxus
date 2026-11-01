// SPDX-License-Identifier: AGPL-3.0-or-later

import { c4RecordUnit, c4RecordEnd } from "./source-unit.js";
import type { MermaidC4Argument, MermaidC4Model } from "./model.js";
import {
  c4CallSource,
  c4Quote,
  c4RequiredArgumentIssues,
  isC4ArgumentKey,
} from "./runtime-contract.js";
import {
  nextC4SourceKey,
  scanC4Source,
  type C4SourceDocument,
} from "./source-document.js";
import { C4WriteError, writeC4Patches, type C4Patch } from "./patches.js";

/** Replace only the bound call; indentation, braces and inline comments stay owned by their records. */
export function c4CallPatch(
  basis: MermaidC4Model | C4SourceDocument,
  sourceKey: string,
  kind: string,
  args: readonly MermaidC4Argument[],
): C4Patch {
  if (args.some((argument) => !isC4ArgumentKey(argument.key)))
    throw new C4WriteError(
      "The named argument key contains its native delimiter",
    );
  const document = "sourceDocument" in basis ? basis.sourceDocument : basis;
  const record = document.records.find((r) => r.sourceKey === sourceKey);
  if (!record?.callRange)
    throw new C4WriteError("C4 call binding was lost before writing");
  const serialized = c4CallSource(kind, args);
  let text = serialized;
  if (
    typeof record.callKind === "string" &&
    record.arguments?.length === args.length &&
    record.argumentBindings?.length === args.length
  ) {
    const edits: C4Patch[] = [];
    // A body-kind change with unchanged slots owns only the keyword token.
    // Preserve the existing argument quotes and whitespace just like value edits.
    if (kind !== record.callKind)
      edits.push({
        start: record.callRange.start,
        end: record.callRange.start + record.callKind.length,
        text: kind,
      });
    let retain = true;
    for (let index = 0; index < args.length; index++) {
      const before = record.arguments[index],
        after = args[index],
        binding = record.argumentBindings[index];
      if (JSON.stringify(before) === JSON.stringify(after)) continue;
      const wasNamed = !!(before.named || before.key),
        isNamed = !!(after.named || after.key);
      const quoted =
        document.source[binding.value.start - 1] === '"' &&
        document.source[binding.value.end] === '"';
      // Paired-comma empties own delimiters. Changing their form requires rebuilding
      // the call; ordinary value/key edits retain every untouched token byte.
      if (!quoted && binding.form === "empty") {
        retain = false;
        break;
      }
      if (wasNamed !== isNamed) {
        const prefix = /^[ ]*/.exec(
          document.source.slice(binding.range.start, binding.range.end),
        )![0];
        edits.push({
          start: binding.range.start,
          end: binding.range.end,
          text:
            prefix +
            (isNamed
              ? `$${after.key}=${c4Quote(after.value || " ")}`
              : c4Quote(after.value)),
        });
        continue;
      }
      if (before.key !== after.key) {
        if (!binding.key) {
          retain = false;
          break;
        }
        edits.push({
          start: binding.key.start,
          end: binding.key.end,
          text: after.key || " ",
        });
      }
      if (before.value !== after.value)
        edits.push({
          start: binding.value.start,
          end: binding.value.end,
          text: quoted
            ? (after.value || (isNamed ? " " : "")).replaceAll('"', "#quot;")
            : c4Quote(after.value),
        });
    }
    if (retain) {
      text = document.source.slice(
        record.callRange.start,
        record.callRange.end,
      );
      for (const edit of edits.sort((a, b) => b.start - a.start))
        text =
          text.slice(0, edit.start - record.callRange.start) +
          edit.text +
          text.slice(edit.end - record.callRange.start);
    }
  }
  return { start: record.callRange.start, end: record.callRange.end, text };
}

/** Deleting a boundary declaration removes its own braces, never implicitly its children/trivia. */
export function c4RecordDeletionPatches(
  model: MermaidC4Model,
  sourceKeys: readonly string[],
): C4Patch[] {
  const records = model.sourceDocument.records,
    keys = new Set(sourceKeys);
  for (const record of records)
    if (keys.has(record.sourceKey) && record.kind === "boundary-open") {
      if (!record.closeKey)
        throw new C4WriteError("Cannot delete an unclosed C4 boundary");
      keys.add(record.closeKey);
      if (record.braceKey) keys.add(record.braceKey);
    }
  return records
    .filter((r) => keys.has(r.sourceKey))
    .map((r) => ({
      start: r.range.start,
      end: r.range.end + r.eol.length,
      text: "",
    }));
}

export type C4InsertTarget = Readonly<{
  parentKey: string | null;
  beforeKey?: string;
}>;

/** New updates follow every existing target declaration/update in its physical scope.
 * Named attributes avoid clearing unrelated fields through empty positional padding. */
export function insertC4StyleUpdate(
  model: MermaidC4Model,
  kind: "UpdateElementStyle" | "UpdateRelStyle",
  args: readonly MermaidC4Argument[],
) {
  if (
    c4RequiredArgumentIssues(kind, args).length ||
    (kind === "UpdateElementStyle"
      ? ![...model.elements, ...model.boundaries].some(
          (value) => value.alias === args[0].value,
        )
      : !model.relationships.some(
          (value) => value.from === args[0].value && value.to === args[1].value,
        ))
  )
    throw new C4WriteError("C4 update target has no declaration");
  const records = model.sourceDocument.records;
  const resolution =
    kind === "UpdateElementStyle"
      ? [...model.elements, ...model.boundaries].find(
          (value) => value.alias === args[0].value,
        )!.resolution!
      : model.relationships.find(
          (value) => value.from === args[0].value && value.to === args[1].value,
        )!.resolution!;
  const ownedKeys = new Set(
    model.occurrences
      .filter((o) => o.selectionId === resolution.selectionId)
      .map((o) => o.sourceKey),
  );
  const owner = records.findLast((record) => ownedKeys.has(record.sourceKey));
  if (!owner) throw new C4WriteError("C4 update target has no declaration");
  const parentKey = owner.scopeKeys.at(-1) ?? null,
    end = c4RecordEnd(c4RecordUnit(model, owner)!.at(-1)!);
  const before = records.find(
    (record) =>
      record.range.start >= end &&
      (record.scopeKeys.at(-1) ?? null) === parentKey,
  );
  return insertC4Record(
    model,
    { parentKey, beforeKey: before?.sourceKey },
    owner.indent + c4CallSource(kind, args),
  );
}
/** Explicit lexical insertion. Geometry never chooses a Source parent or position. */
export function insertC4Record(
  model: MermaidC4Model,
  target: C4InsertTarget,
  raw: string,
) {
  const document = model.sourceDocument,
    records = document.records;
  const parent = target.parentKey
    ? records.find((r) => r.sourceKey === target.parentKey)
    : undefined;
  if (
    target.parentKey &&
    (!parent || parent.kind !== "boundary-open" || !parent.closeKey)
  )
    throw new C4WriteError("C4 insertion parent has no complete boundary");
  const beforeKey = target.beforeKey ?? parent?.closeKey;
  const before = beforeKey
    ? records.find((r) => r.sourceKey === beforeKey)
    : undefined;
  if (
    beforeKey &&
    (!before || (before.scopeKeys.at(-1) ?? null) !== target.parentKey)
  )
    throw new C4WriteError("C4 insertion position belongs to another scope");
  if (before && ["header", "directive", "frontmatter"].includes(before.kind))
    throw new C4WriteError("C4 insertion must follow the header");
  const position = before
    ? (c4RecordUnit(model, before)?.[0]?.range.start ?? before.range.start)
    : document.source.length;
  const prefix =
    position > 0 && !/[\r\n]$/.test(document.source.slice(0, position))
      ? document.newline
      : "";
  const text = prefix + raw + (/[\r\n]$/.test(raw) ? "" : document.newline);
  const scanned = scanC4Source("C4Context" + document.newline + raw);
  const offset = "C4Context".length + document.newline.length;
  const identities = scanned.records
    .filter((r) => r.range.start >= offset)
    .map(
      (r) =>
        [prefix.length + r.range.start - offset, nextC4SourceKey()] as const,
    );
  return writeC4Patches(model, [
    { start: position, end: position, text, identities },
  ]);
}
