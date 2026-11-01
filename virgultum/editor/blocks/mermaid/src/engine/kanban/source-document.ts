// SPDX-License-Identifier: AGPL-3.0-or-later

export type KanbanRange = { start: number; end: number; line: number };
export type KanbanSourceRecord = {
  sourceKey: string;
  kind:
    | "header"
    | "node"
    | "comment"
    | "blank"
    | "frontmatter"
    | "directive"
    | "decoration"
    | "invalid";
  range: KanbanRange;
  raw: string;
  eol: string;
  indent: string;
  complete: boolean;
};
export type KanbanSourceDocument = {
  source: string;
  newline: string;
  records: KanbanSourceRecord[];
};
let identity = 0;
/** Session identity is independent of Mermaid IDs, labels and array position. */
export function nextKanbanSourceKey() {
  return `kanban-source-${++identity}`;
}

/** This scanner only bounds native statements; semantic projection stays in parser.ts. */
function nodeComplete(raw: string) {
  const opening =
    /^(?:[ \t]*)([^([\n){}@]*)(-\)|\(-|\)\)|\)|\(\(|\{\{|\(|\[)/.exec(raw);
  let cursor = 0;
  if (opening) {
    cursor = opening[0].length;
    if (raw.slice(cursor).startsWith('"`')) {
      const end = raw.indexOf('`"', cursor + 2);
      if (end < 0) return false;
      cursor = end + 2;
    } else if (raw[cursor] === '"') {
      const end = raw.indexOf('"', cursor + 1);
      if (end < 0) return false;
      cursor = end + 1;
    } else {
      while (cursor < raw.length && !/[)\](}]/.test(raw[cursor]!)) cursor++;
    }
    const close = /^(?:\)\)|\)|\]|\}\}|\(-|-\)|\(\(|\()/.exec(
      raw.slice(cursor),
    );
    if (!close) return false;
    cursor += close[0].length;
  }
  while (cursor < raw.length) {
    const metadata = raw.indexOf("@{", cursor);
    const comment = raw.indexOf("%%", cursor);
    if (metadata < 0 || (comment >= 0 && comment < metadata)) return true;
    cursor = metadata + 2;
    let quoted = false;
    for (; cursor < raw.length; cursor++) {
      if (raw[cursor] === '"') quoted = !quoted;
      if (!quoted && raw[cursor] === "}") break;
    }
    if (cursor === raw.length) return false;
    cursor++;
  }
  return true;
}
export function scanKanbanSource(source: string): KanbanSourceDocument {
  const lines = [...source.matchAll(/([^\r\n]*)(\r\n|\r|\n|$)/g)]
    .filter((match) => match[0] || match.index === 0)
    .flatMap((match) => {
      const raw = match[1]!;
      const header = /^([ \t]*kanban\b)(.+)$/i.exec(raw);
      // The native grammar allows its first statement on the header line.
      if (
        header &&
        header[2]!.trim() &&
        !header[2]!.trimStart().startsWith("%%")
      )
        return [
          { start: match.index!, raw: header[1]!, eol: "" },
          {
            start: match.index! + header[1]!.length,
            raw: header[2]!,
            eol: match[2]!,
          },
        ];
      return [{ start: match.index!, raw, eol: match[2]! }];
    });
  const records: KanbanSourceRecord[] = [];
  for (let index = 0; index < lines.length; index++) {
    const first = lines[index]!;
    let last = first;
    const text = first.raw.trim();
    let kind: KanbanSourceRecord["kind"] = !text
      ? "blank"
      : /^%%\{/.test(text)
        ? "directive"
        : /^%%/.test(text)
          ? "comment"
          : /^kanban\b/i.test(text)
            ? "header"
            : /^::(?:icon\(|:)/.test(text)
              ? "decoration"
              : "node";
    let complete = true;
    if (index === 0 && text === "---") {
      kind = "frontmatter";
      complete = false;
      while (++index < lines.length) {
        last = lines[index]!;
        if (last.raw.trim() === "---") {
          complete = true;
          break;
        }
      }
    } else if (kind === "directive") {
      complete = first.raw.includes("}%%");
      while (!complete && index + 1 < lines.length) {
        last = lines[++index]!;
        complete = last.raw.includes("}%%");
      }
    } else if (kind === "node") {
      complete = nodeComplete(first.raw);
      while (!complete && index + 1 < lines.length) {
        last = lines[++index]!;
        complete = nodeComplete(
          source.slice(first.start, last.start + last.raw.length),
        );
      }
    }
    const start = first.start;
    const end = last.start + last.raw.length;
    records.push({
      sourceKey: nextKanbanSourceKey(),
      kind,
      range: {
        start,
        end,
        line: source.slice(0, start).split(/\r\n|\r|\n/).length,
      },
      raw: source.slice(start, end),
      eol: last.eol,
      indent: /^[ \t]*/.exec(first.raw)![0],
      complete,
    });
  }
  return {
    source,
    newline: source.includes("\r\n")
      ? "\r\n"
      : source.includes("\r")
        ? "\r"
        : "\n",
    records,
  };
}

/** External edits only retain uniquely unchanged anchors or untouched prefix/suffix ranges.
 * Explicit writer mappings reserve moved/renamed destinations before reconciling other records. */
export function reconcileKanbanSource(
  document: KanbanSourceDocument,
  previous?: KanbanSourceDocument,
  mapping?: ReadonlyMap<number, string>,
) {
  if (!previous) return document;
  const reserved = new Set(mapping?.values());
  const used = new Set<string>();
  let prefix = 0;
  let suffix = 0;
  while (
    prefix < Math.min(document.source.length, previous.source.length) &&
    document.source[prefix] === previous.source[prefix]
  )
    prefix++;
  while (
    suffix <
      Math.min(document.source.length, previous.source.length) - prefix &&
    document.source[document.source.length - suffix - 1] ===
      previous.source[previous.source.length - suffix - 1]
  )
    suffix++;
  const delta = document.source.length - previous.source.length;
  const matches = new Map<number, string>();
  for (const record of document.records) {
    const candidates = previous.records.filter(
      (old) =>
        !reserved.has(old.sourceKey) &&
        old.kind === record.kind &&
        old.raw === record.raw,
    );
    const count = document.records.filter(
      (other) => other.kind === record.kind && other.raw === record.raw,
    ).length;
    const anchored =
      candidates.length === count
        ? candidates.find(
            (old) =>
              (old.range.end <= prefix
                ? old.range.start
                : old.range.start >= previous.source.length - suffix
                  ? old.range.start + delta
                  : undefined) === record.range.start,
          )
        : undefined;
    const match =
      anchored ??
      (candidates.length === 1 && count === 1 ? candidates[0] : undefined);
    if (match) matches.set(record.range.start, match.sourceKey);
  }
  for (const record of document.records) {
    const key =
      mapping?.get(record.range.start) ?? matches.get(record.range.start);
    if (key && !used.has(key)) {
      record.sourceKey = key;
      used.add(key);
    }
  }
  return document;
}
