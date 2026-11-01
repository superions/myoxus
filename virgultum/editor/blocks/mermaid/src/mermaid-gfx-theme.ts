// SPDX-License-Identifier: AGPL-3.0-or-later

import { getFontString, wrapText } from "@virgultum/gfx-text";
import { FontFamily } from "@virgultum/model";

export type MermaidGfxTypography = {
  displayFontSize: number;
  fontFamily: string;
  fontSize: number;
  fontStyle: string;
  fontWeight: string;
  letterSpacing: number;
  lineHeight: number;
  minimumReadableFontSize: number;
  sectionFontSize: number;
};

export type MermaidGfxTheme = {
  borderColor: string;
  errorColor: string;
  errorSurfaceColor: string;
  primaryColor: string;
  processingColor: string;
  processingSurfaceColor: string;
  secondarySurfaceColor: string;
  secondaryTextColor: string;
  successColor: string;
  successSurfaceColor: string;
  surfaceColor: string;
  textColor: string;
  typography: MermaidGfxTypography;
  warningColor: string;
  warningSurfaceColor: string;
};

const THEME_PROPERTIES = {
  borderColor: "--myoxus-border-color",
  errorColor: "--myoxus-error-color",
  errorSurfaceColor: "--myoxus-background-error-color",
  displayFontSize: "--myoxus-typography-h1-size",
  primaryColor: "--myoxus-primary-color",
  processingColor: "--myoxus-processing-color",
  processingSurfaceColor: "--myoxus-background-processing-color",
  secondarySurfaceColor: "--myoxus-background-secondary-color",
  secondaryTextColor: "--myoxus-text-secondary-color",
  successColor: "--myoxus-success-color",
  successSurfaceColor: "--myoxus-background-success-color",
  fontFamily: "--myoxus-typography-body-family",
  fontSize: "--myoxus-typography-body-size",
  fontStyle: "--myoxus-typography-body-font-style",
  fontWeight: "--myoxus-typography-body-weight",
  letterSpacing: "--myoxus-typography-body-letter-spacing",
  lineHeight: "--myoxus-typography-body-line-height",
  minimumReadableFontSize: "--myoxus-typography-body-small-size",
  sectionFontSize: "--myoxus-typography-h3-size",
  surfaceColor: "--myoxus-background-primary-color",
  textColor: "--myoxus-text-primary-color",
  warningColor: "--myoxus-warning-color",
  warningSurfaceColor: "--myoxus-background-warning-color",
} as const;

export const mermaidGfxThemeProperties = THEME_PROPERTIES;

const turnThemeProjections = new WeakMap<
  Element,
  { key: string; theme: MermaidGfxTheme }
>();

function projectedThemeColor(property: string) {
  // GFX colors are collaborative model values. Persist the server-owned
  // semantic CSS property, not the RGB value resolved for one participant's
  // current light/dark mode. The Surface theme provider resolves this stable
  // reference locally when it paints the canvas.
  return property;
}

export class MermaidGfxThemeUnavailableError extends Error {
  constructor(readonly property: string) {
    super(`Mermaid GFX requires the projected theme property ${property}.`);
    this.name = "MermaidGfxThemeUnavailableError";
  }
}

function requiredThemeProperty(style: CSSStyleDeclaration, property: string) {
  const value = style.getPropertyValue(property).trim();
  if (!value) throw new MermaidGfxThemeUnavailableError(property);
  return value;
}

function finiteCssPixels(value: string, property: string) {
  const parsed = Number.parseFloat(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new MermaidGfxThemeUnavailableError(property);
  }
  return parsed;
}

