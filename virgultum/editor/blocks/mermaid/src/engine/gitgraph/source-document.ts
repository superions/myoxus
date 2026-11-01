// SPDX-License-Identifier: AGPL-3.0-or-later

export type GitGraphRange = { start: number; end: number; line: number };
export type GitGraphAttribute = {
  sourceKey: string;
  nativeValue?: string;
  nativeLexeme?: string;
  name: import("./runtime-contract.js").GitGraphAttributeName;
  value: string;
  raw: string;
  range: GitGraphRange;
  valueRange: GitGraphRange;
  effective: boolean;
};
export type GitGraphRecord = {
  sourceKey: string;
  kind:
    | import("./runtime-contract.js").GitGraphCall
    | "header"
    | "frontmatter"
    | "directive"
    | "title"
    | "accessibility-title"
    | "accessibility-description"
    | "comment"
    | "blank"
    | "invalid";
  raw: string;
  range: GitGraphRange;
  eol: string;
  indent: string;
  complete: boolean;
  attributes: GitGraphAttribute[];
  reference?: {
    value: string;
    nativeValue?: string;
    nativeLexeme?: string;
    raw: string;
    range: GitGraphRange;
  };
  value?: string;
  valueRange?: GitGraphRange;
  keyword?: string;
  previousKey?: string;
  nextKey?: string;
  anchor?: { sourceKey: string; position: "before" | "after" | "inline" };
};
export type GitGraphSourceDocument = {
  source: string;
  newline: string;
  records: GitGraphRecord[];
  diagnostics: import("./diagnostics.js").GitGraphDiagnostic[];
};
export type GitGraphSourceBindings = {
  previous?: GitGraphSourceDocument;
  mapping?: ReadonlyMap<number, string>;
  attributeMapping?: ReadonlyMap<number, string>;
};
export const nextGitGraphSourceKey = () =>
  `gitgraph-source-${crypto.randomUUID()}`;

import {
  GITGRAPH_REFERENCE,
  decodeGitString,
  gitGraphNativeStringValue,
  gitGraphMaskedQuotedSpan,
  gitGraphDirectiveSpans,
  gitGraphAttributeAllowed,
  type GitGraphCall,
  type GitGraphAttributeName,
} from "./runtime-contract.js";
import {
  gitGraphDiagnostic,
  type GitGraphDiagnosticCode,
} from "./diagnostics.js";

/** Physical Source records preserve delimiters and comments. Semantic execution
 * happens later, against these occurrences rather than an ID-keyed map. */
