// SPDX-License-Identifier: AGPL-3.0-or-later

export type JourneyRange = { start: number; end: number; line: number };
export type JourneySourceRecord = {
  sourceKey: string;
  kind:
    | "header"
    | "section"
    | "step"
    | "title"
    | "accessibility-title"
    | "accessibility-description"
    | "comment"
    | "blank"
    | "frontmatter"
    | "directive"
    | "invalid";
  range: JourneyRange;
  raw: string;
  eol: string;
  indent: string;
  complete: boolean;
};
export type JourneySourceDocument = {
  source: string;
  newline: string;
  records: JourneySourceRecord[];
};
let identity = 0;
/** Editor-only session identity; never a Mermaid object ID or a label/index lookup. */
export function nextJourneySourceKey() {
  return `journey-source-${++identity}`;
}
export function scanJourneySource(source: string): JourneySourceDocument {
  const lines = [...source.matchAll(/([^\r\n]*)(\r\n|\r|\n|$)/g)].filter(
    (m) => m[0] || m.index === 0,
  );
  // Native start is `journey document EOF`; the first statement may share
  // the header line. Split its physical ranges without normalizing whitespace.
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const header = /^[ \t]*journey\b/i.exec(line[1]!);
    if (!header || !line[1]!.slice(header[0].length).trim()) continue;
    const rest = line[1]!.slice(header[0].length);
    const tail = [rest + line[2], rest, line[2]] as unknown as RegExpExecArray;
    tail.index = line.index! + header[0].length;
    const head = [header[0], header[0], ""] as unknown as RegExpExecArray;
    head.index = line.index;
    lines.splice(i, 1, head, tail);
    i++;
  }
  const records: JourneySourceRecord[] = [];
  for (let i = 0; i < lines.length; i++) {
    const first = lines[i]!;
    let last = first;
    const text = first[1]!.trim();
    let kind: JourneySourceRecord["kind"] = !text
      ? "blank"
      : /^%%\{/.test(text)
        ? "directive"
        : /^[%#]/.test(text) || /^[^}]%%/.test(text)
          ? "comment"
          : /^journey\b/i.test(text)
            ? "header"
            : /^title\s/i.test(text)
              ? "title"
              : /^accTitle\s*:/i.test(text)
                ? "accessibility-title"
                : /^accDescr\s*[:{]/i.test(text)
                  ? "accessibility-description"
                  : /^section\s/i.test(first[1]!.trimStart())
                    ? "section"
                    : text.includes(":")
                      ? "step"
                      : "invalid";
    let complete = true;
    if (i === 0 && text === "---") {
      kind = "frontmatter";
      complete = false;
      while (++i < lines.length) {
        last = lines[i]!;
        if (last[1]!.trim() === "---") {
          complete = true;
          break;
        }
      }
    } else if (kind === "directive") {
      complete = first[1]!.includes("}%%");
      while (!complete && i + 1 < lines.length) {
        last = lines[++i]!;
        complete = last[1]!.includes("}%%");
      }
    } else if (
      kind === "accessibility-description" &&
      /^accDescr\s*\{/i.test(text)
    ) {
      complete = first[1]!.includes("}");
      while (!complete && i + 1 < lines.length) {
        last = lines[++i]!;
        complete = last[1]!.includes("}");
      }
    }
    // These closing tokens return control to the native lexer on the same line.
    // A following statement needs its own anchor, not ownership by the preceding block.
    const closing =
      kind === "directive"
        ? "}%%"
        : kind === "accessibility-description" && /^accDescr\s*\{/i.test(text)
          ? "}"
          : undefined;
    if (complete && closing) {
      const token = last[1]!.indexOf(closing);
      const boundary = token + closing.length;
      if (token >= 0 && last[1]!.slice(boundary).trim()) {
        const rest = last[1]!.slice(boundary);
        const tail = [
          rest + last[2],
          rest,
          last[2],
        ] as unknown as RegExpExecArray;
        tail.index = last.index! + boundary;
        lines.splice(i + 1, 0, tail);
        const prefix = last[1]!.slice(0, boundary);
        const closed = [prefix, prefix, ""] as unknown as RegExpExecArray;
        closed.index = last.index;
        last = closed;
      }
    }
    const start = first.index!;
    const end = last.index! + last[1]!.length;
    records.push({
      sourceKey: nextJourneySourceKey(),
      kind,
      range: {
        start,
        end,
        line: source.slice(0, start).split(/\r\n|\r|\n/).length,
      },
      raw: source.slice(start, end),
      eol: last[2]!,
      indent: /^[ \t]*/.exec(first[1]!)![0],
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
export function reconcileJourneySource(
  document: JourneySourceDocument,
  previous?: JourneySourceDocument,
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
