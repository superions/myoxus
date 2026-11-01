// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Bordeaux — Wein-Bistro (P-AR-1-T-D, expressive-existing).
//
// Character: wine-bistro, dark berry and honey with parchment warmth.
// Display uses Lobster (a script-bistro display with rounded warmth);
// Body is Merriweather for editorial print weight; Mono is JetBrains
// Mono. Light mode: warm parchment paper with dark bordeaux near-black
// ink. Dark mode: deep wine-black surface with light champagne ink.
// Accent pair: deep berry + honey-yellow. Migration source: legacy
// `vivid-balanced` preset.
//
// Concept reference: todo/admin-redesign-concept.md § 3.2 (Expressive
// existing). Mapping: vivid-balanced → bordeaux.

import type { ThemeTokenSet } from "./types";

export const bordeaux: ThemeTokenSet = {
  colors: {
    light: {
      // Surfaces — warm parchment, faintly rosé-tinted
      paper: "#f8eee0",
      "paper-deep": "#ede0c9",
      rule: "#dcc6a6",
      // Ink — dark bordeaux near-black (>= 16:1 vs paper)
      ink: "#1a0a10",
      "ink-soft": "#5a2c3a",
      "ink-mute": "#8c7a76",
      // Accent pair — deep berry + honey
      "accent-primary": "#7a1e34",
      "accent-secondary": "#b8851c",
      // Status pairs — paper-friendly bistro
      "status-success-paper": "#cee0cc",
      "status-success-deep": "#3a7052",
      "status-pending-paper": "#f3d4ac",
      "status-pending-deep": "#9c5a18",
      "status-error-paper": "#efc0bc",
      "status-error-deep": "#9a3838",
      "status-preset-paper": "#ecd29a",
      "status-preset-deep": "#735000",
      "status-info-paper": "#cdd5dc",
      "status-info-deep": "#3a5a76",
    },
    dark: {
      // Surfaces — deep wine-black, near-black with berry undertone
      paper: "#0e0608",
      "paper-deep": "#180a0e",
      rule: "#34222a",
      // Ink — light champagne for warm bistro contrast (>= 16:1)
      ink: "#ece0c4",
      "ink-soft": "#b6a78a",
      "ink-mute": "#7a705e",
      // Accent pair — softened berry + warm honey on dark
      "accent-primary": "#dc8a96",
      "accent-secondary": "#edc36c",
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
      family: "Lobster",
      weight: 400,
      size: "36px",
      lineHeight: "1.2",
      letterSpacing: "-0.005em",
    },
    h2: {
      family: "Lobster",
      weight: 400,
      size: "28px",
      lineHeight: "1.25",
      letterSpacing: "0",
    },
    h3: {
      family: "Lobster",
      weight: 400,
      size: "23px",
      lineHeight: "1.3",
      letterSpacing: "0",
    },
    h4: {
      family: "Lobster",
      weight: 400,
      size: "19px",
      lineHeight: "1.35",
      letterSpacing: "0",
    },
    h5: {
      family: "Lobster",
      weight: 400,
      size: "16px",
      lineHeight: "1.4",
      letterSpacing: "0",
    },
    body: {
      family: "Merriweather",
      weight: 400,
      size: "14px",
      lineHeight: "1.65",
      letterSpacing: "0",
    },
    bodySmall: {
      family: "Merriweather",
      weight: 400,
      size: "12px",
      lineHeight: "1.65",
      letterSpacing: "0.01em",
    },
    blockquote: {
      family: "Merriweather",
      weight: 400,
      size: "15px",
      lineHeight: "1.7",
      letterSpacing: "0",
    },
    link: {
      family: "Merriweather",
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
    cityName: "Bordeaux",
    category: "expressive-existing",
    previousPreset: "vivid-balanced",
  },
};
