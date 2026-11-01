// SPDX-License-Identifier: AGPL-3.0-or-later

export type MindmapXmlLimits = Readonly<{
  bytes: number;
  nodes: number;
  depth: number;
  labelCodepoints: number;
}>;
export const MINDMAP_XML_LIMITS: MindmapXmlLimits = Object.freeze({
  bytes: 10 * 1024 * 1024,
  nodes: 5000,
  depth: 128,
  labelCodepoints: 8000,
});
export type ForeignMindmapNode = {
  text: string;
  children: ForeignMindmapNode[];
  layoutType?: "left" | "right";
};
export type MindmapXmlFormat = "mm" | "opml";
export type MindmapXmlLoss = {
  kind: "link" | "icon" | "richtext" | "note" | "attribute" | "element";
  field: string;
  count: number;
  firstNode: number | null;
};
export type MindmapXmlImport = {
  format: MindmapXmlFormat;
  root: ForeignMindmapNode;
  nodeCount: number;
  depth: number;
  losses: MindmapXmlLoss[];
};
export type MindmapXmlErrorCode =
  | "bytes"
  | "declaration"
  | "xml"
  | "format"
  | "body"
  | "root"
  | "label"
  | "nodes"
  | "depth"
  | "label-codepoints";

/** Diagnostics contain format/ordinal/structural position, never XML or labels. */
export class MindmapXmlError extends Error {
  constructor(
    readonly code: MindmapXmlErrorCode,
    readonly format: MindmapXmlFormat | null = null,
    readonly node: number | null = null,
    readonly position: string | null = null,
    readonly limit: number | null = null,
  ) {
    super(
      `Mindmap XML: ${code}${format ? ` (${format})` : ""}${node === null ? "" : `, node ${node} at ${position}`}${limit === null ? "" : `, limit ${limit}`}`,
    );
    this.name = "MindmapXmlError";
  }
}

/** Callers may tighten the import budget; the confirmed ceilings cannot be raised.
 * Bytes and declarations are checked before DOMParser. Validate iteratively before
 * creating the destination tree, so a rejected import never returns a partial tree. */
