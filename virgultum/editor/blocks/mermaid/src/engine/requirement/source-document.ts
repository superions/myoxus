// SPDX-License-Identifier: AGPL-3.0-or-later

import { hashMermaidSource } from "../source-hash.js";
import { reconcileSourceRecordBindings } from "../source-record-bindings.js";
import type { RequirementSourceDiagnostic } from "./diagnostics.js";
import { REQUIREMENT_CSS_ID_LIST } from "./runtime-contract.js";

export type RequirementRange = { start: number; end: number; line: number };
export type RequirementNamespace = "requirement" | "element";
export type RequirementSourceRecord = {
  sourceKey: string;
  kind:
    | "header"
    | "frontmatter"
    | "directive"
    | "direction"
    | "accessibility-title"
    | "accessibility-description"
    | "object-open"
    | "property"
    | "object-close"
    | "relation"
    | "style-definition"
    | "style-assignment"
    | "inline-class"
    | "style"
    | "comment"
    | "blank"
    | "invalid";
  range: RequirementRange;
  raw: string;
  eol: string;
  indent: string;
  complete: boolean;
  namespace?: RequirementNamespace;
  ownerId?: string;
  blockKey?: string;
  closeKey?: string;
  values: Record<string, RequirementRange>;
  references: Array<{ id: string; range: RequirementRange }>;
};
export type RequirementSourceDocument = {
  source: string;
  newline: string;
  records: RequirementSourceRecord[];
  diagnostics: RequirementSourceDiagnostic[];
};

export function nextRequirementSourceKey() {
  return `requirement-source-${crypto.randomUUID()}`;
}

export function requirementRecordRange(
  record: RequirementSourceRecord,
  start: number,
  end: number,
): RequirementRange {
  return {
    start: record.range.start + start,
    end: record.range.start + end,
    line:
      record.range.line +
      (record.raw.slice(0, start).match(/\r\n|\r|\n/g)?.length ?? 0),
  };
}

/** Physical records retain every byte. Double-quoted strings may span lines;
 * backslashes do not escape quotes in the pinned Requirement lexer. Grammar and
 * effective first-definition/first-property semantics belong to the parser. */
