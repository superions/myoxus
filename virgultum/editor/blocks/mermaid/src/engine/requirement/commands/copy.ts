// SPDX-License-Identifier: AGPL-3.0-or-later
import type { MermaidRequirementModel } from "../model.js";
import { requirementComments } from "./comments.js";
import { resolveMermaidRequirementSource } from "../parser.js";
import { sourceRequirementString } from "../runtime-contract.js";
import {
  nextRequirementSourceKey,
  type RequirementSourceRecord,
} from "../source-document.js";
import {
  requirementNoChange,
  writeRequirementPatches,
  type RequirementWriteOptions,
} from "../writer.js";

const objectAt = (model: MermaidRequirementModel, alias: string) =>
  model.requirements.find((object) => object.name === alias) ??
  model.elements.find((object) => object.name === alias);
function replaceRanges(
  record: RequirementSourceRecord,
  patches: { start: number; end: number; value: string }[],
) {
  let raw = record.raw;
  for (const patch of patches.sort((a, b) => b.start - a.start))
    raw =
      raw.slice(0, patch.start - record.range.start) +
      patch.value +
      raw.slice(patch.end - record.range.start);
  return raw + record.eol;
}
function referenceList(
  record: RequirementSourceRecord,
  aliases: readonly string[],
) {
  const first = record.references[0],
    last = record.references.at(-1);
  return first && last && aliases.length
    ? replaceRanges(record, [
        {
          start: first.range.start,
          end: last.range.end,
          value: aliases.map(sourceRequirementString).join(","),
        },
      ])
    : "";
}

/** A card fragment owns whole namespace definition groups, their body comments,
 * internal relationships and only their members of shared class/style lists.
 * Global preamble and ClassDefs remain with the original diagram. */
export function copyRequirementSelection(
  model: MermaidRequirementModel,
  keys: readonly string[],
) {
  const document = model.sourceDocument,
    selected = [...model.requirements, ...model.elements].filter((object) =>
      keys.includes(object.sourceKey ?? ""),
    );
  if (!document || !selected.length || selected.length !== new Set(keys).size)
    return null;
  const selectedKeys = new Set(selected.map((object) => object.sourceKey));
  const definitions = new Set(
    document.records
      .filter(
        (record) =>
          record.kind === "object-open" &&
          selected.some(
            (object) =>
              object.name === record.ownerId &&
              record.namespace ===
                ("requirementType" in object ? "requirement" : "element"),
          ),
      )
      .map((record) => record.sourceKey),
  );
  const relations = new Set(
    model.relations
      .filter(
        (relation) =>
          selectedKeys.has(objectAt(model, relation.from)?.sourceKey) &&
          selectedKeys.has(objectAt(model, relation.to)?.sourceKey),
      )
      .map((relation) => relation.sourceKey),
  );
  const retained = new Map<string, string>();
  for (const record of document.records) {
    if (
      definitions.has(record.sourceKey) ||
      definitions.has(record.blockKey ?? "") ||
      relations.has(record.sourceKey)
    )
      retained.set(record.sourceKey, record.raw + record.eol);
    else if (
      ["style", "style-assignment", "inline-class"].includes(record.kind)
    ) {
      const aliases = record.references
        .filter((reference) =>
          selected.some((object) => object.name === reference.id),
        )
        .map((reference) => reference.id);
      const raw = referenceList(record, aliases);
      if (raw) retained.set(record.sourceKey, raw);
    }
  }
  for (const comment of requirementComments(model))
    if (comment.anchor.key && retained.has(comment.anchor.key)) {
      const record = document.records.find(
        (record) => record.sourceKey === comment.key,
      )!;
      retained.set(record.sourceKey, record.raw + record.eol);
    }
  return (
    `requirementDiagram${document.newline}` +
    document.records
      .flatMap((record) => retained.get(record.sourceKey) ?? [])
      .join("")
  );
}

/** Append checked copied records with fresh syntax aliases and occurrence keys.
 * Source values (including domain IDs) never participate in identity allocation. */
