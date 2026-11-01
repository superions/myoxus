// SPDX-License-Identifier: AGPL-3.0-or-later

import { hashMermaidSource } from "../../utils.js";
import { detectMermaidDiagramType } from "../diagram-types.js";

import type {
  MermaidClassModel,
  MermaidClassMember,
  MermaidClassNamespace,
  MermaidClassNode,
  MermaidClassNote,
  MermaidClassRelation,
  ClassMarker,
  MermaidClassInteraction,
  MermaidClassStyle,
  MermaidClassComment,
} from "./model.js";
import type { ClassSourceDiagnostic } from "./diagnostics.js";
import { readClassConfig } from "./config.js";
import {
  CLASS_NAME_SOURCE,
  CLASS_GENERIC_TYPE_SOURCE,
  CLASS_REFERENCE_SOURCE,
  INTERACTION_OWNER_RE,
  scanClassSource,
  nextClassSourceKey,
  reconcileClassSource,
  classRecordRange,
  type ClassSourceDocument,
  type ClassSourceRecord,
  type ClassRange,
} from "./source-document.js";

const CSS_CLASS_LIST_SOURCE = String.raw`[\p{L}\p{N}_.,-]+`;
const CLASS_NAME_RE = new RegExp(
  `^(${CLASS_NAME_SOURCE})(?:\\s*~([^~]*)~)?$`,
  "du",
);
const CLASS_BLOCK_RE = new RegExp(
  `^class\\s+(${CLASS_NAME_SOURCE})(?:\\s*~([^~]*)~)?(?:\\s*\\["([^"]*)"\\])?(?:\\s+<<([^>]+)>>)?(?:\\s*:::\\s*(${CSS_CLASS_LIST_SOURCE}))?\\s*\\{$`,
  "du",
);
const CLASS_EMPTY_BLOCK_RE = new RegExp(
  `^class\\s+(${CLASS_NAME_SOURCE})(?:\\s*~([^~]*)~)?(?:\\s*\\["([^"]*)"\\])?(?:\\s+<<([^>]+)>>)?(?:\\s*:::\\s*(${CSS_CLASS_LIST_SOURCE}))?\\s*\\{\\s*\\}\\s*;?$`,
  "du",
);
const CLASS_DECLARATION_RE = new RegExp(
  `^class\\s+(${CLASS_NAME_SOURCE})(?:\\s*~([^~]*)~)?(?:\\s*\\["([^"]*)"\\])?(?:\\s+<<([^>]+)>>)?(?:\\s*:::\\s*(${CSS_CLASS_LIST_SOURCE}))?\\s*;?$`,
  "du",
);
const MEMBER_RE = new RegExp(
  `^(${CLASS_NAME_SOURCE})(?:\\s*~(${CLASS_GENERIC_TYPE_SOURCE})~)?\\s*:\\s*([^:;\\n]+?)\\s*;?$`,
  "du",
);
const ANNOTATION_RE = new RegExp(
  `^<<([^>]+)>>\\s+(${CLASS_NAME_SOURCE})(?:\\s*~(${CLASS_GENERIC_TYPE_SOURCE})~)?\\s*;?$`,
  "du",
);
const NOTE_FOR_RE = new RegExp(
  `^note\\s+for\\s+(${CLASS_NAME_SOURCE})(?:\\s*~(${CLASS_GENERIC_TYPE_SOURCE})~)?\\s+"([^"]*)"\\s*;?$`,
  "du",
);
const RELATION_KIND_PARTS_RE =
  /^(<\||\*|o|<|\(\))?(--|\.\.)(\|>|\*|o|>|\(\))?$/;
const DIRECTION_RE = /^direction\s+(TB|BT|RL|LR)\s*;?$/d;
const NAMESPACE_RE = new RegExp(
  `^namespace\\s+(${CLASS_NAME_SOURCE})(?:\\s*\\["([^"]*)"\\])?\\s*\\{\\s*(\\})?$`,
  "du",
);
const INTERACTION_RE = new RegExp(
  `^(?:callback\\s+${CLASS_REFERENCE_SOURCE}\\s+"[^"]+"(?:\\s+"[^"]*")?|link\\s+${CLASS_REFERENCE_SOURCE}\\s+"[^"]+"(?:\\s+"[^"]*")?(?:\\s+_(?:self|blank|parent|top))?|click\\s+${CLASS_REFERENCE_SOURCE}\\s+(?:(?:call\\s+)?[\\w.]+(?:\\([^)]*\\))?|href\\s+"[^"]+")(?:\\s+"[^"]*")?(?:\\s+_(?:self|blank|parent|top))?)\\s*;?$`,
  "du",
);
function isClassStyleStatement(value: string) {
  return (
    /^classDef\s+[\p{L}\p{N}_,-]+\s+.+\s*;?$/u.test(value) ||
    /^style\s+.+?\s+[\w-]+\s*:.+\s*;?$/u.test(value) ||
    /^(?:class|cssClass)\s+.+?\s+[\p{L}\p{N}_.,-]+\s*;?$/u.test(value)
  );
}

function cleanLabel(value: string) {
  return value.trim().replace(/^"([\s\S]*)"$/, "$1");
}

function cleanClassName(value: string) {
  return value.trim().replace(/^`([\s\S]*)`$/, "$1");
}

