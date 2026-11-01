// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Helsinki — Nordic-Refined (P-AR-1-T-C, expressive-existing).
//
// Character: nordic-refined, deep greens with bone-paper warmth.
// Display uses Orelega One (modern display-serif with strong
// character); Body is PT Serif for editorial calm; Mono is JetBrains
// Mono. Light mode: bone off-white paper with deep fir-green ink.
// Dark mode: deep fir-anthracite with light birch-yellow ink. Accent
// pair: deep fir + birch yellow with bone highlights. Migration
// source: legacy `forest` preset.
//
// Concept reference: todo/admin-redesign-concept.md § 3.2 (Expressive
// existing). Mapping: forest → helsinki.

import type { ThemeTokenSet } from "./types";

export const helsinki: ThemeTokenSet = {
  colors: {
    light: {
      // Surfaces — bone off-white, slightly warm to soften the green ink
      paper: "#f6f1e3",
      "paper-deep": "#ece4cf",
      rule: "#d8ccae",
      // Ink — deep fir-green near-black (>= 16:1 vs paper)
      ink: "#0f1a14",
      "ink-soft": "#3d4f43",
      "ink-mute": "#7c857d",
      // Accent pair — deep fir green + birch yellow
      "accent-primary": "#234d34",
      "accent-secondary": "#a78a2a",
      // Status pairs — earthy, paper-friendly
      "status-success-paper": "#cce0c8",
      "status-success-deep": "#3a6f44",
      "status-pending-paper": "#efd8b0",
      "status-pending-deep": "#9a5e1a",
      "status-error-paper": "#eec3bd",
      "status-error-deep": "#9a3838",
      "status-preset-paper": "#ebd49a",
      "status-preset-deep": "#735000",
      "status-info-paper": "#cad8d2",
      "status-info-deep": "#365e58",
    },
    dark: {
      // Surfaces — deep fir-anthracite, slightly green-cast black
      paper: "#0d1410",
      "paper-deep": "#161e18",
      rule: "#2c352d",
      // Ink — light birch yellow, warm and luminous (>= 14:1)
      ink: "#ede2bf",
      "ink-soft": "#b8b094",
      "ink-mute": "#7c7864",
      // Accent pair — high-key fir + birch yellow on dark
      "accent-primary": "#9bd0a6",
      "accent-secondary": "#edd47c",
      "status-success-paper": "#1c3528",
      "status-success-deep": "#82cc8e",
      "status-pending-paper": "#332514",
      "status-pending-deep": "#eaa070",
      "status-error-paper": "#3a2020",
      "status-error-deep": "#e89890",
      "status-preset-paper": "#352b14",
      "status-preset-deep": "#edd47c",
      "status-info-paper": "#1c2c2a",
      "status-info-deep": "#9cccc0",
    },
  },
  typography: {
    h1: {
      family: "Orelega One",
      weight: 400,
      size: "34px",
      lineHeight: "1.15",
      letterSpacing: "-0.005em",
    },
    h2: {
      family: "Orelega One",
      weight: 400,
      size: "27px",
      lineHeight: "1.2",
      letterSpacing: "0",
    },
    h3: {
      family: "Orelega One",
      weight: 400,
      size: "22px",
      lineHeight: "1.25",
      letterSpacing: "0",
    },
    h4: {
      family: "Orelega One",
      weight: 400,
      size: "18px",
      lineHeight: "1.3",
      letterSpacing: "0",
    },
    h5: {
      family: "Orelega One",
      weight: 400,
      size: "15px",
      lineHeight: "1.35",
      letterSpacing: "0",
    },
    body: {
      family: "PT Serif",
      weight: 400,
      size: "14px",
      lineHeight: "1.6",
      letterSpacing: "0",
    },
    bodySmall: {
      family: "PT Serif",
      weight: 400,
      size: "12px",
      lineHeight: "1.6",
      letterSpacing: "0.01em",
    },
    blockquote: {
      family: "PT Serif",
      weight: 400,
      size: "15px",
      lineHeight: "1.7",
      letterSpacing: "0",
    },
    link: {
      family: "PT Serif",
      weight: 700,
      size: "14px",
      lineHeight: "1.6",
      letterSpacing: "0",
    },
    mono: {
      family: "JetBrains Mono",
      weight: 400,
      size: "13px",
      lineHeight: "1.55",
      letterSpacing: "0",
    },
  },
  meta: {
    cityName: "Helsinki",
    category: "expressive-existing",
    previousPreset: "forest",
  },
};