export function pasteRequirementSelection(
  model: MermaidRequirementModel,
  source: string,
  options: RequirementWriteOptions = {},
) {
  const fragment = resolveMermaidRequirementSource(source).model,
    document = model.sourceDocument;
  if (
    !fragment?.sourceDocument ||
    !document ||
    !(fragment.requirements.length + fragment.elements.length)
  )
    return {
      ...requirementNoChange(model, "invalid"),
      copiedKeys: [] as string[],
    };
  if (
    fragment.relations.some(
      (relation) =>
        !objectAt(fragment, relation.from) || !objectAt(fragment, relation.to),
    )
  )
    return {
      ...requirementNoChange(model, "invalid"),
      copiedKeys: [] as string[],
    };
  const objects = [...fragment.requirements, ...fragment.elements],
    used = new Set(
      document.records
        .filter((record) => record.kind === "object-open")
        .map((record) => record.ownerId),
    ),
    aliases = new Map<string, string>();
  for (const object of objects) {
    let index = 1,
      name = `${object.name}_copy${index}`;
    while (used.has(name)) name = `${object.name}_copy${++index}`;
    used.add(name);
    aliases.set(object.sourceKey!, name);
  }
  const definitionAliases = new Map(
    fragment.sourceDocument.records
      .filter((record) => record.kind === "object-open")
      .map((record) => {
        const object = objects.find(
          (object) =>
            object.name === record.ownerId &&
            record.namespace ===
              ("requirementType" in object ? "requirement" : "element"),
        );
        return [record.sourceKey, object && aliases.get(object.sourceKey!)];
      }),
  );
  const referenceAlias = (alias: string) => {
    const object = objectAt(fragment, alias);
    return object && aliases.get(object.sourceKey!);
  };
  const identities: (readonly [number, string])[] = [],
    copiedKeys: string[] = [];
  let appended =
    document.source.length && !/[\r\n]$/.test(document.source)
      ? document.newline
      : "";
  for (const record of fragment.sourceDocument.records) {
    if (
      [
        "header",
        "frontmatter",
        "directive",
        "direction",
        "accessibility-title",
        "accessibility-description",
        "style-definition",
      ].includes(record.kind)
    )
      continue;
    if (
      ["style", "style-assignment", "inline-class"].includes(record.kind) &&
      !record.references.some((reference) => referenceAlias(reference.id))
    )
      continue;
    const key = nextRequirementSourceKey();
    identities.push([appended.length, key]);
    if (objects.some((object) => object.sourceKey === record.sourceKey))
      copiedKeys.push(key);
    if (record.kind === "object-open") {
      const alias = definitionAliases.get(record.sourceKey),
        range = record.values.alias;
      if (!alias || !range)
        return { ...requirementNoChange(model, "invalid"), copiedKeys: [] };
      const quoted = record.raw
        .slice(range.start - record.range.start)
        .startsWith('"');
      appended += replaceRanges(record, [
        {
          ...range,
          value: quoted ? `"${alias}"` : sourceRequirementString(alias),
        },
      ]);
    } else if (
      ["style", "style-assignment", "inline-class"].includes(record.kind)
    )
      appended += referenceList(
        record,
        record.references.flatMap((reference) =>
          objects
            .filter((object) => object.name === reference.id)
            .flatMap((object) => aliases.get(object.sourceKey!) ?? []),
        ),
      );
    else if (record.kind === "relation") {
      const patches = record.references.map((reference) => ({
        ...reference.range,
        value: sourceRequirementString(
          referenceAlias(reference.id) ?? reference.id,
        ),
      }));
      appended += replaceRanges(record, patches);
    } else appended += record.raw + record.eol;
    if (appended && !/[\r\n]$/.test(appended)) appended += document.newline;
  }
  const end = document.source.length,
    result = writeRequirementPatches(
      model,
      [{ range: { start: end, end }, value: appended, identities }],
      options,
    );
  if (result.changed) {
    // Existing edit IDs can outlive an alias rename. Allocate copied edit IDs
    // from fresh records, not from aliases that may equal one of those old IDs.
    const fresh = new Set(identities.map(([, key]) => key));
    for (const object of [
      ...result.model.requirements,
      ...result.model.elements,
      result.model.relations,
    ].flat())
      if (object.sourceKey && fresh.has(object.sourceKey))
        object.id = object.sourceKey;
    for (const relation of result.model.relations) {
      relation.fromId = objectAt(result.model, relation.from)?.id;
      relation.toId = objectAt(result.model, relation.to)?.id;
    }
  }
  return { ...result, copiedKeys: result.changed ? copiedKeys : [] };
}
