// SPDX-License-Identifier: AGPL-3.0-or-later
import { hashMermaidSource } from "../../utils.js";
import type {
  MermaidBlockDirection,
  MermaidBlockNodeSyntax,
  MermaidBlockShape,
} from "./model.js";
import {
  BLOCK_NODE_OPEN_TOKENS,
  BLOCK_NODE_CLOSE_TOKENS,
  SHAPE_SYNTAX,
} from "./config.js";

function cleanLabel(value: string) {
  const trimmed = value.trim();
  if (trimmed.startsWith('"`') && trimmed.endsWith('`"')) {
    return trimmed
      .slice(2, -2)
      .replaceAll("#quot;", '"')
      .replaceAll("&quot;", '"');
  }
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    return trimmed
      .slice(1, -1)
      .replaceAll("#quot;", '"')
      .replaceAll("&quot;", '"');
  }
  return trimmed.replaceAll("#quot;", '"').replaceAll("&quot;", '"');
}

function parseBlockQuotedLabelAt(
  input: string,
  offset: number,
  allowEmpty = true,
) {
  if (input.startsWith('"`', offset)) {
    const end = input.indexOf('`"', offset + 2);
    if (end < 0 || (!allowEmpty && end === offset + 2)) return null;
    const source = input.slice(offset, end + 2);
    return { consumed: source.length, label: cleanLabel(source) };
  }
  if (input[offset] !== '"') return null;
  const end = input.indexOf('"', offset + 1);
  if (end < 0 || (!allowEmpty && end === offset + 1)) return null;
  const source = input.slice(offset, end + 1);
  return { consumed: source.length, label: cleanLabel(source) };
}

function normalizeSpan(value: string | undefined) {
  return value === undefined ? 1 : Math.max(0, Number(value) || 0);
}

function parseBlockArrow(rest: string): {
  consumed: number;
  directions: MermaidBlockDirection[];
  label: string;
} | null {
  if (!rest.startsWith("<[")) return null;
  const parsedLabel = parseBlockQuotedLabelAt(rest, 2, false);
  if (!parsedLabel) return null;
  const labelEnd = 2 + parsedLabel.consumed;
  if (!rest.startsWith("]>", labelEnd)) return null;
  const label = parsedLabel.label;
  const directionGap = /^\s*/.exec(rest.slice(labelEnd + 2))?.[0].length ?? 0;
  const directionStart = labelEnd + 2 + directionGap;
  if (rest[directionStart] !== "(") return null;
  const directionEnd = rest.indexOf(")", directionStart + 1);
  if (directionEnd < 0) return null;
  const directionSource = rest.slice(directionStart + 1, directionEnd);
  const directions: MermaidBlockDirection[] = [];
  let directionCursor = 0;
  while (directionCursor < directionSource.length) {
    const direction = /^\s*,?\s*(right|left|x|y|up|down)\s*/.exec(
      directionSource.slice(directionCursor),
    );
    if (!direction) return null;
    directions.push(direction[1] as MermaidBlockDirection);
    directionCursor += direction[0].length;
  }
  if (!directions.length) return null;
  return { consumed: directionEnd + 1, directions, label };
}

