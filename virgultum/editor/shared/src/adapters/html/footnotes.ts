// SPDX-License-Identifier: AGPL-3.0-or-later
import { footnotePlacement, type FootnotePlacement } from "@virgultum/model";
import {
  nanoid,
  getAssetName,
  type AssetsManager,
  type BlockSnapshot,
} from "@virgultum/store";
import { localFootnoteSnapshotPresentation } from "../../commands/local-footnote.js";
import {
  editorMessage,
  resolveEditorMessage,
  type EditorI18nService,
} from "../../services/i18n-service.js";
import type { Element, Root } from "hast";
import { visit } from "unist-util-visit";
import { normalizeFootnoteLabel } from "../markdown/footnotes.js";
import { encodeClipboardBlobs } from "../clipboard/utils.js";

export const LOCAL_FOOTNOTE_HTML_PREFIX = "localFootnoteHtml:";
export const LOCAL_FOOTNOTE_READING_PREFIX = "localFootnoteReading:";

/** Transient export copy from the editor's projection; never native metadata. */
export function prepareLocalFootnoteReading(
  roots: BlockSnapshot[],
  configs: Map<string, string>,
  i18n?: EditorI18nService | null,
) {
  for (const key of configs.keys())
    if (key.startsWith(LOCAL_FOOTNOTE_READING_PREFIX)) configs.delete(key);
  for (const [id, presentation] of localFootnoteSnapshotPresentation(roots)) {
    const label =
      presentation.number === undefined
        ? undefined
        : new Intl.NumberFormat(i18n?.locale$.value ?? "en").format(
            presentation.number,
          );
    const message = !presentation.placement
      ? editorMessage("com.myoxus.editor.note.missing", "Missing note")
      : label === undefined
        ? presentation.placement === "endnote"
          ? editorMessage(
              "com.myoxus.editor.endnote.unreferenced",
              "Endnote — no reference",
            )
          : editorMessage(
              "com.myoxus.editor.footnote.unreferenced",
              "Footnote — no reference",
            )
        : presentation.placement === "endnote"
          ? editorMessage(
              "com.myoxus.editor.endnote.reference",
              "Endnote {{label}}",
              { label },
            )
          : editorMessage(
              "com.myoxus.editor.footnote.reference",
              "Footnote {{label}}",
              { label },
            );
    configs.set(
      LOCAL_FOOTNOTE_READING_PREFIX + id,
      JSON.stringify({
        ...presentation,
        name: resolveEditorMessage(message, i18n ?? undefined),
        marker: label === undefined ? "[?]" : `[${label}]`,
      }),
    );
  }
}

/** HTML-only clipboard data has no archive to deliver definition images. */
export async function inlineFootnoteHtmlAssets(
  ast: Root,
  assets: AssetsManager | undefined,
  assetIds: string[],
) {
  const images: Element[] = [];
  visit(ast, "element", (node) => {
    if (node.properties.dataMyoxusFootnoteDefinition === undefined) return;
    visit(node, "element", (child) => {
      if (child.tagName === "img") images.push(child);
    });
  });
  if (!images.length) return;
  const available = assets?.getAssets() ?? new Map<string, Blob>();
  const selected = new Map(
    assetIds.flatMap((id) => {
      const blob = available.get(id);
      return blob ? [[id, blob] as const] : [];
    }),
  );
  // Keep the existing native clipboard byte limits and byte encoding owner.
  const encoded = await encodeClipboardBlobs(selected);
  const byPath = new Map(
    Object.entries(encoded).map(([id, blob]) => [
      `assets/${getAssetName(available, id)}`,
      `data:${blob.type};base64,${blob.content}`,
    ]),
  );
  for (const image of images) {
    const source = byPath.get(String(image.properties.src));
    if (!source)
      throw new Error(
        "Footnote clipboard image unavailable within existing clipboard limits",
      );
    image.properties.src = source;
  }
}