function canvasFontFamily(value: string): FontFamily {
  const fontFamily = value.trim();
  const quote = fontFamily[0];
  const unquoted =
    fontFamily.length >= 2 &&
    (quote === '"' || quote === "'") &&
    fontFamily.at(-1) === quote
      ? fontFamily.slice(1, -1).trim()
      : fontFamily;
  const normalized = unquoted.replaceAll(/[^a-z0-9]/gi, "").toLowerCase();
  const projectedFamily = Object.values(FontFamily).find(
    (family) =>
      family.slice(family.lastIndexOf(":") + 1).toLowerCase() === normalized,
  );
  // Keep deployed projection IDs; additional server families use their canonical names.
  return projectedFamily ?? unquoted;
}

/**
 * Resolves the server-owned runtime theme into the numeric values required by
 * canvas. No static typography or color fallback is permitted at this
 * boundary: Browser Web must already have a live theme projection, while
 * Electron/Admin may provide their generated projection.
 */
export function resolveMermaidGfxTheme(scope?: Element): MermaidGfxTheme {
  const themeScope =
    scope ??
    (typeof document === "undefined" ? undefined : document.documentElement);
  if (!themeScope) {
    throw new MermaidGfxThemeUnavailableError("document");
  }
  const scopeStyle = getComputedStyle(themeScope);
  const key = JSON.stringify([
    ...Object.values(THEME_PROPERTIES).map((property) =>
      requiredThemeProperty(scopeStyle, property),
    ),
    scopeStyle.color,
    scopeStyle.colorScheme,
    scopeStyle.fontSize,
    getComputedStyle(themeScope.ownerDocument.documentElement).fontSize,
  ]);
  const cached = turnThemeProjections.get(themeScope);
  if (cached?.key === key) {
    return { ...cached.theme, typography: { ...cached.theme.typography } };
  }

  const probe = themeScope.ownerDocument.createElement("span");
  probe.style.backgroundColor = `var(${THEME_PROPERTIES.surfaceColor})`;
  probe.style.borderBottomColor = `var(${THEME_PROPERTIES.successSurfaceColor})`;
  probe.style.borderLeftColor = `var(${THEME_PROPERTIES.borderColor})`;
  probe.style.borderRightColor = `var(${THEME_PROPERTIES.primaryColor})`;
  probe.style.borderTopColor = `var(${THEME_PROPERTIES.secondarySurfaceColor})`;
  probe.style.color = `var(${THEME_PROPERTIES.textColor})`;
  probe.style.fontFamily = `var(${THEME_PROPERTIES.fontFamily})`;
  probe.style.fontSize = `var(${THEME_PROPERTIES.fontSize})`;
  probe.style.fontStyle = `var(${THEME_PROPERTIES.fontStyle})`;
  probe.style.fontWeight = `var(${THEME_PROPERTIES.fontWeight})`;
  probe.style.letterSpacing = `var(${THEME_PROPERTIES.letterSpacing})`;
  probe.style.lineHeight = `var(${THEME_PROPERTIES.lineHeight})`;
  probe.style.outlineColor = `var(${THEME_PROPERTIES.secondaryTextColor})`;
  probe.style.textDecorationColor = `var(${THEME_PROPERTIES.successColor})`;
  probe.style.position = "absolute";
  probe.style.visibility = "hidden";
  probe.textContent = "M";
  themeScope.append(probe);
  try {
    const resolved = getComputedStyle(probe);
    const baseTheme = {
      borderColor: resolved.borderLeftColor,
      primaryColor: resolved.borderRightColor,
      secondarySurfaceColor: resolved.borderTopColor,
      secondaryTextColor: resolved.outlineColor,
      successColor: resolved.textDecorationColor,
      successSurfaceColor: resolved.borderBottomColor,
      surfaceColor: resolved.backgroundColor,
      textColor: resolved.color,
    };
    const resolveColor = (property: string) => {
      probe.style.color = `var(${property})`;
      return getComputedStyle(probe).color;
    };
    const theme = {
      ...baseTheme,
      errorColor: resolveColor(THEME_PROPERTIES.errorColor),
      errorSurfaceColor: resolveColor(THEME_PROPERTIES.errorSurfaceColor),
      processingColor: resolveColor(THEME_PROPERTIES.processingColor),
      processingSurfaceColor: resolveColor(
        THEME_PROPERTIES.processingSurfaceColor,
      ),
      typography: {
        displayFontSize: finiteCssPixels(
          requiredThemeProperty(scopeStyle, THEME_PROPERTIES.displayFontSize),
          THEME_PROPERTIES.displayFontSize,
        ),
        // Surface elements persist the namespaced FontFamily contract. Resolve
        // the server-owned CSS family to that identity here; the canvas
        // renderer owns CSS quoting through getFontString().
        fontFamily: canvasFontFamily(resolved.fontFamily),
        fontSize: finiteCssPixels(resolved.fontSize, THEME_PROPERTIES.fontSize),
        fontStyle: resolved.fontStyle,
        fontWeight: resolved.fontWeight,
        letterSpacing:
          resolved.letterSpacing === "normal"
            ? 0
            : Number.parseFloat(resolved.letterSpacing),
        lineHeight: finiteCssPixels(
          resolved.lineHeight,
          THEME_PROPERTIES.lineHeight,
        ),
        minimumReadableFontSize: finiteCssPixels(
          requiredThemeProperty(
            scopeStyle,
            THEME_PROPERTIES.minimumReadableFontSize,
          ),
          THEME_PROPERTIES.minimumReadableFontSize,
        ),
        sectionFontSize: finiteCssPixels(
          requiredThemeProperty(scopeStyle, THEME_PROPERTIES.sectionFontSize),
          THEME_PROPERTIES.sectionFontSize,
        ),
      },
      warningColor: resolveColor(THEME_PROPERTIES.warningColor),
      warningSurfaceColor: resolveColor(THEME_PROPERTIES.warningSurfaceColor),
    } satisfies MermaidGfxTheme;
    if (!Number.isFinite(theme.typography.letterSpacing)) {
      throw new MermaidGfxThemeUnavailableError(THEME_PROPERTIES.letterSpacing);
    }
    // One Surface transaction resolves the same theme for many properties and
    // toolbar candidates. Repeated DOM probes force style/layout each time.
    // Share only validated, unchanged inputs within this synchronous turn;
    // the next microtask remeasures, including theme/font readiness changes.
    const entry = { key, theme };
    turnThemeProjections.set(themeScope, entry);
    queueMicrotask(() => {
      if (turnThemeProjections.get(themeScope) === entry) {
        turnThemeProjections.delete(themeScope);
      }
    });
    return { ...theme, typography: { ...theme.typography } };
  } finally {
    probe.remove();
  }
}

