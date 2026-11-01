// SPDX-License-Identifier: AGPL-3.0-or-later

/** Mermaid 11.17.2 Langium terminals. Reference and quoted String have distinct
 * lexical contracts; statements end at newline/EOF, never at a semicolon. */
export const GITGRAPH_REFERENCE = /^\w([-./\w]*[-\w])?$/;
export const GITGRAPH_TYPES = ["NORMAL", "HIGHLIGHT", "REVERSE"] as const;
export const GITGRAPH_DIRECTIONS = ["LR", "TB", "BT"] as const;
export const GITGRAPH_ATTRIBUTES = {
  commit: ["id", "message", "type", "tag"],
  merge: ["id", "type", "tag"],
  "cherry-pick": ["id", "parent", "tag"],
  branch: ["order"],
  checkout: [],
} as const;
export type GitGraphCall = keyof typeof GITGRAPH_ATTRIBUTES;
export type GitGraphAttributeName =
  "id" | "message" | "type" | "tag" | "parent" | "order";
export function gitGraphAttributeAllowed(
  call: GitGraphCall,
  name: GitGraphAttributeName,
) {
  return (GITGRAPH_ATTRIBUTES[call] as readonly string[]).includes(name);
}
/** Langium removes quotes and decodes its escape table; unknown escapes lose the slash. */
export function decodeGitString(raw: string, strict = false) {
  const quote = raw[0];
  if ((quote !== '"' && quote !== "'") || raw.at(-1) !== quote) return null;
  let value = "";
  const escapes: Record<string, string> = {
    b: "\b",
    f: "\f",
    n: "\n",
    r: "\r",
    t: "\t",
    v: "\v",
    "0": "\0",
  };
  for (let i = 1; i < raw.length - 1; i++) {
    const char = raw[i]!;
    if (char !== "\\") {
      if (strict && char === quote) return null;
      value += char;
      continue;
    }
    const next = raw[++i];
    if (next === undefined || i === raw.length - 1 || /[\r\n]/.test(next))
      return null;
    value += escapes[next] ?? next;
  }
  return value;
}
/** Use the native escape table. JSON \u escapes would change the decoded value. */
export function encodeGitString(value: string, quote = '"') {
  let encoded = quote;
  const escapes: Record<string, string> = {
    "\b": "b",
    "\f": "f",
    "\n": "n",
    "\r": "r",
    "\t": "t",
    "\v": "v",
    "\0": "0",
  };
  for (const char of value) {
    if (char === quote || char === "\\") encoded += "\\" + char;
    else if (Object.hasOwn(escapes, char)) encoded += "\\" + escapes[char];
    else encoded += char;
  }
  return encoded + quote;
}
export function encodeGitReference(value: string, quoted = false, quote = '"') {
  return !quoted && GITGRAPH_REFERENCE.test(value)
    ? value
    : encodeGitString(value, quote);
}

/** Branch INT accepts decimal digits only. Validated JS integers must not use
 * Number's exponential spelling at large magnitudes. */
export function encodeGitGraphBranchOrder(value: number) {
  return BigInt(value).toString();
}

/** Public Mermaid preprocessing runs before Langium, including inside quoted
 * values. Spans retain original offsets for Source providers and minimal writes. */
export const GITGRAPH_NATIVE_DIRECTIVE =
  /%{2}\{\s*(?:(\w+)\s*:|(\w+))\s*(?:(\w+)|((?:(?!}%%)[^\r\n]|\r\n|\r|\n)*))?\s*(?:}%%)?/dgi;
