// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Sevilla — Rundlich-Warm Süden (P-AR-1-T-D, expressive-new).
//
// Character: round-warm, southern, terracotta and olive. Display uses
// Nunito Black (rounded heavy sans, southern warmth without script
// flourish); Body is Open Sans for grounded readability; Mono is
// JetBrains Mono. Light mode: terracotta-tinted cream paper with deep
// terra-brown near-black ink. Dark mode: deep terra-black surface with
// light terra-cream ink. Accent pair: olive-green + warm terracotta.
// No legacy migration source — newly introduced theme.
//
// Concept reference: todo/admin-redesign-concept.md § 3.2 (Expressive
// new).

import type { ThemeTokenSet } from "./types";

export const sevilla: ThemeTokenSet = {
  colors: {
    light: {
      // Surfaces — terracotta-tinted cream, southern paper warmth
      paper: "#f8e6d5",
      "paper-deep": "#eed6c0",
      rule: "#dcbfa3",
      // Ink — deep terra-brown near-black (>= 12:1 vs paper)
      ink: "#1f1208",
      "ink-soft": "#5a3a26",
      "ink-mute": "#8c7768",
      // Accent pair — olive-green + warm terracotta
      "accent-primary": "#566b22",
      "accent-secondary": "#b4582c",
      // Status pairs — sunbaked paper-friendly
      "status-success-paper": "#d2dec0",
      "status-success-deep": "#496c2a",
      "status-pending-paper": "#f3d2b0",
      "status-pending-deep": "#a45418",
      "status-error-paper": "#efc1bc",
      "status-error-deep": "#9c3838",
      "status-preset-paper": "#ecd29a",
      "status-preset-deep": "#735000",
      "status-info-paper": "#cdd5dc",
      "status-info-deep": "#3a5a76",
    },
    dark: {
      // Surfaces — deep terra-black, warm earth undertone
      paper: "#100805",
      "paper-deep": "#1a0e08",
      rule: "#3a2c20",
      // Ink — light terra-cream, southern warmth on dark (>= 16:1)
      ink: "#f0e2cb",
      "ink-soft": "#bca988",
      "ink-mute": "#7e7058",
      // Accent pair — softened olive + terracotta on dark
      "accent-primary": "#b8cc7a",
      "accent-secondary": "#ec9670",
      "status-success-paper": "#283518",
      "status-success-deep": "#bcd47c",
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
      family: "Nunito",
      weight: 900,
      size: "34px",
      lineHeight: "1.2",
      letterSpacing: "-0.005em",
    },
    h2: {
      family: "Nunito",
      weight: 900,
      size: "27px",
      lineHeight: "1.25",
      letterSpacing: "0",
    },
    h3: {
      family: "Nunito",
      weight: 900,
      size: "22px",
      lineHeight: "1.3",
      letterSpacing: "0",
    },
    h4: {
      family: "Nunito",
      weight: 900,
      size: "18px",
      lineHeight: "1.35",
      letterSpacing: "0",
    },
    h5: {
      family: "Nunito",
      weight: 900,
      size: "15px",
      lineHeight: "1.4",
      letterSpacing: "0",
    },
    body: {
      family: "Open Sans",
      weight: 400,
      size: "14px",
      lineHeight: "1.6",
      letterSpacing: "0",
    },
    bodySmall: {
      family: "Open Sans",
      weight: 400,
      size: "12px",
      lineHeight: "1.6",
      letterSpacing: "0.01em",
    },
    blockquote: {
      family: "Open Sans",
      weight: 400,
      size: "15px",
      lineHeight: "1.7",
      letterSpacing: "0",
    },
    link: {
      family: "Open Sans",
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
    cityName: "Sevilla",
    category: "expressive-new",
  },
};