export function scanGitGraphSource(
  source: string,
  bindings: GitGraphSourceBindings = {},
): GitGraphSourceDocument {
  const document: GitGraphSourceDocument = {
    source,
    newline: /\r\n|\r|\n/.exec(source)?.[0] ?? "\n",
    records: [],
    diagnostics: [],
  };
  let cursor = 0,
    line = 1;
  const range = (start: number, end: number): GitGraphRange => ({
    start,
    end,
    line: 1 + (source.slice(0, start).match(/\r\n|\r|\n/g)?.length ?? 0),
  });
  const push = (end: number, kind: GitGraphRecord["kind"], complete = true) => {
    const raw = source.slice(cursor, end),
      eol = /^(?:\r\n|\r|\n)/.exec(source.slice(end))?.[0] ?? "";
    const record: GitGraphRecord = {
      sourceKey: nextGitGraphSourceKey(),
      kind,
      raw,
      range: { start: cursor, end, line },
      eol,
      indent: /^[ \t]*/.exec(raw)![0],
      complete,
      attributes: [],
    };
    document.records.push(record);
    cursor = end + eol.length;
    line += (raw.match(/\r\n|\r|\n/g)?.length ?? 0) + (eol ? 1 : 0);
    return record;
  };
  const diagnose = (
    r: GitGraphRecord,
    code: GitGraphDiagnosticCode,
    reference?: string,
  ) => {
    r.complete = false;
    document.diagnostics.push({
      stage: "syntax",
      severity: "error",
      code,
      sourceKey: r.sourceKey,
      range: r.range,
      reference,
      message: gitGraphDiagnostic(code, reference),
    });
  };
  while (cursor < source.length) {
    const tail = source.slice(cursor),
      indent = /^[ \t]*/.exec(tail)![0].length,
      text = tail.slice(indent),
      nl = tail.search(/[\r\n]/),
      lineEnd = cursor + (nl < 0 ? tail.length : nl);
    if (!source.slice(cursor, lineEnd).trim()) {
      push(lineEnd, "blank");
      continue;
    }
    if (cursor === 0 && /^---[ \t]*(?:\r\n|\r|\n)/.test(text)) {
      const prefix = tail.slice(0, indent),
        close = new RegExp(
          `(?:\\r\\n|\\r|\\n)${prefix}---[ \t]*(?=\\r\\n|\\r|\\n|$)`,
        ).exec(tail.slice(indent + 3));
      const r = push(
        close
          ? cursor + indent + 3 + close.index + close[0].length
          : source.length,
        "frontmatter",
        !!close,
      );
      if (!close) diagnose(r, "gitgraph.syntax.frontmatter-close");
      continue;
    }
    if (text.startsWith("%%{")) {
      const span = gitGraphDirectiveSpans(text)[0];
      if (span?.start === 0) push(cursor + indent + span.end, "directive");
      else {
        const r = push(lineEnd, "invalid");
        diagnose(r, "gitgraph.syntax.directive");
      }
      continue;
    }
    if (text.startsWith("%%")) {
      const r = push(lineEnd, "comment");
      r.value = r.raw.trim().slice(2).trim();
      continue;
    }
    if (/^accDescr[ \t]*\{/.test(text)) {
      const end = source.indexOf("}", cursor + indent),
        r = push(
          end < 0 ? source.length : end + 1,
          "accessibility-description",
          end >= 0,
        );
      const open = r.raw.indexOf("{");
      r.valueRange = range(
        r.range.start + open + 1,
        r.range.end - (end >= 0 ? 1 : 0),
      );
      r.value = source
        .slice(r.valueRange.start, r.valueRange.end)
        .replace(/\r\n?/g, "\n")
        .replace(/^\s*/gm, "")
        .replace(/\s+$/gm, "")
        .replace(/[\t ]{2,}/g, " ")
        .replace(/[\r\n]{2,}/g, "\n");
      if (end < 0) diagnose(r, "gitgraph.syntax.accessibility-close");
      continue;
    }
    // Common metadata has plain-text lexer terminals, not String tokens. Quotes
    // and apostrophes in a title therefore never open a statement String.
    const metadata = /^(title(?=[ \t]|$)|accTitle[ \t]*:|accDescr[ \t]*:)/.exec(
      text,
    );
    if (metadata) {
      const marker = source.indexOf("%%", cursor + indent + metadata[0].length),
        end = marker >= 0 && marker < lineEnd ? marker : lineEnd;
      const kind = metadata[0].startsWith("accTitle")
        ? "accessibility-title"
        : metadata[0].startsWith("accDescr")
          ? "accessibility-description"
          : "title";
      const r = push(end, kind),
        start = r.range.start + indent + metadata[0].length,
        rawValue = source.slice(start, end),
        valueStart = start + rawValue.length - rawValue.trimStart().length;
      r.keyword = metadata[0];
      // Separators belong to the statement, not its editable plain-text value.
      r.valueRange = range(
        valueStart,
        Math.max(valueStart, start + rawValue.trimEnd().length),
      );
      r.value = rawValue.trim().replace(/[ \t]{2,}/g, " ");
      continue;
    }
    if (/^gitGraph(?=[ \t:]|$)/.test(text)) {
      const h = /^gitGraph(?:[ \t]+(LR|TB|BT)[ \t]*:|[ \t]*:)?/.exec(text)!;
      const r = push(cursor + indent + h[0].length, "header");
      r.value = h[1] ?? "LR";
      r.keyword = "gitGraph";
      continue;
    }
    let end = cursor + indent,
      quote = "";
    for (; end < source.length; end++) {
      const char = source[end]!;
      if (quote) {
        const masked = gitGraphMaskedQuotedSpan(source, end, quote);
        if (masked) {
          end += masked - 1;
          continue;
        }
        if (char === "\\") {
          end++;
          continue;
        }
        if (char === quote) quote = "";
        continue;
      }
      if (char === '"' || char === "'") {
        quote = char;
        continue;
      }
      if (/[\r\n]/.test(char) || source.startsWith("%%", end)) break;
    }
    const raw = source.slice(cursor, end),
      keyword =
        /^[ \t]*(gitGraph\b|commit\b|branch\b|checkout\b|switch\b|merge\b|cherry-pick\b|accTitle[ \t]*:|accDescr[ \t]*:|title(?=[ \t]|$))/.exec(
          raw,
        );
    const word = keyword?.[1] ?? "",
      kind: GitGraphRecord["kind"] =
        word === "gitGraph"
          ? "header"
          : word === "switch"
            ? "checkout"
            : word.startsWith("accTitle")
              ? "accessibility-title"
              : word.startsWith("accDescr")
                ? "accessibility-description"
                : word === "title"
                  ? "title"
                  : [
                        "commit",
                        "branch",
                        "checkout",
                        "merge",
                        "cherry-pick",
                      ].includes(word)
                    ? (word as GitGraphCall)
                    : "invalid";
    const r = push(end, kind, !quote);
    r.keyword = word;
    if (quote || !keyword) {
      diagnose(
        r,
        quote ? "gitgraph.syntax.string-close" : "gitgraph.syntax.statement",
      );
      continue;
    }
    let offset = keyword[0].length;
    const skip = () => {
      while (/[ \t]/.test(raw[offset] ?? "")) offset++;
    };
    const string = () => {
      const start = offset,
        q = raw[offset];
      if (q !== '"' && q !== "'") return null;
      offset++;
      while (offset < raw.length) {
        const masked = gitGraphMaskedQuotedSpan(raw, offset, q);
        if (masked) {
          offset += masked;
          continue;
        }
        if (raw[offset] === "\\") {
          offset += 2;
          continue;
        }
        if (raw[offset++] === q) {
          const lexeme = raw.slice(start, offset),
            value = decodeGitString(lexeme.replace(/\r\n?/g, "\n"));
          return value === null || gitGraphNativeStringValue(lexeme) === null
            ? null
            : { start, end: offset, value, raw: lexeme };
        }
      }
      return null;
    };
    if (kind === "header") {
      const h = /^gitGraph(?:[ \t]+(LR|TB|BT)[ \t]*:|[ \t]*:)?[ \t]*$/.exec(
        raw.trim(),
      );
      if (!h) diagnose(r, "gitgraph.syntax.header");
      r.value = h?.[1] ?? "LR";
      continue;
    }
    if (
      ["title", "accessibility-title", "accessibility-description"].includes(
        kind,
      )
    ) {
      skip();
      r.value = raw
        .slice(offset)
        .trim()
        .replace(/[ \t]{2,}/g, " ");
      r.valueRange = range(r.range.start + offset, r.range.end);
      continue;
    }
    if (kind === "branch" || kind === "checkout" || kind === "merge") {
      skip();
      const start = offset,
        quoted = string();
      if (quoted)
        r.reference = {
          value: quoted.value,
          nativeValue: gitGraphNativeStringValue(quoted.raw) ?? quoted.value,
          nativeLexeme: quoted.raw,
          raw: quoted.raw,
          range: range(r.range.start + start, r.range.start + quoted.end),
        };
      else {
        const ref = /^\w([-./\w]*[-\w])?/.exec(raw.slice(offset));
        if (!ref) {
          diagnose(r, "gitgraph.syntax.branch-reference");
          continue;
        }
        offset += ref[0].length;
        r.reference = {
          value: ref[0],
          nativeValue: ref[0],
          nativeLexeme: ref[0],
          raw: ref[0],
          range: range(r.range.start + start, r.range.start + offset),
        };
      }
      if (
        r.reference &&
        !/^["']/.test(r.reference.raw) &&
        !GITGRAPH_REFERENCE.test(r.reference.raw)
      )
        diagnose(r, "gitgraph.syntax.branch-reference");
    }
    while (offset < raw.length) {
      skip();
      if (offset === raw.length) break;
      const start = offset,
        key = /^(id|msg|type|tag|parent|order):/.exec(raw.slice(offset));
      let name: GitGraphAttributeName;
      if (key) {
        name = key[1] === "msg" ? "message" : (key[1] as GitGraphAttributeName);
        offset += key[0].length;
        skip();
      } else if (
        kind === "commit" &&
        (raw[offset] === '"' || raw[offset] === "'")
      )
        name = "message";
      else {
        diagnose(r, "gitgraph.syntax.attribute");
        break;
      }
      if (!gitGraphAttributeAllowed(kind as GitGraphCall, name)) {
        diagnose(r, "gitgraph.syntax.attribute-unsupported", `${kind}.${name}`);
        break;
      }
      const valueStart = offset;
      let value = "";
      if (name === "type" || name === "order") {
        const token = (
          name === "type"
            ? /^(NORMAL|HIGHLIGHT|REVERSE)\b/
            : /^(0|[1-9]\d*)(?![\d.])/
        ).exec(raw.slice(offset));
        if (!token) {
          diagnose(
            r,
            name === "type" ? "gitgraph.syntax.type" : "gitgraph.syntax.order",
          );
          break;
        }
        value = token[0];
        offset += value.length;
      } else {
        const token = string();
        if (!token) {
          diagnose(r, "gitgraph.syntax.string", name);
          break;
        }
        value = token.value;
      }
      r.attributes.push({
        sourceKey: nextGitGraphSourceKey(),
        name,
        value,
        raw: raw.slice(start, offset),
        range: range(r.range.start + start, r.range.start + offset),
        valueRange: range(r.range.start + valueStart, r.range.start + offset),
        nativeValue:
          name === "order" || name === "type"
            ? value
            : (gitGraphNativeStringValue(raw.slice(valueStart, offset)) ??
              value),
        nativeLexeme: raw.slice(valueStart, offset),
        effective: true,
      });
    }
    if (kind === "branch" && r.attributes.length > 1)
      diagnose(r, "gitgraph.syntax.branch-order");
    for (const a of r.attributes)
      if (a.name !== "tag")
        a.effective = r.attributes.findLast((b) => b.name === a.name) === a;
  }
  for (const span of gitGraphDirectiveSpans(source)) {
    const owner = document.records.find(
      (r) => r.range.start <= span.start && r.range.end >= span.end,
    );
    if (!owner || owner.kind === "directive" || owner.kind === "frontmatter")
      continue;
    document.records.push({
      sourceKey: nextGitGraphSourceKey(),
      kind: "directive",
      raw: span.raw,
      range: range(span.start, span.end),
      eol: "",
      indent: "",
      complete: true,
      attributes: [],
    });
  }
  document.records.sort(
    (a, b) => a.range.start - b.range.start || b.range.end - a.range.end,
  );
  const headers = document.records.filter((r) => r.kind === "header"),
    body = document.records.filter(
      (r) => !["blank", "comment", "frontmatter", "directive"].includes(r.kind),
    );
  if (headers.length > 1)
    diagnose(headers[1]!, "gitgraph.syntax.duplicate-header");
  if (body.length && body[0]?.kind !== "header")
    diagnose(body[0]!, "gitgraph.syntax.header-first");
  reconcileGitGraphSource(document, bindings);
  return document;
}

/** Explicit writer mappings reserve changed/moved occurrences before matching
 * retained bytes. Identical records cannot borrow an unrelated occurrence key. */
export function reconcileGitGraphSource(
  document: GitGraphSourceDocument,
  { previous, mapping, attributeMapping }: GitGraphSourceBindings = {},
) {
  const reserved = new Set(mapping?.values()),
    used = new Set<string>();
  const signature = (r: GitGraphRecord) => `${r.kind}\0${r.raw}`;
  const groups = new Map<string, GitGraphRecord[]>(),
    oldGroups = new Map<string, GitGraphRecord[]>();
  for (const r of document.records) {
    const key = signature(r);
    groups.set(key, [...(groups.get(key) ?? []), r]);
  }
  for (const r of previous?.records ?? []) {
    const key = signature(r);
    oldGroups.set(key, [...(oldGroups.get(key) ?? []), r]);
  }
  let prefix = 0,
    suffix = 0;
  if (previous) {
    const limit = Math.min(previous.source.length, document.source.length);
    while (
      prefix < limit &&
      previous.source[prefix] === document.source[prefix]
    )
      prefix++;
    while (
      suffix < limit - prefix &&
      previous.source.at(-suffix - 1) === document.source.at(-suffix - 1)
    )
      suffix++;
  }
  for (const r of document.records) {
    const key = mapping?.get(r.range.start),
      candidates = (oldGroups.get(signature(r)) ?? []).filter(
        (o) => !used.has(o.sourceKey) && !reserved.has(o.sourceKey),
      );
    const exact = candidates.filter(
      (o) =>
        (o.range.end <= prefix
          ? o.range.start
          : o.range.start >= (previous?.source.length ?? 0) - suffix
            ? o.range.start +
              document.source.length -
              (previous?.source.length ?? 0)
            : undefined) === r.range.start,
    );
    const old = key
      ? previous?.records.find((o) => o.sourceKey === key)
      : exact.length === 1
        ? exact[0]
        : candidates.length === 1 && groups.get(signature(r))?.length === 1
          ? candidates[0]
          : undefined;
    r.sourceKey = key ?? old?.sourceKey ?? r.sourceKey;
    used.add(r.sourceKey);
    const usedAttributes = new Set<string>();
    for (const [index, a] of r.attributes.entries()) {
      const mapped = attributeMapping?.get(a.range.start);
      if (mapped) {
        a.sourceKey = mapped;
        usedAttributes.add(mapped);
        continue;
      }
      const retained = old?.attributes.find(
        (o) =>
          !usedAttributes.has(o.sourceKey) &&
          o.name === a.name &&
          o.raw === a.raw,
      );
      const provider =
        retained ??
        (old?.attributes.length === r.attributes.length &&
        old.attributes[index]?.name === a.name &&
        !usedAttributes.has(old.attributes[index]!.sourceKey)
          ? old.attributes[index]
          : undefined);
      if (provider) {
        a.sourceKey = provider.sourceKey;
        usedAttributes.add(a.sourceKey);
      }
    }
  }
  const statements = document.records.filter(
    (r) => !["comment", "blank"].includes(r.kind),
  );
  for (const [i, r] of document.records.entries()) {
    r.previousKey = document.records[i - 1]?.sourceKey;
    r.nextKey = document.records[i + 1]?.sourceKey;
    if (r.kind !== "comment" && r.kind !== "blank") continue;
    const before = statements.findLast((o) => o.range.end <= r.range.start),
      after = statements.find((o) => o.range.start >= r.range.end);
    r.anchor =
      before && before.range.line === r.range.line
        ? { sourceKey: before.sourceKey, position: "inline" }
        : after
          ? { sourceKey: after.sourceKey, position: "before" }
          : before
            ? { sourceKey: before.sourceKey, position: "after" }
            : undefined;
  }
  for (const d of document.diagnostics) {
    const r = document.records.find((r) => r.range.start === d.range.start);
    if (r) d.sourceKey = r.sourceKey;
  }
  return document;
}