export function scanRequirementSource(
  source: string,
  previous?: RequirementSourceDocument,
  mapping?: ReadonlyMap<number, string>,
): RequirementSourceDocument {
  const records: RequirementSourceRecord[] = [];
  let cursor = 0;
  let line = 1;
  let owner: RequirementSourceRecord | undefined;
  const push = (
    kind: RequirementSourceRecord["kind"],
    end: number,
    complete = true,
  ) => {
    const raw = source.slice(cursor, end);
    const eol = /^(?:\r\n|\r|\n)/.exec(source.slice(end))?.[0] ?? "";
    const record: RequirementSourceRecord = {
      sourceKey: `requirement-record-${cursor}-${hashMermaidSource(raw)}`,
      kind,
      range: { start: cursor, end, line },
      raw,
      eol,
      indent: /^[ \t]*/.exec(raw)![0],
      complete,
      values: {},
      references: [],
    };
    if (owner) {
      record.namespace = owner.namespace;
      record.ownerId = owner.ownerId;
      record.blockKey = owner.sourceKey;
    }
    records.push(record);
    cursor = end + eol.length;
    line += (raw.match(/\r\n|\r|\n/g)?.length ?? 0) + (eol ? 1 : 0);
    return record;
  };
  while (cursor < source.length) {
    const tail = source.slice(cursor);
    const indent = /^[ \t]*/.exec(tail)![0].length;
    const text = tail.slice(indent);
    const offset = cursor + indent;
    const newline = tail.search(/[\r\n]/);
    const lineEnd = cursor + (newline < 0 ? tail.length : newline);
    if (cursor === 0 && /^---[ \t]*(?:\r\n|\r|\n)/.test(text)) {
      const close = /(?:\r\n|\r|\n)[ \t]*---[ \t]*(?=\r\n|\r|\n|$)/.exec(
        tail.slice(indent + 3),
      );
      push(
        "frontmatter",
        close ? offset + 3 + close.index + close[0].length : source.length,
        Boolean(close),
      );
      continue;
    }
    if (text.startsWith("%%{")) {
      const end = source.indexOf("}%%", offset + 3);
      push("directive", end < 0 ? source.length : end + 3, end >= 0);
      continue;
    }
    if (/^[%#]/.test(text)) {
      push("comment", lineEnd);
      continue;
    }
    if (!source.slice(cursor, lineEnd).trim()) {
      push("blank", lineEnd);
      continue;
    }
    if (!owner && /^accDescr\s*\{/i.test(text)) {
      const end = source.indexOf("}", offset);
      push(
        "accessibility-description",
        end < 0 ? source.length : end + 1,
        end >= 0,
      );
      continue;
    }
    if (!owner && /^acc(?:Title|Descr)\s*:/i.test(text)) {
      push(
        /^accTitle/i.test(text)
          ? "accessibility-title"
          : "accessibility-description",
        lineEnd,
      );
      continue;
    }
    if (!owner && /^requirementDiagram\b/i.test(text)) {
      push("header", offset + "requirementDiagram".length);
      continue;
    }
    if (owner && text.startsWith("}")) {
      const close = push("object-close", offset + 1);
      owner.closeKey = close.sourceKey;
      owner = undefined;
      continue;
    }
    const declaration = !owner
      ? new RegExp(
          `^(requirement|functionalRequirement|interfaceRequirement|performanceRequirement|physicalRequirement|designConstraint|element)\\b[ \\t]+("[^"]*"|[\\w][^:,\\r\\n{}<>\\-=]*?)(?:[ \\t]*:::[ \\t]*(${REQUIREMENT_CSS_ID_LIST}))?[ \\t]*\\{`,
          "i",
        ).exec(text)
      : null;
    if (declaration) {
      const record = push("object-open", offset + declaration[0].length);
      record.namespace =
        declaration[1]!.toLowerCase() === "element" ? "element" : "requirement";
      record.ownerId = declaration[2]!.startsWith('"')
        ? declaration[2]!.slice(1, -1)
        : declaration[2]!.trim();
      const kindStart = indent;
      const aliasStart = record.raw.indexOf(
        declaration[2]!,
        kindStart + declaration[1]!.length,
      );
      record.values.kind = requirementRecordRange(
        record,
        kindStart,
        kindStart + declaration[1]!.length,
      );
      record.values.alias = requirementRecordRange(
        record,
        aliasStart,
        aliasStart + declaration[2]!.length,
      );
      if (declaration[3]) {
        const start = record.raw.indexOf(":::", aliasStart) + 3;
        record.values.classes = requirementRecordRange(
          record,
          start,
          record.raw.lastIndexOf("{"),
        );
      }
      owner = record;
      continue;
    }
    // A statement boundary is outside quoted content, even when that content
    // contains braces, comment prefixes or physical newlines.
    let end = offset;
    let quoted = false;
    const enumProperty = owner
      ? /^(?:risk|verifyMethod)\s*:\s*\w+\b/i.exec(text)
      : null;
    if (enumProperty) end += enumProperty[0].length;
    for (; !enumProperty && end < source.length; end++) {
      const char = source[end]!;
      if (char === '"') {
        quoted = !quoted;
        if (!quoted && owner && /^\s*\w+\s*:\s*"/.test(tail)) {
          end++;
          break;
        }
      }
      if (quoted) continue;
      if (/[\r\n]/.test(char) || char === "}") break;
    }
    if (end === offset) end++;
    const raw = source.slice(cursor, end);
    const trimmed = raw.trim();
    let kind: RequirementSourceRecord["kind"] = "invalid";
    if (owner) kind = "property";
    else if (/^direction\b/i.test(trimmed)) kind = "direction";
    else if (/^accTitle\s*:/i.test(trimmed)) kind = "accessibility-title";
    else if (/^accDescr\s*:/i.test(trimmed)) kind = "accessibility-description";
    else if (/^classDef\b/i.test(trimmed)) kind = "style-definition";
    else if (/^class\b/i.test(trimmed)) kind = "style-assignment";
    else if (/^style\b/i.test(trimmed)) kind = "style";
    else if (/:::/.test(trimmed)) kind = "inline-class";
    else if (/(?:<-|->)/.test(trimmed)) kind = "relation";
    const record = push(kind, end, !quoted);
    if (kind === "relation") {
      const relation =
        /^\s*("[^"]*"|[\w][^:,\r\n{}<>\-=]*?)\s*(?:<-\s*(\w+)\s*-|-\s*(\w+)\s*->)\s*("[^"]*"|[\w][^:,\r\n{}<>\-=]*?)\s*$/di.exec(
          raw,
        );
      if (relation) {
        for (const [name, index] of [
          ["left", 1],
          ["relationship", relation[2] ? 2 : 3],
          ["right", 4],
        ] as const) {
          const [start, stop] = relation.indices![index]!;
          record.values[name] = requirementRecordRange(record, start, stop);
          if (name !== "relationship") {
            const value = relation[index]!;
            record.references.push({
              id: value.startsWith('"') ? value.slice(1, -1) : value.trim(),
              range: record.values[name]!,
            });
          }
        }
      }
    }
    if (
      kind === "style" ||
      kind === "style-assignment" ||
      kind === "inline-class"
    ) {
      const targets =
        kind === "inline-class"
          ? /^([ \t]*)("[^"]+"|[\w][^:,\r\n{}<>\-=]*?)[ \t]*:::/d.exec(raw)
          : new RegExp(
              `^([ \\t]*(?:style|class)[ \\t]+)(${REQUIREMENT_CSS_ID_LIST})`,
              "di",
            ).exec(raw);
      if (targets) {
        const start = targets.indices![2]![0];
        const items =
          kind === "inline-class"
            ? [[targets[2]!, 0] as const]
            : [...targets[2]!.matchAll(/"[^"]*"|\w+/g)].map(
                (match) => [match[0], match.index] as const,
              );
        for (const [value, index] of items) {
          const offset = start + index;
          record.references.push({
            id: value.startsWith('"') ? value.slice(1, -1) : value,
            range: requirementRecordRange(
              record,
              offset,
              offset + value.length,
            ),
          });
        }
      }
    }
    if (kind === "property") {
      const colon = raw.indexOf(":");
      if (colon >= 0) {
        record.values.name = requirementRecordRange(record, indent, colon);
        const valueStart =
          colon + 1 + /^[ \t]*/.exec(raw.slice(colon + 1))![0].length;
        record.values.value = requirementRecordRange(
          record,
          valueStart,
          Math.max(valueStart, raw.length - /[ \t]*$/.exec(raw)![0].length),
        );
      }
    }
  }
  const document: RequirementSourceDocument = {
    source,
    newline: source.includes("\r\n")
      ? "\r\n"
      : source.includes("\r")
        ? "\r"
        : "\n",
    records,
    diagnostics: [],
  };
  return reconcileSourceRecordBindings(
    document,
    previous,
    mapping,
    (record) =>
      `${record.kind}\0${record.namespace ?? ""}\0${record.ownerId ?? ""}\0${record.raw}`,
    nextRequirementSourceKey,
  );
}