/**
 * Returns the theme values that may safely be written into a collaborative
 * projection owner. Typography remains numeric because it owns shared layout;
 * colors stay as semantic CSS-property references so participants with
 * different light/dark preferences cannot overwrite each other's projection.
 */
export function resolveMermaidGfxProjectionTheme(
  scope?: Element,
): MermaidGfxTheme {
  const theme = resolveMermaidGfxTheme(scope);
  return {
    borderColor: projectedThemeColor(THEME_PROPERTIES.borderColor),
    errorColor: projectedThemeColor(THEME_PROPERTIES.errorColor),
    errorSurfaceColor: projectedThemeColor(THEME_PROPERTIES.errorSurfaceColor),
    primaryColor: projectedThemeColor(THEME_PROPERTIES.primaryColor),
    processingColor: projectedThemeColor(THEME_PROPERTIES.processingColor),
    processingSurfaceColor: projectedThemeColor(
      THEME_PROPERTIES.processingSurfaceColor,
    ),
    secondarySurfaceColor: projectedThemeColor(
      THEME_PROPERTIES.secondarySurfaceColor,
    ),
    secondaryTextColor: projectedThemeColor(
      THEME_PROPERTIES.secondaryTextColor,
    ),
    successColor: projectedThemeColor(THEME_PROPERTIES.successColor),
    successSurfaceColor: projectedThemeColor(
      THEME_PROPERTIES.successSurfaceColor,
    ),
    surfaceColor: projectedThemeColor(THEME_PROPERTIES.surfaceColor),
    textColor: projectedThemeColor(THEME_PROPERTIES.textColor),
    typography: theme.typography,
    warningColor: projectedThemeColor(THEME_PROPERTIES.warningColor),
    warningSurfaceColor: projectedThemeColor(
      THEME_PROPERTIES.warningSurfaceColor,
    ),
  };
}

