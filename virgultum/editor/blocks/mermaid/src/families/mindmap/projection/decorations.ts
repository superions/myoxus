// SPDX-License-Identifier: AGPL-3.0-or-later
import { marked, type Token } from "marked";
import {
  CloudWorkspaceIconOutline,
  DatabaseIconOutline,
  StarIconOutline,
  MindmapIconOutline,
  CheckCircleIconOutline,
} from "@myoxus/icons/outline";
import { dedent } from "ts-dedent";
import DOMPurify from "dompurify";

// Explicit bundled resources, not aliases for unavailable Font Awesome/Iconify
// packs. Unknown names remain authored Source and are diagnosed by the controls.
export const mindmapBundledIcons = {
  "myoxus:cloud": CloudWorkspaceIconOutline,
  "myoxus:database": DatabaseIconOutline,
  "myoxus:star": StarIconOutline,
  "myoxus:mindmap": MindmapIconOutline,
  "myoxus:check-circle": CheckCircleIconOutline,
} as const;
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
  const outline = mindmapBundledIcons[name as keyof typeof mindmapBundledIcons];
  return { ...outline, strokeWidth: iconStrokeWidth(outline.strokeWidth) };
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