/** Reserve every target from the parsed HTML before markers or assets are converted. */
export function prepareHtmlFootnotes(ast: Root, configs: Map<string, string>) {
  for (const key of configs.keys())
    if (key.startsWith(LOCAL_FOOTNOTE_HTML_PREFIX)) configs.delete(key);
  const labels = new Set<string>();
  const definitions = new Map<
    string,
    { label: string; definitionId: string; placement: FootnotePlacement }
  >();
  visit(ast, "element", (node) => {
    const id = node.properties.dataMyoxusFootnoteDefinition;
    if (id === undefined) return;
    const label = node.properties.dataMyoxusFootnoteLabel;
    const placement = footnotePlacement(
      node.properties.dataMyoxusFootnotePlacement,
    );
    if (
      !placement ||
      node.tagName !== "section" ||
      typeof id !== "string" ||
      !id ||
      typeof label !== "string" ||
      !normalizeFootnoteLabel(label) ||
      labels.has(normalizeFootnoteLabel(label)) ||
      definitions.has(id)
    )
      throw new Error(
        `Invalid HTML footnote definition: ${typeof label === "string" ? label : ""}`,
      );
    // Only generated navigation is omitted; ordinary children stay in order.
    node.children = node.children.filter(
      (child) =>
        child.type !== "element" ||
        child.properties.dataMyoxusFootnoteNavigation === undefined,
    );
    labels.add(normalizeFootnoteLabel(label));
    definitions.set(id, { label, definitionId: nanoid(), placement });
  });
  const inspect = (node: Root | Element, insideDefinition = false) => {
    if (node.type === "element") {
      if (node.properties.dataMyoxusFootnoteDefinition !== undefined) {
        if (insideDefinition)
          throw new Error(
            `Nested HTML footnote definition: ${String(node.properties.dataMyoxusFootnoteLabel ?? "")}`,
          );
        insideDefinition = true;
      }
      const id = node.properties.dataMyoxusFootnoteDefinitionId;
      if (id !== undefined) {
        const label = node.properties.dataMyoxusFootnoteLabel;
        const definition =
          typeof id === "string" ? definitions.get(id) : undefined;
        if (
          insideDefinition ||
          node.tagName !== "sup" ||
          !definition ||
          typeof label !== "string" ||
          normalizeFootnoteLabel(label) !==
            normalizeFootnoteLabel(definition.label)
        )
          throw new Error(
            `Unresolved or nested HTML footnote reference: ${typeof label === "string" ? label : ""}`,
          );
      }
    }
    for (const child of node.children)
      if (child.type === "element") inspect(child, insideDefinition);
  };
  inspect(ast);
  for (const [id, definition] of definitions)
    configs.set(LOCAL_FOOTNOTE_HTML_PREFIX + id, JSON.stringify(definition));
}

/** Derive reading anchors from the complete output AST, including forward refs
 * and slice siblings. Navigation chrome never becomes editable body content. */