/** Consume an existing server typography role without copying a native font literal. */
export function resolveMermaidGfxHeadingFont(scope = document.documentElement) {
  const style = getComputedStyle(scope);
  const family = "--myoxus-typography-h1-family";
  const fontStyle = "--myoxus-typography-h1-font-style";
  requiredThemeProperty(style, family);
  requiredThemeProperty(style, fontStyle);
  const probe = document.createElement("span");
  probe.hidden = true;
  probe.style.fontFamily = `var(${family})`;
  probe.style.fontStyle = `var(${fontStyle})`;
  scope.append(probe);
  try {
    const resolved = getComputedStyle(probe);
    return {
      fontFamily: canvasFontFamily(resolved.fontFamily),
      fontStyle: resolved.fontStyle,
    };
  } finally {
    probe.remove();
  }
}

let measureContext: CanvasRenderingContext2D | null = null;

function mermaidMeasureContext() {
  if (measureContext) return measureContext;
  if (typeof document === "undefined") {
    throw new MermaidGfxThemeUnavailableError("document");
  }
  const canvas = document.createElement("canvas");
  measureContext = canvas.getContext("2d");
  if (!measureContext) {
    throw new Error("Mermaid GFX requires canvas text measurement.");
  }
  return measureContext;
}

export function measureMermaidGfxText(
  text: string,
  typography: MermaidGfxTypography,
) {
  const context = mermaidMeasureContext();
  // Use the renderer's namespaced-family resolution; raw identities are not valid CSS fonts.
  context.font = getFontString(typography);
  const lines = text
    .replaceAll("\r\n", "\n")
    .replaceAll("\r", "\n")
    .split("\n");
  return {
    height: typography.lineHeight * Math.max(lines.length, 1),
    lineHeight: typography.lineHeight,
    width: Math.max(
      0,
      ...lines.map(
        (line) =>
          context.measureText(line).width +
          Math.max(Array.from(line).length - 1, 0) * typography.letterSpacing,
      ),
    ),
  };
}

/** Single-line renderer ink metrics, including italic/fallback-glyph overhang.
 * Advance alone cannot protect the physical bounds of a centered label. */
export function measureMermaidGfxTextInk(
  text: string,
  typography: MermaidGfxTypography,
) {
  const context = mermaidMeasureContext();
  context.font = getFontString(typography);
  context.textAlign = "left";
  const metrics = context.measureText(text);
  const spacing =
    Math.max(Array.from(text).length - 1, 0) * typography.letterSpacing;
  return {
    advance: metrics.width + spacing,
    left: metrics.actualBoundingBoxLeft ?? 0,
    right: (metrics.actualBoundingBoxRight ?? metrics.width) + spacing,
    ascent: Math.max(
      metrics.actualBoundingBoxAscent ?? 0,
      metrics.fontBoundingBoxAscent ?? typography.fontSize,
    ),
    descent: Math.max(
      metrics.actualBoundingBoxDescent ?? 0,
      metrics.fontBoundingBoxDescent ?? 0,
    ),
  };
}

export function mermaidGfxShapeSize(
  text: string,
  typography: MermaidGfxTypography,
) {
  const content = measureMermaidGfxText(text, typography);
  return {
    height: content.height + typography.lineHeight,
    width: content.width + typography.lineHeight * 2,
  };
}

