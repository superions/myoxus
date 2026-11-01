// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Habana — Handgeschrieben (P-AR-1-T-D, expressive-existing).
//
// Character: handwritten warmth, mojito and sunshine. Display uses
// Kalam (a handwritten display script with relaxed pen strokes);
// Body is Nunito for rounded readable warmth; Mono is JetBrains
// Mono. Light mode: warm cream paper with a faint sand cast and deep
// chocolate-brown near-black ink. Dark mode: deep chocolate-black
// surface with light cream ink. Accent pair: mojito-green + warm
// sunshine-yellow. Migration source: legacy `vibrant` preset.
//
// Concept reference: todo/admin-redesign-concept.md § 3.2 (Expressive
// existing). Mapping: vibrant → habana.

import type { ThemeTokenSet } from "./types";

export const habana: ThemeTokenSet = {
  colors: {
    light: {
      // Surfaces — warm cream with minimal sand cast
      paper: "#faf2e2",
      "paper-deep": "#f0e5cb",
      rule: "#decfa8",
      // Ink — deep chocolate-brown near-black (>= 14:1 vs paper)
      ink: "#1a120a",
      "ink-soft": "#523c28",
      "ink-mute": "#8c7e6c",
      // Accent pair — mojito-green + warm sunshine yellow
      "accent-primary": "#2f7048",
      "accent-secondary": "#c08a18",
      // Status pairs — warm paper-friendly
      "status-success-paper": "#cce0c4",
      "status-success-deep": "#3a7048",
      "status-pending-paper": "#f5d4ac",
      "status-pending-deep": "#a4581a",
      "status-error-paper": "#efc3bc",
      "status-error-deep": "#9a3838",
      "status-preset-paper": "#ecd29a",
      "status-preset-deep": "#735000",
      "status-info-paper": "#cdd5dc",
      "status-info-deep": "#3a5a76",
    },
    dark: {
      // Surfaces — deep chocolate-black, warm-cast near-black
      paper: "#100a06",
      "paper-deep": "#1a120c",
      rule: "#332820",
      // Ink — light cream, sunny tropical contrast (>= 16:1)
      ink: "#f0e6cd",
      "ink-soft": "#bcad8e",
      "ink-mute": "#7e745e",
      // Accent pair — softened mojito + warm sunshine on dark
      "accent-primary": "#88cc9c",
      "accent-secondary": "#edcc6c",
      "status-success-paper": "#1c3528",
      "status-success-deep": "#82cc9a",
      "status-pending-paper": "#352510",
      "status-pending-deep": "#eba072",
      "status-error-paper": "#3a2020",
      "status-error-deep": "#e89890",
      "status-preset-paper": "#322a14",
      "status-preset-deep": "#edd47c",
      "status-info-paper": "#1c2a38",
      "status-info-deep": "#9cbcd4",
    },
  },
  typography: {
    h1: {
      family: "Kalam",
      weight: 700,
      size: "34px",
      lineHeight: "1.25",
      letterSpacing: "-0.005em",
    },
    h2: {
      family: "Kalam",
      weight: 700,
      size: "27px",
      lineHeight: "1.3",
      letterSpacing: "0",
    },
    h3: {
      family: "Kalam",
      weight: 700,
      size: "22px",
      lineHeight: "1.35",
      letterSpacing: "0",
    },
    h4: {
      family: "Kalam",
      weight: 700,
      size: "18px",
      lineHeight: "1.4",
      letterSpacing: "0",
    },
    h5: {
      family: "Kalam",
      weight: 700,
      size: "15px",
      lineHeight: "1.45",
      letterSpacing: "0",
    },
    body: {
      family: "Nunito",
      weight: 400,
      size: "14px",
      lineHeight: "1.6",
      letterSpacing: "0",
    },
    bodySmall: {
      family: "Nunito",
      weight: 400,
      size: "12px",
      lineHeight: "1.6",
      letterSpacing: "0.01em",
    },
    blockquote: {
      family: "Kalam",
      weight: 400,
      size: "15px",
      lineHeight: "1.7",
      letterSpacing: "0",
    },
    link: {
      family: "Nunito",
      weight: 700,
      size: "14px",
      lineHeight: "1.55",
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
    cityName: "Habana",
    category: "expressive-existing",
    previousPreset: "vibrant",
  },
};