export function linkLocalFootnoteHtml(ast: Root, configs: Map<string, string>) {
  const definitions = new Map<string, Element>();
  const labels = new Set<string>();
  visit(ast, "element", (node) => {
    const id = node.properties.dataMyoxusFootnoteDefinition;
    if (id === undefined) return;
    const label = String(node.properties.dataMyoxusFootnoteLabel ?? "");
    const normalized = normalizeFootnoteLabel(label);
    if (
      typeof id !== "string" ||
      !id ||
      !normalized ||
      definitions.has(id) ||
      labels.has(normalized)
    )
      throw new Error(`Invalid HTML footnote definition: ${label}`);
    definitions.set(id, node);
    labels.add(normalized);
    const raw = configs.get(LOCAL_FOOTNOTE_READING_PREFIX + id);
    if (!raw) throw new Error("Missing native note reading projection");
    const reading = JSON.parse(raw) as {
      name: string;
      placement?: FootnotePlacement;
    };
    if (!reading.placement)
      throw new Error("Invalid native footnote placement");
    node.properties.ariaLabel = reading.name;
    node.properties.role =
      reading.placement === "footnote" ? "doc-footnote" : "doc-endnote";
    for (const child of node.children)
      if (
        child.type === "element" &&
        child.tagName === "header" &&
        child.properties.dataMyoxusFootnoteNavigation !== undefined
      )
        child.children = [{ type: "text", value: reading.name }];
  });
  const returns = new Map<string, string[]>();
  const rejectNested = (node: Root | Element, insideDefinition = false) => {
    if (node.type === "element") {
      if (
        insideDefinition &&
        node.properties.dataMyoxusFootnoteDefinitionId !== undefined
      )
        throw new Error("Nested HTML footnote reference");
      if (node.properties.dataMyoxusFootnoteDefinition !== undefined) {
        if (insideDefinition)
          throw new Error("Nested HTML footnote definition");
        insideDefinition = true;
      }
    }
    for (const child of node.children)
      if (child.type === "element") rejectNested(child, insideDefinition);
  };
  rejectNested(ast);
  visit(ast, "element", (node) => {
    const id = node.properties.dataMyoxusFootnoteDefinitionId;
    if (id === undefined) return;
    const definition = typeof id === "string" ? definitions.get(id) : undefined;
    const label = String(node.properties.dataMyoxusFootnoteLabel ?? "");
    if (
      !definition ||
      normalizeFootnoteLabel(label) !==
        normalizeFootnoteLabel(
          String(definition.properties.dataMyoxusFootnoteLabel),
        )
    )
      throw new Error(`Unresolved HTML footnote reference: ${label}`);
    const references = returns.get(String(id)) ?? [];
    const referenceId = `myoxus-footnote-ref-${id}-${references.length + 1}`;
    node.properties.id = referenceId;
    references.push(referenceId);
    returns.set(String(id), references);
    const reading = JSON.parse(
      configs.get(LOCAL_FOOTNOTE_READING_PREFIX + String(id))!,
    ) as { name: string; marker: string };
    for (const child of node.children)
      if (child.type === "element" && child.tagName === "a") {
        child.properties.ariaLabel = reading.name;
        child.children = [{ type: "text", value: reading.marker }];
      }
  });
  for (const [id, definition] of definitions) {
    const references = returns.get(id) ?? [];
    if (!references.length) continue;
    definition.children.push({
      type: "element",
      tagName: "footer",
      properties: { dataMyoxusFootnoteNavigation: true },
      children: references.map((referenceId, index) => ({
        type: "element",
        tagName: "a",
        properties: {
          href: `#${referenceId}`,
          role: "doc-backlink",
          ariaLabel: `${definition.properties.ariaLabel} (${index + 1})`,
        },
        children: [{ type: "text", value: "↩" }],
      })),
    });
  }
  const order = (node: Element) => {
    const raw = configs.get(
      LOCAL_FOOTNOTE_READING_PREFIX +
        node.properties.dataMyoxusFootnoteDefinition,
    );
    return raw
      ? ((JSON.parse(raw) as { order?: number }).order ?? Infinity)
      : Infinity;
  };
  const sort = (node: Root | Element) => {
    // Only native definition siblings move in this output view. Ordinary body
    // order and every definition's rich child order remain unchanged.
    node.children.sort((a, b) => {
      const aNote =
        a.type === "element" &&
        a.properties.dataMyoxusFootnoteDefinition !== undefined;
      const bNote =
        b.type === "element" &&
        b.properties.dataMyoxusFootnoteDefinition !== undefined;
      return (
        Number(aNote) - Number(bNote) ||
        (aNote && bNote ? order(a as Element) - order(b as Element) : 0)
      );
    });
    for (const child of node.children)
      if (child.type === "element") sort(child);
  };
  sort(ast);
}
