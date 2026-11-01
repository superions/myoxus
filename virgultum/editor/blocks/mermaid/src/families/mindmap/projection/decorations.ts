// SPDX-License-Identifier: AGPL-3.0-or-later
import { marked, type Token } from "marked";
import {
  CloudWorkspaceIcon,
  DatabaseIcon,
  StarIcon,
  MindmapIcon,
  CheckCircleIcon,
} from "@myoxus/icons/lit";
import { render } from "lit";
import { dedent } from "ts-dedent";
import DOMPurify from "dompurify";
import type { ShapeLabelProjection } from "@virgultum/model";

// Explicit bundled resources, not aliases for unavailable Font Awesome/Iconify
// packs. Unknown names remain authored Source and are diagnosed by the controls.
export const mindmapBundledIcons = {
  "myoxus:cloud": CloudWorkspaceIcon,
  "myoxus:database": DatabaseIcon,
  "myoxus:star": StarIcon,
  "myoxus:mindmap": MindmapIcon,
  "myoxus:check-circle": CheckCircleIcon,
} as const;
type BundledIcon = NonNullable<ShapeLabelProjection["icon"]>;
const icons = new Map<
  string,
  Pick<BundledIcon, "paths" | "viewBox" | "strokeWidth">
>();

function iconStrokeWidth(bundledDefault: number) {
  const value = Number.parseFloat(
    getComputedStyle(document.documentElement).getPropertyValue(
      "--myoxus-icon-stroke-width",
    ),
  );
  return Number.isFinite(value) && value > 0 ? value : bundledDefault;
}

/** Extract geometry from the existing owned icon bundle once. No external fetch,
 * new icon geometry, arbitrary SVG or live DOM layer enters the editor. */
export function mindmapIconResource(name: string | undefined) {
  if (!name || !Object.hasOwn(mindmapBundledIcons, name)) return undefined;
  const cached = icons.get(name);
  if (cached)
    return { ...cached, strokeWidth: iconStrokeWidth(cached.strokeWidth) };
  const container = document.createElement("div");
  render(
    mindmapBundledIcons[name as keyof typeof mindmapBundledIcons](),
    container,
  );
  const svg = container.querySelector("svg")!;
  const viewBox = svg.getAttribute("viewBox")!.split(/\s+/).map(Number) as [
    number,
    number,
    number,
    number,
  ];
  const paths = [...svg.querySelectorAll("path")].map((path) =>
    path.getAttribute("d")!,
  );
  const declaration = svg.querySelector("path")!.getAttribute("stroke-width")!;
  const strokeWidth = Number.parseFloat(
    declaration.match(/,\s*([\d.]+)\)/)![1],
  );
  const resource = { paths, viewBox, strokeWidth };
  icons.set(name, resource);
  return { ...resource, strokeWidth: iconStrokeWidth(resource.strokeWidth) };
}

export type MindmapTextRun = { text: string; bold: boolean; italic: boolean };

function plainHtml(value: string) {
  const decoder = document.createElement("textarea");
  decoder.innerHTML = DOMPurify.sanitize(value, {
    ALLOWED_TAGS: [],
    ALLOWED_ATTR: [],
  });
  return decoder.value;
}

/** Same lexer and BR/newline/dedent preprocessing as Mermaid 11.17.2. Source
 * keeps its authored Markdown; the GFX projection receives measured text runs. */
export function mindmapMarkdownRuns(label: string): MindmapTextRun[] {
  const runs: MindmapTextRun[] = [];
  const push = (text: string, bold: boolean, italic: boolean) => {
    if (!text) return;
    const last = runs.at(-1);
    if (last && last.bold === bold && last.italic === italic) last.text += text;
    else runs.push({ text, bold, italic });
  };
  const visit = (tokens: readonly Token[], bold = false, italic = false) => {
    for (const token of tokens) {
      if (token.type === "br") {
        push("\n", bold, italic);
        continue;
      }
      if (token.type === "html") {
        push(plainHtml(token.text), bold, italic);
        continue;
      }
      if ("tokens" in token && token.tokens) {
        visit(
          token.tokens,
          bold || token.type === "strong",
          italic || token.type === "em",
        );
        continue;
      }
      if ("text" in token && typeof token.text === "string")
        push(plainHtml(token.text), bold, italic);
      else if (token.type === "space") push("\n", bold, italic);
      else push(token.raw, bold, italic);
    }
  };
  const source = dedent(
    label.replace(/<br\/>/g, "\n").replace(/\n{2,}/g, "\n"),
  );
  visit(marked.lexer(source));
  return runs;
}
