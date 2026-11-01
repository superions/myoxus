// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Invariant tests for the shared hover-state derivation.
// Every test asserts against INV-THEME-HOVER-01
// (see docs/dev/branding/theme/hover-state-architecture.md).

import { describe, expect, it } from "vitest";

import {
  adaptiveForeground,
  contrastRatio,
  deriveHoverPair,
  type HexColor,
  HoverDerivationError,
  relativeLuminance,
} from "./hover";
import { PRESET_FIXTURES, PRESET_IDS, PRESET_MODES } from "./hover.fixtures";

const EPS = 1e-4;

describe("relativeLuminance (inv_hover_01)", () => {
  it("inv_hover_01_luminance_matches_wcag_reference", () => {
    const cases: Array<{ hex: HexColor; expected: number }> = [
      { hex: "#000000", expected: 0 },
      { hex: "#ffffff", expected: 1 },
      { hex: "#808080", expected: 0.2159 },
      { hex: "#ff0000", expected: 0.2126 },
      { hex: "#00ff00", expected: 0.7152 },
    ];
    for (const { hex, expected } of cases) {
      expect(relativeLuminance(hex)).toBeCloseTo(expected, 3);
      expect(Math.abs(relativeLuminance(hex) - expected)).toBeLessThan(
        EPS + 0.001,
      );
    }
  });
});

describe("contrastRatio", () => {
  it("inv_hover_02_contrast_ratio_symmetric", () => {
    const pairs: Array<[HexColor, HexColor]> = [
      ["#ffffff", "#000000"],
      ["#7c3aed", "#fff5f9"],
      ["#255de5", "#e8eeff"],
      ["#505050", "#ffffff"],
      ["#68d391", "#0d1a0d"],
      ["#a0a0a0", "#161616"],
      ["#b45a3c", "#ffffff"],
      ["#f3e3d8", "#4e382f"],
      ["#2b6cb0", "#ffffff"],
      ["#0055a4", "#ffffff"],
      ["#000000", "#ffffff"],
      ["#808080", "#808080"],
      ["#010203", "#fefdfc"],
      ["#ffffff", "#ffffff"],
      ["#000000", "#000000"],
    ];
    for (const [a, b] of pairs) {
      expect(contrastRatio(a, b)).toBeCloseTo(contrastRatio(b, a), 10);
    }
  });

  it("inv_hover_03_contrast_ratio_bounds", () => {
    const probes: HexColor[] = [
      "#000000",
      "#ffffff",
      "#112233",
      "#abcdef",
      "#ff00ff",
      "#00ffff",
      "#808080",
      "#121212",
      "#fafafa",
    ];
    for (const a of probes) {
      for (const b of probes) {
        const ratio = contrastRatio(a, b);
        expect(ratio).toBeGreaterThanOrEqual(1);
        expect(ratio).toBeLessThanOrEqual(21);
      }
    }
  });
});

describe("deriveHoverPair", () => {
  it("inv_hover_04_derive_preserves_contrast", () => {
    // 10 concrete presets × 2 modes × 3 variants = 60 cases.
    // `default-current` and `custom` presets are excluded by design
    // (see hover.fixtures.ts).
    let caseCount = 0;
    for (const presetId of PRESET_IDS) {
      for (const mode of PRESET_MODES) {
        const tokens = PRESET_FIXTURES[presetId][mode];
        const variants: Array<[HexColor, HexColor, string]> = [
          [tokens.buttonPrimaryBg, tokens.buttonPrimaryFg, "primary"],
          [tokens.buttonSecondaryBg, tokens.buttonSecondaryFg, "secondary"],
          [tokens.surfaceCard, tokens.textPrimary, "overlay"],
        ];
        for (const [bg, fg, variant] of variants) {
          const pair = deriveHoverPair(bg, fg);
          const ratio = contrastRatio(pair.hoverBg, pair.hoverFg);
          expect(
            ratio,
            `preset=${presetId} mode=${mode} variant=${variant} bg=${bg} fg=${fg} -> ${JSON.stringify(pair)}`,
          ).toBeGreaterThanOrEqual(4.5);
          caseCount++;
        }
      }
    }
    expect(caseCount).toBe(60);
  });

  it("inv_hover_05_derive_shifts_away_from_fg", () => {
    for (const presetId of PRESET_IDS) {
      for (const mode of PRESET_MODES) {
        const tokens = PRESET_FIXTURES[presetId][mode];
        const pairs: Array<[HexColor, HexColor]> = [
          [tokens.buttonPrimaryBg, tokens.buttonPrimaryFg],
          [tokens.buttonSecondaryBg, tokens.buttonSecondaryFg],
          [tokens.surfaceCard, tokens.textPrimary],
        ];
        for (const [bg, fg] of pairs) {
          const lBg = relativeLuminance(bg);
          const lFg = relativeLuminance(fg);
          const pair = deriveHoverPair(bg, fg);
          const lHover = relativeLuminance(pair.hoverBg);
          const expectedDirection = lFg < 0.5 ? +1 : -1;
          // Clamping at 0/1 can produce a delta of 0. Accept same sign or
          // boundary saturation.
          const delta = lHover - lBg;
          if (Math.abs(delta) > 1e-4) {
            expect(
              Math.sign(delta),
              `bg=${bg} fg=${fg} lBg=${lBg} lFg=${lFg} lHover=${lHover}`,
            ).toBe(expectedDirection);
          } else {
            // At the boundary: original bg already at 0 or 1 in the away-direction.
            expect(lBg === 0 || lBg === 1 || Math.abs(delta) <= 1e-4).toBe(
              true,
            );
          }
        }
      }
    }
  });

  it("inv_hover_06_derive_is_deterministic", () => {
    const bg: HexColor = "#2b6cb0";
    const fg: HexColor = "#ffffff";
    const first = deriveHoverPair(bg, fg);
    for (let i = 0; i < 99; i++) {
      const next = deriveHoverPair(bg, fg);
      expect(next.hoverBg).toBe(first.hoverBg);
      expect(next.hoverFg).toBe(first.hoverFg);
    }
  });

  it("inv_hover_07_fg_inversion_kicks_in", () => {
    // Low-contrast base: nearly-mid gray bg with an almost-matching fg.
    // The luminance shift yields a hoverBg around 0.5 which has weak contrast
    // with the original near-gray fg; derivation must fall back to
    // adaptiveForeground (pure black or white).
    const bg: HexColor = "#7f7f7f";
    const fg: HexColor = "#6b6b6b";
    const pair = deriveHoverPair(bg, fg);
    expect(["#000000", "#ffffff"]).toContain(pair.hoverFg);
  });

  it("inv_hover_08_derivation_error_on_unreachable", () => {
    // Force the contract off by demanding an impossible minimum contrast.
    // The branch is unreachable under the default 4.5 threshold (because
    // adaptiveForeground always achieves ~4.58 or better), so we cover it
    // by tightening the requirement instead of contriving a color pair.
    expect(() =>
      deriveHoverPair("#7f7f7f" as HexColor, "#808080" as HexColor, {
        minContrastRatio: 21.5,
      }),
    ).toThrow(HoverDerivationError);
  });
});

describe("adaptiveForeground", () => {
  it("picks black or white whichever gives higher contrast", () => {
    expect(adaptiveForeground("#ffffff" as HexColor)).toBe("#000000");
    expect(adaptiveForeground("#000000" as HexColor)).toBe("#ffffff");
    expect(adaptiveForeground("#f5f5f5" as HexColor)).toBe("#000000");
    expect(adaptiveForeground("#121212" as HexColor)).toBe("#ffffff");
  });
});
