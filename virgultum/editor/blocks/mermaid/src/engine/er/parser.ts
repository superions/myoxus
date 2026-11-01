// SPDX-License-Identifier: AGPL-3.0-or-later
import { hashMermaidSource } from "../../utils.js";

import type {
  MermaidErAttribute,
  MermaidErEntity,
  MermaidErModel,
  MermaidErRelationship,
} from "./model.js";

export const ENTITY_SOURCE = String.raw`(?:"[^"]*"|(?:[^\x00-\x7F]|\w|[-*.])+)`;
export const CSS_CLASS_LIST_SOURCE = String.raw`[\p{L}\p{N}_.,-]+`;
const ENTITY_DECLARATION_RE = new RegExp(
  `^(${ENTITY_SOURCE})(?:\\s*\\[(${ENTITY_SOURCE})\\])?(?:\\s*:::\\s*(${CSS_CLASS_LIST_SOURCE}))?\\s*;?$`,
  "du",
);
const ENTITY_BLOCK_RE = new RegExp(
  `^(${ENTITY_SOURCE})(?:\\s*\\[(${ENTITY_SOURCE})\\])?(?:\\s*:::\\s*(${CSS_CLASS_LIST_SOURCE}))?\\s*\\{$`,
  "du",
);
export const ATTRIBUTE_WORD_RE = /^[\p{L}_*][\p{L}\p{N}_()[\].,*-]*$/u;
export const GENERIC_ATTRIBUTE_WORD_RE = /^\S*~[^~\n]+~\S*$/u;
const ATTRIBUTE_TAIL_RE =
  /^((?:PK|FK|UK)(?:\s*,\s*(?:PK|FK|UK))*)?(?:\s*"([^"]*)")?\s*;?$/i;
const DIRECTION_RE = /^direction\s+(TB|BT|RL|LR)\s*;?$/i;

export function isErStyleStatement(value: string) {
  return (
    /^classDef\s+[\p{L}\p{N}_,-]+\s+.+\s*;?$/iu.test(value) ||
    /^style\s+.+?\s+[\w-]+\s*:.+\s*;?$/iu.test(value) ||
    /^class\s+.+?\s+[\p{L}\p{N}_.,-]+\s*;?$/iu.test(value)
  );
}

function cleanQuoted(value: string) {
  return value.trim().replace(/^"([\s\S]*)"$/, "$1");
}

export function isMermaidErEntityCharacter(character: string) {
  return (character.codePointAt(0) ?? 0) > 0x7f || /[\w.*-]/u.test(character);
}

