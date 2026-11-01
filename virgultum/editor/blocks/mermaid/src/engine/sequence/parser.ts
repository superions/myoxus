// SPDX-License-Identifier: AGPL-3.0-or-later

import { readSourceYaml } from "../source-yaml.js";
import {
  reconcileSequenceSource,
  scanSequenceSource,
  sequenceRecordValue,
  type SequenceSourceRecord,
} from "./source-document.js";
import type { SequenceSourceDiagnostic } from "./diagnostics.js";
import type {
  SequenceActivationInterval,
  SequenceComment,
  SequenceParticipantType,
} from "./model.js";
import { hashMermaidSource } from "../../utils.js";
import { detectMermaidDiagramType } from "../diagram-types.js";

import {
  MERMAID_SEQUENCE_MESSAGE_ARROWS,
  isMermaidSequenceMessageArrow,
  isSequenceMessageParticipantId,
  SEQUENCE_PARTICIPANT_TYPES,
} from "./model.js";
import type {
  MermaidSequenceActivation,
  MermaidSequenceBackground,
  MermaidSequenceBackgroundKind,
  MermaidSequenceControl,
  MermaidSequenceControlKind,
  MermaidSequenceMessage,
  MermaidSequenceModel,
  MermaidSequenceNote,
  MermaidSequenceNotePlacement,
  MermaidSequenceParticipant,
  MermaidSequenceParticipantKind,
} from "./model.js";

const AUTONUMBER_RE =
  /^\s*(autonumber(?:\s+(?:off|(?:\d+(?:\.\d{1,2})?|\.\d{1,2})(?:\s+(?:\d+(?:\.\d{1,2})?|\.\d{1,2}))?))?)\s*;?\s*$/i;
const ACCESSIBILITY_TITLE_RE = /^\s*accTitle\s*:\s*(.*?)(?:;\s*)?$/i;
const ACCESSIBILITY_DESCRIPTION_RE = /^\s*accDescr\s*:\s*(.*?)(?:;\s*)?$/i;
const TITLE_RE = /^\s*title\s*:?[ \t]+(.*?)(?:;\s*)?$/i;
const PARTICIPANT_RE =
  /^\s*(participant|actor)\s+([^<>:\n,;@]+?)(\s*@\s*\{[\s\S]*\})?(?:\s+as\s+(.+?))?\s*;?\s*$/i;
const CREATE_PARTICIPANT_RE =
  /^\s*create\s+(participant|actor)\s+([^<>:\n,;@]+?)(\s*@\s*\{[\s\S]*\})?(?:\s+as\s+(.+?))?\s*;?\s*$/i;
const DESTROY_PARTICIPANT_RE = /^\s*destroy\s+([^<>:\n,;@]+?)\s*;?\s*$/i;
const PARTICIPANT_LINK_RE =
  /^\s*link\s+([^<>:\n,;@]+?)\s*:\s*(.*?)\s+@\s+(.*?)\s*;?\s*$/i;
const PARTICIPANT_LINKS_RE =
  /^\s*links\s+([^<>:\n,;@]+?)\s*:\s*(.*?)\s*;?\s*$/i;
const PARTICIPANT_PROPERTIES_RE =
  /^\s*properties\s+([^<>:\n,;@]+?)\s*:\s*(.*?)\s*;?\s*$/i;
const PARTICIPANT_DETAILS_RE =
  /^\s*details\s+([^<>:\n,;@]+?)\s*:\s*(.*?)\s*;?\s*$/i;
