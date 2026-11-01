// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Frozen snapshot of preset base tokens at commit time of SHARED-01.
//
// Source: frozen legacy preset snapshot retained for hover.spec.ts algorithm
// regressions. Runtime admin theming now uses the v2 city-theme registry.
//
// These fixtures are test-only and must not be used as runtime preset data. Update deliberately together with
// client/libs/theme/src/hover.spec.ts when presets move.
//
// Presets `default-current` and `custom` are intentionally excluded:
// `default-current` delegates to whatever is currently configured and has
// no frozen base tokens; `custom` is user-defined. The 10 concrete
// presets below cover every shape the derivation must handle.

import type { HexColor } from "./hover";

export type PresetMode = "light" | "dark";

export interface PresetBaseTokens {
  buttonPrimaryBg: HexColor;
  buttonPrimaryFg: HexColor;
  buttonSecondaryBg: HexColor;
  buttonSecondaryFg: HexColor;
  surfaceCard: HexColor;
  textPrimary: HexColor;
}

export type PresetFixture = Record<PresetMode, PresetBaseTokens>;

export const PRESET_FIXTURES: Record<string, PresetFixture> = {
  "warm-soft": {
    light: {
      buttonPrimaryBg: "#b45a3c",
      buttonPrimaryFg: "#ffffff",
      buttonSecondaryBg: "#f3e3d8",
      buttonSecondaryFg: "#4e382f",
      surfaceCard: "#fffdfc",
      textPrimary: "#3c2b24",
    },
    dark: {
      buttonPrimaryBg: "#d4886a",
      buttonPrimaryFg: "#1e1714",
      buttonSecondaryBg: "#4a3830",
      buttonSecondaryFg: "#e8d5ca",
      surfaceCard: "#2a201b",
      textPrimary: "#f5e9e3",
    },
  },
  "warm-contrast": {
    light: {
      buttonPrimaryBg: "#9e3316",
      buttonPrimaryFg: "#ffffff",
      buttonSecondaryBg: "#f5e6de",
      buttonSecondaryFg: "#2f1d16",
      surfaceCard: "#ffffff",
      textPrimary: "#2f1d16",
    },
    dark: {
      buttonPrimaryBg: "#ff9a6e",
      buttonPrimaryFg: "#171110",
      buttonSecondaryBg: "#4a3833",
      buttonSecondaryFg: "#f0ddd5",
      surfaceCard: "#231a18",
      textPrimary: "#fff1ea",
    },
  },
  "vivid-balanced": {
    light: {
      buttonPrimaryBg: "#255de5",
      buttonPrimaryFg: "#ffffff",
      buttonSecondaryBg: "#e8eeff",
      buttonSecondaryFg: "#1c2232",
      surfaceCard: "#ffffff",
      textPrimary: "#1c2232",
    },
    dark: {
      buttonPrimaryBg: "#72a2ff",
      buttonPrimaryFg: "#101521",
      buttonSecondaryBg: "#304063",
      buttonSecondaryFg: "#d8e4f8",
      surfaceCard: "#182033",
      textPrimary: "#edf3ff",
    },
  },
  reduced: {
    light: {
      buttonPrimaryBg: "#505050",
      buttonPrimaryFg: "#ffffff",
      buttonSecondaryBg: "#ebebeb",
      buttonSecondaryFg: "#333333",
      surfaceCard: "#f5f5f5",
      textPrimary: "#1a1a1a",
    },
    dark: {
      buttonPrimaryBg: "#a0a0a0",
      buttonPrimaryFg: "#161616",
      buttonSecondaryBg: "#333333",
      buttonSecondaryFg: "#d0d0d0",
      surfaceCard: "#1e1e1e",
      textPrimary: "#e8e8e8",
    },
  },
  arctic: {
    light: {
      buttonPrimaryBg: "#2b6cb0",
      buttonPrimaryFg: "#ffffff",
      buttonSecondaryBg: "#e2e8f0",
      buttonSecondaryFg: "#2d3748",
      surfaceCard: "#edf2f7",
      textPrimary: "#1a202c",
    },
    dark: {
      buttonPrimaryBg: "#63b3ed",
      buttonPrimaryFg: "#0d1b2a",
      buttonSecondaryBg: "#2d4a5e",
      buttonSecondaryFg: "#e2e8f0",
      surfaceCard: "#1b2838",
      textPrimary: "#e2e8f0",
    },
  },
  vibrant: {
    light: {
      buttonPrimaryBg: "#7c3aed",
      buttonPrimaryFg: "#ffffff",
      buttonSecondaryBg: "#f3e8ff",
      buttonSecondaryFg: "#5b21b6",
      surfaceCard: "#fff5f9",
      textPrimary: "#1f0a1e",
    },
    dark: {
      buttonPrimaryBg: "#a78bfa",
      buttonPrimaryFg: "#150a1e",
      buttonSecondaryBg: "#3d2a4a",
      buttonSecondaryFg: "#e8d5f5",
      surfaceCard: "#1f1028",
      textPrimary: "#f5e6ff",
    },
  },
  accessible: {
    light: {
      buttonPrimaryBg: "#0055a4",
      buttonPrimaryFg: "#ffffff",
      buttonSecondaryBg: "#e8e8e8",
      buttonSecondaryFg: "#000000",
      surfaceCard: "#f5f5f5",
      textPrimary: "#000000",
    },
    dark: {
      buttonPrimaryBg: "#6cb4ee",
      buttonPrimaryFg: "#121212",
      buttonSecondaryBg: "#404040",
      buttonSecondaryFg: "#ffffff",
      surfaceCard: "#1e1e1e",
      textPrimary: "#ffffff",
    },
  },
  sunset: {
    light: {
      buttonPrimaryBg: "#b84800",
      buttonPrimaryFg: "#ffffff",
      buttonSecondaryBg: "#f5e0cc",
      buttonSecondaryFg: "#4a2c1a",
      surfaceCard: "#ffefe0",
      textPrimary: "#2c1810",
    },
    dark: {
      buttonPrimaryBg: "#f0a070",
      buttonPrimaryFg: "#1a110d",
      buttonSecondaryBg: "#4a3528",
      buttonSecondaryFg: "#f0d8c4",
      surfaceCard: "#251a14",
      textPrimary: "#ffe8d6",
    },
  },
  midnight: {
    light: {
      buttonPrimaryBg: "#1a365d",
      buttonPrimaryFg: "#ffffff",
      buttonSecondaryBg: "#d8e4f0",
      buttonSecondaryFg: "#1a365d",
      surfaceCard: "#e4eaf0",
      textPrimary: "#1a202c",
    },
    dark: {
      buttonPrimaryBg: "#7bb5f0",
      buttonPrimaryFg: "#0a0e18",
      buttonSecondaryBg: "#253050",
      buttonSecondaryFg: "#c0d0e8",
      surfaceCard: "#121828",
      textPrimary: "#e0e8f0",
    },
  },
  forest: {
    light: {
      buttonPrimaryBg: "#276749",
      buttonPrimaryFg: "#ffffff",
      buttonSecondaryBg: "#dde8d5",
      buttonSecondaryFg: "#2d4a2d",
      surfaceCard: "#eff5eb",
      textPrimary: "#1a2e1a",
    },
    dark: {
      buttonPrimaryBg: "#68d391",
      buttonPrimaryFg: "#0d1a0d",
      buttonSecondaryBg: "#2a4a2a",
      buttonSecondaryFg: "#c8e8c8",
      surfaceCard: "#142014",
      textPrimary: "#e0f0e0",
    },
  },
};

export const PRESET_MODES: PresetMode[] = ["light", "dark"];
export const PRESET_IDS = Object.keys(PRESET_FIXTURES);
