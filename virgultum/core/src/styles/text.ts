import type { StyleInfo } from "lit/directives/style-map.js";

import type { MyoxusLabelTone, MyoxusTextAttributes } from "../types";

const labelToneColors: Record<
  MyoxusLabelTone,
  Pick<StyleInfo, "background-color" | "color">
> = {
  neutral: {
    "background-color": "var(--myoxus-sem-surface-muted)",
    color: "var(--myoxus-sem-ink-soft)",
  },
  info: {
    "background-color": "var(--myoxus-sem-status-info-paper)",
    color: "var(--myoxus-sem-status-info-deep)",
  },
  positive: {
    "background-color": "var(--myoxus-sem-status-success-paper)",
    color: "var(--myoxus-sem-status-success-deep)",
  },
  warning: {
    "background-color": "var(--myoxus-sem-status-pending-paper)",
    color: "var(--myoxus-sem-status-pending-deep)",
  },
  danger: {
    "background-color": "var(--myoxus-sem-status-error-paper)",
    color: "var(--myoxus-sem-status-error-deep)",
  },
  accent: {
    "background-color": "var(--myoxus-sem-status-preset-paper)",
    color: "var(--myoxus-accent-primary)",
  },
};

export function isMyoxusLabelTone(value: unknown): value is MyoxusLabelTone {
  return typeof value === "string" && value in labelToneColors;
}

/**
 * Resolves the persisted semantic tone into theme-owned label chrome. Invalid
 * future or imported values deliberately return no decoration so the literal
 * document text remains readable instead of acquiring an accidental meaning.
 */
export function myoxusLabelToneStyles(value: unknown): StyleInfo {
  if (!isMyoxusLabelTone(value)) return {};

  return {
    ...labelToneColors[value],
    display: "inline",
    "box-decoration-break": "clone",
    "-webkit-box-decoration-break": "clone",
    "border-radius": "var(--mantine-radius-sm)",
    "font-family": "var(--myoxus-typography-label-compact-family)",
    "font-size": "var(--myoxus-typography-label-compact-size)",
    "font-style": "var(--myoxus-typography-label-compact-font-style)",
    "font-weight": "var(--myoxus-typography-label-compact-weight)",
    "letter-spacing": "var(--myoxus-typography-label-compact-letter-spacing)",
    "line-height": "var(--myoxus-typography-label-compact-line-height)",
    "padding-block": "var(--mantine-spacing-2xs)",
    "padding-inline": "var(--mantine-spacing-xs)",
  };
}

export function myoxusTextStyles(
  props: MyoxusTextAttributes,
  override?: Readonly<StyleInfo>,
): StyleInfo {
  let textDecorations = "";
  if (props.underline) {
    textDecorations += "underline";
  }
  if (props.strike) {
    textDecorations += " line-through";
  }

  let inlineCodeStyle = {};
  if (props.code) {
    inlineCodeStyle = {
      "font-family": "var(--myoxus-typography-mono-family)",
      "font-size":
        "calc(var(--myoxus-typography-mono-size) * var(--myoxus-document-reading-scale, 1))",
      "font-weight": props.bold
        ? "bolder"
        : "var(--myoxus-typography-mono-weight)",
      "font-style": props.italic
        ? "italic"
        : "var(--myoxus-typography-mono-font-style)",
      "letter-spacing": "var(--myoxus-typography-mono-letter-spacing)",
      background: "var(--myoxus-background-code-block)",
      border: "1px solid var(--myoxus-border-color)",
      "border-radius": "4px",
      color: "var(--myoxus-text-primary-color)",
      "font-variant-ligatures": "none",
      "vertical-align": "bottom",
      "line-height": "var(--myoxus-typography-mono-line-height)",
    };
  }

  return {
    "font-weight": props.bold ? "bolder" : "inherit",
    "font-style": props.italic ? "italic" : "inherit",
    "background-color": props.background ? props.background : undefined,
    // Neon fills stay bright in both modes; only their default ink is fixed.
    // Authored text colors still win, and historical pastel fills keep inheriting.
    color:
      props.color ||
      (/^var\(--myoxus-sem-text-marker-(yellow|green|pink|orange|blue)\)$/.test(
        props.background ?? "",
      )
        ? "var(--myoxus-sem-text-marker-ink)"
        : undefined),
    "text-decoration": textDecorations.length > 0 ? textDecorations : "none",
    ...inlineCodeStyle,
    ...myoxusLabelToneStyles(props.labelTone),
    ...override,
  };
}
