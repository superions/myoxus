// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Installed Mermaid 11.17.2 mindmap lexer/DB/render semantics. Padding, width,
 * sanitization and available CSS/icon resources belong to renderer config;
 * they do not introduce syntax or make an unknown resource an invalid tree.
 * Titles and preamble remain owned by the common Mermaid source boundary.
 */
export const mindmapRuntimeContract = {
  version: "11.17.2",
  header: /^mindmap\b/i,
  shapes: [
    "default",
    "rounded",
    "square",
    "circle",
    "cloud",
    "hexagon",
    "bang",
  ],
  // Order matters: these are lexer alternatives, not paired brackets.
  openers: ["-)", "(-", "))", ")", "((", "{{", "(", "["],
  closers: ["))", ")", "]", "}}", "(-", "-)", "((", "("],
  labelType: "markdown",
} as const;

export type MermaidMindmapShape =
  (typeof mindmapRuntimeContract.shapes)[number];
export type MindmapLabelForm = "bare" | "quoted" | "markdown";
export type MindmapDecoration = {
  kind: "icon" | "class";
  value: string;
  sourceKey?: string;
};

export function isMindmapShape(value: unknown): value is MermaidMindmapShape {
  return mindmapRuntimeContract.shapes.some((shape) => shape === value);
}

/** Mirrors MindmapDB.getType(); aliases (- and -) intentionally remain default. */
export function mindmapShapeFromDelimiters(
  open: string,
  close: string,
): MermaidMindmapShape {
  switch (open) {
    case "[":
      return "square";
    case "(":
      return close === ")" ? "rounded" : "cloud";
    case "((":
      return "circle";
    case ")":
      return "cloud";
    case "))":
      return "bang";
    case "{{":
      return "hexagon";
    default:
      return "default";
  }
}

export const mindmapShapeDelimiters: Record<
  MermaidMindmapShape,
  readonly [string, string]
> = {
  default: ["", ""],
  rounded: ["(", ")"],
  square: ["[", "]"],
  circle: ["((", "))"],
  cloud: [")", "("],
  bang: ["))", "(("],
  hexagon: ["{{", "}}"],
};

/** INITIAL-state NODE_ID token. Repeated IDs are legal occurrences, not keys.
 * A leading lexer directive/comment or indentation cannot be an ID prefix. */