const SEQUENCE_MESSAGE_ARROW_PATTERN = [...MERMAID_SEQUENCE_MESSAGE_ARROWS]
  .sort((a, b) => b.length - a.length)
  .map((token) => token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
  .join("|");
const MESSAGE_RE = new RegExp(
  `^\\s*(.+?)\\s*(\\(\\))?\\s*(${SEQUENCE_MESSAGE_ARROW_PATTERN})\\s*([+-])?\\s*(\\(\\))?\\s*([^:\\n;]+?)\\s*:\\s*(.*?)\\s*$`,
);
function sequenceSignal(line: string) {
  if (!line.includes("@{")) {
    const groups = MESSAGE_RE.exec(line);
    return groups
      ? {
          groups,
          arrowOffset: line.indexOf(
            groups[3]!,
            line.indexOf(groups[1]!) + groups[1]!.length,
          ),
        }
      : null;
  }
  let depth = 0,
    quote = "";
  const tokens = [...MERMAID_SEQUENCE_MESSAGE_ARROWS].sort(
    (a, b) => b.length - a.length,
  );
  for (let index = 0; index < line.length; index++) {
    const c = line[index]!;
    if (quote) {
      if (c === quote && line[index - 1] !== "\\") quote = "";
      continue;
    }
    if (depth && (c === '"' || c === "'")) {
      quote = c;
      continue;
    }
    if (c === "{" && (depth || line[index - 1] === "@")) depth++;
    if (c === "}" && depth) depth--;
    if (depth) continue;
    const arrow = tokens.find((token) => line.startsWith(token, index));
    if (!arrow) continue;
    let from = line.slice(0, index).trim(),
      centralFrom = "",
      tail = line.slice(index + arrow.length).trimStart(),
      marker = "",
      centralTo = "";
    if (from.endsWith("()")) {
      from = from.slice(0, -2).trimEnd();
      centralFrom = "()";
    }
    if (/^[+-]/.test(tail)) {
      marker = tail[0]!;
      tail = tail.slice(1).trimStart();
    }
    if (tail.startsWith("()")) {
      centralTo = "()";
      tail = tail.slice(2).trimStart();
    }
    let nested = 0,
      quoted = "";
    for (let end = 0; end < tail.length; end++) {
      const char = tail[end]!;
      if (quoted) {
        if (char === quoted && tail[end - 1] !== "\\") quoted = "";
        continue;
      }
      if (nested && (char === '"' || char === "'")) {
        quoted = char;
        continue;
      }
      if (char === "{" && (nested || tail[end - 1] === "@")) nested++;
      if (char === "}" && nested) nested--;
      if (char === ":" && !nested)
        return {
          arrowOffset: index,
          groups: [
            line,
            from,
            centralFrom,
            arrow,
            marker,
            centralTo,
            tail.slice(0, end).trim(),
            tail.slice(end + 1).trim(),
          ],
        };
    }
    return null;
  }
  return null;
}
function sequenceEndpoint(value: string) {
  const match = /^\s*([^<>:\n,;@]+?)(@\{[\s\S]*\})?\s*$/.exec(value);
  if (!match || !isSequenceMessageParticipantId(match[1]!)) return null;
  const config = match[2] ?? "",
    metadata = config ? parseParticipantConfig(config) : undefined;
  return config && !metadata
    ? null
    : { id: match[1]!.trim(), config, metadata };
}

const NOTE_RE =
  /^\s*Note\s+(left of|right of|over)\s+([^:\n;]+?)\s*:\s*(.*?)\s*$/i;
const ACTIVATION_RE = /^\s*(activate|deactivate)\s+([^<>:\n,;@]+?)\s*;?\s*$/i;
const CONTROL_START_RE =
  /^\s*(alt|break|critical|loop|opt|par|par_over)\b\s*(.*?)\s*$/i;
const CONTROL_BRANCH_RE = /^\s*(else|and|option)\b\s*(.*?)\s*$/i;
const CONTROL_END_RE = /^\s*end\s*;?\s*$/i;
const BACKGROUND_START_RE = /^\s*(box|rect)\b\s*(.*?)\s*;?\s*$/i;
const CSS_FUNCTION_COLOR_RE =
  /^((?:rgba?|hsla?)\s*\([^)]+\))(?:\s+([\s\S]*))?$/i;
const CSS_NAMED_COLORS = new Set(
  `aliceblue antiquewhite aqua aquamarine azure beige bisque black blanchedalmond blue blueviolet brown burlywood cadetblue chartreuse chocolate coral cornflowerblue cornsilk crimson cyan darkblue darkcyan darkgoldenrod darkgray darkgreen darkgrey darkkhaki darkmagenta darkolivegreen darkorange darkorchid darkred darksalmon darkseagreen darkslateblue darkslategray darkslategrey darkturquoise darkviolet deeppink deepskyblue dimgray dimgrey dodgerblue firebrick floralwhite forestgreen fuchsia gainsboro ghostwhite gold goldenrod gray green greenyellow grey honeydew hotpink indianred indigo ivory khaki lavender lavenderblush lawngreen lemonchiffon lightblue lightcoral lightcyan lightgoldenrodyellow lightgray lightgreen lightgrey lightpink lightsalmon lightseagreen lightskyblue lightslategray lightslategrey lightsteelblue lightyellow lime limegreen linen magenta maroon mediumaquamarine mediumblue mediumorchid mediumpurple mediumseagreen mediumslateblue mediumspringgreen mediumturquoise mediumvioletred midnightblue mintcream mistyrose moccasin navajowhite navy oldlace olive olivedrab orange orangered orchid palegoldenrod palegreen paleturquoise palevioletred papayawhip peachpuff peru pink plum powderblue purple rebeccapurple red rosybrown royalblue saddlebrown salmon sandybrown seagreen seashell sienna silver skyblue slateblue slategray slategrey snow springgreen steelblue tan teal thistle tomato transparent turquoise violet wheat white whitesmoke yellow yellowgreen`.split(
    /\s+/,
  ),
);
function cleanLabel(value: string) {
  return value.trim().replace(/^"([\s\S]*)"$/, "$1");
}

function cleanSequenceText(value: string) {
  const trimmed = value.trim();
  const withoutTerminator = /#(?:\d+|[A-Za-z]+);$/.test(trimmed)
    ? trimmed
    : trimmed.replace(/;$/, "").trimEnd();
  return cleanLabel(withoutTerminator);
}

function cleanControlLabel(value: string) {
  return cleanSequenceText(value).trim();
}

