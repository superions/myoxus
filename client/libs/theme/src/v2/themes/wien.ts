// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Wien — Atelier-Editorial Refined (P-AR-1-T-B, expressive-new).
//
// Character: refined editorial. Display uses Lora (Italic Variable
// Font) for the cursive Atelier-shoulder feel; Body is Inter for
// clean, neutral reading. Light mode is a warm cream paper close to
// Stuttgart with a deep burgundy-black ink. Dark mode is a deep
// noble dark with cream ink. Accent pair: gold + burgundy — the
// "Vienna-coffeehouse" duo.
//
// Concept reference: todo/admin-redesign-concept.md § 3.2 (Expressive
// new). No legacy migration source — newly introduced theme.

import type { ThemeTokenSet } from "./types";

export const wien: ThemeTokenSet = {
  colors: {
    light: {
      // Surfaces — warm cream, very close to Stuttgart but with a touch
      // more amber to support the gold accent
      paper: "#faf7f2",
      "paper-deep": "#f1ebde",
      rule: "#e3dac6",
      // Ink — deep burgundy-black (>= 16:1 vs paper)
      ink: "#1f1418",
      "ink-soft": "#564048",
      "ink-mute": "#8c8076",
      // Accent pair — warm gold + deep burgundy
      "accent-primary": "#a78838",
      "accent-secondary": "#6a2638",
      // Status pairs — paper-friendly, editorial in tone
      "status-success-paper": "#cce1cf",
      "status-success-deep": "#37755a",
      "status-pending-paper": "#f3d8b8",
      "status-pending-deep": "#a65e1c",
      "status-error-paper": "#efc6c0",
      "status-error-deep": "#9a3a3a",
      "status-preset-paper": "#ecd8a2",
      "status-preset-deep": "#785408",
      "status-info-paper": "#cdd7e2",
      "status-info-deep": "#3a5d7a",
    },
    dark: {
      // Surfaces — deep noble dark, near-black with warm cast
      paper: "#15110f",
      "paper-deep": "#1f1a17",
      rule: "#3a3128",
      // Ink — warm cream for editorial warmth (>= 16:1 vs paper)
      ink: "#ede4d2",
      "ink-soft": "#bdb09a",
      "ink-mute": "#7e7468",
      // Accent pair — softened gold + dusty burgundy for dark surfaces
      "accent-primary": "#e8c878",
      "accent-secondary": "#d28898",
      "status-success-paper": "#23382c",
      "status-success-deep": "#80cc9a",
      "status-pending-paper": "#3a2614",
      "status-pending-deep": "#eba072",
      "status-error-paper": "#3a2020",
      "status-error-deep": "#e89890",
      "status-preset-paper": "#352b14",
      "status-preset-deep": "#edd47c",
      "status-info-paper": "#1e2c3c",
      "status-info-deep": "#9cbcd4",
    },
  },
  typography: {
    h1: {
      family: "Lora",
      weight: 600,
      size: "32px",
      lineHeight: "1.2",
      letterSpacing: "-0.005em",
    },
    h2: {
      family: "Lora",
      weight: 600,
      size: "26px",
      lineHeight: "1.25",
      letterSpacing: "0",
    },
    h3: {
      family: "Lora",
      weight: 600,
      size: "21px",
      lineHeight: "1.3",
      letterSpacing: "0",
    },
    h4: {
      family: "Lora",
      weight: 600,
      size: "17px",
      lineHeight: "1.35",
      letterSpacing: "0",
    },
    h5: {
      family: "Lora",
      weight: 600,
      size: "15px",
      lineHeight: "1.4",
      letterSpacing: "0",
    },
    body: {
      family: "Inter",
      weight: 400,
      size: "14px",
      lineHeight: "1.55",
      letterSpacing: "0",
    },
    bodySmall: {
      family: "Inter",
      weight: 400,
      size: "12px",
      lineHeight: "1.55",
      letterSpacing: "0.01em",
    },
    blockquote: {
      family: "Lora",
      weight: 400,
      size: "15px",
      lineHeight: "1.65",
      letterSpacing: "0",
    },
    link: {
      family: "Inter",
      weight: 500,
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
    cityName: "Wien",
    category: "expressive-new",
  },
};
