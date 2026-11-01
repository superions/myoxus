// SPDX-License-Identifier: AGPL-3.0-or-later

import { getMermaidFrontmatterTitle } from "../diagram-types.js";
import { parseMermaidC4SourceWithDiagnostics } from "./parser.js";
import { C4WriteError, writeC4Patches, type C4Patch } from "./patches.js";
export { writeC4Patches, type C4Patch } from "./patches.js";
import type { C4SourceRecord } from "./source-document.js";
import type {
  MermaidC4Model,
  MermaidC4Boundary,
  MermaidC4Element,
} from "./model.js";
import {
  C4_CALLS,
  c4CallSource,
  relationshipArgumentIndexes,
  elementArgumentIndexes,
  boundaryArgumentIndexes,
} from "./runtime-contract.js";
import {
  elementArguments,
  boundaryArguments,
  relationshipArguments,
} from "./call-arguments.js";
import {
  c4CallPatch,
  c4RecordDeletionPatches,
  insertC4StyleUpdate,
} from "./record-writer.js";
import { c4AliasArguments, c4PairArguments } from "./identity-arguments.js";
import { c4PreamblePatches } from "./preamble-writer.js";
import {
  finishC4StructuralWrites,
  matchC4Object,
} from "./structural-writer.js";

export function generateMermaidC4Source(model: MermaidC4Model) {
  return generateMermaidC4SourceWithBindings(model).source;
}

export function generateMermaidC4SourceWithBindings(model: MermaidC4Model) {
  if (model.sourceDocument.source) return patchRetainedC4Source(model);
  const source = generateNewC4Source(model);
  const resolved = parseMermaidC4SourceWithDiagnostics(source, {
    previous: model.sourceDocument,
  }).model;
  if (!resolved) throw new Error("The generated C4 source cannot be resolved");
  return {
    source,
    model: resolved,
    bindings: { previous: resolved.sourceDocument },
  };
}

function generateNewC4Source(model: MermaidC4Model) {
  const lines = [
    ...model.directives.filter((line) => line.trim()),
    model.headerLine || "C4Context",
  ];
  if (
    model.title &&
    (model.sourceDocument.records.some((r) => r.kind === "title") ||
      model.title !== getMermaidFrontmatterTitle(model.directives))
  )
    lines.push(`  title ${model.title}`);
  if (model.accessibilityTitle)
    lines.push(`  accTitle: ${model.accessibilityTitle}`);
  if (model.accessibilityDescription.includes("\n")) {
    lines.push("  accDescr {");
    lines.push(
      ...model.accessibilityDescription
        .split("\n")
        .map((line) => `    ${line}`),
    );
    lines.push("  }");
  } else if (model.accessibilityDescription) {
    lines.push(`  accDescr: ${model.accessibilityDescription}`);
  }
  const boundariesByParent = new Map<string, MermaidC4Boundary[]>();
  for (const boundary of model.boundaries) {
    const siblings = boundariesByParent.get(boundary.parentId) ?? [];
    siblings.push(boundary);
    boundariesByParent.set(boundary.parentId, siblings);
  }
  for (const siblings of boundariesByParent.values())
    siblings.sort((a, b) => a.order - b.order);
  const elementsByBoundary = new Map<string, MermaidC4Element[]>();
  for (const element of model.elements) {
    const siblings = elementsByBoundary.get(element.boundaryId) ?? [];
    siblings.push(element);
    elementsByBoundary.set(element.boundaryId, siblings);
  }
  for (const siblings of elementsByBoundary.values())
    siblings.sort((a, b) => a.order - b.order);
  const emitElement = (element: MermaidC4Element, indent: string) => {
    lines.push(
      `${indent}${c4CallSource(element.kind, elementArguments(element))}`,
    );
  };
  const emittedBoundaries = new Set<string>();
  const emitBoundary = (boundary: MermaidC4Boundary, indent: string) => {
    if (emittedBoundaries.has(boundary.id)) {
      throw new Error("Cyclic Mermaid C4 boundary hierarchy");
    }
    emittedBoundaries.add(boundary.id);
    lines.push(
      `${indent}${c4CallSource(boundary.kind, boundaryArguments(boundary))} {`,
    );
    for (const child of boundariesByParent.get(boundary.id) ?? [])
      emitBoundary(child, `${indent}  `);
    for (const element of elementsByBoundary.get(boundary.id) ?? [])
      emitElement(element, `${indent}  `);
    lines.push(`${indent}}`);
  };
  for (const boundary of boundariesByParent.get("") ?? [])
    emitBoundary(boundary, "  ");
  if (emittedBoundaries.size !== model.boundaries.length) {
    throw new Error("Disconnected Mermaid C4 boundary hierarchy");
  }
  for (const element of elementsByBoundary.get("") ?? [])
    emitElement(element, "  ");
  for (const relationship of [...model.relationships].sort(
    (a, b) => a.order - b.order,
  )) {
    lines.push(
      `  ${c4CallSource(relationship.kind, relationshipArguments(relationship))}`,
    );
  }
  for (const statement of [...model.updateStatements].sort(
    (a, b) => a.order - b.order,
  )) {
    lines.push(`  ${c4CallSource(statement.kind, statement.callArguments)}`);
  }
  return `${lines.join(model.sourceDocument.newline)}${model.sourceDocument.newline}`;
}