export function parseMindmapXml(
  content: string,
  limits: MindmapXmlLimits = MINDMAP_XML_LIMITS,
): MindmapXmlImport {
  const budget = { ...MINDMAP_XML_LIMITS };
  for (const key of Object.keys(budget) as Array<keyof MindmapXmlLimits>) {
    if (!Number.isSafeInteger(limits[key]) || limits[key] < 1)
      throw new RangeError(`Invalid mindmap XML limit: ${key}`);
    budget[key] = Math.min(budget[key], limits[key]);
  }
  // UTF-16 length is a cheap lower bound on the actual UTF-8 byte count.
  if (
    content.length > budget.bytes ||
    new TextEncoder().encode(content).byteLength > budget.bytes
  )
    throw new MindmapXmlError("bytes", null, null, null, budget.bytes);
  if (/<!\s*(?:DOCTYPE|ENTITY)\b/i.test(content))
    throw new MindmapXmlError("declaration");
  const document = new DOMParser().parseFromString(content, "application/xml");
  const parseError = document.getElementsByTagName("parsererror")[0];
  if (document.doctype || parseError || !document.documentElement) {
    // Native parser messages may embed Source; retain only numeric coordinates.
    const at =
      /line(?: number)?[ :]*(\d+)(?:,| at)?\s*(?:at )?column[ :]*(\d+)/i.exec(
        parseError?.textContent ?? "",
      );
    throw new MindmapXmlError(
      "xml",
      null,
      null,
      at ? `line:${at[1]}/column:${at[2]}` : "document",
    );
  }
  const element = document.documentElement;
  const format =
    element.tagName === "map"
      ? "mm"
      : element.tagName === "opml"
        ? "opml"
        : null;
  if (!format) throw new MindmapXmlError("format");
  const children = (element: Element, tag: string) =>
    Array.from(element.children).filter((child) => child.tagName === tag);
  const bodies = format === "opml" ? children(element, "body") : [element];
  if (bodies.length !== 1)
    throw new MindmapXmlError("body", format, null, "opml/body");
  const tag = format === "mm" ? "node" : "outline";
  const roots = children(bodies[0], tag);
  if (roots.length !== 1)
    throw new MindmapXmlError(
      "root",
      format,
      null,
      format === "mm" ? "map/node" : "opml/body/outline",
    );
  const losses = new Map<string, MindmapXmlLoss>();
  const loss = (
    kind: MindmapXmlLoss["kind"],
    field: string,
    node: number | null,
  ) => {
    const boundedField = field.slice(0, 64),
      key = `${kind}:${boundedField}`;
    const previous = losses.get(key);
    if (previous) previous.count++;
    else
      losses.set(key, { kind, field: boundedField, count: 1, firstNode: node });
  };
  const kind = (field: string): MindmapXmlLoss["kind"] =>
    /link|url|href/i.test(field)
      ? "link"
      : /icon/i.test(field)
        ? "icon"
        : /note/i.test(field)
          ? "note"
          : /rich|html/i.test(field)
            ? "richtext"
            : "attribute";
  const inspect = (
    element: Element,
    node: number | null,
    allowed: readonly string[],
  ) => {
    for (const attribute of Array.from(element.attributes))
      if (!allowed.includes(attribute.name))
        loss(kind(attribute.name), attribute.name, node);
    for (const child of Array.from(element.children)) {
      if (child.tagName === tag) continue;
      const field =
        child.tagName === "richcontent"
          ? `${child.tagName}:${child.getAttribute("TYPE") ?? ""}`
          : child.tagName;
      const category = kind(field);
      loss(category === "attribute" ? "element" : category, field, node);
    }
  };
  inspect(element, null, format === "mm" ? ["version"] : ["version"]);
  if (format === "opml") {
    // body/head are envelope containers, not discarded outline nodes.
    losses.delete("element:body");
    const head = children(element, "head");
    if (head.length) {
      losses.delete("element:head");
      for (const entry of head) inspect(entry, null, []);
    }
    inspect(bodies[0], null, []);
  }
  type Entry = {
    element: Element;
    parent: number;
    depth: number;
    position: string;
  };
  const stack: Entry[] = [
    { element: roots[0], parent: -1, depth: 1, position: "1" },
  ];
  const validated: Array<{
    text: string;
    parent: number;
    side?: "left" | "right";
  }> = [];
  let maximumDepth = 0;
  while (stack.length) {
    const current = stack.pop()!,
      ordinal = validated.length + 1;
    const fail = (code: MindmapXmlErrorCode, limit?: number): never => {
      throw new MindmapXmlError(
        code,
        format,
        ordinal,
        current.position,
        limit ?? null,
      );
    };
    if (ordinal > budget.nodes) fail("nodes", budget.nodes);
    if (current.depth > budget.depth) fail("depth", budget.depth);
    const text = current.element.getAttribute(
      format === "mm" ? "TEXT" : "text",
    );
    if (text === null || !text.trim()) return fail("label");
    let points = 0;
    for (const _point of text)
      if (++points > budget.labelCodepoints)
        fail("label-codepoints", budget.labelCodepoints);
    const position =
      format === "mm" ? current.element.getAttribute("POSITION") : null;
    const side =
      position === "left" || position === "right" ? position : undefined;
    inspect(current.element, ordinal, [
      format === "mm" ? "TEXT" : "text",
      ...(side ? ["POSITION"] : []),
    ]);
    const index = validated.length;
    validated.push({ text, parent: current.parent, ...(side ? { side } : {}) });
    maximumDepth = Math.max(maximumDepth, current.depth);
    const descendants = children(current.element, tag);
    if (validated.length + stack.length + descendants.length > budget.nodes)
      fail("nodes", budget.nodes);
    for (let i = descendants.length - 1; i >= 0; i--)
      stack.push({
        element: descendants[i],
        parent: index,
        depth: current.depth + 1,
        position: `${current.position}/${i + 1}`,
      });
  }
  const nodes: ForeignMindmapNode[] = validated.map((node) => ({
    text: node.text,
    children: [],
    ...(node.side ? { layoutType: node.side } : {}),
  }));
  for (const [index, node] of validated.entries())
    if (node.parent !== -1) nodes[node.parent].children.push(nodes[index]);
  return {
    format,
    root: nodes[0],
    nodeCount: nodes.length,
    depth: maximumDepth,
    losses: [...losses.values()],
  };
}