function parseSequenceBackgroundArgs(
  kind: MermaidSequenceBackgroundKind,
  value: string,
) {
  const trimmed = cleanLabel(value);
  if (kind === "rect") {
    return { color: trimmed, label: "" };
  }
  const cssFunction = CSS_FUNCTION_COLOR_RE.exec(trimmed);
  if (cssFunction) {
    return {
      color: cssFunction[1].trim(),
      label: (cssFunction[2] ?? "").trim(),
    };
  }
  const [first = "", ...rest] = trimmed.split(/\s+/);
  const looksLikeNamedColor =
    first.length > 0 && CSS_NAMED_COLORS.has(first.toLowerCase());
  return looksLikeNamedColor
    ? { color: first, label: rest.join(" ").trim() }
    : { color: "", label: trimmed };
}
function normalizeNotePlacement(value: string): MermaidSequenceNotePlacement {
  const placement = value.toLowerCase();
  return placement === "left of" || placement === "right of"
    ? placement
    : "over";
}

function normalizeParticipantConfig(value: string | undefined) {
  return value ? value.replace(/^\s*@\s*/, "@").trim() : "";
}

function parseParticipantConfig(value: string) {
  if (!value) return null;
  const body = value.slice(value.indexOf("{") + 1, value.lastIndexOf("}"));
  // Mermaid's participant metadata is YAML, with flow maps only on one line.
  return (
    readSourceYaml(/[\r\n]/.test(body) ? body : `{${body}}`, 0)?.values ?? null
  );
}
function sequenceText(value: string) {
  const text = cleanSequenceText(value);
  const match = /^:?(wrap|nowrap):/.exec(text);
  const label = (match ? text.slice(match[0].length).trim() : text)
    .replaceAll(/<br\s*\/?>/gi, "\n")
    .replaceAll(/#(\d+);/g, (raw, code: string) => {
      const value = Number(code);
      return value > 0 && value <= 0x10ffff ? String.fromCodePoint(value) : raw;
    });
  return { label, wrap: match ? match[1] === "wrap" : undefined };
}

export function mermaidSequenceParticipantConfigType(value: string) {
  const type = parseParticipantConfig(value)?.type;
  return typeof type === "string" ? type.toLowerCase() : "";
}

function mermaidSequenceParticipantConfigAlias(value: string) {
  const alias = parseParticipantConfig(value)?.alias;
  return typeof alias === "string" ? alias : "";
}

function upsertParticipant(
  participants: Map<string, MermaidSequenceParticipant>,
  id: string,
  partial: Partial<
    Pick<MermaidSequenceParticipant, "config" | "kind" | "label" | "order">
  > = {},
) {
  const existing = participants.get(id);
  if (existing) {
    participants.set(id, {
      ...existing,
      ...partial,
      label: partial.label ?? existing.label,
    });
    return;
  }
  const order = partial.order ?? participants.size;
  const label = partial.label ?? id;
  participants.set(id, {
    sourceKey: `sequence-participant-${id}`,
    type: "participant",
    declared: false,
    declarationKeys: [],
    boxId: null,
    config: partial.config ?? "",
    detailsId: "",
    id,
    kind: partial.kind ?? "participant",
    label,
    links: [],
    order,
    properties: {},
    width: Math.max(120, Math.min(220, 72 + label.length * 8)),
    x: 40 + order * 170,
  });
}

function layoutParticipants(
  participants: Iterable<MermaidSequenceParticipant>,
) {
  return [...participants]
    .sort((a, b) => a.order - b.order)
    .map((participant, index) => ({
      ...participant,
      order: index,
      width: Math.max(120, Math.min(220, 72 + participant.label.length * 8)),
      x: Number.isFinite(participant.x) ? participant.x : 40 + index * 170,
    }));
}

export function parseMermaidSequenceSource(
  source: string,
): MermaidSequenceModel | null {
  return resolveMermaidSequenceSource(source).model;
}

/** One parser owns syntax, scope and the pinned runtime's DB invariants. Open
 * activations are valid; only a deactivation without a matching start fails. */
