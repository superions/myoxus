// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Shared hover-state derivation for Myoxus theming.
//
// Enforces invariant INV-THEME-HOVER-01: for every variant (primary, secondary,
// overlay/ghost) × mode (light, dark) × preset, the emitted pair
// {state_bg, state_fg} achieves contrast ratio >= 4.5 (WCAG AA normal text).
//
// The pair is always derived atomically from the same base tokens so bg and fg
// can never drift apart at runtime.
//
// Reference: docs/dev/branding/theme/hover-state-architecture.md
// §"Deterministic Derivation Rule".

export type HexColor = `#${string}`;

export interface HoverPair {
  hoverBg: HexColor;
  hoverFg: HexColor;
}

export interface DeriveHoverOptions {
  /** Optional sink for luminance/contrast diagnostics. Default: no-op. */
  log?: (msg: string, ctx: object) => void;
  /**
   * Minimum contrast ratio required between hoverBg and hoverFg.
   * Defaults to 4.5 (WCAG AA normal text). Values above 21 make derivation
   * unreachable; tests use this to cover the error branch deterministically.
   */
  minContrastRatio?: number;
}

export class HoverDerivationError extends Error {
  public readonly bg: HexColor;
  public readonly fg: HexColor;
  public readonly achievedRatio: number;

  constructor(bg: HexColor, fg: HexColor, achievedRatio: number) {
    super(
      `HoverDerivationError: unable to derive pair with contrast >= 4.5 for bg=${bg} fg=${fg} (achieved ${achievedRatio.toFixed(3)})`,
    );
    this.name = "HoverDerivationError";
    this.bg = bg;
    this.fg = fg;
    this.achievedRatio = achievedRatio;
  }
}

const DEFAULT_MIN_CONTRAST = 4.5;
const LUMINANCE_SHIFT = 0.12;
const HEX_6_RE = /^#[0-9a-fA-F]{6}$/;
const HEX_3_RE = /^#[0-9a-fA-F]{3}$/;

function expand3DigitHex(hex: string): string {
  const h = hex.slice(1);
  return `#${h[0]}${h[0]}${h[1]}${h[1]}${h[2]}${h[2]}`;
}

function normalizeHex(hex: HexColor): string {
  if (HEX_6_RE.test(hex)) return hex.toLowerCase();
  if (HEX_3_RE.test(hex)) return expand3DigitHex(hex).toLowerCase();
  throw new TypeError(`Invalid hex color: ${hex}`);
}

function hexToRgb01(hex: HexColor): [number, number, number] {
  const full = normalizeHex(hex);
  const r = parseInt(full.slice(1, 3), 16) / 255;
  const g = parseInt(full.slice(3, 5), 16) / 255;
  const b = parseInt(full.slice(5, 7), 16) / 255;
  return [r, g, b];
}

