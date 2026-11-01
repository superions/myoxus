/**
 * @vitest-environment node
 *
 * Tests for appendHoverVariables (INV-THEME-HOVER-01 enforcement in the web runtime).
 */
import { describe, expect, test } from "vitest";

import { appendHoverVariables, findBlockContent } from "./hover-css";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a minimal but syntactically valid CSS block the server would emit. */
function makeCss(
  light: Record<string, string>,
  dark: Record<string, string>,
): string {
  const semVars = (tokens: Record<string, string>, indent: string) =>
    Object.entries(tokens)
      .map(([k, v]) => `${indent}--myoxus-sem-${k}: ${v};`)
      .join("\n");

  return [
    `:root {\n${semVars(light, "  ")}\n}`,
    `@media (prefers-color-scheme: dark) {\n  :root {\n${semVars(dark, "    ")}\n  }\n}`,
    `[data-theme='light'] {\n${semVars(light, "  ")}\n}`,
    `[data-theme='dark'] {\n${semVars(dark, "  ")}\n}`,
  ].join("\n\n");
}

const LIGHT_TOKENS = {
  "button-primary-bg": "#1E96EB",
  "button-primary-fg": "#FFFFFF",
  "button-secondary-bg": "#F5F5F5",
  "button-secondary-fg": "#2B2B2B",
  "surface-card": "#FFFFFF",
  "text-primary": "#2B2B2B",
  "status-error": "#B83224",
};

const DARK_TOKENS = {
  "button-primary-bg": "#72A2FF",
  "button-primary-fg": "#FFFFFF",
  "button-secondary-bg": "#2B2B2B",
  "button-secondary-fg": "#FFFFFF",
  "surface-card": "#1E1E1E",
  "text-primary": "#FFFFFF",
  "status-error": "#FF8A7A",
};

const FULL_CSS = makeCss(LIGHT_TOKENS, DARK_TOKENS);

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("appendHoverVariables", () => {
  test("inv_hover_34_web_all_runtime_hover_vars_set", () => {
    const result = appendHoverVariables(FULL_CSS);

    const hoverVarNames = [
      "--myoxus-btn-primary-hover-bg",
      "--myoxus-btn-primary-hover-fg",
      "--myoxus-btn-secondary-hover-bg",
      "--myoxus-btn-secondary-hover-fg",
      "--myoxus-overlay-hover-bg",
      "--myoxus-overlay-hover-fg",
      "--myoxus-btn-destructive-hover-bg",
      "--myoxus-btn-destructive-hover-fg",
    ];

    for (const v of hoverVarNames) {
      expect(result).toContain(v);
    }
  });

  test("inv_hover_32_web_mode_switch_atomic", () => {
    const result = appendHoverVariables(FULL_CSS);

    // Count occurrences of bg vs fg for each variant — must be equal
    const countBg = (result.match(/--myoxus-btn-primary-hover-bg/g) ?? [])
      .length;
    const countFg = (result.match(/--myoxus-btn-primary-hover-fg/g) ?? [])
      .length;
    expect(countBg).toBe(countFg);
    expect(countBg).toBeGreaterThan(0);

    const countOvBg = (result.match(/--myoxus-overlay-hover-bg/g) ?? []).length;
    const countOvFg = (result.match(/--myoxus-overlay-hover-fg/g) ?? []).length;
    expect(countOvBg).toBe(countOvFg);

    const countDestructiveBg = (
      result.match(/--myoxus-btn-destructive-hover-bg/g) ?? []
    ).length;
    const countDestructiveFg = (
      result.match(/--myoxus-btn-destructive-hover-fg/g) ?? []
    ).length;
    expect(countDestructiveBg).toBe(countDestructiveFg);

    // Both light (:root) and dark ([data-theme='dark']) contexts must have hover vars
    const rootBlock = findBlockContent(
      result.split("\n\n/* Hover")[1] ?? "",
      ":root",
    );
    expect(rootBlock).toContain("--myoxus-btn-primary-hover-bg");
    expect(rootBlock).toContain("--myoxus-btn-primary-hover-fg");

    const darkBlock = findBlockContent(
      result.split("\n\n/* Hover")[1] ?? "",
      "[data-theme='dark']",
    );
    expect(darkBlock).toContain("--myoxus-btn-primary-hover-bg");
    expect(darkBlock).toContain("--myoxus-btn-primary-hover-fg");
  });

  test("inv_hover_33_web_pair_never_orphan", () => {
    // Missing button-secondary-fg → neither secondary hover bg nor fg should appear
    const tokens = { ...LIGHT_TOKENS } as Record<string, string>;
    delete tokens["button-secondary-fg"];
    const css = makeCss(tokens, DARK_TOKENS);
    const result = appendHoverVariables(css);

    // Secondary hover vars must not appear in light context
    const lightSection = result.split("\n\n/* Hover")[1] ?? "";
    const lightRootBlock = findBlockContent(lightSection, ":root");
    expect(lightRootBlock).not.toContain("--myoxus-btn-secondary-hover-bg");
    expect(lightRootBlock).not.toContain("--myoxus-btn-secondary-hover-fg");

    // Other pairs must still appear (primary and overlay unaffected)
    expect(lightRootBlock).toContain("--myoxus-btn-primary-hover-bg");
    expect(lightRootBlock).toContain("--myoxus-btn-primary-hover-fg");
    expect(lightRootBlock).toContain("--myoxus-overlay-hover-bg");
    expect(lightRootBlock).toContain("--myoxus-overlay-hover-fg");
  });

  test("inv_hover_35_web_cleanup_removes_all_six", () => {
    // When there are no --myoxus-sem-* vars in the CSS, no hover vars are appended
    const emptyCss = ":root { --myoxus-primary-color: #1E96EB; }";
    const result = appendHoverVariables(emptyCss);
    expect(result).not.toContain("--myoxus-btn-primary-hover-bg");
    expect(result).not.toContain("--myoxus-btn-secondary-hover-bg");
    expect(result).not.toContain("--myoxus-overlay-hover-bg");
    expect(result).not.toContain("--myoxus-btn-destructive-hover-bg");
    // CSS is returned unchanged
    expect(result).toBe(emptyCss);
  });

  test("inv_hover_32b_hover_values_are_valid_hex", () => {
    const result = appendHoverVariables(FULL_CSS);
    const hexValuesRe =
      /--myoxus-(?:btn-\w+-|overlay-)hover-(?:bg|fg):\s*(#[0-9a-fA-F]{3,8})/g;
    const matches = [...result.matchAll(hexValuesRe)];
    expect(matches.length).toBeGreaterThanOrEqual(8 * 4); // 8 vars × 4 contexts
    for (const [, hex] of matches) {
      expect(hex).toMatch(/^#[0-9a-fA-F]{6}$/);
    }
  });

  test("inv_hover_34b_all_four_css_contexts_have_hover_vars", () => {
    const result = appendHoverVariables(FULL_CSS);
    const hoverSection = result.split("\n\n/* Hover")[1] ?? "";

    const contexts = [
      ":root",
      "@media (prefers-color-scheme: dark)",
      "[data-theme='light']",
      "[data-theme='dark']",
    ];

    for (const ctx of contexts) {
      expect(hoverSection).toContain(ctx);
    }
  });

  test("returns original css unchanged when input is empty string", () => {
    expect(appendHoverVariables("")).toBe("");
  });
});