export function resolveMermaidSequenceSource(
  source: string,
  previous?: MermaidSequenceModel,
  mapping?: ReadonlyMap<number, string>,
  participantKeys?: ReadonlyMap<string, string>,
  primaryBranchKeys?: ReadonlyMap<string, string>,
  commentAnchors?: ReadonlyMap<
    string,
    Pick<SequenceComment, "anchorKind" | "anchorId" | "position">
  >,
) {
  const document = reconcileSequenceSource(
    scanSequenceSource(source),
    previous?.sourceDocument,
    mapping,
  );
  const diagnostics = document.diagnostics;
  const fail = (
    record: SequenceSourceRecord | undefined,
    code: SequenceSourceDiagnostic["code"],
    construct: string,
  ) => {
    diagnostics.push({
      code,
      construct,
      sourceKey: record?.sourceKey,
      line: record?.range.line ?? 1,
      column: record?.indent.length ?? 0,
    });
    if (record) record.kind = "invalid";
    return {
      document,
      diagnostics,
      model: null as MermaidSequenceModel | null,
    };
  };
  if (detectMermaidDiagramType(source) !== "sequenceDiagram")
    return fail(document.records[0], "missing-header", "sequenceDiagram");
  const header = document.records.find((r) =>
    /^\s*sequenceDiagram\s*;?\s*$/i.test(r.raw),
  );
  if (!header)
    return fail(document.records[0], "missing-header", "sequenceDiagram");
  header.kind = "header";
  const participants = new Map<string, MermaidSequenceParticipant>();
  const activations: MermaidSequenceActivation[] = [],
    backgrounds: MermaidSequenceBackground[] = [],
    controls: MermaidSequenceControl[] = [],
    messages: MermaidSequenceMessage[] = [],
    notes: MermaidSequenceNote[] = [];
  const intervals: SequenceActivationInterval[] = [],
    stacks = new Map<string, SequenceActivationInterval[]>();
  const structureStack: Array<
    | { background: MermaidSequenceBackground; kind: "background" }
    | { control: MermaidSequenceControl; kind: "control" }
  > = [];
  let statementOrder = 0,
    accessibilityDescription = "",
    accessibilityTitle = "",
    diagramTitle = "",
    autonumberLine: string | undefined;
  let autonumber = { enabled: false, start: 1, step: 1 };
  let pendingCreate: MermaidSequenceActivation | undefined,
    pendingDestroy: MermaidSequenceActivation | undefined;
  const ensure = (id: string, record: SequenceSourceRecord) => {
    upsertParticipant(participants, id);
    const p = participants.get(id)!;
    if (!p.declared && p.sourceKey === `sequence-participant-${id}`)
      p.sourceKey =
        participantKeys?.get(id) ??
        previous?.participants.find((old) => old.id === id)?.sourceKey ??
        `${record.sourceKey}:participant:${id}`;
    return p;
  };
  const reference = (
    record: SequenceSourceRecord,
    field: string,
    id: string,
    after = 0,
  ) => {
    const next = sequenceRecordValue(record, field, id, after);
    const range = record.values[field];
    if (range) record.references.push({ id, range });
    return next;
  };
  const temporal = (
    record: SequenceSourceRecord,
    kind: SequenceSourceRecord["kind"],
  ) => {
    record.kind = kind;
    record.temporal = true;
    return statementOrder++;
  };
  const activation = (
    record: SequenceSourceRecord,
    participantId: string,
    kind: "activate" | "deactivate",
    order: number,
    embedded = false,
    messageId?: string,
  ) => {
    const stack = stacks.get(participantId) ?? [];
    const id = embedded ? `${record.sourceKey}:activation` : record.sourceKey;
    if (kind === "deactivate" && !stack.length) return false;
    if (kind === "activate") {
      const interval: SequenceActivationInterval = {
        id,
        participantId,
        startId: id,
        depth: stack.length,
      };
      stack.push(interval);
      intervals.push(interval);
    } else stack.pop()!.endId = id;
    stacks.set(participantId, stack);
    activations.push({
      id,
      kind,
      order,
      participantId,
      embedded,
      messageId,
      y: 112 + order * 64,
    });
    return true;
  };
  for (const record of document.records) {
    const line = record.raw,
      trimmed = line.trim();
    const parent = structureStack.at(-1);
    record.parentId =
      parent?.kind === "control"
        ? parent.control.id
        : (parent?.background.id ?? null);
    const branchScope = [...structureStack]
      .reverse()
      .find((item) => item.kind === "control");
    record.branchId =
      branchScope?.kind === "control"
        ? branchScope.control.branches.at(-1)!.id
        : null;
    if (!record.complete)
      return fail(record, "incomplete-record", trimmed.slice(0, 80));
    if (
      ["blank", "comment", "frontmatter", "directive", "header"].includes(
        record.kind,
      )
    )
      continue;
    if (record.range.start < header.range.start)
      return fail(record, "invalid-record", trimmed);
    if (
      parent?.kind === "background" &&
      parent.background.kind === "box" &&
      !PARTICIPANT_RE.test(line) &&
      !DESTROY_PARTICIPANT_RE.test(line) &&
      !CONTROL_END_RE.test(line)
    )
      return fail(record, "invalid-record", `box ${parent.background.label}`);
    if (record.kind === "accessibility-description") {
      accessibilityDescription = trimmed
        .slice(trimmed.indexOf("{") + 1, trimmed.lastIndexOf("}"))
        .trim();
      sequenceRecordValue(record, "label", accessibilityDescription);
      continue;
    }
    const accTitle = ACCESSIBILITY_TITLE_RE.exec(trimmed),
      accDescription = ACCESSIBILITY_DESCRIPTION_RE.exec(trimmed),
      title = TITLE_RE.exec(trimmed);
    if (accTitle || accDescription || title) {
      const value = (accTitle ?? accDescription ?? title)![1]!.trim();
      if (accTitle) {
        record.kind = "accessibility-title";
        accessibilityTitle = value;
      } else if (accDescription) {
        record.kind = "accessibility-description";
        accessibilityDescription = value;
      } else {
        record.kind = "title";
        diagramTitle = value;
      }
      sequenceRecordValue(record, "label", value);
      continue;
    }
    const numbering = AUTONUMBER_RE.exec(line);
    if (numbering) {
      record.kind = "autonumber";
      autonumberLine = numbering[1]!.trim();
      const parts = autonumberLine.split(/\s+/);
      autonumber = {
        enabled: parts[1] !== "off",
        start: parts[1] && parts[1] !== "off" ? Number(parts[1]) : 1,
        step: parts[2] ? Number(parts[2]) : 1,
      };
      continue;
    }
    const declaration = PARTICIPANT_RE.exec(line),
      creation = CREATE_PARTICIPANT_RE.exec(line);
    if (declaration || creation) {
      const [, rawKind, rawId, rawConfig, rawLabel] = (declaration ??
        creation)!;
      const id = rawId!.trim();
      if (creation && participants.has(id!))
        return fail(
          record,
          "lifecycle",
          `create ${id}: duplicate participant ID`,
        );
      const config = normalizeParticipantConfig(rawConfig),
        metadata = config ? parseParticipantConfig(config) : {};
      if (!metadata)
        return fail(record, "invalid-record", `participant ${id}: metadata`);
      const declaredKind =
        rawKind!.toLowerCase() as MermaidSequenceParticipantKind;
      const candidateType = metadata.type ?? declaredKind;
      const type: SequenceParticipantType =
        typeof candidateType === "string" &&
        SEQUENCE_PARTICIPANT_TYPES.includes(
          candidateType as SequenceParticipantType,
        )
          ? (candidateType as SequenceParticipantType)
          : "participant";
      if (!rawLabel && /\bas\s*$/i.test(id))
        return fail(record, "invalid-record", `participant ${id}: alias`);
      const text = sequenceText(
        rawLabel ?? (mermaidSequenceParticipantConfigAlias(config) || id!),
      );
      const p = ensure(id!, record);
      if (
        parent?.kind === "background" &&
        parent.background.kind === "box" &&
        p.boxId &&
        p.boxId !== parent.background.id
      )
        return fail(record, "box-membership", `participant ${id}`);
      if (!p.declared)
        p.sourceKey =
          participantKeys?.get(id!) ??
          previous?.participants.find((old) => old.id === id)?.sourceKey ??
          record.sourceKey;
      Object.assign(p, {
        config,
        kind: declaredKind,
        type,
        label: text.label,
        wrap: text.wrap,
        declared: true,
      });
      p.declarationKeys.push(record.sourceKey);
      record.kind = creation ? "create" : "participant";
      record.ownerId = id;
      let next = reference(
        record,
        "id",
        id!,
        line.indexOf(rawKind!) + rawKind!.length,
      );
      if (rawConfig)
        next = sequenceRecordValue(record, "config", rawConfig.trim(), next);
      if (rawLabel)
        sequenceRecordValue(record, "label", cleanSequenceText(rawLabel), next);
      if (parent?.kind === "background" && parent.background.kind === "box") {
        p.boxId = parent.background.id;
        parent.background.participantIds.push(id!);
      }
      if (creation) {
        const order = temporal(record, "create");
        pendingCreate = {
          id: record.sourceKey,
          kind: "create",
          order,
          participantId: id!,
          y: 112 + order * 64,
        };
        activations.push(pendingCreate);
      }
      continue;
    }
    const destruction = DESTROY_PARTICIPANT_RE.exec(line);
    if (destruction) {
      const id = destruction[1]!.trim();
      record.ownerId = id;
      reference(record, "id", id, line.toLowerCase().indexOf("destroy") + 7);
      const order = temporal(record, "destroy");
      pendingDestroy = {
        id: record.sourceKey,
        kind: "destroy",
        order,
        participantId: id,
        y: 112 + order * 64,
      };
      activations.push(pendingDestroy);
      continue;
    }
    const links = PARTICIPANT_LINKS_RE.exec(line),
      link = PARTICIPANT_LINK_RE.exec(line),
      properties = PARTICIPANT_PROPERTIES_RE.exec(line),
      details = PARTICIPANT_DETAILS_RE.exec(line);
    if (links || link || properties || details) {
      const match = (links ?? link ?? properties ?? details)!,
        id = match[1]!.trim();
      const p = ensure(id, record);
      record.ownerId = id;
      record.kind = properties ? "properties" : details ? "details" : "link";
      reference(
        record,
        "id",
        id,
        line.search(/\S/) + trimmed.split(/\s+/)[0]!.length,
      );
      if (link) {
        const label = sequenceText(link[2]!).label,
          url = link[3]!.trim();
        if (!label || !url) return fail(record, "invalid-record", `link ${id}`);
        p.links.push({ label, url });
        sequenceRecordValue(record, "label", link[2]!);
        sequenceRecordValue(record, "url", link[3]!);
      } else if (details) {
        p.detailsId = sequenceText(details[2]!).label;
        sequenceRecordValue(record, "payload", details[2]!);
      } else {
        const payload = match[2]!;
        sequenceRecordValue(record, "payload", payload);
        // Runtime preserves syntactically valid text even when JSON decoding has
        // no effect. Opaque participant metadata must not lock neighboring edits.
        try {
          const parsed: unknown = JSON.parse(payload);
          if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
            if (properties) Object.assign(p.properties, parsed);
            else
              for (const [label, url] of Object.entries(parsed))
                if (typeof url === "string") p.links.push({ label, url });
          }
        } catch {
          /* Retained by the owning source record. */
        }
      }
      continue;
    }
    const background = BACKGROUND_START_RE.exec(line);
    if (background) {
      const kind =
        background[1]!.toLowerCase() as MermaidSequenceBackgroundKind;
      const args = parseSequenceBackgroundArgs(kind, background[2]!);
      if (kind === "rect" && !args.color)
        return fail(record, "invalid-record", "rect color");
      const text = sequenceText(args.label),
        order =
          kind === "rect"
            ? temporal(record, "rect")
            : ((record.kind = "box"), statementOrder);
      const item: MermaidSequenceBackground = {
        ...args,
        label: text.label,
        wrap: text.wrap,
        id: record.sourceKey,
        kind,
        order,
        startOrder: order,
        endOrder: order,
        parentId: record.parentId ?? undefined,
        participantIds: [],
      };
      sequenceRecordValue(record, "color", args.color);
      sequenceRecordValue(record, "label", args.label);
      backgrounds.push(item);
      structureStack.push({ kind: "background", background: item });
      continue;
    }
    const control = CONTROL_START_RE.exec(line);
    if (control) {
      const kind = control[1]!.toLowerCase() as MermaidSequenceControlKind,
        order = temporal(record, "fragment"),
        label = cleanControlLabel(control[2]!);
      const item: MermaidSequenceControl = {
        id: record.sourceKey,
        kind,
        order,
        startOrder: order,
        endOrder: order,
        label,
        parentId: record.parentId ?? undefined,
        branches: [
          {
            id:
              primaryBranchKeys?.get(record.sourceKey) ??
              previous?.controls.find((c) => c.id === record.sourceKey)
                ?.branches[0]?.id ??
              `${record.sourceKey}:primary`,
            kind: "primary",
            label,
            order: 0,
            startOrder: order,
          },
        ],
      };
      sequenceRecordValue(record, "kind", control[1]!);
      sequenceRecordValue(record, "label", label);
      record.primaryBranchKey = item.branches[0]!.id;
      controls.push(item);
      structureStack.push({ kind: "control", control: item });
      continue;
    }
    const branch = CONTROL_BRANCH_RE.exec(line);
    if (branch) {
      if (parent?.kind !== "control")
        return fail(record, "invalid-branch", branch[1]!);
      const kind = branch[1]!.toLowerCase() as "and" | "else" | "option",
        fragment = parent.control;
      const allowed =
        fragment.kind === "alt"
          ? "else"
          : fragment.kind === "par" || fragment.kind === "par_over"
            ? "and"
            : fragment.kind === "critical"
              ? "option"
              : null;
      if (kind !== allowed)
        return fail(record, "invalid-branch", `${kind} in ${fragment.kind}`);
      const label = cleanControlLabel(branch[2]!),
        order = temporal(record, "branch");
      fragment.branches.push({
        id: record.sourceKey,
        kind,
        label,
        order: fragment.branches.length,
        startOrder: order,
      });
      sequenceRecordValue(record, "kind", branch[1]!);
      sequenceRecordValue(record, "label", label);
      continue;
    }
    if (CONTROL_END_RE.test(line)) {
      const ended = structureStack.pop();
      if (!ended) return fail(record, "invalid-record", "end without opener");
      const item = ended.kind === "control" ? ended.control : ended.background;
      record.kind = "end";
      record.blockKey = item.id;
      document.records.find((r) => r.sourceKey === item.id)!.closeKey =
        record.sourceKey;
      item.endOrder =
        ended.kind === "background" && item.kind === "box"
          ? statementOrder
          : temporal(record, "end");
      continue;
    }
    const note = NOTE_RE.exec(line);
    if (note) {
      const ids = note[2]!
          .split(",")
          .map((id) => id.trim())
          .filter(Boolean),
        placement = normalizeNotePlacement(note[1]!);
      if (
        !ids.length ||
        ids.length > 2 ||
        (placement !== "over" && ids.length !== 1)
      )
        return fail(record, "invalid-record", "Note anchors");
      let after =
        line.toLowerCase().indexOf(note[1]!.toLowerCase()) + note[1]!.length;
      for (const [i, id] of ids.entries()) {
        ensure(id, record);
        after = reference(record, `anchor-${i}`, id, after);
      }
      const order = temporal(record, "note"),
        text = sequenceText(note[3]!);
      sequenceRecordValue(record, "label", cleanSequenceText(note[3]!), after);
      notes.push({
        id: record.sourceKey,
        ...text,
        order,
        participantIds: ids,
        placement,
        x: 40,
        y: 112 + order * 64,
      });
      continue;
    }
    const active = ACTIVATION_RE.exec(line);
    if (active) {
      const id = active[2]!.trim(),
        kind = active[1]!.toLowerCase() as "activate" | "deactivate";
      reference(
        record,
        "id",
        id,
        line.toLowerCase().indexOf(kind) + kind.length,
      );
      record.ownerId = id;
      const order = temporal(record, "activation");
      if (!activation(record, id, kind, order))
        return fail(record, "activation-balance", `deactivate ${id}`);
      continue;
    }
    const message = sequenceSignal(line);
    if (message) {
      const [
        ,
        rawFrom,
        centralFrom,
        token,
        marker,
        centralTo,
        rawTo,
        rawLabel,
      ] = message.groups;
      const fromEndpoint = sequenceEndpoint(rawFrom!),
        toEndpoint = sequenceEndpoint(rawTo!);
      if (!fromEndpoint || !toEndpoint)
        return fail(record, "invalid-record", "message endpoint");
      const from = fromEndpoint.id,
        to = toEndpoint.id;
      if (
        !isMermaidSequenceMessageArrow(token) ||
        (marker && (centralFrom || centralTo))
      )
        return fail(
          record,
          "invalid-record",
          "message arrow/activation combination",
        );
      if (pendingCreate && pendingCreate.participantId !== to)
        return fail(
          record,
          "lifecycle",
          `create ${pendingCreate.participantId}: next message must target it`,
        );
      else if (
        !pendingCreate &&
        pendingDestroy &&
        ![from, to].includes(pendingDestroy.participantId)
      )
        return fail(
          record,
          "lifecycle",
          `destroy ${pendingDestroy.participantId}: next message must use it`,
        );
      for (const endpoint of [fromEndpoint, toEndpoint]) {
        const p = ensure(endpoint.id, record);
        if (endpoint.metadata) {
          const type = endpoint.metadata.type ?? p.type;
          if (!p.declared || endpoint.metadata.alias) {
            p.type =
              typeof type === "string" &&
              SEQUENCE_PARTICIPANT_TYPES.includes(
                type as SequenceParticipantType,
              )
                ? (type as SequenceParticipantType)
                : "participant";
            p.config = endpoint.config;
            if (typeof endpoint.metadata.alias === "string")
              p.label = sequenceText(endpoint.metadata.alias).label;
          }
        }
      }
      const order = temporal(record, "message"),
        text = sequenceText(rawLabel!);
      const item: MermaidSequenceMessage = {
        id: record.sourceKey,
        arrow: token,
        activation: marker as "+" | "-" | undefined,
        centralFrom: Boolean(centralFrom),
        centralTo: Boolean(centralTo),
        from,
        to,
        ...text,
        order,
        y: 112 + order * 64,
      };
      messages.push(item);
      reference(record, "from", from);
      const arrowEnd = sequenceRecordValue(
        record,
        "arrow",
        token,
        message.arrowOffset,
      );
      if (centralFrom) {
        const at = record.raw
          .slice(0, record.values.arrow!.start - record.range.start)
          .lastIndexOf("()");
        sequenceRecordValue(record, "centralFrom", "()", at);
      }
      if (marker) sequenceRecordValue(record, "activation", marker, arrowEnd);
      if (centralTo) sequenceRecordValue(record, "centralTo", "()", arrowEnd);
      const toEnd = reference(record, "to", to, arrowEnd);
      sequenceRecordValue(
        record,
        "label",
        cleanSequenceText(rawLabel!),
        rawTo?.includes("@{")
          ? record.raw.indexOf(rawTo, toEnd - to.length) + rawTo.length
          : toEnd,
      );
      if (pendingCreate) {
        pendingCreate.messageId = item.id;
        participants.get(to)!.createdBy = item.id;
        pendingCreate = undefined;
      } else if (pendingDestroy) {
        pendingDestroy.messageId = item.id;
        participants.get(pendingDestroy.participantId)!.destroyedBy = item.id;
        pendingDestroy = undefined;
      }
      if (
        marker &&
        !activation(
          record,
          marker === "+" ? to : from,
          marker === "+" ? "activate" : "deactivate",
          order,
          true,
          item.id,
        )
      )
        return fail(
          record,
          "activation-balance",
          `message deactivates ${from}`,
        );
      continue;
    }
    return fail(record, "invalid-record", trimmed.slice(0, 100));
  }
  if (structureStack.length) {
    const scope = structureStack.at(-1)!,
      item = scope.kind === "control" ? scope.control : scope.background;
    return fail(
      document.records.find((r) => r.sourceKey === item.id),
      "unclosed-fragment",
      `${item.kind} ${item.label}: end`,
    );
  }
  const comments: SequenceComment[] = document.records
    .filter((r) => r.kind === "comment")
    .map((r) => {
      const index = document.records.indexOf(r),
        prev = document.records
          .slice(0, index)
          .findLast((n) => !["comment", "blank"].includes(n.kind)),
        next = document.records
          .slice(index + 1)
          .find((n) => !["comment", "blank"].includes(n.kind));
      const old =
        commentAnchors?.get(r.sourceKey) ??
        previous?.commentRecords.find((c) => c.id === r.sourceKey);
      const allKeys = new Set(
        [
          ...document.records.map((n) => n.sourceKey),
          ...participants.values(),
          ...activations.map((a) => a.id),
          ...controls.flatMap((c) => c.branches.map((b) => b.id)),
        ].map((n) => (typeof n === "string" ? n : n.sourceKey)),
      );
      if (old && (!old.anchorId || allKeys.has(old.anchorId))) {
        const participant =
          old.anchorKind === "participant"
            ? [...participants.values()].find(
                (p) => p.sourceKey === old.anchorId,
              )
            : undefined;
        const active =
          old.anchorKind === "activation"
            ? activations.find((a) => a.id === old.anchorId)
            : undefined;
        const fragment =
          old.anchorKind === "branch"
            ? controls.find((c) =>
                c.branches.some((b) => b.id === old.anchorId),
              )
            : undefined;
        const branch = fragment?.branches.find((b) => b.id === old.anchorId);
        const ownerKey =
          active?.messageId ??
          active?.id ??
          (branch?.kind === "primary" ? fragment!.id : branch?.id) ??
          old.anchorId;
        const adjacent = [prev, next]
          .filter((n) => Boolean(n))
          .some(
            (n) =>
              n!.sourceKey === ownerKey ||
              (participant &&
                n!.references.some((ref) => ref.id === participant.id)),
          );
        const inside =
          old.position === "inside" &&
          (r.parentId === ownerKey || r.branchId === old.anchorId);
        // Persisted anchor hints are semantic bindings, not authority to attach
        // a comment to an unrelated statement after a Source edit.
        if (old.anchorKind === "diagram" ? !r.parentId : adjacent || inside)
          return {
            ...old,
            id: r.sourceKey,
            text: r.raw.trim().replace(/^(?:%+|#)\s?/, ""),
          };
      }
      const inline = prev?.range.line === r.range.line ? prev : undefined;
      const separated = document.records[index + 1]?.kind === "blank";
      const owner =
        inline ??
        (!separated &&
        next?.parentId === r.parentId &&
        next?.branchId === r.branchId &&
        next.kind !== "end"
          ? next
          : separated && prev?.parentId === r.parentId
            ? prev
            : undefined);
      const diagram =
        r.range.start < header.range.start ||
        owner?.kind === "header" ||
        (!r.parentId &&
          (!owner ||
            [
              "box",
              "frontmatter",
              "directive",
              "title",
              "accessibility-title",
              "accessibility-description",
              "autonumber",
            ].includes(owner.kind)));
      const kind = diagram
        ? "diagram"
        : owner?.kind === "participant" || owner?.kind === "create"
          ? "participant"
          : owner?.kind === "message"
            ? "message"
            : owner?.kind === "activation" || owner?.kind === "destroy"
              ? "activation"
              : owner?.kind === "note"
                ? "note"
                : owner?.kind === "fragment"
                  ? "fragment"
                  : owner?.kind === "branch"
                    ? "branch"
                    : owner
                      ? "record"
                      : r.branchId
                        ? "branch"
                        : r.parentId
                          ? "fragment"
                          : "diagram";
      const anchor =
        kind === "diagram"
          ? undefined
          : kind === "participant"
            ? participants.get(owner!.ownerId!)?.sourceKey
            : kind === "branch" && owner?.kind === "fragment"
              ? `${owner.sourceKey}:primary`
              : (owner?.sourceKey ?? r.branchId ?? r.parentId ?? undefined);
      const position =
        kind === "diagram"
          ? "before"
          : (inline || separated) && ["fragment", "branch"].includes(kind)
            ? "inside"
            : inline || (separated && owner)
              ? "after"
              : owner
                ? "before"
                : r.parentId
                  ? "inside"
                  : "before";
      return {
        id: r.sourceKey,
        text: r.raw.trim().replace(/^(?:%+|#)\s?/, ""),
        anchorKind: kind,
        anchorId: anchor,
        position,
      } as SequenceComment;
    });
  const model: MermaidSequenceModel = {
    sourceDocument: document,
    commentRecords: comments,
    activationIntervals: intervals,
    autonumber,
    accessibilityDescription,
    accessibilityTitle,
    activations,
    autonumberLine,
    backgrounds,
    controls,
    diagramType: "sequenceDiagram",
    diagramTitle,
    directives: document.records
      .filter((r) => r.kind === "frontmatter" || r.kind === "directive")
      .flatMap((r) => r.raw.split(/\r\n|\r|\n/)),
    headerLine: header.raw.trim(),
    messages,
    notes,
    participants: layoutParticipants(participants.values()),
    passthroughLines: comments.map((c) => `%% ${c.text}`),
    sourceHash: hashMermaidSource(source),
    version: 1,
  };
  return { document, diagnostics, model: model as MermaidSequenceModel | null };
}