export function readBlockNodeAt(
  input: string,
  offset: number,
): {
  consumed: number;
  directions: MermaidBlockDirection[];
  id: string;
  label: string;
  shape: MermaidBlockShape;
  sourceClose: string;
  sourceOpen: string;
  span: number;
  syntax: MermaidBlockNodeSyntax;
} | null {
  const leading = input.slice(offset).match(/^\s*/)?.[0].length ?? 0;
  const start = offset + leading;
  const idMatch = /^[^([\n\-){}\s<>:=]+/.exec(input.slice(start));
  if (!idMatch) return null;
  const id = idMatch[0];
  let cursor = start + id.length;
  let directions: MermaidBlockDirection[] = [];
  let label = id;
  let shape: MermaidBlockShape = "rect";
  let sourceClose = "";
  let sourceOpen = "";
  let syntax: MermaidBlockNodeSyntax = "bare";

  const shapeWhitespace = input.slice(cursor).match(/^\s*/)?.[0].length ?? 0;
  const shapeStart = cursor + shapeWhitespace;
  const arrow = parseBlockArrow(input.slice(shapeStart));
  if (arrow) {
    cursor = shapeStart + arrow.consumed;
    directions = arrow.directions;
    label = arrow.label;
    shape = "odd";
    sourceClose = "]>";
    sourceOpen = "<[";
    syntax = "block-arrow";
  } else {
    const open = BLOCK_NODE_OPEN_TOKENS.find((candidate) =>
      input.startsWith(candidate, shapeStart),
    );
    if (open) {
      const parsedLabel = parseBlockQuotedLabelAt(
        input,
        shapeStart + open.length,
        false,
      );
      if (!parsedLabel) return null;
      const closeStart = shapeStart + open.length + parsedLabel.consumed;
      const close = BLOCK_NODE_CLOSE_TOKENS.find((candidate) =>
        input.startsWith(candidate, closeStart),
      );
      if (!close) return null;
      const known = SHAPE_SYNTAX.find(
        (candidate) => candidate.open === open && candidate.close === close,
      );
      label = parsedLabel.label;
      shape = known?.shape ?? "rect";
      sourceClose = close;
      sourceOpen = open;
      syntax = known?.syntax ?? "custom";
      cursor = closeStart + close.length;
    }
  }

  const spanMatch = /^\s*:(\d+)/.exec(input.slice(cursor));
  const span = normalizeSpan(spanMatch?.[1]);
  if (spanMatch) cursor += spanMatch[0].length;
  return {
    consumed: cursor - offset,
    directions,
    id,
    label,
    shape,
    sourceClose,
    sourceOpen,
    span,
    syntax,
  };
}

export function readBlockConnectionAt(rest: string) {
  const direct =
    /^\s*([xo<]?(?:--+[-xo>]|==+[=xo>]|-?\.+-[xo>]?)|~~~+)\s*/.exec(rest);
  if (direct) {
    return { connector: direct[1], consumed: direct[0].length, label: "" };
  }
  const start = /^\s*([xo<]?)(--|==|-\.)\s*/.exec(rest);
  if (!start) return null;
  const parsedLabel = parseBlockQuotedLabelAt(rest, start[0].length);
  if (!parsedLabel) return null;
  const finalOffset = start[0].length + parsedLabel.consumed;
  const final =
    /^\s*([xo<]?--+[-xo>]|[xo<]?==+[=xo>]|[xo<]?-?\.+-[xo>]?)\s*/.exec(
      rest.slice(finalOffset),
    );
  if (!final) return null;
  return {
    connector: final[1],
    consumed: finalOffset + final[0].length,
    label: parsedLabel.label,
  };
}

export function splitBlockComment(line: string) {
  let quote = "";
  for (let index = 0; index < line.length - 1; index += 1) {
    const char = line[index];
    if (quote) {
      if (char === "\\") index += 1;
      else if (char === quote) quote = "";
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (char === "%" && line[index + 1] === "%") {
      return {
        annotation: line.slice(index + 2).trim(),
        hasComment: true,
        syntax: line.slice(0, index).trimEnd(),
      };
    }
  }
  return { annotation: "", hasComment: false, syntax: line };
}

export type BlockRange = { start: number; end: number; line: number };
export type BlockSourceRecord = {
  sourceKey: string;
  kind:
    | "statement"
    | "header"
    | "block"
    | "composite"
    | "end"
    | "columns"
    | "space"
    | "connection"
    | "classDef"
    | "class"
    | "style"
    | "comment"
    | "blank"
    | "frontmatter"
    | "directive"
    | "invalid";
  raw: string;
  range: BlockRange;
  indent: string;
  eol: string;
  complete: boolean;
  parentKey: string | null;
  parentId: string;
  order: number;
  closeKey?: string;
  endpoints?: Array<
    NonNullable<ReturnType<typeof readBlockNodeAt>> & {
      role: "block" | "from" | "to";
      range: BlockRange;
      values: Record<string, BlockRange>;
      labelForm: "bare" | "quoted" | "markdown";
    }
  >;
  chained?: boolean;
  connector?: {
    token: string;
    label: string;
    startToken?: string;
    labelSource: string;
  };

  values: Record<string, BlockRange>;
  references: Array<{ id: string; range: BlockRange }>;
};
export type BlockSourceDocument = {
  source: string;
  newline: string;
  records: BlockSourceRecord[];
  diagnostics: import("./diagnostics.js").BlockDiagnostic[];
};

export function nextBlockSourceKey() {
  return `block-source-${crypto.randomUUID()}`;
}

/** Block statements are token-delimited. A semicolon remains an ID character;
 * each occurrence and every interstitial byte retain their own owning record. */
export function scanBlockSource(source: string): BlockSourceDocument {
  const document: BlockSourceDocument = {
    source,
    newline: /\r\n|\r|\n/.exec(source)?.[0] ?? "\n",
    records: [],
    diagnostics: [],
  };
  let cursor = 0,
    line = 1,
    header = false;
  const stack: BlockSourceRecord[] = [];
  const counts = new Map<string, number>();
  const issue = (
    record: BlockSourceRecord,
    code: import("./diagnostics.js").BlockDiagnostic["code"],
    construct = record.raw.trim(),
  ) => {
    document.diagnostics.push({
      stage: "syntax",
      code,
      range: record.range,
      sourceKey: record.sourceKey,
      scope: record.parentKey ?? undefined,
      construct,
    });
  };
  const push = (
    kind: BlockSourceRecord["kind"],
    end: number,
    complete = true,
  ) => {
    const raw = source.slice(cursor, end),
      eol = /^(?:\r\n|\r|\n)/.exec(source.slice(end))?.[0] ?? "";
    const parent = stack.at(-1),
      parentKey = parent?.sourceKey ?? null;
    const order = counts.get(parentKey ?? "") ?? 0;
    counts.set(parentKey ?? "", order + 1);
    const record: BlockSourceRecord = {
      sourceKey: `block-record-${cursor}-${hashMermaidSource(raw)}`,
      kind,
      raw,
      range: { start: cursor, end, line },
      indent: /^[ \t]*/.exec(raw)![0],
      eol,
      complete,
      parentKey,
      parentId: parent?.endpoints?.[0]?.id ?? "",
      order,
      values: {},
      references: [],
    };
    document.records.push(record);
    cursor = end + eol.length;
    line += (raw.match(/\r\n|\r|\n/g)?.length ?? 0) + (eol ? 1 : 0);
    return record;
  };
  const valueRange = (start: number, end: number): BlockRange => ({
    start,
    end,
    line:
      line + (source.slice(cursor, start).match(/\r\n|\r|\n/g)?.length ?? 0),
  });
  const endpoint = (start: number, role: "block" | "from" | "to") => {
    // Match the keyword precedence of the pinned lexer before its NODE_ID rule.
    const text = source.slice(start).trimStart();
    if (
      /^(?:block-beta|block|space|end|default|linkStyle|interpolate|columns)\b/.test(
        text,
      ) ||
      /^(?:classDef|class|style)\s+/.test(text) ||
      /^acc(?:Title|Descr)\s*[:{]/.test(text)
    )
      return null;
    const node = readBlockNodeAt(source, start);
    if (!node || text.startsWith('"')) return null;
    const leading = /^\s*/.exec(source.slice(start))![0].length,
      idStart = start + leading;
    const raw = source.slice(idStart, start + node.consumed);
    const values: Record<string, BlockRange> = {
      id: valueRange(idStart, idStart + node.id.length),
    };
    const quote = raw.indexOf('"', node.id.length);
    let labelForm: "bare" | "quoted" | "markdown" = "bare";
    if (quote >= 0) {
      const markdown = raw[quote + 1] === "`";
      labelForm = markdown ? "markdown" : "quoted";
      const labelStart = idStart + quote + (markdown ? 2 : 1);
      const close = source.indexOf(markdown ? '`"' : '"', labelStart);
      values.label = valueRange(labelStart, close);
      values.labelToken = valueRange(
        idStart + quote,
        close + (markdown ? 2 : 1),
      );
      values.shape = valueRange(
        idStart + node.id.length,
        start + node.consumed - (/\s*:\d+$/.exec(raw)?.[0].length ?? 0),
      );
    }
    const span = /:(\d+)$/.exec(raw);
    if (span)
      values.span = valueRange(idStart + span.index + 1, idStart + raw.length);
    if (node.syntax === "block-arrow") {
      const directions = /\(([^)]*)\)\s*(?::\d+)?$/.exec(raw)!;
      const directionStart = idStart + directions.index + 1;
      values.directions = valueRange(
        directionStart,
        directionStart + directions[1]!.length,
      );
    }
    return {
      ...node,
      role,
      labelForm,
      values,
      range: valueRange(idStart, start + node.consumed),
    };
  };
  while (cursor < source.length) {
    const tail = source.slice(cursor),
      indent = /^[ \t]*/.exec(tail)![0].length,
      start = cursor + indent,
      text = source.slice(start);
    const breakAt = tail.search(/[\r\n]/),
      lineEnd = cursor + (breakAt < 0 ? tail.length : breakAt);
    if (!source.slice(cursor, lineEnd).trim()) {
      push("blank", lineEnd);
      continue;
    }
    if (!header && /^---[ \t]*(?:\r\n|\r|\n)/.test(text)) {
      const close = /(?:\r\n|\r|\n)[ \t]*---[ \t]*(?=\r\n|\r|\n|$)/.exec(
        source.slice(start + 3),
      );
      const record = push(
        "frontmatter",
        close ? start + 3 + close.index + close[0].length : source.length,
        Boolean(close),
      );
      if (!record.complete) issue(record, "incomplete-record");
      continue;
    }
    if (text.startsWith("%%{")) {
      const end = source.indexOf("}%%", start + 3),
        record = push("directive", end < 0 ? source.length : end + 3, end >= 0);
      if (!record.complete) issue(record, "incomplete-record");
      continue;
    }
    if (text.startsWith("%%") || (!header && text.startsWith("#"))) {
      push("comment", lineEnd);
      continue;
    }
    if (!header) {
      const match = /^(block-beta|block)\b(?!:)/.exec(text);
      const record = push(
        match ? "header" : "invalid",
        match ? start + match[0].length : lineEnd,
      );
      if (!match) issue(record, "missing-header");
      else header = true;
      continue;
    }
    const columns = /^columns\s+(auto\b|\d+)/.exec(text);
    if (columns) {
      const range = valueRange(
          start + columns[0].length - columns[1]!.length,
          start + columns[0].length,
        ),
        r = push("columns", start + columns[0].length);
      r.values.columns = range;
      continue;
    }
    const space = /^space(?::(\d+)|\b)/.exec(text);
    if (space) {
      const range =
        space[1] !== undefined
          ? valueRange(
              start + space[0].length - space[1].length,
              start + space[0].length,
            )
          : undefined;
      const r = push("space", start + space[0].length);
      if (range) r.values.span = range;
      continue;
    }
    if (/^end\b/.test(text)) {
      const open = stack.pop(),
        r = push("end", start + 3);
      if (!open) issue(r, "unexpected-end");
      else {
        r.parentKey = open.sourceKey;
        r.parentId = open.endpoints?.[0]?.id ?? "";
        open.closeKey = r.sourceKey;
      }
      continue;
    }
    if (/^block(?::|\b)/.test(text)) {
      const explicit = text.startsWith("block:"),
        node = explicit ? endpoint(start + 6, "block") : null;
      const r = push(
        node || !explicit ? "composite" : "invalid",
        node ? start + 6 + node.consumed : explicit ? lineEnd : start + 5,
      );
      if (node) {
        r.endpoints = [node];
        r.references = [{ id: node.id, range: node.values.id! }];
      }
      if (r.kind === "invalid") issue(r, "invalid-record");
      else stack.push(r);
      continue;
    }
    const style = /^(classDef|class|style)\s+/.exec(text);
    if (style) {
      const kind = style[1] as "classDef" | "class" | "style";
      const targetStart = start + style[0].length;
      const body = source.slice(targetStart);
      const target =
        kind === "classDef"
          ? /^\w+(?=\s)/.exec(body)
          : /^\w+(?:,\s*\w+)*/.exec(body);
      const targetEnd = targetStart + (target?.[0].length ?? 0);
      // CLASSDEF_ID consumes all following whitespace, including physical
      // line breaks. Its next line can therefore be CSS, not a new node.
      const gap =
        kind === "classDef"
          ? /^\s*/.exec(source.slice(targetEnd))![0].length
          : /^[ \t]*/.exec(source.slice(targetEnd))![0].length;
      let valueStart = targetEnd + gap;
      const nestedComments: Array<{ start: number; end: number; eol: string }> =
        [];
      if (kind === "classDef")
        while (
          source.startsWith("%%", valueStart) &&
          !source.startsWith("%%{", valueStart)
        ) {
          const breakAt = source.slice(valueStart).search(/[\r\n]/),
            end = breakAt < 0 ? source.length : valueStart + breakAt;
          const eol = /^(?:\r\n|\r|\n)/.exec(source.slice(end))?.[0] ?? "";
          nestedComments.push({ start: valueStart, end, eol });
          valueStart =
            end +
            eol.length +
            /^\s*/.exec(source.slice(end + eol.length))![0].length;
        }
      const styleBreak = source.slice(valueStart).search(/[\r\n]/);
      const effectiveEnd =
        styleBreak < 0 ? source.length : valueStart + styleBreak;
      const styleEnd =
        valueStart +
        splitBlockComment(source.slice(valueStart, effectiveEnd)).syntax.length;
      const ranges = {
        targets: valueRange(targetStart, targetEnd),
        value: valueRange(Math.min(valueStart, styleEnd), styleEnd),
      };
      const r = push(target ? kind : "invalid", styleEnd);
      r.values = ranges;
      for (const [index, comment] of nestedComments.entries()) {
        const raw = source.slice(comment.start, comment.end);
        document.records.push({
          sourceKey: `block-record-${comment.start}-${hashMermaidSource(raw)}`,
          kind: "comment",
          raw,
          range: {
            start: comment.start,
            end: comment.end,
            line:
              1 +
              (source.slice(0, comment.start).match(/\r\n|\r|\n/g)?.length ??
                0),
          },
          indent: "",
          eol: comment.eol,
          complete: true,
          parentKey: r.parentKey,
          parentId: r.parentId,
          order: r.order + (index + 1) / 1000,
          values: {},
          references: [],
        });
      }
      if (!target) issue(r, "invalid-record");
      else if (kind !== "classDef") {
        for (const match of target[0].matchAll(/\w+/g))
          r.references.push({
            id: match[0],
            range: {
              start: targetStart + match.index,
              end: targetStart + match.index + match[0].length,
              line: r.range.line,
            },
          });
      }
      continue;
    }
    const first = endpoint(start, "block");
    if (!first) {
      const r = push("invalid", lineEnd);
      issue(r, "invalid-record");
      continue;
    }
    const next = start + first.consumed,
      connection = readBlockConnectionAt(source.slice(next));
    if (connection) {
      first.role = "from";
      const endpoints = [first];
      let current = connection,
        connectorStart = next,
        targetStart = next + connection.consumed;
      let lastTarget: ReturnType<typeof endpoint> = null;
      let targetEnd = targetStart;
      let invalidSpan = false;
      while (true) {
        const target = endpoint(targetStart, "to");
        if (!target) break;
        endpoints.push(target);
        lastTarget = target;
        invalidSpan ||= Boolean(target.values.span);
        targetEnd = targetStart + target.consumed;
        const following = readBlockConnectionAt(source.slice(targetEnd));
        if (!following) break;
        current = following;
        connectorStart = targetEnd;
        targetStart = targetEnd + following.consumed;
        lastTarget = null;
      }
      const connectorSource = source.slice(connectorStart, targetStart).trim();
      const quoted = connectorSource.indexOf('"'),
        labelToken =
          quoted < 0
            ? ""
            : connectorSource.slice(
                quoted,
                connectorSource.lastIndexOf('"') + 1,
              );
      const tokenEnd =
        targetStart -
        /\s*$/.exec(source.slice(connectorStart, targetStart))![0].length;
      const tokenStart = tokenEnd - current.connector.length;
      const startToken =
        quoted < 0 ? undefined : connectorSource.slice(0, quoted).trim();
      const labelOffset =
        connectorStart +
        source.slice(connectorStart, targetStart).indexOf(labelToken);
      const values = {
        connector: valueRange(tokenStart, tokenEnd),
        label:
          quoted < 0
            ? undefined
            : valueRange(
                labelOffset + (labelToken.startsWith('"`') ? 2 : 1),
                labelOffset +
                  labelToken.length -
                  (labelToken.endsWith('`"') ? 2 : 1),
              ),
        fromExpression: valueRange(first.range.start, connectorStart),
      };
      const r = push(
        lastTarget ? "connection" : "invalid",
        lastTarget ? targetEnd : lineEnd,
      );
      r.endpoints = endpoints;
      r.chained = endpoints.length > 2;
      r.references = endpoints.map((e) => ({ id: e.id, range: e.values.id! }));
      r.values.connector = values.connector;
      r.values.fromExpression = values.fromExpression;
      if (values.label) r.values.label = values.label;
      r.connector = {
        token: current.connector,
        label: current.label,
        startToken,
        labelSource: labelToken,
      };
      if (!lastTarget || invalidSpan) issue(r, "invalid-connection");
      if (
        endpoints.some((e) => e.labelForm === "markdown") ||
        labelToken.startsWith('"`')
      )
        issue(r, "invalid-record", "Markdown label");
      continue;
    }
    const r = push("block", start + first.consumed);
    r.endpoints = [first];
    r.references = [{ id: first.id, range: first.values.id! }];
    if (first.labelForm === "markdown")
      issue(r, "invalid-record", "Markdown label");
  }
  if (!header)
    document.diagnostics.push({
      stage: "syntax",
      code: "missing-header",
      range: { start: 0, end: 0, line: 1 },
      construct: "block-beta",
    });
  for (const r of stack)
    issue(r, "unclosed-composite", r.endpoints?.[0]?.id ?? "block");
  const hasBody = (key: string | null) =>
    document.records.some(
      (r) =>
        r.parentKey === key &&
        [
          "columns",
          "block",
          "composite",
          "space",
          "connection",
          "classDef",
          "class",
          "style",
        ].includes(r.kind),
    );
  if (header && !hasBody(null)) {
    const r = document.records.find((r) => r.kind === "header")!;
    issue(r, "empty-body", r.raw.trim());
  }
  for (const r of document.records.filter(
    (r) => r.kind === "composite" && r.closeKey,
  ))
    if (!hasBody(r.sourceKey))
      issue(r, "empty-composite", r.endpoints?.[0]?.id ?? "block");
  document.records.sort((a, b) => a.range.start - b.range.start);
  return document;
}

export function reconcileBlockSource(
  document: BlockSourceDocument,
  previous?: BlockSourceDocument,
  mapping?: ReadonlyMap<number, string>,
) {
  if (!previous && !mapping) return document;
  const reserved = new Set(mapping?.values()),
    matches = new Map<number, string>();
  const exact = new Map<string, BlockSourceRecord[]>(),
    incoming = new Map<string, BlockSourceRecord[]>();
  const signature = (r: BlockSourceRecord) => r.raw;
  for (const r of previous?.records ?? []) {
    if (reserved.has(r.sourceKey)) continue;
    const group = exact.get(signature(r)) ?? [];
    group.push(r);
    exact.set(signature(r), group);
  }
  for (const r of document.records) {
    if (mapping?.has(r.range.start)) continue;
    const group = incoming.get(signature(r)) ?? [];
    group.push(r);
    incoming.set(signature(r), group);
  }
  for (const [key, group] of incoming) {
    const old = exact.get(key);
    if (group.length === 1 && old?.length === 1) {
      matches.set(group[0]!.range.start, old[0]!.sourceKey);
      reserved.add(old[0]!.sourceKey);
    }
  }
  let prefix = 0,
    suffix = 0;
  if (previous) {
    const limit = Math.min(document.source.length, previous.source.length);
    while (
      prefix < limit &&
      document.source[prefix] === previous.source[prefix]
    )
      prefix++;
    while (
      suffix < limit - prefix &&
      document.source[document.source.length - suffix - 1] ===
        previous.source[previous.source.length - suffix - 1]
    )
      suffix++;
    const delta = document.source.length - previous.source.length;
    for (const r of document.records) {
      if (mapping?.has(r.range.start) || matches.has(r.range.start)) continue;
      const candidates = (exact.get(signature(r)) ?? []).filter(
        (old) =>
          !reserved.has(old.sourceKey) &&
          (old.range.end <= prefix
            ? old.range.start
            : old.range.start >= previous.source.length - suffix
              ? old.range.start + delta
              : undefined) === r.range.start,
      );
      if (candidates.length === 1) {
        matches.set(r.range.start, candidates[0]!.sourceKey);
        reserved.add(candidates[0]!.sourceKey);
      }
    }
  }
  const used = new Set<string>();
  const remapped = new Map<string, string>();
  for (const r of document.records) {
    const key = mapping?.get(r.range.start) ?? matches.get(r.range.start);
    if (key && !used.has(key)) {
      remapped.set(r.sourceKey, key);
      r.sourceKey = key;
      used.add(key);
    }
  }
  for (const record of document.records) {
    if (record.parentKey)
      record.parentKey = remapped.get(record.parentKey) ?? record.parentKey;
    if (record.closeKey)
      record.closeKey = remapped.get(record.closeKey) ?? record.closeKey;
  }
  for (const diagnostic of document.diagnostics) {
    if (diagnostic.scope)
      diagnostic.scope = remapped.get(diagnostic.scope) ?? diagnostic.scope;
    if (diagnostic.sourceKey)
      diagnostic.sourceKey =
        remapped.get(diagnostic.sourceKey) ?? diagnostic.sourceKey;
  }
  return document;
}