export function mermaidGfxLayoutMetrics(typography: MermaidGfxTypography) {
  return {
    blockGap: typography.lineHeight,
    groupBlockInset: typography.lineHeight,
    groupInlineInset: typography.lineHeight,
    inlineGap: typography.lineHeight * 2,
  };
}

export function mermaidGfxTypographyKey(typography: MermaidGfxTypography) {
  return JSON.stringify({
    ...typography,
    measuredProbeWidth: measureMermaidGfxText("MmWwi09◇☁⛁◉◎▤", typography)
      .width,
  });
}

export function mermaidGfxTypographyForNode(
  node: {
    fontFamily?: string;
    fontSize?: number;
    fontStyle?: string;
    fontWeight?: string;
  },
  theme = resolveMermaidGfxTheme(),
): MermaidGfxTypography {
  const fontSize = node.fontSize ?? theme.typography.fontSize;
  if (!Number.isFinite(fontSize) || fontSize <= 0) {
    throw new MermaidGfxThemeUnavailableError(THEME_PROPERTIES.fontSize);
  }
  const scale = fontSize / theme.typography.fontSize;
  return {
    displayFontSize: theme.typography.displayFontSize,
    fontFamily: node.fontFamily ?? theme.typography.fontFamily,
    fontSize,
    fontStyle: node.fontStyle ?? theme.typography.fontStyle,
    fontWeight: node.fontWeight ?? theme.typography.fontWeight,
    letterSpacing: theme.typography.letterSpacing * scale,
    lineHeight: theme.typography.lineHeight * scale,
    minimumReadableFontSize: theme.typography.minimumReadableFontSize,
    sectionFontSize: theme.typography.sectionFontSize,
  };
}

export function mermaidGfxLabelPadding(
  theme: MermaidGfxTheme = resolveMermaidGfxTheme(),
) {
  return [
    theme.typography.lineHeight / 2,
    theme.typography.lineHeight,
  ] as const;
}

function wrappedMermaidGfxLabelLineCount(
  label: string,
  availableWidth: number,
  typography: MermaidGfxTypography,
) {
  const font = getFontString(typography);
  return wrapText(
    label.replaceAll("\r\n", "\n").replaceAll("\r", "\n"),
    font,
    availableWidth,
  ).split("\n").length;
}

export function fitMermaidGfxLabelFontSize(
  label: string,
  geometry: { readonly height: number; readonly width: number },
  style: {
    readonly fontFamily?: string;
    readonly fontStyle?: string;
    readonly fontWeight?: string;
    readonly minimumFontSize?: number;
    readonly maximumFontSize?: number;
  } = {},
  theme: MermaidGfxTheme = resolveMermaidGfxTheme(),
) {
  const [verticalPadding, horizontalPadding] = mermaidGfxLabelPadding(theme);
  const availableHeight = geometry.height - verticalPadding * 2;
  const availableWidth = geometry.width - horizontalPadding * 2;
  const minimumFontSize =
    style.minimumFontSize ?? theme.typography.sectionFontSize;
  if (availableHeight <= 0 || availableWidth <= 0) return minimumFontSize;

  const step = Math.max(
    theme.typography.fontSize - theme.typography.minimumReadableFontSize,
    1,
  );
  // Diagram labels are viewed through a camera and therefore need a bounded
  // lift above the ordinary UI display size. One adjacent live-theme scale
  // step keeps short labels legible without dominating the fixed shape
  // geometry; explicit source font sizes remain authoritative.
  const maximumFontSize =
    style.maximumFontSize ?? theme.typography.displayFontSize + step;
  for (
    let fontSize = maximumFontSize;
    fontSize >= minimumFontSize;
    fontSize -= step
  ) {
    const typography = mermaidGfxTypographyForNode(
      { ...style, fontSize },
      theme,
    );
    const lineCount = wrappedMermaidGfxLabelLineCount(
      label,
      availableWidth,
      typography,
    );
    if (lineCount * typography.lineHeight <= availableHeight) {
      return fontSize;
    }
  }
  return minimumFontSize;
}