function parseCssClasses(value = "") {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

export function takeErAttributeWord(
  value: string,
  stopAtOptionalMarker = false,
) {
  const source = value.trimStart();
  if (source.startsWith("`")) {
    const end = source.indexOf("`", 1);
    if (end < 2) return null;
    return { rest: source.slice(end + 1), value: source.slice(1, end) };
  }
  let inGeneric = false;
  let end = 0;
  for (; end < source.length; end += 1) {
    const character = source[end];
    if (stopAtOptionalMarker && character === "?" && !inGeneric) break;
    if (character === "~") inGeneric = !inGeneric;
    if (/\s/.test(character) && !inGeneric) break;
  }
  const word = source.slice(0, end);
  if (
    !word ||
    (!ATTRIBUTE_WORD_RE.test(word) && !GENERIC_ATTRIBUTE_WORD_RE.test(word))
  ) {
    return null;
  }
  return { rest: source.slice(end), value: word };
}

export function parseMermaidErAttributeSourceLine(value: string) {
  const typeWord = takeErAttributeWord(value, true);
  if (!typeWord) return null;
  let rest = typeWord.rest.trimStart();
  let type = typeWord.value;
  if (rest.startsWith("?")) {
    type += "?";
    rest = rest.slice(1);
  }
  const nameWord = takeErAttributeWord(rest);
  if (!nameWord) return null;
  const tail = ATTRIBUTE_TAIL_RE.exec(nameWord.rest.trimStart());
  if (!tail) return null;
  return {
    comment: tail[2] || undefined,
    keyType: (tail[1] ?? "")
      .split(",")
      .map((key) => key.trim().toUpperCase())
      .filter(Boolean)
      .join(", "),
    name: nameWord.value,
    type,
  };
}

export function parseMermaidErAttributeDetailValue(
  name: string,
  value: string,
) {
  const typeWord = takeErAttributeWord(value, true);
  if (!typeWord) return null;
  let rest = typeWord.rest.trimStart();
  let type = typeWord.value;
  if (rest.startsWith("?")) {
    type += "?";
    rest = rest.slice(1).trimStart();
  }
  const tail =
    /^((?:PK|FK|UK)(?:\s*,\s*(?:PK|FK|UK))*)?(?:\s+[“"]([^”"]*)[”"])?\s*$/i.exec(
      rest,
    );
  if (!tail) return null;
  return {
    comment: tail[2] || undefined,
    keyType: (tail[1] ?? "")
      .split(",")
      .map((key) => key.trim().toUpperCase())
      .filter(Boolean)
      .join(", "),
    name,
    type,
  };
}

function upsertEntity(
  entities: Map<string, MermaidErEntity>,
  rawId: string,
  partial: Partial<
    Pick<MermaidErEntity, "attributes" | "cssClasses" | "label">
  > = {},
) {
  const id = cleanQuoted(rawId);
  const existing = entities.get(id);
  if (existing) {
    existing.attributes = partial.attributes ?? existing.attributes;
    existing.cssClasses = partial.cssClasses
      ? [...existing.cssClasses, ...partial.cssClasses]
      : existing.cssClasses;
    if (partial.label && existing.label === existing.id) {
      existing.label = partial.label;
    }
    return id;
  }
  const order = entities.size;
  const label = partial.label ?? id;
  entities.set(id, {
    sourceKey: `er-entity-${id}`,
    scopeId: null,
    subgraphId: null,
    attributes: partial.attributes ?? [],
    cssClasses: partial.cssClasses ?? [],
    id,
    label,
    order,
  });
  return id;
}

export function relationshipCardinality(value: string, side: "from" | "to") {
  const normalized = value.trim().toLowerCase().replaceAll(/\s+/g, " ");
  const from = side === "from";
  if (normalized === "u") return "u";
  if (["||", "one", "only one", "1"].includes(normalized)) return "||";
  if (["o|", "|o", "one or zero", "zero or one"].includes(normalized)) {
    return from ? "o|" : "|o";
  }
  if (
    [
      "}|",
      "|{",
      "one or more",
      "one or many",
      "many(1)",
      "1+",
      "many",
    ].includes(normalized)
  ) {
    return from ? "}|" : "|{";
  }
  if (
    ["}o", "o{", "zero or more", "zero or many", "many(0)", "0+"].includes(
      normalized,
    )
  ) {
    return from ? "}o" : "o{";
  }
  return null;
}

export function relationshipIdentification(value: string): "--" | ".." | null {
  const normalized = value.trim().toLowerCase();
  if (normalized === "--" || normalized === "to") return "--";
  if (["..", ".-", "-.", "optionally to"].includes(normalized)) return "..";
  return null;
}

export function splitRelationshipLabel(value: string) {
  let quoted = false;
  for (let index = 0; index < value.length; index += 1) {
    if (value[index] === '"') quoted = !quoted;
    if (!quoted && value[index] === ":") {
      return {
        body: value.slice(0, index).trim(),
        labelStart:
          index +
          1 +
          (value.slice(index + 1).length -
            value.slice(index + 1).trimStart().length),
        label: value
          .slice(index + 1)
          .trim()
          .replace(/;\s*$/, ""),
      };
    }
  }
  return null;
}

function parseRelationshipEntity(value: string) {
  const match = new RegExp(
    `^(${ENTITY_SOURCE})(?:\\s*:::\\s*(${CSS_CLASS_LIST_SOURCE}))?$`,
    "u",
  ).exec(value.trim());
  return match
    ? { cssClasses: parseCssClasses(match[2]), rawId: match[1] }
    : null;
}

export function parseSymbolicRelationship(value: string) {
  const statement = splitRelationshipLabel(value);
  if (!statement || !statement.label) return null;
  const markerMatch = [
    ...statement.body.matchAll(
      /(\|\||o\||\}\||\}o|u)\s*(--|\.\.|\.-|-\.)\s*(\|\||\|o|\|\{|o\{|u)/g,
    ),
  ].find(
    (match) =>
      (statement.body.slice(0, match.index).match(/"/g)?.length ?? 0) % 2 === 0,
  );
  if (!markerMatch || markerMatch.index === undefined) {
    return null;
  }
  if (
    (markerMatch[1] === "u" &&
      isMermaidErEntityCharacter(
        statement.body[markerMatch.index - 1] ?? "",
      )) ||
    (markerMatch[3] === "u" &&
      isMermaidErEntityCharacter(
        statement.body[markerMatch.index + markerMatch[0].length] ?? "",
      ) &&
      !/[.\-|]/.test(
        statement.body[markerMatch.index + markerMatch[0].length] ?? "",
      ))
  ) {
    return null;
  }
  const from = parseRelationshipEntity(
    statement.body.slice(0, markerMatch.index),
  );
  const to = parseRelationshipEntity(
    statement.body.slice(markerMatch.index + markerMatch[0].length),
  );
  return from && to
    ? {
        from,
        fromCardinality: markerMatch[1],
        identification: markerMatch[2],
        label: statement.label,
        to,
        toCardinality: markerMatch[3],
      }
    : null;
}

const CARDINALITY_PHRASES = [
  "zero or more",
  "zero or many",
  "one or more",
  "one or many",
  "one or zero",
  "zero or one",
  "only one",
  "many(0)",
  "many(1)",
  "many",
  "0+",
  "1+",
  "one",
  "1",
] as const;

export function parseVerbalRelationship(value: string) {
  const statement = splitRelationshipLabel(value);
  if (!statement || !statement.label) return null;
  const { body, label } = statement;
  const phrase = CARDINALITY_PHRASES.map((item) =>
    item.replace(/[()+]/g, "\\$&"),
  ).join("|");
  const match = new RegExp(
    `^(${ENTITY_SOURCE})(?:\\s*:::\\s*(${CSS_CLASS_LIST_SOURCE}))?\\s+(${phrase})\\s+(optionally to|to)\\s+(${phrase})\\s+(${ENTITY_SOURCE})(?:\\s*:::\\s*(${CSS_CLASS_LIST_SOURCE}))?$`,
    "iu",
  ).exec(body);
  return match
    ? {
        from: {
          cssClasses: parseCssClasses(match[2]),
          rawId: match[1],
        },
        fromCardinality: match[3],
        identification: match[4],
        label,
        to: {
          cssClasses: parseCssClasses(match[7]),
          rawId: match[6],
        },
        toCardinality: match[5],
      }
    : null;
}

export function parseMermaidErSource(source: string): MermaidErModel | null {
  return resolveMermaidErSource(source).model;
}

export function splitMermaidErCardinality(value: string) {
  const match = /^(\|\||o\||\}\||\}o|u)(--|\.\.)(\|\||\|o|\|\{|o\{|u)$/.exec(
    value,
  );
  return match
    ? {
        fromCardinality: match[1],
        identification: match[2] as "--" | "..",
        toCardinality: match[3],
      }
    : null;
}

import {
  scanErSource,
  reconcileErSource,
  erRecordRange,
  type ErSourceRecord,
  type ErRange,
} from "./source-document.js";
import { readErConfig } from "./config.js";
import type { ErSourceDiagnostic } from "./diagnostics.js";
import type {
  ErCardinality,
  MermaidErSubgraph,
  MermaidErStyle,
  MermaidErComment,
} from "./model.js";

export function erCardinality(value: string): ErCardinality | null {
  const token = relationshipCardinality(value, "from");
  return token === "||"
    ? "exactly-one"
    : token === "o|"
      ? "zero-or-one"
      : token === "}|"
        ? "one-or-many"
        : token === "}o"
          ? "zero-or-many"
          : token === "u"
            ? "mermaid-parent"
            : null;
}
export function erCardinalityToken(value: ErCardinality, side: "from" | "to") {
  return (
    {
      "exactly-one": ["||", "||"],
      "zero-or-one": ["o|", "|o"],
      "one-or-many": ["}|", "|{"],
      "zero-or-many": ["}o", "o{"],
      "mermaid-parent": ["u", "u"],
    } as const
  )[value][side === "from" ? 0 : 1];
}
export function erStyleProperties(
  source: string,
  range: ErRange,
): MermaidErStyle["properties"] {
  const properties: MermaidErStyle["properties"] = [];
  let start = range.start,
    quote = "",
    depth = 0;
  for (let i = start; i <= range.end; i++) {
    const c = source[i];
    if ((c === '"' || c === "'") && source[i - 1] !== "\\")
      quote = quote === c ? "" : quote || c;
    if (!quote && (c === "(" || c === "[")) depth++;
    if (!quote && (c === ")" || c === "]")) depth--;
    if (i < range.end && (c !== "," || quote || depth)) continue;
    const raw = source.slice(start, i),
      colon = raw.indexOf(":");
    if (colon >= 0) {
      const value = raw.slice(colon + 1),
        leading = value.length - value.trimStart().length;
      properties.push({
        name: raw.slice(0, colon).trim(),
        value: value.trim(),
        range: { ...range, start, end: i },
        valueRange: {
          ...range,
          start: start + colon + 1 + leading,
          end: i - (value.length - value.trimEnd().length),
        },
      });
    }
    start = i + 1;
  }
  return properties;
}
function recordValue(
  record: ErSourceRecord,
  name: string,
  start: number,
  end: number,
) {
  return (record.values[name] = erRecordRange(record, start, end));
}
function matchValue(
  record: ErSourceRecord,
  name: string,
  match: RegExpExecArray,
  index: number,
) {
  const bound = match.indices?.[index];
  if (bound)
    recordValue(
      record,
      name,
      record.indent.length + bound[0],
      record.indent.length + bound[1],
    );
}
function references(
  record: ErSourceRecord,
  range: ErRange,
  kind: "entity" | "subgraph" | "style",
  source: string,
) {
  const raw = source.slice(range.start, range.end);
  const re = /(?:"[^"]*"|[^,\s]+)/gu;
  for (const m of raw.matchAll(re))
    record.references.push({
      kind,
      id: cleanQuoted(m[0]),
      range: {
        ...range,
        start: range.start + m.index,
        end: range.start + m.index + m[0].length,
      },
    });
}
/** The pinned DB closes inner groups first and removes members already claimed by
 * any completed group. Keep lexical scope separately from that effective membership. */
export function resolveMermaidErSource(
  source: string,
  previous?: MermaidErModel,
  mapping?: ReadonlyMap<number, string>,
  entityKeys?: ReadonlyMap<string, string>,
  subgraphKeys?: ReadonlyMap<string, string>,
) {
  const document = scanErSource(source),
    entities = new Map<string, MermaidErEntity>(),
    relationships: MermaidErRelationship[] = [],
    subgraphs: MermaidErSubgraph[] = [],
    styles: MermaidErStyle[] = [],
    stack: MermaidErSubgraph[] = [],
    closed: MermaidErSubgraph[] = [];
  let entity: MermaidErEntity | null = null,
    entityRecord: ErSourceRecord | null = null,
    header = false,
    direction: MermaidErModel["direction"] = "TB",
    accessibilityTitle = "",
    accessibilityDescription = "";
  const issue = (
    record: ErSourceRecord,
    code: ErSourceDiagnostic["code"],
    construct = record.raw.trim(),
  ) =>
    document.diagnostics.push({
      code,
      construct,
      line: record.range.line,
      column: record.indent.length + 1,
      sourceKey: record.sourceKey,
    });
  const entityFor = (
    id: string,
    record: ErSourceRecord,
    label?: string,
    cssClasses?: string[],
  ) => {
    const existed = entities.has(cleanQuoted(id));
    const sourceId = upsertEntity(entities, id, {
      ...(label ? { label } : {}),
      ...(cssClasses?.length ? { cssClasses } : {}),
    });
    const node = entities.get(sourceId)!;
    if (!existed) node.scopeId = stack.at(-1)?.id ?? null;
    const parent = stack.at(-1);
    if (parent && !parent.sourceMembers.includes(sourceId))
      parent.sourceMembers.push(sourceId);
    record.references.push({
      kind: "entity",
      id: sourceId,
      range: record.values.id ?? record.range,
    });
    return node;
  };
  for (const record of document.records) {
    const raw = record.raw.trim(),
      offset = record.indent.length;
    record.subgraphId = stack.at(-1)?.id ?? null;
    if (!record.complete) {
      issue(record, "incomplete-record");
      continue;
    }
    if (["frontmatter", "directive", "blank"].includes(record.kind)) continue;
    if (record.kind === "comment") {
      record.ownerId = entity?.id;
      continue;
    }
    if (!header) {
      if (/^erDiagram$/i.test(raw)) {
        header = true;
        record.kind = "header";
        continue;
      }
      issue(record, "missing-header");
      record.kind = "invalid";
      continue;
    }
    if (entity) {
      record.ownerId = entity.id;
      record.blockKey = entityRecord!.sourceKey;
      if (raw === "}") {
        record.kind = "entity-close";
        entityRecord!.closeKey = record.sourceKey;
        entity = null;
        entityRecord = null;
        continue;
      }
      const parsed = parseMermaidErAttributeSourceLine(raw);
      if (!parsed) {
        record.kind = "invalid";
        issue(record, "invalid-record");
        continue;
      }
      record.kind = "attribute";
      const typeWord = takeErAttributeWord(raw, true)!;
      let consumed = raw.length - typeWord.rest.length;
      recordValue(record, "type", offset, offset + consumed);
      const optional = /^\s*\?/.exec(typeWord.rest);
      if (optional) {
        recordValue(
          record,
          "optional",
          offset + consumed + optional[0].length - 1,
          offset + consumed + optional[0].length,
        );
        consumed += optional[0].length;
      }
      const rest = raw.slice(consumed),
        nameWord = takeErAttributeWord(rest)!;
      const leading = rest.length - rest.trimStart().length,
        nameStart = consumed + leading,
        nameEnd = raw.length - nameWord.rest.length;
      recordValue(record, "name", offset + nameStart, offset + nameEnd);
      const tailStart = nameEnd,
        nameTail = raw.slice(tailStart),
        keys = /^\s*((?:PK|FK|UK)(?:\s*,\s*(?:PK|FK|UK))*)/i.exec(nameTail);
      if (keys) {
        const start = tailStart + keys[0].indexOf(keys[1]!);
        recordValue(
          record,
          "keys",
          offset + start,
          offset + start + keys[1]!.length,
        );
      }
      const comment = /"[^"]*"/.exec(nameTail);
      if (comment)
        recordValue(
          record,
          "comment",
          offset + tailStart + comment.index,
          offset + tailStart + comment.index + comment[0].length,
        );
      entity.attributes.push({
        id: record.sourceKey,
        name: parsed.name,
        type: parsed.type.replace(/\?$/, ""),
        optional: parsed.type.endsWith("?"),
        keys: parsed.keyType
          .split(",")
          .map((k) => k.trim())
          .filter(Boolean) as MermaidErAttribute["keys"],
        comment: parsed.comment,
      });
      continue;
    }
    if (record.kind === "accessibility-description") {
      const start = record.raw.indexOf("{") + 1,
        end = record.raw.lastIndexOf("}");
      recordValue(record, "text", start, end);
      accessibilityDescription = record.raw.slice(start, end).trim();
      continue;
    }
    const acc = /^(accTitle|accDescr)\s*:\s*([\s\S]*?);?$/diu.exec(raw);
    if (acc) {
      record.kind =
        acc[1]!.toLowerCase() === "acctitle"
          ? "accessibility-title"
          : "accessibility-description";
      matchValue(record, "text", acc, 2);
      if (record.kind === "accessibility-title") accessibilityTitle = acc[2]!;
      else accessibilityDescription = acc[2]!;
      continue;
    }
    const dir = DIRECTION_RE.exec(raw);
    if (dir) {
      record.kind = "direction";
      recordValue(
        record,
        "direction",
        offset + raw.search(/TB|BT|LR|RL/i),
        offset + raw.search(/TB|BT|LR|RL/i) + 2,
      );
      if (stack.length)
        stack.at(-1)!.direction = dir[1]!.toUpperCase() as typeof direction;
      else direction = dir[1]!.toUpperCase() as typeof direction;
      continue;
    }
    const group = new RegExp(
      `^subgraph\\s+(${ENTITY_SOURCE})(?:\\s*\\[([\\s\\S]*?)\\])?\\s*;?$`,
      "idu",
    ).exec(raw);
    if (group) {
      record.kind = "subgraph";
      record.ownerId = cleanQuoted(group[1]!);
      matchValue(record, "id", group, 1);
      if (group[2] !== undefined) matchValue(record, "label", group, 2);
      record.references.push({
        kind: "subgraph",
        id: cleanQuoted(group[1]!),
        range: record.values.id!,
      });
      const g: MermaidErSubgraph = {
        sourceKey: record.sourceKey,
        id: cleanQuoted(group[1]!),
        label:
          group[2] !== undefined
            ? cleanQuoted(group[2])
            : cleanQuoted(group[1]!),
        parentId: stack.at(-1)?.id ?? null,
        members: [],
        sourceMembers: [],
        order: subgraphs.length,
        cssClasses: [],
      };
      subgraphs.push(g);
      stack.push(g);
      continue;
    }
    if (/^end\s*;?$/i.test(raw)) {
      record.kind = "subgraph-end";
      const g = stack.pop();
      if (!g) {
        issue(record, "invalid-record");
        continue;
      }
      record.subgraphId = g.id;
      const opener = document.records.find((r) => r.sourceKey === g.sourceKey)!;
      record.blockKey = opener.sourceKey;
      opener.closeKey = record.sourceKey;
      const claimed = new Set(closed.flatMap((c) => c.members));
      g.members = [...new Set(g.sourceMembers)].filter(
        (id) => !claimed.has(id),
      );
      closed.push(g);
      const parent = stack.at(-1);
      if (parent) parent.sourceMembers.push(g.id);
      continue;
    }
    const declaration =
      ENTITY_BLOCK_RE.exec(raw) ?? ENTITY_DECLARATION_RE.exec(raw);
    if (declaration) {
      record.kind = "entity";
      record.ownerId = cleanQuoted(declaration[1]!);
      matchValue(record, "id", declaration, 1);
      if (declaration[2]) matchValue(record, "label", declaration, 2);
      if (declaration[3]) matchValue(record, "styles", declaration, 3);
      const n = entityFor(
        declaration[1]!,
        record,
        declaration[2] ? cleanQuoted(declaration[2]) : undefined,
        parseCssClasses(declaration[3]),
      );
      if (record.values.styles) {
        references(record, record.values.styles, "style", source);
        const range = record.values.styles;
        const prefix = source.slice(record.range.start, range.start),
          marker = /:::\s*$/.exec(prefix)!;
        styles.push({
          id: `${record.sourceKey}:classes`,
          sourceKey: record.sourceKey,
          kind: "assignment",
          owners: [n.id],
          styles: parseCssClasses(declaration[3]),
          properties: [],
          assignmentRange: range,
          removalRange: { ...range, start: record.range.start + marker.index },
        });
      }
      if (raw.endsWith("{")) {
        entity = n;
        entityRecord = record;
      }
      continue;
    }
    const relation =
      parseSymbolicRelationship(raw) ?? parseVerbalRelationship(raw);
    if (relation) {
      record.kind = "relation";
      const endpoint = (value: { rawId: string; cssClasses: string[] }) =>
        closed.find((g) => g.id === cleanQuoted(value.rawId)) ??
        entityFor(value.rawId, record, undefined, value.cssClasses);
      const from = endpoint(relation.from),
        to = endpoint(relation.to);
      // These lexemes come from the existing parser, including verbal forms and quotes.
      let cursor = 0;
      for (const [name, value] of [
        ["from", relation.from.rawId],
        ["fromCardinality", relation.fromCardinality],
        ["identification", relation.identification],
        ["toCardinality", relation.toCardinality],
        ["to", relation.to.rawId],
      ] as const) {
        const start = raw.indexOf(value, cursor);
        if (start >= 0) {
          recordValue(
            record,
            name,
            offset + start,
            offset + start + value.length,
          );
          cursor = start + value.length;
          if (name === "from") {
            const classes = /^\s*:::\s*[^\s]+/.exec(raw.slice(cursor));
            if (classes) cursor += classes[0].length;
          }
        }
      }
      for (const [end, value] of [
        ["from", relation.from],
        ["to", relation.to],
      ] as const) {
        if (!value.cssClasses.length) continue;
        const endpointRange = record.values[end]!;
        const suffix = source.slice(endpointRange.end, record.range.end),
          match = /^\s*:::\s*([^\s]+)/.exec(suffix);
        if (!match) continue;
        const start = endpointRange.end + match[0].lastIndexOf(match[1]!);
        const range = {
          ...endpointRange,
          start,
          end: start + match[1]!.length,
        };
        record.values[`${end}Styles`] = range;
        references(record, range, "style", source);
        styles.push({
          id: `${record.sourceKey}:${end}-classes`,
          sourceKey: record.sourceKey,
          kind: "assignment",
          owners: [cleanQuoted(value.rawId)],
          styles: value.cssClasses,
          properties: [],
          assignmentRange: range,
          removalRange: { ...range, start: endpointRange.end },
        });
      }
      const labelStart = splitRelationshipLabel(raw)!.labelStart,
        leading = 0;
      recordValue(
        record,
        "label",
        offset + labelStart + leading,
        offset + raw.replace(/;\s*$/, "").length,
      );
      record.references = record.references.filter((r) => r.kind !== "entity");
      record.references.push(
        {
          kind: closed.includes(from as MermaidErSubgraph)
            ? "subgraph"
            : "entity",
          id: from.id,
          range: record.values.from!,
        },
        {
          kind: closed.includes(to as MermaidErSubgraph)
            ? "subgraph"
            : "entity",
          id: to.id,
          range: record.values.to!,
        },
      );
      relationships.push({
        sourceKey: record.sourceKey,
        id: record.sourceKey,
        from: from.id,
        to: to.id,
        fromCardinality: relationshipCardinality(
          relation.fromCardinality,
          "from",
        )!,
        toCardinality: relationshipCardinality(relation.toCardinality, "to")!,
        cardinalityA: erCardinality(relation.fromCardinality)!,
        cardinalityB: erCardinality(relation.toCardinality)!,
        identification: relationshipIdentification(relation.identification)!,
        label: cleanQuoted(relation.label),
        order: relationships.length,
        scopeId: stack.at(-1)?.id ?? null,
      });
      continue;
    }
    const style =
      /^(classDef|class|style)\s+((?:"[^"\r\n]*"|[^\s",]+)(?:\s*,\s*(?:"[^"\r\n]*"|[^\s",]+))*)\s+([\s\S]*?);?$/diu.exec(
        raw,
      );
    if (style) {
      record.kind =
        style[1]!.toLowerCase() === "classdef"
          ? "style-definition"
          : style[1]!.toLowerCase() === "class"
            ? "style-assignment"
            : "style";
      matchValue(record, "owners", style, 2);
      matchValue(record, "properties", style, 3);
      references(
        record,
        record.values.owners!,
        record.kind === "style-definition" ? "style" : "entity",
        source,
      );
      if (record.kind === "style-assignment")
        references(record, record.values.properties!, "style", source);
      styles.push({
        id: record.sourceKey,
        sourceKey: record.sourceKey,
        kind:
          record.kind === "style-definition"
            ? "definition"
            : record.kind === "style-assignment"
              ? "assignment"
              : "inline",
        owners: record.references
          .filter(
            (r) => r.kind !== "style" || record.kind === "style-definition",
          )
          .map((r) => r.id),
        styles:
          record.kind === "style-assignment"
            ? record.references
                .filter((r) => r.kind === "style")
                .map((r) => r.id)
            : [],
        properties:
          record.kind === "style-assignment"
            ? []
            : erStyleProperties(source, record.values.properties!),
      });
      continue;
    }
    record.kind = "invalid";
    issue(record, "invalid-record");
  }
  if (!header)
    document.diagnostics.push({
      code: "missing-header",
      line: 1,
      column: 1,
      construct: "erDiagram",
    });
  if (entityRecord) issue(entityRecord, "unclosed-entity", entity!.id);
  for (const group of stack) {
    const record = document.records.find(
      (r) => r.sourceKey === group.sourceKey,
    )!;
    issue(record, "unclosed-subgraph", group.id);
  }
  reconcileErSource(document, previous?.sourceDocument, mapping);
  // Rebind semantic records after all reserved lexical identities have been assigned.
  const remapRecord = (oldKey: string) =>
    document.records.find((r) => r.sourceKey === oldKey)?.sourceKey ??
    document.records.find(
      (r) =>
        `er-record-${r.range.start}-${hashMermaidSource(r.raw)}` === oldKey,
    )?.sourceKey ??
    oldKey;
  for (const n of entities.values()) {
    const declarations = document.records.filter(
      (r) =>
        r.kind === "entity" &&
        r.references.some((ref) => ref.kind === "entity" && ref.id === n.id),
    );
    n.sourceKey =
      entityKeys?.get(n.id) ??
      previous?.entities.find((old) => old.id === n.id)?.sourceKey ??
      declarations[0]?.sourceKey ??
      `er-entity-${document.records.find((r) => r.kind === "relation" && r.references.some((ref) => ref.id === n.id))?.sourceKey}-${n.id}`;
    n.scopeId = declarations[0]?.subgraphId ?? n.scopeId;
    n.attributes.forEach((a) => {
      a.id = remapRecord(a.id);
    });
    n.subgraphId = closed.find((g) => g.members.includes(n.id))?.id ?? null;
  }
  for (const g of subgraphs)
    g.sourceKey =
      subgraphKeys?.get(g.id) ??
      previous?.subgraphs.find((old) => old.id === g.id)?.sourceKey ??
      remapRecord(g.sourceKey);
  for (const r of relationships) {
    r.id = remapRecord(r.id);
    r.sourceKey = r.id;
  }
  for (const style of styles) {
    const old = style.sourceKey;
    style.sourceKey = remapRecord(old);
    style.id =
      style.id === old
        ? style.sourceKey
        : style.sourceKey + style.id.slice(old.length);
  }
  for (const record of document.records)
    if (record.kind === "style" || record.kind === "style-assignment")
      for (const ref of record.references)
        if (ref.kind === "entity" && subgraphs.some((g) => g.id === ref.id))
          ref.kind = "subgraph";
  for (const style of styles)
    if (style.kind === "assignment")
      for (const owner of style.owners) {
        const target =
          entities.get(owner) ?? subgraphs.find((g) => g.id === owner);
        if (target) target.cssClasses.push(...style.styles);
      }
  const commentRecords: MermaidErComment[] = document.records
    .filter((r) => r.kind === "comment")
    .map((r) => {
      const following = document.records.find(
        (next) =>
          next.range.start > r.range.start &&
          !["blank", "comment"].includes(next.kind),
      );
      const beforeAnyObject = !document.records.some(
        (old) =>
          old.range.start < r.range.start &&
          ["entity", "attribute", "relation", "subgraph"].includes(old.kind),
      );
      let anchorKind: MermaidErComment["anchorKind"] = "diagram",
        anchorId: string | undefined,
        position: MermaidErComment["position"] = "before";
      const inline = document.records.findLast(
        (previous) =>
          previous.range.line === r.range.line &&
          previous.range.end <= r.range.start &&
          !["blank", "comment"].includes(previous.kind),
      );
      const textStart =
        r.raw.indexOf("%%") +
        2 +
        (r.raw.slice(r.raw.indexOf("%%") + 2).length -
          r.raw.slice(r.raw.indexOf("%%") + 2).trimStart().length);
      recordValue(r, "text", textStart, r.raw.trimEnd().length);
      if (inline) {
        position = "after";
        if (inline.kind === "header") {
          anchorKind = "diagram";
        } else if (inline.kind === "entity") {
          anchorKind = "entity";
          anchorId = entities.get(inline.ownerId!)?.sourceKey;
        } else if (inline.kind === "subgraph") {
          anchorKind = "subgraph";
          anchorId = inline.sourceKey;
        } else if (inline.kind === "relation" || inline.kind === "attribute") {
          anchorKind = inline.kind;
          anchorId = inline.sourceKey;
        } else {
          anchorKind = "record";
          anchorId = inline.sourceKey;
        }
      } else if (r.ownerId) {
        const a =
          following?.kind === "attribute" && following.ownerId === r.ownerId
            ? following
            : null;
        anchorKind = a ? "attribute" : "entity";
        anchorId = a?.sourceKey ?? entities.get(r.ownerId)?.sourceKey;
        position = a ? "before" : "inside";
      } else if (following?.kind === "relation") {
        anchorKind = "relation";
        anchorId = following.sourceKey;
      } else if (r.subgraphId) {
        anchorKind = "subgraph";
        anchorId = subgraphs.find((g) => g.id === r.subgraphId)?.sourceKey;
        position = "inside";
      } else if (!beforeAnyObject && following?.kind === "entity") {
        anchorKind = "entity";
        anchorId = entities.get(
          following.references.find((ref) => ref.kind === "entity")?.id ?? "",
        )?.sourceKey;
      } else if (!beforeAnyObject && following?.kind === "subgraph") {
        anchorKind = "subgraph";
        anchorId = following.sourceKey;
      }
      return {
        id: r.sourceKey,
        text: r.raw.trim().slice(2).trim(),
        anchorKind,
        anchorId,
        position,
      };
    });
  const config = readErConfig(document).config;
  if (!document.records.some((r) => r.kind === "direction" && !r.subgraphId))
    direction = config.layoutDirection;
  const model: MermaidErModel = {
    sourceDocument: document,
    subgraphs,
    styles,
    commentRecords,
    diagramType: "erDiagram",
    headerLine: "erDiagram",
    version: 1,
    sourceHash: hashMermaidSource(source),
    accessibilityTitle,
    accessibilityDescription,
    comments: commentRecords.map((c) => c.text),
    directives: document.records
      .filter((r) => r.kind === "frontmatter" || r.kind === "directive")
      .map((r) => r.raw),
    direction,
    entities: [...entities.values()].sort((a, b) => a.order - b.order),
    relationships,
    styleStatements: document.records
      .filter((r) =>
        ["style", "style-definition", "style-assignment"].includes(r.kind),
      )
      .map((r) => r.raw.trim()),
  };
  return {
    document,
    diagnostics: document.diagnostics,
    model: document.diagnostics.length ? null : model,
  };
}