/** Populated diagrams retain their physical scaffold through both field and structural edits. */
function patchRetainedC4Source(model: MermaidC4Model) {
  const basis = model.sourceDocument;
  const previous = parseMermaidC4SourceWithDiagnostics(basis.source, {
    previous: basis,
  }).model;
  if (!previous)
    throw new Error("Cannot rewrite invalid C4 source through a visual model");
  // Draft arrays may share references with their copied Source records. Read
  // actual bytes again; mutated cached arguments are never the comparison basis.
  const document = previous.sourceDocument;
  const patches: C4Patch[] = [];
  const metadataUpdates = new Map<string, Map<string, string>>();
  const calls = new Map<
    string,
    { kind: string; args: MermaidC4Model["elements"][number]["callArguments"] }
  >();
  const edit = (key: string) => {
    let value = calls.get(key);
    if (!value) {
      const record = document.records.find((r) => r.sourceKey === key)!;
      if (!record?.arguments || !record.callKind)
        throw new Error("C4 call binding was lost before writing");
      value = {
        kind: record.callKind,
        args: record.arguments.map((a) => ({ ...a })),
      };
      calls.set(key, value);
    }
    return value;
  };
  const field = (
    resolution: NonNullable<MermaidC4Model["elements"][number]["resolution"]>,
    name: "label" | "techn" | "descr" | "sprite" | "tags" | "link" | "type",
    value: string,
    fallback: number,
  ) => {
    const owner = resolution.providers[name];
    // Native omitted defaults have no physical argument value to overwrite.
    const provider =
      owner && owner.form !== "omitted" && !removed.has(owner.sourceKey)
        ? owner
        : undefined;
    if (!provider) {
      const pending = calls.get(resolution.declarationKey);
      const original = document.records.find(
        (r) => r.sourceKey === resolution.declarationKey,
      )!;
      const introduced =
        pending && !C4_CALLS[original.callKind!].slots.includes(name)
          ? C4_CALLS[pending.kind].slots.indexOf(name)
          : -1;
      const argument = pending?.args[introduced];
      // A kind remap can create a genuine new slot before its first reparse.
      if (
        pending &&
        introduced >= 0 &&
        argument &&
        ((!argument.named && !argument.key) || argument.key === name)
      ) {
        pending.args[introduced] = { ...argument, value };
        return;
      }
      const update =
        metadataUpdates.get(resolution.selectionId) ??
        new Map<string, string>();
      update.set(name, value);
      metadataUpdates.set(resolution.selectionId, update);
      return;
    }
    const key = provider?.sourceKey ?? resolution.declarationKey;
    let index = provider?.argumentIndex ?? fallback;
    const original = document.records.find((r) => r.sourceKey === key)!;
    const pending = calls.get(key);
    if (
      provider?.argumentIndex !== undefined &&
      pending &&
      pending.kind !== original.callKind
    ) {
      const slot = C4_CALLS[original.callKind!].slots[index];
      index = C4_CALLS[pending.kind].slots.indexOf(slot);
    }
    if (index < 0) return;
    const call = edit(key);
    while (call.args.length <= index) call.args.push({ key: "", value: "" });
    call.args[index] = { ...call.args[index], value };
  };
  const removed = new Set<string>();
  const remove = (key: string) => removed.add(key);
  const aliases: {
    owner: {
      alias: string;
      resolution: NonNullable<MermaidC4Model["elements"][number]["resolution"]>;
    };
    alias: string;
  }[] = [];
  const retain = <
    T extends {
      id: string;
      alias: string;
      resolution?: MermaidC4Model["elements"][number]["resolution"];
    },
  >(
    old: readonly T[],
    wanted: readonly T[],
  ) => {
    for (const value of old) {
      const next = matchC4Object(wanted, value);
      if (!next) value.resolution!.sourceKeys.forEach(remove);
      else if (value.alias !== next.alias)
        aliases.push({
          owner: { alias: value.alias, resolution: value.resolution! },
          alias: next.alias,
        });
    }
  };
  retain(previous.elements, model.elements);
  retain(previous.boundaries, model.boundaries);
  for (const old of previous.updateStatements) {
    const next = model.updateStatements.find(
      (s) => s.sourceKey === old.sourceKey,
    );
    if (!next) remove(old.sourceKey!);
    else if (
      old.kind !== next.kind ||
      JSON.stringify(old.callArguments) !== JSON.stringify(next.callArguments)
    )
      calls.set(old.sourceKey!, {
        kind: next.kind,
        args: next.callArguments.map((a) => ({ ...a })),
      });
  }
  for (const value of model.elements) {
    const old = matchC4Object(previous.elements, value);
    if (!old) continue;
    const key = old.resolution!.declarationKey;
    if (old.kind !== value.kind) {
      // Remap declaration slots first; field edits still address their real providers.
      calls.set(key, {
        kind: value.kind,
        args: elementArguments(
          { ...old, kind: value.kind, alias: value.alias },
          old,
        ),
      });
    } else if (
      JSON.stringify(old.callArguments) !== JSON.stringify(value.callArguments)
    )
      calls.set(key, {
        kind: value.kind,
        args: value.callArguments.map((a) => ({ ...a })),
      });
    const indexes = elementArgumentIndexes(value.kind);
    for (const [property, name, index] of [
      ["label", "label", 1],
      ["technology", "techn", indexes.technology],
      ["description", "descr", indexes.description],
      ["sprite", "sprite", indexes.sprite],
      ["tags", "tags", indexes.tags],
      ["link", "link", indexes.link],
    ] as const)
      if (old[property] !== value[property])
        field(old.resolution!, name, value[property], index);
  }
  for (const value of model.boundaries) {
    const old = matchC4Object(previous.boundaries, value);
    if (!old) continue;
    const key = old.resolution!.declarationKey;
    if (old.kind !== value.kind) {
      calls.set(key, { kind: value.kind, args: boundaryArguments(value, old) });
      continue;
    }
    if (
      JSON.stringify(old.callArguments) !== JSON.stringify(value.callArguments)
    )
      calls.set(key, {
        kind: value.kind,
        args: value.callArguments.map((a) => ({ ...a })),
      });
    const indexes = boundaryArgumentIndexes(value.kind);
    for (const [property, name, index] of [
      ["label", "label", 1],
      ["boundaryType", "type", indexes.type],
      ["description", "descr", indexes.description],
      ["sprite", "sprite", indexes.sprite],
      ["tags", "tags", indexes.tags],
      ["link", "link", indexes.link],
    ] as const)
      if (old[property] !== value[property] && index >= 0)
        field(old.resolution!, name, value[property], index);
  }
  for (const old of previous.relationships)
    if (!matchC4Object(model.relationships, old))
      old.resolution!.sourceKeys.forEach(remove);
  for (const value of model.relationships) {
    const old = matchC4Object(previous.relationships, value);
    if (!old) continue;
    const key = old.resolution!.declarationKey;
    if (old.kind !== value.kind) {
      calls.set(key, {
        kind: value.kind,
        args: relationshipArguments(value, old),
      });
      continue;
    }
    if (
      JSON.stringify(old.callArguments) !== JSON.stringify(value.callArguments)
    )
      calls.set(key, {
        kind: value.kind,
        args: value.callArguments.map((a) => ({ ...a })),
      });
    const indexes = relationshipArgumentIndexes(value.kind);
    if (old.index !== value.index && value.kind === "RelIndex")
      edit(key).args[0].value = value.index ?? "";
    for (const [property, name, index] of [
      ["label", "label", indexes.label],
      ["technology", "techn", indexes.technology],
      ["description", "descr", indexes.description],
      ["sprite", "sprite", indexes.sprite],
      ["tags", "tags", indexes.tags],
      ["link", "link", indexes.link],
    ] as const)
      if (old[property] !== value[property])
        field(old.resolution!, name, value[property], index);
  }
  // Apply identity edits after receiving-slot remaps, so raw/kind edits cannot undo them.
  for (const { owner, alias } of aliases) {
    const declarations = new Set(owner.resolution.sourceKeys);
    for (const record of document.records) {
      if (removed.has(record.sourceKey)) continue;
      for (const { index } of c4AliasArguments(
        previous,
        record,
        owner,
        declarations,
      )) {
        const call = edit(record.sourceKey);
        const slot = C4_CALLS[record.callKind!].slots[index];
        const receiving =
          call.kind === record.callKind
            ? index
            : C4_CALLS[call.kind].slots.indexOf(slot);
        if (receiving >= 0 && call.args[receiving])
          call.args[receiving].value = alias;
      }
    }
  }
  for (const value of model.relationships) {
    const old = matchC4Object(previous.relationships, value);
    if (!old || (old.from === value.from && old.to === value.to)) continue;
    for (const record of document.records) {
      if (removed.has(record.sourceKey)) continue;
      for (const { index, field: endpoint } of c4PairArguments(
        previous,
        record,
        old.resolution!.selectionId,
      )) {
        if (old[endpoint] === value[endpoint]) continue;
        if (
          aliases.some(
            (rename) =>
              rename.owner.alias === old[endpoint] &&
              rename.alias === value[endpoint],
          )
        )
          continue;
        const call = edit(record.sourceKey);
        const slot = C4_CALLS[record.callKind!].slots[index];
        const receiving =
          call.kind === record.callKind
            ? index
            : C4_CALLS[call.kind].slots.indexOf(slot);
        if (receiving >= 0 && call.args[receiving])
          call.args[receiving].value = value[endpoint];
      }
    }
  }
  patches.push(...c4RecordDeletionPatches(previous, [...removed]));
  for (const [key, call] of calls)
    if (!removed.has(key)) {
      const record = document.records.find((r) => r.sourceKey === key)!;
      if (
        record.callKind !== call.kind ||
        JSON.stringify(record.arguments) !== JSON.stringify(call.args)
      )
        patches.push(c4CallPatch(previous, key, call.kind, call.args));
    }
  if (JSON.stringify(previous.directives) !== JSON.stringify(model.directives))
    patches.push(...c4PreamblePatches(previous, model.directives));
  const metadata = (
    kind: C4SourceRecord["kind"],
    before: string,
    after: string,
    prefix: string,
  ) => {
    if (before === after) return;
    if (kind === "title" && !after) {
      patches.push(
        ...document.records
          .filter((r) => r.kind === "title")
          .map((r) => ({
            start: r.range.start,
            end: r.range.end + r.eol.length,
            text: "",
          })),
      );
      return;
    }
    const record = document.records.findLast((r) => r.kind === kind);
    if (
      record?.valueRange &&
      kind === "accessibility-description" &&
      /[\r\n]/.test(after) &&
      !record.raw.trimStart().startsWith("accDescr {")
    )
      patches.push({
        start: record.range.start + record.indent.length,
        end: record.range.end,
        text: `accDescr {${document.newline}${after}${document.newline}${record.indent}}`,
      });
    else if (record?.valueRange)
      patches.push({
        start: record.valueRange.start,
        end: record.valueRange.end,
        text: after,
      });
    else if (after) {
      const header = document.records.find((r) => r.kind === "header")!;
      const eolStart = document.source.slice(header.range.end).search(/[\r\n]/);
      const position =
        eolStart < 0
          ? document.source.length
          : header.range.end + eolStart + document.newline.length;
      patches.push({
        start: position,
        end: position,
        text: `${eolStart < 0 ? document.newline : ""}  ${
          kind === "accessibility-description" && /[\r\n]/.test(after)
            ? `accDescr {${document.newline}${after}${document.newline}  }`
            : `${prefix}${after}`
        }${document.newline}`,
      });
    }
  };
  const frontmatterTitle = getMermaidFrontmatterTitle(previous.directives);
  if (previous.title || model.title !== frontmatterTitle)
    metadata("title", previous.title, model.title, "title ");
  metadata(
    "accessibility-title",
    previous.accessibilityTitle,
    model.accessibilityTitle,
    "accTitle: ",
  );
  metadata(
    "accessibility-description",
    previous.accessibilityDescription,
    model.accessibilityDescription,
    "accDescr: ",
  );
  if (previous.headerLine !== model.headerLine) {
    const header = document.records.find((r) => r.kind === "header")!;
    patches.push({
      start: header.range.start + header.indent.length,
      end: header.range.end,
      text: model.headerLine,
    });
  }
  let result = finishC4StructuralWrites(
    previous,
    model,
    writeC4Patches(previous, patches),
  );
  for (const [selectionId, fields] of metadataUpdates) {
    const alias = [...result.model.elements, ...result.model.boundaries].find(
      (value) => value.resolution?.selectionId === selectionId,
    );
    const pair = result.model.relationships.find(
      (value) => value.resolution?.selectionId === selectionId,
    );
    if (alias)
      result = insertC4StyleUpdate(result.model, "UpdateElementStyle", [
        { key: "", value: alias.alias },
        ...[...fields].map(([key, value]) => ({ key, value })),
      ]);
    else if (pair) {
      // Only the first two optional RelStyle slots assign strings; offsets use native parseInt.
      const entries = [...fields];
      for (let index = 0; index < entries.length; index += 2)
        result = insertC4StyleUpdate(result.model, "UpdateRelStyle", [
          { key: "", value: pair.from },
          { key: "", value: pair.to },
          ...entries
            .slice(index, index + 2)
            .map(([key, value]) => ({ key, value })),
        ]);
    } else throw new C4WriteError("C4 metadata target was lost before writing");
  }
  return result;
}
