// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Hover-variable derivation for runtime theme loaders.
//
// Parses --myoxus-sem-* tokens from the CSS text returned by
// /api/branding/theme.css, runs deriveHoverPair, and appends the hover pair
// variables to all 4 CSS contexts in the injected style element.
//
// Enforces INV-THEME-HOVER-01: hover bg/fg are always emitted or omitted
// together (pairwise atomicity). Missing base token → the whole pair is skipped.
//
// Reference: docs/dev/branding/theme/hover-state-architecture.md

import { deriveHoverPair, type HexColor, HoverDerivationError } from "./hover";

type HoverPairSpec = {
  bg: string;
  fg?: string;
  fallbackFg?: HexColor;
  outBg: string;
  outFg: string;
};

// Maps kebab-cased --myoxus-sem-* keys to runtime hover output variables.
// Destructive buttons derive from the semantic error color. Server themes do
// not need a separate destructive foreground token; white is the existing
// product contract for destructive call-to-action text and deriveHoverPair
// still verifies the resulting hover pair.
const HOVER_PAIRS: readonly HoverPairSpec[] = [
  {
    bg: "button-primary-bg",
    fg: "button-primary-fg",
    outBg: "--myoxus-btn-primary-hover-bg",
    outFg: "--myoxus-btn-primary-hover-fg",
  },
  {
    bg: "button-secondary-bg",
    fg: "button-secondary-fg",
    outBg: "--myoxus-btn-secondary-hover-bg",
    outFg: "--myoxus-btn-secondary-hover-fg",
  },
  {
    bg: "surface-card",
    fg: "text-primary",
    outBg: "--myoxus-overlay-hover-bg",
    outFg: "--myoxus-overlay-hover-fg",
  },
  {
    bg: "status-error",
    fallbackFg: "#ffffff" as HexColor,
    outBg: "--myoxus-btn-destructive-hover-bg",
    outFg: "--myoxus-btn-destructive-hover-fg",
  },
] as const satisfies readonly HoverPairSpec[];

const SEM_HEX_RE = /--myoxus-sem-([\w-]+)\s*:\s*(#[0-9a-fA-F]{3,8})\s*;/g;

function extractSemVars(block: string): Map<string, HexColor> {
  const map = new Map<string, HexColor>();
  SEM_HEX_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = SEM_HEX_RE.exec(block)) !== null) {
    const key = m[1];
    const value = m[2];
    if (!key || !value) continue;
    map.set(key, value as HexColor);
  }
  return map;
}

function buildHoverCssLines(
  vars: Map<string, HexColor>,
  indent: string,
): string {
  let out = "";
  for (const { bg, fg, fallbackFg, outBg, outFg } of HOVER_PAIRS) {
    const bgVal = vars.get(bg);
    const fgVal = fg ? vars.get(fg) : fallbackFg;
    if (!bgVal || !fgVal) continue; // pairwise: skip both if either is absent
    try {
      const pair = deriveHoverPair(bgVal, fgVal);
      out += `${indent}${outBg}: ${pair.hoverBg};\n`;
      out += `${indent}${outFg}: ${pair.hoverFg};\n`;
    } catch (e) {
      if (!(e instanceof HoverDerivationError)) throw e;
      // Derivation failed — skip both variables atomically (pairwise invariant)
    }
  }
  return out;
}

/**
 * Finds the content between the first `{…}` pair after `prefix` in `css`.
 * Handles nested braces (e.g. @media rules).
 */
export function findBlockContent(css: string, prefix: string): string {
  const idx = css.indexOf(prefix);
  if (idx === -1) return "";
  const openIdx = css.indexOf("{", idx);
  if (openIdx === -1) return "";
  let depth = 1;
  let i = openIdx + 1;
  while (i < css.length && depth > 0) {
    if (css[i] === "{") depth++;
    else if (css[i] === "}") depth--;
    i++;
  }
  return depth === 0 ? css.slice(openIdx + 1, i - 1) : "";
}

/**
 * Parses the CSS text from /api/branding/theme.css, derives WCAG-safe hover
 * pairs via deriveHoverPair, and appends them as additional CSS rule blocks.
 *
 * The four server-emitted CSS contexts (`:root`, `@media dark :root`,
 * `[data-theme='light']`, `[data-theme='dark']`) each get a corresponding
 * hover-pair block appended at the end of the returned CSS string.
 *
 * If any base token is missing the corresponding hover pair is omitted
 * entirely (pairwise atomicity per INV-THEME-HOVER-01).
 */
export function appendHoverVariables(css: string): string {
  // Use explicit data-theme blocks — unambiguous, always emitted by server
  let lightBlock = findBlockContent(css, "[data-theme='light']");
  if (!lightBlock) {
    lightBlock = findBlockContent(css, ":root");
  }

  let darkBlock = findBlockContent(css, "[data-theme='dark']");
  if (!darkBlock) {
    const mediaIdx = css.indexOf("@media (prefers-color-scheme: dark)");
    if (mediaIdx !== -1) {
      const mediaContent = findBlockContent(css.slice(mediaIdx), "@media");
      darkBlock = findBlockContent(mediaContent, ":root");
    }
  }

  const lightVars = extractSemVars(lightBlock);
  const darkVars = extractSemVars(darkBlock || lightBlock);

  const lightLines = buildHoverCssLines(lightVars, "  ");
  const darkLines = buildHoverCssLines(darkVars, "  ");
  const darkLinesIndented = buildHoverCssLines(darkVars, "    ");

  if (!lightLines && !darkLines) return css;

  const extra = [
    "/* Hover pairs — derived by @myoxus/theme deriveHoverPair (INV-THEME-HOVER-01) */",
    `:root {\n${lightLines}}`,
    `@media (prefers-color-scheme: dark) {\n  :root {\n${darkLinesIndented}  }\n}`,
    `[data-theme='light'] {\n${lightLines}}`,
    `[data-theme='dark'] {\n${darkLines}}`,
  ].join("\n\n");

  return `${css}\n\n${extra}`;
}
