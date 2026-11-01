// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Porto — Slab-Press Journalistisch (P-AR-1-T-C, expressive-new).
//
// Character: rustic slab-press journalism. Display uses Merriweather
// Bold Italic (slab-serif, robust, print-press); Body is Lato for
// modern grounded readability; Mono is JetBrains Mono. Light mode:
// parchment with a faint yellow cast (sepia-tinted broadsheet),
// deep burgundy ink. Dark mode: ink-black with warm cream ink.
// Accent pair: rustic bordeaux + honey. No legacy migration source —
// newly introduced theme.
//
// Concept reference: todo/admin-redesign-concept.md § 3.2 (Expressive
// new).

import type { ThemeTokenSet } from "./types";

export const porto: ThemeTokenSet = {
  colors: {
    light: {
      // Surfaces — parchment with minimal yellow cast (sepia broadsheet)
      paper: "#f7f1e0",
      "paper-deep": "#ede4ca",
      rule: "#d8c9a8",
      // Ink — dark burgundy near-black (>= 17:1 vs paper)
      ink: "#1c0e12",
      "ink-soft": "#5a3942",
      "ink-mute": "#8d7c75",
      // Accent pair — rustic bordeaux + honey
      "accent-primary": "#85283a",
      "accent-secondary": "#c08a1c",
      // Status pairs — earthy, print-press friendly
      "status-success-paper": "#cee0cc",
      "status-success-deep": "#377552",
      "status-pending-paper": "#f3d6b0",
      "status-pending-deep": "#9c5a18",
      "status-error-paper": "#efc3bc",
      "status-error-deep": "#9a3838",
      "status-preset-paper": "#ecd49a",
      "status-preset-deep": "#735000",
      "status-info-paper": "#cdd5dc",
      "status-info-deep": "#3a5a76",
    },
    dark: {
      // Surfaces — ink-black with warm cast, very deep
      paper: "#0c0a09",
      "paper-deep": "#16120e",
      rule: "#322820",
      // Ink — warm cream, balances the bordeaux accent (>= 16:1)
      ink: "#ece1c7",
      "ink-soft": "#b8a98d",
      "ink-mute": "#7c705f",
      // Accent pair — softened bordeaux + warm honey for dark
      "accent-primary": "#e09098",
      "accent-secondary": "#edc36c",
      "status-success-paper": "#1c3528",
      "status-success-deep": "#80cc9a",
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
      family: "Merriweather",
      weight: 700,
      size: "34px",
      lineHeight: "1.2",
      letterSpacing: "-0.005em",
    },
    h2: {
      family: "Merriweather",
      weight: 700,
      size: "27px",
      lineHeight: "1.25",
      letterSpacing: "0",
    },
    h3: {
      family: "Merriweather",
      weight: 700,
      size: "22px",
      lineHeight: "1.3",
      letterSpacing: "0",
    },
    h4: {
      family: "Merriweather",
      weight: 700,
      size: "18px",
      lineHeight: "1.35",
      letterSpacing: "0",
    },
    h5: {
      family: "Merriweather",
      weight: 700,
      size: "15px",
      lineHeight: "1.4",
      letterSpacing: "0",
    },
    body: {
      family: "Lato",
      weight: 400,
      size: "14px",
      lineHeight: "1.6",
      letterSpacing: "0",
    },
    bodySmall: {
      family: "Lato",
      weight: 400,
      size: "12px",
      lineHeight: "1.6",
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
      family: "Lato",
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
    cityName: "Porto",
    category: "expressive-new",
  },
};