function parseCssClasses(value = "") {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

/** Use ClassMember's tolerant signature recognition. Unsplit signatures retain
 * their raw line and stay editable without a programming-language validator. */
export function parseMermaidClassMember(
  raw: string,
  {
    id = nextClassSourceKey(),
    classId = "",
    sourceForm = "block",
    range,
  }: {
    id?: string;
    classId?: string;
    sourceForm?: MermaidClassMember["sourceForm"];
    range?: ClassRange;
  } = {},
): MermaidClassMember {
  const member: MermaidClassMember = {
    id,
    classId,
    kind: raw.indexOf(")") > 0 ? "operation" : "attribute",
    visibility: "",
    name: raw,
    type: "",
    parameters: "",
    returnType: "",
    classifier: "",
    raw,
    sourceForm,
    range,
    ranges: {},
    precise: true,
  };
  const set = (
    field: keyof MermaidClassMember["ranges"],
    start: number,
    end: number,
  ) => {
    if (range)
      member.ranges[field] = {
        start: range.start + start,
        end: range.start + end,
        line: range.line,
      };
  };
  const trimRange = (value: string, start: number) =>
    [
      start + value.length - value.trimStart().length,
      start + value.trimEnd().length,
    ] as const;
  if (member.kind === "operation") {
    const match = /([#+~-])?(.+)\((.*)\)([\s$*])?(.*)([$*])?/d.exec(raw);
    if (!match) {
      member.precise = false;
      return member;
    }
    member.precise = match.index === 0 && match[0].length === raw.length;
    member.visibility = (match[1] ?? "") as MermaidClassMember["visibility"];
    member.name = match[2]!.trim();
    member.parameters = match[3]!.trim();
    member.returnType = match[5]!.trim();
    for (const [field, group] of [
      ["visibility", 1],
      ["name", 2],
      ["parameters", 3],
      ["returnType", 5],
    ] as const) {
      const indices = match.indices?.[group];
      if (indices) set(field, ...trimRange(match[group]!, indices[0]));
    }
    let classifier = match[4]?.trim() ?? "";
    if (classifier) {
      const indices = match.indices![4]!;
      set("classifier", indices[0], indices[1]);
    } else if (/[$*]$/.test(member.returnType)) {
      classifier = member.returnType.slice(-1);
      member.returnType = member.returnType.slice(0, -1).trimEnd();
      const indices = match.indices![5]!,
        end = indices[0] + match[5]!.trimEnd().length;
      set("classifier", end - 1, end);
      set(
        "returnType",
        ...trimRange(match[5]!.trimEnd().slice(0, -1), indices[0]),
      );
    }
    member.classifier =
      classifier === "$" ? "static" : classifier === "*" ? "abstract" : "";
  } else {
    const match = /^([#+~-]?)(.*?)([$*]?)$/ds.exec(raw)!;
    member.visibility = match[1] as MermaidClassMember["visibility"];
    member.classifier =
      match[3] === "$" ? "static" : match[3] === "*" ? "abstract" : "";
    member.name = match[2]!.trim();
    set("visibility", ...match.indices![1]!);
    set("classifier", ...match.indices![3]!);
    const body = match[2]!,
      bodyStart = match.indices![2]![0],
      colon = body.indexOf(":");
    if (colon >= 0 && body.indexOf(":", colon + 1) < 0) {
      member.name = body.slice(0, colon).trim();
      member.type = body.slice(colon + 1).trim();
      set("name", ...trimRange(body.slice(0, colon), bodyStart));
      set("type", ...trimRange(body.slice(colon + 1), bodyStart + colon + 1));
    } else {
      set("name", ...trimRange(body, bodyStart));
      member.precise = colon < 0;
    }
  }
  return member;
}

function upsertClass(
  nodes: Map<string, MermaidClassNode>,
  sourceId: string,
  namespaceId: string | null,
  partial: Partial<
    Pick<
      MermaidClassNode,
      | "annotations"
      | "cssClasses"
      | "genericType"
      | "interaction"
      | "label"
      | "members"
      | "order"
    >
  > = {},
) {
  // Mermaid namespaces group globally identified classes; they do not create
  // a second namespace-qualified class identity. A later declaration can move
  // the same class to another namespace, matching ClassDB's parent assignment.
  const id = cleanClassName(sourceId);
  const existing = nodes.get(id);
  if (existing) {
    nodes.set(id, {
      ...existing,
      ...partial,
      annotations: partial.annotations
        ? [...existing.annotations, ...partial.annotations]
        : existing.annotations,
      cssClasses: partial.cssClasses
        ? [...existing.cssClasses, ...partial.cssClasses]
        : existing.cssClasses,
      genericType: existing.genericType,
      label: partial.label ?? existing.label,
      members: partial.members ?? existing.members,
      namespaceId: namespaceId ?? existing.namespaceId,
      sourceId: cleanClassName(sourceId),
    });
    return id;
  }
  const order = partial.order ?? nodes.size;
  const cleanSourceId = cleanClassName(sourceId);
  const label = partial.label ?? cleanSourceId;
  nodes.set(id, {
    annotations: partial.annotations ?? [],
    cssClasses: partial.cssClasses ?? [],
    genericType: partial.genericType ?? "",
    id,
    interaction: partial.interaction ?? "",
    kind: "class",
    label,
    members: partial.members ?? [],
    namespaceId,
    order,
    sourceId: cleanSourceId,
    sourceKey: "",
    width: Math.max(150, Math.min(300, 92 + label.length * 8)),
    x: 48 + (order % 3) * 230,
    y: 48 + Math.floor(order / 3) * 190,
  });
  return id;
}

function addLollipopInterface(
  nodes: Map<string, MermaidClassNode>,
  sourceId: string,
  genericType: string,
  recordKey: string,
  side: "from" | "to",
) {
  let id = `${recordKey}:interface:${side}`;
  while (nodes.has(id)) id = `${id}-interface`;
  const cleanSourceId = cleanClassName(sourceId);
  nodes.set(id, {
    annotations: [],
    cssClasses: [],
    genericType,
    id,
    interaction: "",
    kind: "lollipop-interface",
    label: cleanSourceId,
    members: [],
    namespaceId: null,
    order: nodes.size,
    sourceId: cleanSourceId,
    sourceKey: id,
    width: Math.max(96, Math.min(240, 48 + cleanSourceId.length * 8)),
    x: 48 + (nodes.size % 3) * 230,
    y: 48 + Math.floor(nodes.size / 3) * 190,
  });
  return id;
}

function resolveClassId(
  nodes: Map<string, MermaidClassNode>,
  sourceId: string,
  namespaceId: string | null,
  genericType = "",
) {
  return upsertClass(
    nodes,
    sourceId,
    namespaceId,
    genericType ? { genericType } : {},
  );
}

function parseRelationSide(value: string, cardinalityAtEnd: boolean) {
  const trimmed = value.trim();
  const cardinalityMatch = cardinalityAtEnd
    ? /^(.*?)\s+"([^"]*)"$/d.exec(trimmed)
    : /^"([^"]*)"\s+(.*)$/d.exec(trimmed);
  const rawId = cardinalityMatch
    ? cardinalityAtEnd
      ? cardinalityMatch[1]
      : cardinalityMatch[2]
    : trimmed;
  const cardinality = cardinalityMatch
    ? cardinalityAtEnd
      ? cardinalityMatch[2]
      : cardinalityMatch[1]
    : "";
  const classMatch = CLASS_NAME_RE.exec(rawId.trim());
  const nameRange = classMatch?.indices?.[1];
  const cardinalityRange =
    cardinalityMatch?.indices?.[cardinalityAtEnd ? 2 : 1];
  const leading = value.length - value.trimStart().length;
  const idLeading =
    trimmed.indexOf(rawId) + rawId.length - rawId.trimStart().length;
  return classMatch && nameRange
    ? {
        cardinality,
        genericType: classMatch[2] ?? "",
        genericRange: classMatch.indices?.[2]
          ? ([
              leading + idLeading + classMatch.indices[2][0],
              leading + idLeading + classMatch.indices[2][1],
            ] as [number, number])
          : undefined,
        sourceId: classMatch[1],
        idRange: [
          leading + idLeading + nameRange[0],
          leading + idLeading + nameRange[1],
        ] as [number, number],
        cardinalityRange: cardinalityRange
          ? ([leading + cardinalityRange[0], leading + cardinalityRange[1]] as [
              number,
              number,
            ])
          : undefined,
      }
    : null;
}

function parseRelation(value: string) {
  for (const match of value.matchAll(/--|\.\./g)) {
    if (match.index === undefined) continue;
    let relationStart = match.index;
    let relationEnd = match.index + match[0].length;
    let prefix = "";
    for (const candidate of ["()", "<|", "*", "o", "<"] as const) {
      const candidateStart = relationStart - candidate.length;
      if (candidateStart < 0) continue;
      if (value.slice(candidateStart, relationStart) !== candidate) continue;
      if (
        candidate === "o" &&
        /[\p{L}\p{N}_]/u.test(value[candidateStart - 1] ?? "")
      ) {
        continue;
      }
      prefix = candidate;
      relationStart = candidateStart;
      break;
    }
    let suffix = "";
    for (const candidate of ["|>", "()", "*", "o", ">"] as const) {
      if (
        value.slice(relationEnd, relationEnd + candidate.length) !== candidate
      ) {
        continue;
      }
      if (
        candidate === "o" &&
        /[\p{L}\p{N}_]/u.test(value[relationEnd + candidate.length] ?? "")
      ) {
        continue;
      }
      suffix = candidate;
      relationEnd += candidate.length;
      break;
    }
    const before = value.slice(0, relationStart);
    const afterWithLabel = value.slice(relationEnd);
    let quoted = false;
    let backticked = false;
    let labelSeparator = -1;
    for (let index = 0; index < afterWithLabel.length; index += 1) {
      if (afterWithLabel[index] === '"' && !backticked) quoted = !quoted;
      if (afterWithLabel[index] === "`" && !quoted) backticked = !backticked;
      if (!quoted && !backticked && afterWithLabel[index] === ":") {
        labelSeparator = index;
        break;
      }
    }
    const after =
      labelSeparator >= 0
        ? afterWithLabel.slice(0, labelSeparator)
        : afterWithLabel;
    const rawLabel =
      labelSeparator >= 0
        ? afterWithLabel
            .slice(labelSeparator + 1)
            .replace(/;\s*$/, "")
            .trim()
        : "";
    if (
      labelSeparator >= 0 &&
      (!rawLabel || rawLabel.includes(":") || rawLabel.includes(";"))
    ) {
      return null;
    }
    const from = parseRelationSide(before, true);
    const to = parseRelationSide(after.replace(/;\s*$/, ""), false);
    if (!from || !to) continue;
    return {
      ranges: {
        from: from.idRange,
        to: [relationEnd + to.idRange[0], relationEnd + to.idRange[1]] as [
          number,
          number,
        ],
        fromGeneric: from.genericRange,
        toGeneric: to.genericRange
          ? ([
              relationEnd + to.genericRange[0],
              relationEnd + to.genericRange[1],
            ] as [number, number])
          : undefined,
        fromCardinality: from.cardinalityRange,
        toCardinality: to.cardinalityRange
          ? ([
              relationEnd + to.cardinalityRange[0],
              relationEnd + to.cardinalityRange[1],
            ] as [number, number])
          : undefined,
        kind: [relationStart, relationEnd] as [number, number],
        label:
          labelSeparator >= 0
            ? ([
                relationEnd +
                  labelSeparator +
                  1 +
                  afterWithLabel.slice(labelSeparator + 1).search(/\S/),
                relationEnd +
                  labelSeparator +
                  1 +
                  afterWithLabel
                    .slice(labelSeparator + 1)
                    .replace(/;\s*$/, "")
                    .trimEnd().length,
              ] as [number, number])
            : undefined,
      },
      from,
      kind: `${prefix}${match[0]}${suffix}`,
      label: labelSeparator >= 0 ? cleanLabel(rawLabel) : "",
      to,
    };
  }
  return null;
}

function isLollipopInterfaceRelationSide(kind: string, side: "from" | "to") {
  const match = RELATION_KIND_PARTS_RE.exec(kind);
  if (!match) return false;
  return side === "from"
    ? match[1] === "()" && !match[3]
    : match[3] === "()" && !match[1];
}

/** Marker semantics are resolved once; renderer and commands consume the typed ends. */
export function classRelationSemantics(token: string) {
  const match = RELATION_KIND_PARTS_RE.exec(token);
  const marker = (value: string | undefined): ClassMarker =>
    value === "*"
      ? "composition"
      : value === "o"
        ? "aggregation"
        : value === "<|" || value === "|>"
          ? "inheritance"
          : value === "()"
            ? "lollipop"
            : value === "<" || value === ">"
              ? "arrow"
              : "none";
  const fromMarker = marker(match?.[1]),
    toMarker = marker(match?.[3]);
  const points = (m: ClassMarker) => m === "arrow" || m === "inheritance";
  return {
    lineStyle: (match?.[2] === ".."
      ? "dashed"
      : "solid") as MermaidClassRelation["lineStyle"],
    fromMarker,
    toMarker,
    direction: (points(fromMarker)
      ? points(toMarker)
        ? "both"
        : "backward"
      : points(toMarker)
        ? "forward"
        : "undirected") as MermaidClassRelation["direction"],
  };
}
export function classStyleProperties(source: string, range: ClassRange) {
  const properties: MermaidClassStyle["properties"] = [];
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
function classComments(
  document: ClassSourceDocument,
  model: MermaidClassModel,
): MermaidClassComment[] {
  const records = document.records;
  return records
    .filter((r) => r.kind === "comment")
    .map((record) => {
      const index = records.indexOf(record);
      let first = index,
        last = index;
      while (
        records[first - 1]?.kind === "comment" &&
        records[first - 1]?.indent === record.indent
      )
        first--;
      while (
        records[last + 1]?.kind === "comment" &&
        records[last + 1]?.indent === record.indent
      )
        last++;
      const prior = records[first - 1],
        next = records[last + 1];
      const inline = prior?.range.line === record.range.line;
      const after =
        !inline &&
        (!next || next.kind === "blank" || next.kind === "close") &&
        prior?.kind === "member";
      const target = inline || after ? prior : next;
      const kind = [
        "header",
        "direction",
        "accessibility-title",
        "accessibility-description",
        "frontmatter",
        "directive",
      ].includes(prior?.kind ?? "")
        ? "header"
        : target?.kind;
      const anchorKind: MermaidClassComment["anchorKind"] =
        kind === "member" || kind === "relation" || kind === "note"
          ? kind
          : kind === "class"
            ? "class"
            : kind === "namespace"
              ? "namespace"
              : kind === "header"
                ? "diagram"
                : record.ownerId &&
                    model.nodes.some((n) => n.sourceId === record.ownerId)
                  ? "class"
                  : record.namespaceId
                    ? "namespace"
                    : "diagram";
      const anchorId =
        anchorKind === "class"
          ? model.nodes.find(
              (n) => n.sourceId === (target?.ownerId ?? record.ownerId),
            )?.sourceKey
          : anchorKind === "namespace"
            ? model.namespaces.find(
                (n) => n.id === (target?.ownerId ?? record.namespaceId),
              )?.sourceKey
            : anchorKind === "diagram"
              ? undefined
              : target?.sourceKey;
      return {
        id: record.sourceKey,
        text: record.values.text
          ? document.source.slice(
              record.values.text.start,
              record.values.text.end,
            )
          : record.raw.trim().slice(2).trim(),
        anchorKind,
        anchorId,
        position:
          inline || after
            ? "after"
            : target?.kind === "close"
              ? "inside"
              : "before",
      };
    });
}

function layoutNodes(
  nodes: Iterable<MermaidClassNode>,
  direction: MermaidClassModel["direction"],
) {
  const ordered = [...nodes].sort((a, b) => a.order - b.order);
  return ordered.map((node, index) => ({
    ...node,
    order: index,
    width: Math.max(
      150,
      Math.min(
        320,
        92 +
          Math.max(
            node.label.length,
            ...node.annotations.map((item) => item.length + 4),
            ...node.members.map((item) => item.raw.length),
          ) *
            7,
      ),
    ),
    x:
      direction === "LR" || direction === "RL"
        ? 48 + (direction === "RL" ? ordered.length - index - 1 : index) * 360
        : 48,
    y:
      direction === "BT" || direction === "TB"
        ? 48 + (direction === "BT" ? ordered.length - index - 1 : index) * 190
        : 48,
  }));
}

function parseClassDocument(
  source: string,
  document: ClassSourceDocument,
): MermaidClassModel | null {
  const sourceHash = hashMermaidSource(source);
  const diagramType = detectMermaidDiagramType(source);
  const fail = (
    record?: ClassSourceRecord,
    code: ClassSourceDiagnostic["code"] = "invalid-record",
  ) => {
    document.diagnostics.push({
      code,
      line: record?.range.line ?? 1,
      sourceKey: record?.sourceKey,
      construct: record
        ? `${record.kind}${record.ownerId ? ": " + record.ownerId : ""}`
        : "header",
    });
    return null;
  };
  if (diagramType !== "classDiagram" && diagramType !== "classDiagram-v2")
    return fail(undefined, "missing-header");
  const headerIndex = document.records.findIndex(
    (r) => r.raw.trim() === diagramType,
  );
  if (headerIndex < 0) return fail(undefined, "missing-header");
  const incomplete = document.records.find((r) => !r.complete);
  if (incomplete) return fail(incomplete, "incomplete-record");
  const preamble = document.records.slice(0, headerIndex);
  const comments = preamble
    .filter((r) => r.kind === "comment")
    .map((r) => r.raw.trim().slice(2).trim());
  const directives = preamble
    .filter((r) => r.kind !== "comment" && r.kind !== "blank")
    .flatMap((r) => r.raw.split(/\r\n|\r|\n/));
  const headerRecord = document.records[headerIndex]!;
  headerRecord.kind = "header";
  const headerLine = headerRecord.raw.trim();
  let accessibilityDescription = "";
  let accessibilityTitle = "";
  const namespaces: MermaidClassNamespace[] = [];
  const namespaceStack: string[] = [];
  const nodes = new Map<string, MermaidClassNode>();
  const notes: MermaidClassNote[] = [];
  const relations: MermaidClassRelation[] = [];
  const styleStatements: string[] = [];
  const interactions: MermaidClassInteraction[] = [];
  const styles: MermaidClassStyle[] = [];
  let direction: MermaidClassModel["direction"] = "TB";
  let blockClass: {
    id: string;
    namespaceId: string | null;
    record: ClassSourceRecord;
  } | null = null;
  const namespaceRecords: ClassSourceRecord[] = [];
  let blockMembers: MermaidClassMember[] = [];
  for (const record of document.records.slice(headerIndex + 1)) {
    const line = record.raw;
    const trimmed = line.trim();
    const offset = line.length - line.trimStart().length;
    const setValue = (name: string, match: RegExpExecArray, group: number) => {
      const range = match.indices?.[group];
      if (range)
        record.values[name] = classRecordRange(
          record,
          offset + range[0],
          offset + range[1],
        );
    };
    const reference = (
      kind: "class" | "namespace" | "style",
      match: RegExpExecArray,
      group: number,
    ) => {
      const range = match.indices?.[group];
      if (range)
        record.references.push({
          kind,
          id: cleanClassName(match[group]!),
          range: classRecordRange(record, offset + range[0], offset + range[1]),
        });
    };
    const referenceList = (kind: "class" | "style", range: ClassRange) => {
      let start = range.start - record.range.start,
        end = range.end - record.range.start;
      if (line[start] === '"' && line[end - 1] === '"') {
        start++;
        end--;
      }
      let quote = "",
        tokenStart = start;
      for (let cursor = start; cursor <= end; cursor++) {
        const c = line[cursor];
        if (c === "`") quote = quote ? "" : "`";
        if (cursor < end && (c !== "," || quote)) continue;
        const token = line.slice(tokenStart, cursor),
          value = token.trim();
        const leading = token.length - token.trimStart().length;
        if (value)
          record.references.push({
            kind,
            id: cleanClassName(value),
            range: classRecordRange(
              record,
              tokenStart + leading,
              tokenStart + leading + value.length,
            ),
          });
        tokenStart = cursor + 1;
      }
    };
    record.namespaceId = namespaceStack.at(-1) ?? null;
    if (!trimmed) continue;
    if (record.kind === "directive") {
      directives.push(...line.split(/\r\n|\r|\n/));
      continue;
    }
    if (trimmed.startsWith("%%")) {
      record.ownerId = blockClass?.id ?? namespaceStack.at(-1);
      const prefix = offset + 2,
        content = line.slice(prefix),
        lead = content.length - content.trimStart().length;
      record.values.text = classRecordRange(
        record,
        prefix + lead,
        line.trimEnd().length,
      );
      comments.push(trimmed.slice(2).trim());
      continue;
    }
    if (blockClass) {
      record.ownerId = blockClass.id;
      record.blockKey = blockClass.record.sourceKey;
      if (trimmed === "}") {
        const node = nodes.get(blockClass.id);
        if (!node) return fail(record);
        node.members = [...node.members, ...blockMembers];
        blockClass.record.closeKey = record.sourceKey;
        record.kind = "close";
        blockClass = null;
        blockMembers = [];
      } else {
        record.kind = /^<<[^>]+>>$/.test(trimmed) ? "annotation" : "member";
        record.values.text = classRecordRange(
          record,
          offset,
          offset + trimmed.length,
        );
        if (record.kind === "annotation") {
          record.values.annotation = classRecordRange(
            record,
            offset + 2,
            offset + trimmed.length - 2,
          );
          nodes.get(blockClass.id)?.annotations.push(trimmed.slice(2, -2));
        } else
          blockMembers.push(
            parseMermaidClassMember(trimmed, {
              id: record.sourceKey,
              classId: blockClass.id,
              sourceForm: "block",
              range: record.values.text,
            }),
          );
      }
      continue;
    }
    if (record.kind === "accessibility-description") {
      if (namespaceStack.length) return fail(record);
      const open = line.indexOf("{"),
        close = line.lastIndexOf("}");
      accessibilityDescription = line.slice(open + 1, close).trim();
      record.values.text = classRecordRange(record, open + 1, close);
      continue;
    }
    const accessibilityTitleMatch = /^accTitle\s*:\s*(.*?)(?:;\s*)?$/d.exec(
      trimmed,
    );
    if (accessibilityTitleMatch) {
      if (namespaceStack.length) return fail(record);
      record.kind = "accessibility-title";
      setValue("text", accessibilityTitleMatch, 1);
      accessibilityTitle = accessibilityTitleMatch[1];
      continue;
    }
    const accessibilityDescriptionMatch =
      /^accDescr\s*:\s*(.*?)(?:;\s*)?$/d.exec(trimmed);
    if (accessibilityDescriptionMatch) {
      if (namespaceStack.length) return fail(record);
      record.kind = "accessibility-description";
      setValue("text", accessibilityDescriptionMatch, 1);
      accessibilityDescription = accessibilityDescriptionMatch[1];
      continue;
    }
    const namespaceId = namespaceStack.at(-1) ?? null;
    if (trimmed === "}") {
      if (!namespaceStack.length) return fail(record);
      const opening = namespaceRecords.pop();
      if (opening) {
        opening.closeKey = record.sourceKey;
        record.blockKey = opening.sourceKey;
        record.ownerId = namespaceId ?? undefined;
      }
      namespaceStack.pop();
      continue;
    }
    const namespaceMatch = NAMESPACE_RE.exec(trimmed);
    if (namespaceMatch) {
      record.kind = "namespace";
      reference("namespace", namespaceMatch, 1);
      setValue("label", namespaceMatch, 2);
      const sourceId = cleanClassName(namespaceMatch[1]);
      const qualifiedId = namespaceId ? `${namespaceId}.${sourceId}` : sourceId;
      const segments = qualifiedId.split(".");
      for (let index = 0; index < segments.length; index += 1) {
        const id = segments.slice(0, index + 1).join(".");
        const parentId = index ? segments.slice(0, index).join(".") : null;
        const existing = namespaces.find((namespace) => namespace.id === id);
        const label =
          index === segments.length - 1 && namespaceMatch[2]
            ? namespaceMatch[2]
            : segments[index];
        if (existing) {
          // A nested/dotted declaration contributes implicit ancestors, not
          // a new label for an already explicitly declared parent.
          if (index === segments.length - 1) {
            existing.label = label;
            existing.explicit = true;
          }
        } else
          namespaces.push({
            sourceKey: `${record.sourceKey}:namespace:${index}`,
            explicit: index === segments.length - 1,
            id,
            label,
            order: namespaces.length,
            parentId,
          });
      }
      record.ownerId = qualifiedId;
      if (record.references[0]) record.references[0].id = qualifiedId;
      if (!namespaceMatch[3]) {
        namespaceStack.push(qualifiedId);
        namespaceRecords.push(record);
      }
      continue;
    }
    const directionMatch = DIRECTION_RE.exec(trimmed);
    if (directionMatch) {
      if (namespaceId) return fail(record);
      record.kind = "direction";
      setValue("direction", directionMatch, 1);
      direction = directionMatch[1] as MermaidClassModel["direction"];
      continue;
    }
    const emptyBlockMatch = CLASS_EMPTY_BLOCK_RE.exec(trimmed);
    if (emptyBlockMatch) {
      record.kind = "class";
      record.ownerId = cleanClassName(emptyBlockMatch[1]);
      reference("class", emptyBlockMatch, 1);
      if (emptyBlockMatch[2]) setValue("generic", emptyBlockMatch, 2);
      if (emptyBlockMatch[3] !== undefined)
        setValue("label", emptyBlockMatch, 3);
      if (emptyBlockMatch[4]) setValue("annotation", emptyBlockMatch, 4);
      if (emptyBlockMatch[5]) setValue("styles", emptyBlockMatch, 5);
      if (record.values.styles) referenceList("style", record.values.styles);
      upsertClass(nodes, emptyBlockMatch[1], namespaceId, {
        ...(emptyBlockMatch[4]
          ? { annotations: [emptyBlockMatch[4].trim()] }
          : {}),
        ...(emptyBlockMatch[5]
          ? { cssClasses: parseCssClasses(emptyBlockMatch[5]) }
          : {}),
        ...(emptyBlockMatch[2] ? { genericType: emptyBlockMatch[2] } : {}),
        ...(emptyBlockMatch[3] !== undefined
          ? { label: emptyBlockMatch[3] }
          : {}),
      });
      continue;
    }
    const blockMatch = CLASS_BLOCK_RE.exec(trimmed);
    if (blockMatch) {
      record.kind = "class";
      record.ownerId = cleanClassName(blockMatch[1]);
      reference("class", blockMatch, 1);
      if (blockMatch[2]) setValue("generic", blockMatch, 2);
      if (blockMatch[3] !== undefined) setValue("label", blockMatch, 3);
      if (blockMatch[4]) setValue("annotation", blockMatch, 4);
      if (blockMatch[5]) setValue("styles", blockMatch, 5);
      if (record.values.styles) referenceList("style", record.values.styles);
      const id = upsertClass(nodes, blockMatch[1], namespaceId, {
        ...(blockMatch[4] ? { annotations: [blockMatch[4].trim()] } : {}),
        ...(blockMatch[5]
          ? { cssClasses: parseCssClasses(blockMatch[5]) }
          : {}),
        ...(blockMatch[2] ? { genericType: blockMatch[2] } : {}),
        ...(blockMatch[3] !== undefined ? { label: blockMatch[3] } : {}),
      });
      blockClass = { id, namespaceId, record };
      blockMembers = [];
      continue;
    }
    const declarationMatch = CLASS_DECLARATION_RE.exec(trimmed);
    if (declarationMatch) {
      record.kind = "class";
      record.ownerId = cleanClassName(declarationMatch[1]);
      reference("class", declarationMatch, 1);
      if (declarationMatch[2]) setValue("generic", declarationMatch, 2);
      if (declarationMatch[3] !== undefined)
        setValue("label", declarationMatch, 3);
      if (declarationMatch[4]) setValue("annotation", declarationMatch, 4);
      if (declarationMatch[5]) setValue("styles", declarationMatch, 5);
      if (record.values.styles) referenceList("style", record.values.styles);
      upsertClass(nodes, declarationMatch[1], namespaceId, {
        ...(declarationMatch[4]
          ? { annotations: [declarationMatch[4].trim()] }
          : {}),
        ...(declarationMatch[5]
          ? { cssClasses: parseCssClasses(declarationMatch[5]) }
          : {}),
        ...(declarationMatch[2] ? { genericType: declarationMatch[2] } : {}),
        ...(declarationMatch[3] !== undefined
          ? { label: declarationMatch[3] }
          : {}),
      });
      continue;
    }
    const annotationMatch = ANNOTATION_RE.exec(trimmed);
    if (annotationMatch) {
      record.kind = "annotation";
      record.ownerId = cleanClassName(annotationMatch[2]);
      reference("class", annotationMatch, 2);
      setValue("annotation", annotationMatch, 1);
      if (namespaceId) return fail(record);
      const id = resolveClassId(
        nodes,
        annotationMatch[2],
        namespaceId,
        annotationMatch[3],
      );
      const node = nodes.get(id);
      if (!node) return fail(record);
      node.annotations.push(annotationMatch[1].trim());
      continue;
    }
    const noteForMatch = NOTE_FOR_RE.exec(trimmed);
    if (noteForMatch) {
      record.kind = "note";
      record.ownerId = cleanClassName(noteForMatch[1]);
      reference("class", noteForMatch, 1);
      setValue("text", noteForMatch, 3);
      const classId = cleanClassName(noteForMatch[1]);
      const id = record.sourceKey;
      notes.push({
        sourceKey: record.sourceKey,
        classId,
        id,
        namespaceId,
        order: notes.length,
        text: noteForMatch[3],
      });
      continue;
    }
    const noteMatch = /^note\s+"([^"]*)"\s*;?$/d.exec(trimmed);
    if (noteMatch) {
      record.kind = "note";
      setValue("text", noteMatch, 1);
      const id = record.sourceKey;
      notes.push({
        sourceKey: record.sourceKey,
        classId: null,
        id,
        namespaceId,
        order: notes.length,
        text: noteMatch[1],
      });
      continue;
    }
    const memberMatch = MEMBER_RE.exec(trimmed);
    if (memberMatch) {
      record.kind = "member";
      record.ownerId = cleanClassName(memberMatch[1]);
      reference("class", memberMatch, 1);
      setValue("text", memberMatch, 3);
      if (memberMatch[2] !== undefined) setValue("generic", memberMatch, 2);
      if (namespaceId) return fail(record);
      const id = resolveClassId(
        nodes,
        memberMatch[1],
        namespaceId,
        memberMatch[2],
      );
      nodes.get(id)?.members.push(
        parseMermaidClassMember(memberMatch[3].replace(/;\s*$/, ""), {
          id: record.sourceKey,
          classId: id,
          sourceForm: "short",
          range: record.values.text,
        }),
      );
      continue;
    }
    const relation = parseRelation(trimmed);
    if (relation) {
      record.kind = "relation";
      for (const [name, range] of Object.entries(relation.ranges)) {
        if (range)
          record.values[name] = classRecordRange(
            record,
            offset + range[0],
            offset + range[1],
          );
      }
      for (const [side, endpoint] of [
        ["from", relation.from],
        ["to", relation.to],
      ] as const) {
        const range = record.values[side];
        if (range)
          record.references.push({
            kind: "class",
            id: cleanClassName(endpoint.sourceId),
            range,
          });
      }
      if (namespaceId) return fail(record);
      const from = isLollipopInterfaceRelationSide(relation.kind, "from")
        ? addLollipopInterface(
            nodes,
            relation.from.sourceId,
            relation.from.genericType,
            record.sourceKey,
            "from",
          )
        : resolveClassId(
            nodes,
            relation.from.sourceId,
            namespaceId,
            relation.from.genericType,
          );
      const to = isLollipopInterfaceRelationSide(relation.kind, "to")
        ? addLollipopInterface(
            nodes,
            relation.to.sourceId,
            relation.to.genericType,
            record.sourceKey,
            "to",
          )
        : resolveClassId(
            nodes,
            relation.to.sourceId,
            namespaceId,
            relation.to.genericType,
          );
      relations.push({
        from,
        fromCardinality: relation.from.cardinality,
        id: record.sourceKey,
        sourceKey: record.sourceKey,
        fromSourceId: cleanClassName(relation.from.sourceId),
        toSourceId: cleanClassName(relation.to.sourceId),
        ...classRelationSemantics(relation.kind),
        kind: relation.kind,
        label: relation.label,
        order: relations.length,
        to,
        toCardinality: relation.to.cardinality,
      });
      continue;
    }
    if (INTERACTION_RE.test(trimmed)) {
      record.kind = "interaction";
      if (namespaceId) return fail(record);
      const interactionOwner = INTERACTION_OWNER_RE.exec(trimmed);
      if (!interactionOwner) return fail(record);
      record.ownerId = cleanClassName(interactionOwner[1]);
      reference("class", interactionOwner, 1);
      const payloadStart = offset + interactionOwner[0].length;
      record.values.payload = classRecordRange(
        record,
        payloadStart,
        line.trimEnd().replace(/;$/, "").length,
      );
      const payload = line.slice(
        payloadStart,
        record.values.payload.end - record.range.start,
      );
      const quotes = [...payload.matchAll(/"([^"]*)"/dg)];
      const isUrl = /^(?:link\b|click\b.*?\bhref\b)/.test(trimmed);
      for (const [index, token] of quotes.entries()) {
        const range = token.indices?.[1];
        if (range)
          record.values[
            isUrl && index === 0
              ? "url"
              : index === (isUrl ? 1 : 0)
                ? "tooltip"
                : `payload-${index}`
          ] = classRecordRange(
            record,
            payloadStart + range[0],
            payloadStart + range[1],
          );
      }
      const target = /_((?:self|blank|parent|top))\s*;?$/d.exec(trimmed);
      if (target) setValue("target", target, 0);

      const node = nodes.get(record.ownerId!);
      if (node) node.interaction = trimmed.replace(/;\s*$/, "");
      const read = (name: string) => {
        const r = record.values[name];
        return r ? source.slice(r.start, r.end) : "";
      };
      interactions.push({
        id: record.sourceKey,
        classId: record.ownerId!,
        kind: isUrl ? "link" : "callback",
        url: read("url"),
        tooltip: read("tooltip"),
        target: (read("target") ||
          "_self") as MermaidClassInteraction["target"],
        payload,
      });
      continue;
    }
    if (isClassStyleStatement(trimmed)) {
      record.kind = /^classDef\b/.test(trimmed)
        ? "style-definition"
        : /^style\b/.test(trimmed)
          ? "style"
          : "style-assignment";
      if (namespaceId) return fail(record);
      const styleMatch =
        /^(classDef|style|class|cssClass)\s+(.+?)\s+(.+?)(?:;\s*)?$/du.exec(
          trimmed,
        );
      if (!styleMatch) return fail(record);
      setValue("targets", styleMatch, 2);
      setValue("properties", styleMatch, 3);
      referenceList(
        record.kind === "style-definition" ? "style" : "class",
        record.values.targets!,
      );
      if (record.kind === "style-assignment")
        referenceList("style", record.values.properties!);
      styleStatements.push(trimmed.replace(/;\s*$/, ""));
      styles.push({
        id: record.sourceKey,
        kind:
          record.kind === "style-definition"
            ? "definition"
            : record.kind === "style"
              ? "inline"
              : "assignment",
        owners: record.references
          .filter((r) => r.kind === "class")
          .map((r) => r.id),
        styles: record.references
          .filter((r) => r.kind === "style")
          .map((r) => r.id),
        properties:
          record.kind === "style-assignment"
            ? []
            : classStyleProperties(source, record.values.properties!),
      });
      continue;
    }
    return fail(record);
  }

  if (blockClass) return fail(blockClass.record, "unclosed-class");
  if (namespaceStack.length)
    return fail(namespaceRecords.at(-1), "unclosed-namespace");
  const occupiedIds = new Set(nodes.keys());
  for (const note of notes) {
    while (occupiedIds.has(note.id)) note.id = `${note.id}-note`;
    occupiedIds.add(note.id);
  }
  return {
    interactions,
    styles,
    commentRecords: [],
    accessibilityDescription,
    accessibilityTitle,
    comments,
    diagramType,
    direction,
    directives,
    headerLine,
    hierarchicalNamespaces:
      readClassConfig(document).config.hierarchicalNamespaces,
    namespaces,
    nodes: layoutNodes(nodes.values(), direction),
    notes,
    relations,
    sourceHash,
    sourceDocument: document,
    styleStatements,
    version: 1,
  };
}