function srgbToLinear(c: number): number {
  return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

function linearToSrgb(c: number): number {
  const clamped = Math.max(0, Math.min(1, c));
  return clamped <= 0.00303949
    ? clamped * 12.92
    : 1.055 * Math.pow(clamped, 1 / 2.4) - 0.055;
}

function hexToLinearRgb(hex: HexColor): [number, number, number] {
  const [r, g, b] = hexToRgb01(hex);
  return [srgbToLinear(r), srgbToLinear(g), srgbToLinear(b)];
}

function linearRgbToHex(rgb: [number, number, number]): HexColor {
  const toByte = (c: number) =>
    Math.max(0, Math.min(255, Math.round(linearToSrgb(c) * 255)));
  const toHex = (n: number) => n.toString(16).padStart(2, "0");
  const r = toByte(rgb[0]);
  const g = toByte(rgb[1]);
  const b = toByte(rgb[2]);
  const hex = `#${toHex(r)}${toHex(g)}${toHex(b)}`;
  return hex.toLowerCase() as HexColor;
}

/**
 * WCAG 2.1 relative luminance. Returns 0 (black) .. 1 (white).
 * @see https://www.w3.org/TR/WCAG21/#dfn-relative-luminance
 */
export function relativeLuminance(hex: HexColor): number {
  const [r, g, b] = hexToLinearRgb(hex);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/**
 * WCAG contrast ratio between two colors. Returns 1..21. Symmetric in arguments.
 * @see https://www.w3.org/TR/WCAG21/#dfn-contrast-ratio
 */
export function contrastRatio(a: HexColor, b: HexColor): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  const lighter = Math.max(la, lb);
  const darker = Math.min(la, lb);
  return (lighter + 0.05) / (darker + 0.05);
}

/**
 * Picks the foreground (`#000000` or `#ffffff`) with higher contrast against `bg`.
 *
 * This is the fallback when the original fg token does not remain WCAG-safe
 * against the shifted hover bg. Always succeeds: for every sRGB color, at
 * least one of black/white achieves a contrast ratio >= 4.58.
 */
export function adaptiveForeground(bg: HexColor): HexColor {
  const whiteContrast = contrastRatio(bg, "#ffffff" as HexColor);
  const blackContrast = contrastRatio(bg, "#000000" as HexColor);
  return blackContrast >= whiteContrast
    ? ("#000000" as HexColor)
    : ("#ffffff" as HexColor);
}

function shiftLuminance(bg: HexColor, targetLuminance: number): HexColor {
  const linear = hexToLinearRgb(bg);
  const currentY = 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2];

  // Fallback: if the source is (near-)black, per-channel scaling is undefined
  // (division by ~0). Mix linearly from black toward white by the target
  // luminance directly — gray with Y = targetLuminance.
  if (currentY < 1e-6) {
    return linearRgbToHex([targetLuminance, targetLuminance, targetLuminance]);
  }

  const k = targetLuminance / currentY;
  const scaled: [number, number, number] = [
    linear[0] * k,
    linear[1] * k,
    linear[2] * k,
  ];
  return linearRgbToHex(scaled);
}

/**
 * Derives a `{hoverBg, hoverFg}` pair from a base `(bg, fg)` token pair such
 * that the hover pair achieves WCAG AA contrast (>= 4.5) and visually shifts
 * the bg away from the fg's luminance (classic "button gets more pressed"
 * feel for dark buttons, "button gets brighter" for light ones).
 *
 * Algorithm (see architecture doc):
 *   1. L_bg, L_fg = relativeLuminance(bg, fg).
 *   2. direction = L_fg < 0.5 ? "lighten" : "darken" — move bg AWAY from fg.
 *   3. L_hover = clamp(L_bg ± 0.12, 0, 1).
 *   4. hoverBg = rescale linear-RGB of bg so its luminance hits L_hover.
 *   5. If contrastRatio(hoverBg, fg) >= 4.5 -> hoverFg = fg;
 *      else hoverFg = adaptiveForeground(hoverBg).
 *   6. Final check: contrastRatio(hoverBg, hoverFg) >= minContrastRatio
 *      (default 4.5); else throw HoverDerivationError.
 */
export function deriveHoverPair(
  bg: HexColor,
  fg: HexColor,
  opts: DeriveHoverOptions = {},
): HoverPair {
  const minContrast = opts.minContrastRatio ?? DEFAULT_MIN_CONTRAST;
  const lBg = relativeLuminance(bg);
  const lFg = relativeLuminance(fg);
  const direction = lFg < 0.5 ? "lighten" : "darken";
  const targetL =
    direction === "lighten"
      ? Math.min(1, lBg + LUMINANCE_SHIFT)
      : Math.max(0, lBg - LUMINANCE_SHIFT);

  const hoverBg = shiftLuminance(bg, targetL);
  const fgContrast = contrastRatio(hoverBg, fg);
  const hoverFg = fgContrast >= minContrast ? fg : adaptiveForeground(hoverBg);
  const achieved = contrastRatio(hoverBg, hoverFg);

  opts.log?.("deriveHoverPair", {
    bg,
    fg,
    lBg,
    lFg,
    direction,
    targetL,
    hoverBg,
    hoverFg,
    fgContrast,
    achieved,
  });

  if (achieved < minContrast) {
    throw new HoverDerivationError(bg, fg, achieved);
  }

  return { hoverBg, hoverFg };
}
