// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Hannover — Sans-Calm theme (P-AR-1-T-B).
//
// Character: low-saturation, calm, almost monochrome with a hint of
// cool steel. Light mode is a near-white with a faint cool grey tint,
// ink is a deep anthracite without blue-shift. Dark mode is a deep
// slate with high-key light-grey ink. Accent pair: dampened steel-blue
// plus a warm stone-grey — the "muted-engineer" duo.
//
// Concept reference: todo/admin-redesign-concept.md § 3.2 (Sans-leaning).
// Migration source: legacy `branding.theme.preset === "reduced"`.

import type { ThemeTokenSet } from "./types";

export const hannover: ThemeTokenSet = {
  colors: {
    light: {
      // Surfaces — near-white with a faint cool-grey shift, no warm hue
      paper: "#f1f2f4",
      "paper-deep": "#e6e8ec",
      rule: "#d2d5dc",
      // Ink — deep anthracite without blue-shift (>= 14:1 vs paper)
      ink: "#1c2028",
      "ink-soft": "#465061",
      "ink-mute": "#7a8290",
      // Accent pair — muted steel-blue + warm stone-grey
      "accent-primary": "#4a6580",
      "accent-secondary": "#8a857c",
      // Status pairs — desaturated to match the calm character
      "status-success-paper": "#cfe1d4",
      "status-success-deep": "#3a7558",
      "status-pending-paper": "#f0d9c0",
      "status-pending-deep": "#9c5a2c",
      "status-error-paper": "#edc8c4",
      "status-error-deep": "#9c4848",
      "status-preset-paper": "#ead9a8",
      "status-preset-deep": "#7a5d18",
      "status-info-paper": "#cdd8e2",
      "status-info-deep": "#3a5d7a",
    },
    dark: {
      // Surfaces — deep slate without warm cast
      paper: "#161821",
      "paper-deep": "#1f2230",
      rule: "#33384a",
      // Ink — light cool-grey for high readability (>= 14:1 vs paper)
      ink: "#dce0e8",
      "ink-soft": "#a8aebb",
      "ink-mute": "#737886",
      // Accent pair — softened steel + stone for dark surfaces
      "accent-primary": "#8aa3c0",
      "accent-secondary": "#c0bbb0",
      "status-success-paper": "#1f3a2c",
      "status-success-deep": "#86c8a3",
      "status-pending-paper": "#3a2818",
      "status-pending-deep": "#e89c70",
      "status-error-paper": "#3a2222",
      "status-error-deep": "#e09898",
      "status-preset-paper": "#332b18",
      "status-preset-deep": "#e6cf80",
      "status-info-paper": "#1c2c3c",
      "status-info-deep": "#9cbcd8",
    },
  },
  typography: {
    h1: {
      family: "Source Sans 3",
      weight: 600,
      size: "30px",
      lineHeight: "1.2",
      letterSpacing: "-0.005em",
    },
    h2: {
      family: "Source Sans 3",
      weight: 600,
      size: "24px",
      lineHeight: "1.25",
      letterSpacing: "0",
    },
    h3: {
      family: "Source Sans 3",
      weight: 600,
      size: "20px",
      lineHeight: "1.3",
      letterSpacing: "0",
    },
    h4: {
      family: "Source Sans 3",
      weight: 600,
      size: "17px",
      lineHeight: "1.35",
      letterSpacing: "0",
    },
    h5: {
      family: "Source Sans 3",
      weight: 600,
      size: "15px",
      lineHeight: "1.4",
      letterSpacing: "0",
    },
    body: {
      family: "Source Sans 3",
      weight: 400,
      size: "14px",
      lineHeight: "1.55",
      letterSpacing: "0",
    },
    bodySmall: {
      family: "Source Sans 3",
      weight: 400,
      size: "12px",
      lineHeight: "1.55",
      letterSpacing: "0.01em",
    },
    blockquote: {
      family: "Source Sans 3",
      weight: 400,
      size: "14px",
      lineHeight: "1.65",
      letterSpacing: "0",
    },
    link: {
      family: "Source Sans 3",
      weight: 600,
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
    cityName: "Hannover",
    category: "sans-leaning",
    previousPreset: "reduced",
  },
};