export function resolveMermaidClassSource(
  source: string,
  previous?: MermaidClassModel,
  mapping?: ReadonlyMap<number, string>,
  classKeys?: ReadonlyMap<string, string>,
  namespaceKeys?: ReadonlyMap<string, string>,
) {
  const document = scanClassSource(source);
  const model = parseClassDocument(source, document);
  const oldKeys = new Map(
    document.records.map((r) => [r.sourceKey, r.range.start]),
  );
  reconcileClassSource(document, previous?.sourceDocument, mapping);
  if (model) {
    const keysByStart = new Map(
      document.records.map((r) => [r.range.start, r.sourceKey]),
    );
    const remapKey = (key: string) => keysByStart.get(oldKeys.get(key)!) ?? key;
    const remapDerivedKey = (value: string) => {
      for (const key of oldKeys.keys())
        if (value.startsWith(`${key}:`))
          return remapKey(key) + value.slice(key.length);
      return value;
    };
    for (const relation of model.relations) {
      relation.id = relation.sourceKey = remapKey(relation.sourceKey);
    }
    for (const note of model.notes)
      note.id = note.sourceKey = remapKey(note.sourceKey);
    for (const item of [...model.interactions, ...model.styles])
      item.id = remapKey(item.id);
    for (const namespace of model.namespaces) {
      const record = document.records.find(
        (r) => r.kind === "namespace" && r.ownerId === namespace.id,
      );
      const previousNamespace = previous?.namespaces.find(
        (n) => n.id === namespace.id,
      );
      namespace.sourceKey =
        namespaceKeys?.get(namespace.id) ??
        previousNamespace?.sourceKey ??
        (record
          ? `${record.sourceKey}:namespace`
          : remapDerivedKey(namespace.sourceKey));
    }
    for (const node of model.nodes) {
      if (node.kind === "lollipop-interface") {
        const oldId = node.id;
        node.id = node.sourceKey = remapDerivedKey(node.id);
        for (const relation of model.relations) {
          if (relation.from === oldId) relation.from = node.id;
          if (relation.to === oldId) relation.to = node.id;
        }
        continue;
      }
      for (const member of node.members)
        member.id = keysByStart.get(oldKeys.get(member.id)!) ?? member.id;
      const primary =
        document.records.find(
          (r) => r.kind === "class" && r.ownerId === node.sourceId,
        ) ??
        document.records.find((r) =>
          r.references.some(
            (ref) => ref.kind === "class" && ref.id === node.sourceId,
          ),
        );
      const existing = previous?.nodes.find(
        (n) => n.kind === node.kind && n.sourceId === node.sourceId,
      );
      node.sourceKey =
        classKeys?.get(node.sourceId) ||
        existing?.sourceKey ||
        (primary
          ? `${primary.sourceKey}:class:${primary.references.findIndex((ref) => ref.kind === "class" && ref.id === node.sourceId)}`
          : nextClassSourceKey());
    }
  }

  if (model) model.commentRecords = classComments(document, model);
  return { model, document, diagnostics: document.diagnostics };
}
export function parseMermaidClassSource(
  source: string,
  previous?: MermaidClassModel,
  mapping?: ReadonlyMap<number, string>,
): MermaidClassModel | null {
  return resolveMermaidClassSource(source, previous, mapping).model;
}