export function gitGraphDirectiveSpans(source: string) {
  return [...source.matchAll(GITGRAPH_NATIVE_DIRECTIVE)].map((m) => ({
    start: m.index,
    end: m.index + m[0].length,
    raw: m[0],
    type: m[1] ?? m[2] ?? "",
    args: m[4] ?? m[3] ?? "",
    plain: m[3] !== undefined,
    argsStart:
      m.indices?.[4]?.[0] ?? m.indices?.[3]?.[0] ?? m.index + m[0].length,
  }));
}
export function gitGraphPublicQuotedValue(raw: string) {
  return raw
    .replace(/\r\n?/g, "\n")
    .replace(
      /<(\w+)([^>]*)>/g,
      (_match, tag: string, attributes: string) =>
        `<${tag}${attributes.replace(/="([^"]*)"/g, "='$1'")}>`,
    )
    .replace(GITGRAPH_NATIVE_DIRECTIVE, "")
    .replace(/^\s*%%(?!\{)[^\n]+\n?/gm, "");
}
/** Raw HTML attribute quotes and directive JSON are masked by the public
 * preprocessor. They cannot prematurely terminate an authored String record. */
export function gitGraphMaskedQuotedSpan(
  source: string,
  at: number,
  quote: string,
) {
  if (source.startsWith("%%{", at)) {
    const span = gitGraphDirectiveSpans(source.slice(at))[0];
    if (span?.start === 0) return span.end;
  }
  if (source.startsWith("%%", at)) {
    const lineStart =
      Math.max(
        source.lastIndexOf("\n", at - 1),
        source.lastIndexOf("\r", at - 1),
      ) + 1;
    if (!source.slice(lineStart, at).trim()) {
      const comment = /^%%(?!\{)[^\r\n]+(?:\r\n|\r|\n)?/.exec(source.slice(at));
      if (comment) return comment[0].length;
    }
  }
  if (quote === '"' && source[at] === "<") {
    const tag = /^<(\w+)([^>]*)>/.exec(source.slice(at));
    if (tag && /="[^"]*"/.test(tag[2]!)) return tag[0].length;
  }
  return 0;
}
/** Diagram.fromText encodes Mermaid entities before Langium reads strings.
 * Keep that native map value separate from the Source lexeme/decoded field. */
export function encodeGitGraphNativeEntities(text: string) {
  return text
    .replace(/style.*:\S*#.*;/g, (s) => s.slice(0, -1))
    .replace(/classDef.*:\S*#.*;/g, (s) => s.slice(0, -1))
    .replace(/#\w+;/g, (s) => {
      const name = s.slice(1, -1);
      return `ﬂ°${/^\+?\d+$/.test(name) ? "°" : ""}${name}¶ß`;
    });
}
export function gitGraphNativeStringValue(lexeme: string) {
  return decodeGitString(
    encodeGitGraphNativeEntities(gitGraphPublicQuotedValue(lexeme)),
    true,
  );
}

/** Retain authored escape and multiline spelling outside the changed decoded
 * span. Public preprocessing metadata inside an untouched span stays in Source. */
export function editGitString(raw: string, value: string) {
  if (decodeGitString(raw) === null) return encodeGitString(value);
  const positions = [1];
  let previous = "";
  const quote = raw[0]!;
  for (let at = 1; at < raw.length - 1; at++) {
    const start = at;
    if (raw[at] === "\\") at++;
    else if (raw[at] === "\r" && raw[at + 1] === "\n") at++;
    previous += decodeGitString(
      quote + raw.slice(start, at + 1).replace(/\r\n?/g, "\n") + quote,
    )!;
    positions.push(at + 1);
  }
  if (previous === value) return raw;
  let prefix = 0,
    suffix = 0;
  while (
    prefix < Math.min(previous.length, value.length) &&
    previous[prefix] === value[prefix]
  )
    prefix++;
  while (
    suffix < Math.min(previous.length, value.length) - prefix &&
    previous.at(-suffix - 1) === value.at(-suffix - 1)
  )
    suffix++;
  const newline = /\r\n|\r|\n/.exec(raw)?.[0];
  const replacement = Array.from(
    value.slice(prefix, value.length - suffix),
    (char) =>
      char === "\n" && newline
        ? newline
        : encodeGitString(char, quote).slice(1, -1),
  ).join("");
  return (
    raw.slice(0, positions[prefix]) +
    replacement +
    raw.slice(positions[previous.length - suffix])
  );
}