export function isMindmapSyntaxId(value: string) {
  return (
    value === "" ||
    (value.trimStart() === value &&
      !mindmapRuntimeContract.header.test(value) &&
      !/^(?:%%|:::)/.test(value) &&
      !/[([\r\n){}]/.test(value))
  );
}

/** There are no JSON/backslash escapes in NSTR/NSTR2. Never invent one on export. */
export function encodeMindmapLabel(
  label: string,
  form: MindmapLabelForm,
): string | null {
  if (form === "quoted")
    return label && !label.includes('"') ? `"${label}"` : null;
  if (form === "markdown")
    return label && !/[`"]/.test(label) ? `"\`${label}\`"` : null;
  return label && !/[\n\r()[{}]/.test(label) && !label.startsWith("%%")
    ? label
    : null;
}

export function serializeMindmapNode(node: {
  label: string;
  shape: MermaidMindmapShape;
  syntax?: Pick<MindmapNodeSyntax, "syntaxId" | "labelForm" | "open" | "close">;
}): string | null {
  const { syntax, label, shape } = node;
  let [open, close] = mindmapShapeDelimiters[shape];
  if (
    syntax?.open &&
    mindmapShapeFromDelimiters(syntax.open, syntax.close) === shape
  ) {
    [open, close] = [syntax.open, syntax.close];
  }
  if (
    !open &&
    (syntax?.labelForm ?? "bare") === "bare" &&
    !(syntax?.open && syntax.syntaxId) &&
    encodeMindmapLabel(label, "bare") &&
    !/^(?:\s|::|mindmap\b)/i.test(label)
  )
    return label;
  // The native default-shape alias provides a string context for punctuation.
  if (!open) [open, close] = ["(-", "-)"];
  const form = syntax?.labelForm ?? "bare";
  let content =
    form === "bare" &&
    !close.startsWith("-") &&
    !/[)\](}]/.test(label) &&
    !label.startsWith('"')
      ? label
      : null;
  if (form !== "bare") content = encodeMindmapLabel(label, form);
  content ??= encodeMindmapLabel(label, "quoted");
  if (!content) return null;
  const prefix = syntax?.open ? syntax.syntaxId : "";
  return `${prefix}${open}${content}${close}`;
}

/** Indentation is relative to the first node, not a fixed number of spaces. */
export function findMindmapParent<T extends { indent: number }>(
  nodes: readonly T[],
  indent: number,
): T | undefined {
  for (let index = nodes.length - 1; index >= 0; index--) {
    if (nodes[index].indent < indent) return nodes[index];
  }
  return undefined;
}

/** Classes/icons are resource names. Unknown resources do not invalidate syntax. */
export function effectiveMindmapDecorations(
  records: readonly MindmapDecoration[],
) {
  const effective: { icon?: string; class?: string } = {};
  for (const record of records)
    if (record.value) effective[record.kind] = record.value;
  return effective;
}

export type MindmapNodeSyntax = {
  label: string;
  syntaxId: string;
  labelForm: MindmapLabelForm;
  open: string;
  close: string;
  shape: MermaidMindmapShape;
  end: number;
  labelStart: number;
  labelEnd: number;
  labelTokenStart: number;
  labelTokenEnd: number;
  openStart: number;
  closeStart: number;
};

/** Reads one native node token, including multiline NODE/NSTR/NSTR2 content. */
export function readMindmapNode(
  text: string,
  start: number,
): MindmapNodeSyntax | null {
  if (mindmapRuntimeContract.header.test(text.slice(start))) return null;
  let offset = start;
  let syntaxId = "";
  let open = mindmapRuntimeContract.openers.find((value) =>
    text.startsWith(value, offset),
  );
  if (!open) {
    const id = /^[^([\r\n){}]+/.exec(text.slice(offset))?.[0];
    if (!id) return null;
    syntaxId = id;
    offset += id.length;
    open = mindmapRuntimeContract.openers.find((value) =>
      text.startsWith(value, offset),
    );
    if (!open)
      return {
        label: id,
        syntaxId: id,
        labelForm: "bare",
        open: "",
        close: "",
        shape: "default",
        end: offset,
        labelStart: start,
        labelEnd: offset,
        labelTokenStart: start,
        labelTokenEnd: offset,
        openStart: offset,
        closeStart: offset,
      };
  }
  const openStart = offset;
  offset += open.length;
  const labelTokenStart = offset;
  let labelStart = offset,
    labelEnd = offset;
  let labelForm: MindmapLabelForm = "bare";
  let label: string;
  if (text.startsWith('"', offset)) {
    labelForm = text.startsWith('"`', offset) ? "markdown" : "quoted";
    const quote = labelForm === "markdown" ? '`"' : '"';
    offset += labelForm === "markdown" ? 2 : 1;
    labelStart = offset;
    const end = text.indexOf(quote, offset);
    if (end < 0 || end === offset) return null;
    label = text.slice(offset, end);
    labelEnd = end;
    if (labelForm === "markdown" && /[`"]/.test(label)) return null;
    offset = end + quote.length;
  } else {
    const value = /^[^)\](}]+/.exec(text.slice(offset))?.[0];
    if (!value) return null;
    label = value;
    offset += value.length;
    labelEnd = offset;
  }
  const close = mindmapRuntimeContract.closers.find((value) =>
    text.startsWith(value, offset),
  );
  if (!close) return null;
  return {
    label,
    syntaxId,
    labelForm,
    open,
    close,
    shape: mindmapShapeFromDelimiters(open, close),
    end: offset + close.length,
    labelStart,
    labelEnd,
    labelTokenStart,
    labelTokenEnd: offset,
    openStart,
    closeStart: offset,
  };
}
