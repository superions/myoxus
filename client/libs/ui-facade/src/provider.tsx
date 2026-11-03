// SPDX-License-Identifier: AGPL-3.0-or-later

import "./styles";
// Date controls install shared Dayjs plugins; preserve their boot lifetime.
import "./date-picker";

import "@mantine/core/styles.css";
import "@mantine/charts/styles.css";
import "@mantine/dates/styles.css";
import "@mantine/schedule/styles.css";
import "@mantine/tiptap/styles.css";
// The `@mantine/notifications` stylesheet is imported at this single Facade
// provider boundary on purpose. It owns the visual chrome for every transient
// notification portal and product roots (Web, Admin, Electron, Mobile) must
// not pull it in themselves; doing so would silently leak the portal
// stylesheet into product bundles and break the single-mount invariant.
import "@mantine/notifications/styles.css";

import {
  ActionIcon,
  Alert,
  Avatar,
  Badge,
  Button,
  Card,
  Checkbox,
  Combobox,
  createTheme,
  type CSSVariablesResolver,
  defaultCssVariablesResolver,
  Divider,
  Drawer,
  MantineProvider,
  Menu,
  Modal,
  MultiSelect,
  NavLink,
  Notification,
  NumberInput,
  PasswordInput,
  Popover,
  Radio,
  SegmentedControl,
  Select,
  Slider,
  Stepper,
  Switch,
  Table,
  Tabs,
  Text,
  Textarea,
  TextInput,
  Timeline,
  Title,
  Tooltip,
  Typography,
} from "@mantine/core";
import { Notifications } from "@mantine/notifications";
import { cssTypographyVar, cssVar, myoxusWebBreakpoints } from "@myoxus/theme";
import {
  createContext,
  type PropsWithChildren,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";

import { myoxusMantineDensity } from "./theme-density";

const myoxusPrimaryScale = [
  cssVar("backgroundPrimaryColor"),
  cssVar("backgroundPrimaryColor"),
  cssVar("backgroundPrimaryColor"),
  cssVar("backgroundPrimaryColor"),
  cssVar("primaryColor"),
  cssVar("primaryColor"),
  cssVar("primaryColor"),
  cssVar("primaryColor"),
  cssVar("textEmphasisColor"),
  cssVar("textEmphasisColor"),
] as const;

function mantineColorScale(
  color: string,
): [
  string,
  string,
  string,
  string,
  string,
  string,
  string,
  string,
  string,
  string,
] {
  return [color, color, color, color, color, color, color, color, color, color];
}

/**
 * Build a 10-stop Mantine color scale for transient notification colors.
 *
 * Each stop uses the canonical unversioned theme roles so Light/Dark switching
 * remains owned by the server projection.
 *
 * - `paper` populates stops 0–5 (light card / accent-line background).
 * - `deep` populates stops 6–9 (icon color, filled border, accent text).
 * - Stop index 6 is the color Mantine applies when callers pass the scale
 *   name as `notifications.show({ color: "myoxusError" | ... })`.
 */
function myoxusNotificationScale(
  paper: string,
  deep: string,
): [
  string,
  string,
  string,
  string,
  string,
  string,
  string,
  string,
  string,
  string,
] {
  return [paper, paper, paper, paper, paper, paper, deep, deep, deep, deep];
}

const MYOXUS_SURFACE_PRIMARY = cssVar("backgroundPrimaryColor");
const MYOXUS_SURFACE_HOVER = cssVar("hoverColor");
const MYOXUS_BORDER = cssVar("borderColor");
const MYOXUS_TEXT_PRIMARY = cssVar("textPrimaryColor");
const MYOXUS_TEXT_SECONDARY = cssVar("textSecondaryColor");
const MYOXUS_TEXT_MUTED = cssVar("placeholderColor");
const MYOXUS_TEXT_LINK = cssVar("linkColor");
const MYOXUS_TEXT_ACCENT = cssVar("textEmphasisColor");
const MYOXUS_TEXT_EMPHASIS = cssVar("textEmphasisColor");
const MYOXUS_TEXT_TERTIARY = cssVar("placeholderColor");
const MYOXUS_BUTTON_PRIMARY_BG = cssVar("primaryColor");
const MYOXUS_BUTTON_PRIMARY_FG = cssVar("--myoxus-branding-button-primary-fg");
const MYOXUS_BUTTON_PRIMARY_HOVER_BG = cssVar(
  "--myoxus-btn-primary-hover-bg",
  cssVar("primaryColor"),
);
const MYOXUS_ERROR = cssVar("errorColor");
const MYOXUS_SUCCESS = cssVar("successColor");
const MYOXUS_DISABLED_BG = cssVar("backgroundSecondaryColor");
const MYOXUS_DISABLED_FG = cssVar("textDisableColor");
const MYOXUS_PRIMARY_SOFT_BG = `color-mix(in srgb, ${MYOXUS_BUTTON_PRIMARY_BG} 12%, ${MYOXUS_SURFACE_PRIMARY})`;
const MYOXUS_PRIMARY_SOFT_HOVER_BG = `color-mix(in srgb, ${MYOXUS_BUTTON_PRIMARY_BG} 18%, ${MYOXUS_SURFACE_PRIMARY})`;
const MYOXUS_PRIMARY_OUTLINE_HOVER_BG = `color-mix(in srgb, ${MYOXUS_BUTTON_PRIMARY_BG} 8%, transparent)`;
const MYOXUS_UI_FONT_FAMILY = cssTypographyVar(
  "ui-font",
  "family",
  cssTypographyVar("body", "family", cssVar("fontFamily")),
);
const MYOXUS_MONO_FONT_FAMILY = cssTypographyVar(
  "mono-font",
  "family",
  cssTypographyVar("mono", "family", cssVar("fontCodeFamily")),
);

const typographyFallback = {
  family: cssVar("fontFamily"),
  letterSpacing: "0em",
  lineHeight: cssVar("lineHeight"),
  size: cssVar("fontBase"),
  weight: "400",
} as const;

type TypographySlotStyle = {
  family: string;
  letterSpacing: string;
  lineHeight: string;
  size: string;
  weight: string;
};

function typographyProperty(
  slot: string,
  property: keyof typeof typographyFallback,
  fallbackSlot: string,
): string {
  const cssProperty =
    property === "letterSpacing"
      ? "letter-spacing"
      : property === "lineHeight"
        ? "line-height"
        : property;

  return cssTypographyVar(
    slot,
    cssProperty,
    cssTypographyVar(fallbackSlot, cssProperty, typographyFallback[property]),
  );
}

function typographySlot(
  slot: string,
  fallbackSlot = "body",
  overrides: Partial<TypographySlotStyle> = {},
): TypographySlotStyle {
  return {
    family:
      overrides.family ?? typographyProperty(slot, "family", fallbackSlot),
    letterSpacing:
      overrides.letterSpacing ??
      typographyProperty(slot, "letterSpacing", fallbackSlot),
    lineHeight:
      overrides.lineHeight ??
      typographyProperty(slot, "lineHeight", fallbackSlot),
    size: overrides.size ?? typographyProperty(slot, "size", fallbackSlot),
    weight:
      overrides.weight ?? typographyProperty(slot, "weight", fallbackSlot),
  };
}

const MYOXUS_MANTINE_TYPOGRAPHY_SLOTS = {
  blockquote: typographySlot("blockquote"),
  body: typographySlot("body"),
  "body-large": typographySlot("body-large"),
  "body-small": typographySlot("body-small"),
  caption: typographySlot("caption", "body-small"),
  "card-title": typographySlot("card-title", "body"),
  "code-block": typographySlot("code-block", "mono"),
  "dense-label": typographySlot("label-compact", "body-small"),
  "heading-small": typographySlot("heading-small", "h4"),
  h1: typographySlot("h1", "page-title"),
  h2: typographySlot("h2", "section-title"),
  h3: typographySlot("h3", "section-title"),
  h4: typographySlot("h4", "heading-small"),
  h5: typographySlot("h5", "label-compact"),
  h6: typographySlot("h6", "label-compact"),
  "label-compact": typographySlot("label-compact", "body-small"),
  link: typographySlot("link"),
  "modal-title": typographySlot("modal-title", "h5"),
  mono: typographySlot("mono", "body", {
    family: cssTypographyVar(
      "mono",
      "family",
      cssTypographyVar("mono-font", "family", cssVar("fontCodeFamily")),
    ),
  }),
  nav: typographySlot("nav", "body"),
  "page-title": typographySlot("page-title", "h1"),
  section: typographySlot("section", "card-title"),
  "section-title": typographySlot("section-title", "h2"),
} as const;

function myoxusMantineFontSizes(): Record<string, string> {
  return Object.fromEntries(
    Object.entries(MYOXUS_MANTINE_TYPOGRAPHY_SLOTS).map(([slot, value]) => [
      slot,
      value.size,
    ]),
  );
}

function myoxusMantineLineHeights(): Record<string, string> {
  return Object.fromEntries(
    Object.entries(MYOXUS_MANTINE_TYPOGRAPHY_SLOTS).map(([slot, value]) => [
      slot,
      value.lineHeight,
    ]),
  );
}

function myoxusMantineFontWeights(): Record<string, string> {
  return Object.fromEntries(
    Object.entries(MYOXUS_MANTINE_TYPOGRAPHY_SLOTS).map(([slot, value]) => [
      slot,
      value.weight,
    ]),
  );
}

function myoxusMantineTypographyVariables(): Record<string, string> {
  return Object.fromEntries(
    Object.entries(MYOXUS_MANTINE_TYPOGRAPHY_SLOTS).flatMap(([slot, value]) => [
      [`--mantine-font-size-${slot}`, value.size],
      [`--mantine-line-height-${slot}`, value.lineHeight],
      [`--mantine-font-weight-${slot}`, value.weight],
      [`--mantine-letter-spacing-${slot}`, value.letterSpacing],
      [`--mantine-font-family-${slot}`, value.family],
    ]),
  );
}

type MantineTypographyVariable =
  | "font-family"
  | "font-size"
  | "font-weight"
  | "letter-spacing"
  | "line-height";

function mantineTypographyVar(
  slot: string,
  variable: MantineTypographyVariable,
  fallback: string,
): string {
  return `var(--mantine-${variable}-${slot}, ${fallback})`;
}

function mantineTypographySlotStyle(
  slot: string,
  fallbackSlot = "body",
): {
  fontFamily: string;
  fontSize: string;
  fontWeight: string;
  letterSpacing: string;
  lineHeight: string;
} {
  return {
    fontFamily: mantineTypographyVar(
      slot,
      "font-family",
      mantineTypographyVar(
        fallbackSlot,
        "font-family",
        "var(--mantine-font-family)",
      ),
    ),
    fontSize: mantineTypographyVar(
      slot,
      "font-size",
      mantineTypographyVar(
        fallbackSlot,
        "font-size",
        "var(--mantine-font-size-md)",
      ),
    ),
    fontWeight: mantineTypographyVar(
      slot,
      "font-weight",
      mantineTypographyVar(
        fallbackSlot,
        "font-weight",
        "var(--mantine-font-weight-regular)",
      ),
    ),
    letterSpacing: mantineTypographyVar(
      slot,
      "letter-spacing",
      mantineTypographyVar(fallbackSlot, "letter-spacing", "0em"),
    ),
    lineHeight: mantineTypographyVar(
      slot,
      "line-height",
      mantineTypographyVar(
        fallbackSlot,
        "line-height",
        "var(--mantine-line-height-md)",
      ),
    ),
  };
}

const bodyTypography = mantineTypographySlotStyle("body");
const bodySmallTypography = mantineTypographySlotStyle("body-small", "body");
const labelCompactTypography = mantineTypographySlotStyle(
  "label-compact",
  "body-small",
);
const linkTypography = mantineTypographySlotStyle("link", "body-small");
const modalTitleTypography = mantineTypographySlotStyle("modal-title", "h5");
const navTypography = mantineTypographySlotStyle("nav", "body-small");

const controlTypographyStyle = {
  fontFamily: bodyTypography.fontFamily,
  fontSize: bodyTypography.fontSize,
  fontWeight: bodyTypography.fontWeight,
  lineHeight: bodyTypography.lineHeight,
} as const;

const controlLabelStyle = {
  color: cssVar("textPrimaryColor"),
  fontFamily: bodyTypography.fontFamily,
  fontSize: bodyTypography.fontSize,
  fontWeight: linkTypography.fontWeight,
  lineHeight: bodyTypography.lineHeight,
} as const;

const controlChoiceLabelStyle = {
  color: cssVar("textPrimaryColor"),
  ...controlTypographyStyle,
} as const;

const controlDescriptionStyle = {
  color: cssVar("textSecondaryColor"),
  fontFamily: bodySmallTypography.fontFamily,
  fontSize: bodySmallTypography.fontSize,
  fontWeight: bodySmallTypography.fontWeight,
  lineHeight: bodySmallTypography.lineHeight,
} as const;

const controlInputStyle = {
  background: cssVar("backgroundPrimaryColor"),
  borderColor: cssVar("borderColor"),
  color: cssVar("textPrimaryColor"),
  ...controlTypographyStyle,
} as const;

const controlDropdownStyle = {
  background: cssVar("backgroundPrimaryColor"),
  borderColor: cssVar("borderColor"),
  color: cssVar("textPrimaryColor"),
} as const;

const menuDropdownStyle = {
  display: "flex",
  flexDirection: "column",
  zIndex: cssVar("zIndexPopover"),
} as const;

const controlOptionStyle = {
  fontFamily: bodyTypography.fontFamily,
  fontSize: bodyTypography.fontSize,
  lineHeight: bodyTypography.lineHeight,
} as const;

const modalTitleStyle = {
  color: cssVar("textPrimaryColor"),
  fontFamily: modalTitleTypography.fontFamily,
  fontSize: modalTitleTypography.fontSize,
  fontWeight: modalTitleTypography.fontWeight,
  lineHeight: modalTitleTypography.lineHeight,
} as const;

const buttonTextStyle = {
  fontFamily: bodySmallTypography.fontFamily,
  fontSize: bodySmallTypography.fontSize,
  fontWeight: linkTypography.fontWeight,
  lineHeight: bodySmallTypography.lineHeight,
} as const;

const menuItemTextStyle = {
  fontFamily: navTypography.fontFamily,
  fontSize: navTypography.fontSize,
  fontWeight: navTypography.fontWeight,
  lineHeight: navTypography.lineHeight,
} as const;

const menuItemLabelStyle = {
  flex: 1,
  minWidth: 0,
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
  textAlign: "left",
} as const;

const menuItemSectionStyle = {
  color: "currentColor",
} as const;

const menuLabelTextStyle = {
  color: cssVar("textSecondaryColor"),
  fontFamily: labelCompactTypography.fontFamily,
  fontSize: labelCompactTypography.fontSize,
  fontWeight: labelCompactTypography.fontWeight,
  lineHeight: labelCompactTypography.lineHeight,
} as const;

const stepperLabelStyle = {
  color: cssVar("textPrimaryColor"),
  fontFamily: navTypography.fontFamily,
  fontSize: navTypography.fontSize,
  fontWeight: navTypography.fontWeight,
  lineHeight: navTypography.lineHeight,
} as const;

const stepperDescriptionStyle = {
  ...controlDescriptionStyle,
  fontFamily: labelCompactTypography.fontFamily,
} as const;

/**
 * Projects server-owned Myoxus runtime tokens into Mantine's CSS-variable
 * surface. Mantine remains the rendering framework; this function prevents
 * Mantine palette defaults from becoming a second product theme.
 */
function myoxusMantineRuntimeVariables(): Record<string, string> {
  return {
    "--mantine-color-body": MYOXUS_SURFACE_PRIMARY,
    "--mantine-color-text": MYOXUS_TEXT_PRIMARY,
    "--mantine-color-default": MYOXUS_SURFACE_PRIMARY,
    "--mantine-color-default-hover": MYOXUS_SURFACE_HOVER,
    "--mantine-color-default-color": MYOXUS_TEXT_PRIMARY,
    "--mantine-color-default-border": MYOXUS_BORDER,
    "--mantine-color-dimmed": MYOXUS_TEXT_SECONDARY,
    "--mantine-color-placeholder": MYOXUS_TEXT_MUTED,
    "--mantine-color-anchor": MYOXUS_TEXT_LINK,
    "--mantine-color-error": MYOXUS_ERROR,
    "--mantine-color-disabled": MYOXUS_DISABLED_BG,
    "--mantine-color-disabled-color": MYOXUS_DISABLED_FG,
    "--mantine-color-disabled-border": MYOXUS_BORDER,
    "--mantine-primary-color-filled": MYOXUS_BUTTON_PRIMARY_BG,
    "--mantine-primary-color-filled-hover": MYOXUS_BUTTON_PRIMARY_HOVER_BG,
    "--mantine-primary-color-contrast": MYOXUS_BUTTON_PRIMARY_FG,
    "--mantine-primary-color-light": MYOXUS_PRIMARY_SOFT_BG,
    "--mantine-primary-color-light-hover": MYOXUS_PRIMARY_SOFT_HOVER_BG,
    "--mantine-primary-color-light-color": MYOXUS_TEXT_LINK,
    "--mantine-color-myoxus-filled": MYOXUS_BUTTON_PRIMARY_BG,
    "--mantine-color-myoxus-filled-hover": MYOXUS_BUTTON_PRIMARY_HOVER_BG,
    "--mantine-color-myoxus-light": MYOXUS_PRIMARY_SOFT_BG,
    "--mantine-color-myoxus-light-hover": MYOXUS_PRIMARY_SOFT_HOVER_BG,
    "--mantine-color-myoxus-light-color": MYOXUS_TEXT_LINK,
    "--mantine-color-myoxus-outline": MYOXUS_BUTTON_PRIMARY_BG,
    "--mantine-color-myoxus-outline-hover": MYOXUS_PRIMARY_OUTLINE_HOVER_BG,
    "--mantine-color-myoxus-text": MYOXUS_TEXT_LINK,
    "--mantine-color-myoxus-text-accent-text": MYOXUS_TEXT_ACCENT,
    "--mantine-color-myoxus-text-annotation-text":
      "var(--myoxus-sem-annotation-ink)",
    "--mantine-color-myoxus-text-danger-text": MYOXUS_ERROR,
    "--mantine-color-myoxus-text-emphasis-text": MYOXUS_TEXT_EMPHASIS,
    "--mantine-color-myoxus-text-link-text": MYOXUS_TEXT_LINK,
    "--mantine-color-myoxus-text-muted-text": MYOXUS_TEXT_MUTED,
    "--mantine-color-myoxus-text-primary-text": MYOXUS_TEXT_PRIMARY,
    "--mantine-color-myoxus-text-secondary-text": MYOXUS_TEXT_SECONDARY,
    "--mantine-color-myoxus-text-success-text": MYOXUS_SUCCESS,
    "--mantine-color-myoxus-text-tertiary-text": MYOXUS_TEXT_TERTIARY,
    "--mantine-color-myoxus-text-warning-text": cssVar("warningColor"),
  };
}

export const myoxusMantineCssVariablesResolver: CSSVariablesResolver = (
  theme,
) => {
  const resolved = defaultCssVariablesResolver(theme);
  const runtimeVariables = myoxusMantineRuntimeVariables();

  return {
    variables: {
      ...resolved.variables,
      "--mantine-font-family": MYOXUS_UI_FONT_FAMILY,
      "--mantine-font-family-monospace": MYOXUS_MONO_FONT_FAMILY,
      "--mantine-font-family-headings":
        MYOXUS_MANTINE_TYPOGRAPHY_SLOTS["section-title"].family,
      ...myoxusMantineTypographyVariables(),
      "--mantine-font-size-xs":
        MYOXUS_MANTINE_TYPOGRAPHY_SLOTS["body-small"].size,
      "--mantine-font-size-sm":
        MYOXUS_MANTINE_TYPOGRAPHY_SLOTS["label-compact"].size,
      "--mantine-font-size-md": MYOXUS_MANTINE_TYPOGRAPHY_SLOTS.body.size,
      "--mantine-line-height-md":
        MYOXUS_MANTINE_TYPOGRAPHY_SLOTS.body.lineHeight,
    },
    light: {
      ...resolved.light,
      ...runtimeVariables,
    },
    dark: {
      ...resolved.dark,
      ...runtimeVariables,
    },
  };
};

/**
 * Shared Mantine theme used by Web, Admin and Electron through the facade.
 * Component defaults may use Myoxus CSS-variable fallbacks for static boot
 * states, but product colors, typography and spacing must still come from the
 * server/generated theme projection rather than hard-coded route values.
 */
export const myoxusMantineTheme = createTheme({
  primaryColor: "myoxus",
  primaryShade: { light: 5, dark: 5 },
  autoContrast: true,
  luminanceThreshold: 0.36,
  defaultRadius: "md",
  cursorType: "pointer",
  fontFamily: MYOXUS_UI_FONT_FAMILY,
  fontFamilyMonospace: MYOXUS_MONO_FONT_FAMILY,
  fontSizes: {
    ...myoxusMantineFontSizes(),
    xs: MYOXUS_MANTINE_TYPOGRAPHY_SLOTS["body-small"].size,
    sm: MYOXUS_MANTINE_TYPOGRAPHY_SLOTS["label-compact"].size,
    md: MYOXUS_MANTINE_TYPOGRAPHY_SLOTS.body.size,
    lg: MYOXUS_MANTINE_TYPOGRAPHY_SLOTS.h4.size,
    xl: MYOXUS_MANTINE_TYPOGRAPHY_SLOTS.h3.size,
  },
  lineHeights: {
    ...myoxusMantineLineHeights(),
    xs: MYOXUS_MANTINE_TYPOGRAPHY_SLOTS["body-small"].lineHeight,
    sm: MYOXUS_MANTINE_TYPOGRAPHY_SLOTS["label-compact"].lineHeight,
    md: MYOXUS_MANTINE_TYPOGRAPHY_SLOTS.body.lineHeight,
    lg: MYOXUS_MANTINE_TYPOGRAPHY_SLOTS.blockquote.lineHeight,
    xl: MYOXUS_MANTINE_TYPOGRAPHY_SLOTS["page-title"].lineHeight,
  },
  fontWeights: {
    ...myoxusMantineFontWeights(),
    regular: MYOXUS_MANTINE_TYPOGRAPHY_SLOTS.body.weight,
    medium: MYOXUS_MANTINE_TYPOGRAPHY_SLOTS.link.weight,
    bold: MYOXUS_MANTINE_TYPOGRAPHY_SLOTS.h1.weight,
    body: MYOXUS_MANTINE_TYPOGRAPHY_SLOTS.body.weight,
    label: MYOXUS_MANTINE_TYPOGRAPHY_SLOTS["body-small"].weight,
    heading: MYOXUS_MANTINE_TYPOGRAPHY_SLOTS["section-title"].weight,
    mono: MYOXUS_MANTINE_TYPOGRAPHY_SLOTS.mono.weight,
  },
  headings: {
    fontFamily: MYOXUS_MANTINE_TYPOGRAPHY_SLOTS["section-title"].family,
    fontWeight: MYOXUS_MANTINE_TYPOGRAPHY_SLOTS["section-title"].weight,
    textWrap: "pretty",
    sizes: {
      h1: {
        fontSize: MYOXUS_MANTINE_TYPOGRAPHY_SLOTS["page-title"].size,
        lineHeight: MYOXUS_MANTINE_TYPOGRAPHY_SLOTS["page-title"].lineHeight,
        fontWeight: MYOXUS_MANTINE_TYPOGRAPHY_SLOTS["page-title"].weight,
      },
      h2: {
        fontSize: MYOXUS_MANTINE_TYPOGRAPHY_SLOTS["section-title"].size,
        lineHeight: MYOXUS_MANTINE_TYPOGRAPHY_SLOTS["section-title"].lineHeight,
        fontWeight: MYOXUS_MANTINE_TYPOGRAPHY_SLOTS["section-title"].weight,
      },
      h3: {
        fontSize: MYOXUS_MANTINE_TYPOGRAPHY_SLOTS.h3.size,
        lineHeight: MYOXUS_MANTINE_TYPOGRAPHY_SLOTS.h3.lineHeight,
        fontWeight: MYOXUS_MANTINE_TYPOGRAPHY_SLOTS.h3.weight,
      },
      h4: {
        fontSize: MYOXUS_MANTINE_TYPOGRAPHY_SLOTS.h4.size,
        lineHeight: MYOXUS_MANTINE_TYPOGRAPHY_SLOTS.h4.lineHeight,
        fontWeight: MYOXUS_MANTINE_TYPOGRAPHY_SLOTS.h4.weight,
      },
      h5: {
        fontSize: MYOXUS_MANTINE_TYPOGRAPHY_SLOTS.h5.size,
        lineHeight: MYOXUS_MANTINE_TYPOGRAPHY_SLOTS.h5.lineHeight,
        fontWeight: MYOXUS_MANTINE_TYPOGRAPHY_SLOTS.h5.weight,
      },
      h6: {
        fontSize: MYOXUS_MANTINE_TYPOGRAPHY_SLOTS.h6.size,
        lineHeight: MYOXUS_MANTINE_TYPOGRAPHY_SLOTS.h6.lineHeight,
        fontWeight: MYOXUS_MANTINE_TYPOGRAPHY_SLOTS.h6.weight,
      },
    },
  },
  colors: {
    myoxus: [...myoxusPrimaryScale],
    "myoxus-text-accent": mantineColorScale(MYOXUS_TEXT_ACCENT),
    "myoxus-text-annotation": mantineColorScale(
      "var(--myoxus-sem-annotation-ink)",
    ),
    "myoxus-text-danger": mantineColorScale(MYOXUS_ERROR),
    "myoxus-text-emphasis": mantineColorScale(MYOXUS_TEXT_EMPHASIS),
    "myoxus-text-link": mantineColorScale(MYOXUS_TEXT_LINK),
    "myoxus-text-muted": mantineColorScale(MYOXUS_TEXT_MUTED),
    "myoxus-text-primary": mantineColorScale(MYOXUS_TEXT_PRIMARY),
    "myoxus-text-secondary": mantineColorScale(MYOXUS_TEXT_SECONDARY),
    "myoxus-text-success": mantineColorScale(MYOXUS_SUCCESS),
    "myoxus-text-tertiary": mantineColorScale(MYOXUS_TEXT_TERTIARY),
    "myoxus-text-warning": mantineColorScale(cssVar("warningColor")),
    // Transient notification color scales. Each stop is an unversioned role,
    // so Light/Dark switching propagates without theme rewrites.
    // Stops 0–5 use the "paper" tint (card / accent-line background),
    // stops 6–9 use the "deep" accent (icon, filled border, text).
    // Index 6 is the color Mantine applies for `notifications.show({ color })`.
    myoxusError: myoxusNotificationScale(
      cssVar("backgroundErrorColor"),
      cssVar("errorColor"),
    ),
    myoxusSuccess: myoxusNotificationScale(
      cssVar("backgroundSuccessColor"),
      cssVar("successColor"),
    ),
    myoxusWarning: myoxusNotificationScale(
      cssVar("backgroundWarningColor"),
      cssVar("warningColor"),
    ),
    myoxusInfo: myoxusNotificationScale(
      cssVar("backgroundProcessingColor"),
      cssVar("processingColor"),
    ),
  },
  ...myoxusMantineDensity,
  breakpoints: {
    ...myoxusWebBreakpoints,
  },
  focusRing: "auto",
  other: {
    myoxusThemeProjection: {
      colorSource: "server-owned-theme-css",
      typographySource: "cssTypographyVar",
      densitySource: "mantine-theme",
      surfaceSource: "cssVar",
    },
  },
  components: {
    ActionIcon: ActionIcon.extend({
      defaultProps: {
        autoContrast: true,
        color: "myoxus",
        radius: "md",
      },
      classNames: {
        root: "myoxus-mantine-action-icon",
      },
    }),
    Alert: Alert.extend({
      defaultProps: {
        color: "myoxus",
        radius: "lg",
        variant: "light",
      },
      styles: {
        root: {
          background: MYOXUS_PRIMARY_SOFT_BG,
          borderColor: MYOXUS_BORDER,
          color: cssVar("textPrimaryColor"),
        },
        title: modalTitleStyle,
        message: controlDescriptionStyle,
      },
    }),
    // Mantine's factory extend is identity; defaults must not load chart code.
    Sparkline: {
      defaultProps: {
        // Inline table trends share cache density without product-owned geometry.
        w: "calc(var(--mantine-spacing-2xl) * 2)",
        h: "calc(var(--mantine-spacing-lg) + var(--mantine-spacing-xs))",
        color: "myoxus",
        fillOpacity: 0,
        withGradient: false,
        connectNulls: false,
      },
    },
    Avatar: Avatar.extend({
      defaultProps: {
        radius: "xl",
        variant: "light",
      },
      classNames: {
        placeholder: "myoxus-mantine-avatar-placeholder",
        root: "myoxus-mantine-avatar",
      },
      styles: {
        placeholder: {
          background: MYOXUS_PRIMARY_SOFT_BG,
          color: MYOXUS_TEXT_LINK,
          fontFamily: labelCompactTypography.fontFamily,
          fontWeight: labelCompactTypography.fontWeight,
        },
      },
    }),
    Badge: Badge.extend({
      defaultProps: {
        color: "myoxus",
        radius: "xl",
        variant: "light",
      },
      classNames: {
        root: "myoxus-mantine-badge",
      },
      styles: {
        root: {
          fontFamily: labelCompactTypography.fontFamily,
          fontSize: labelCompactTypography.fontSize,
          fontWeight: labelCompactTypography.fontWeight,
          lineHeight: labelCompactTypography.lineHeight,
        },
      },
    }),
    Button: Button.extend({
      defaultProps: {
        autoContrast: true,
        color: "myoxus",
        radius: "md",
      },
      classNames: {
        label: "myoxus-mantine-button-label",
        root: "myoxus-mantine-button",
      },
      styles: {
        root: buttonTextStyle,
      },
    }),
    Card: Card.extend({
      defaultProps: {
        radius: "lg",
        withBorder: true,
      },
      styles: {
        root: {
          background: cssVar("backgroundPrimaryColor"),
          borderColor: cssVar("borderColor"),
        },
      },
    }),
    Checkbox: Checkbox.extend({
      styles: (_theme, props) => {
        // Mantine's static dark-scheme checkbox rule follows its light rule and
        // therefore wins when a light renderer is nested inside a dark app.
        // Keep the native checked color, but source neutral states from the
        // server-projected semantic roles so embedded roots remain independent.
        const selected = Boolean(props.checked || props.indeterminate);
        const background = props.disabled
          ? MYOXUS_DISABLED_BG
          : selected
            ? "var(--checkbox-color)"
            : MYOXUS_SURFACE_PRIMARY;
        const borderColor = selected ? "var(--checkbox-color)" : MYOXUS_BORDER;
        return {
          description: controlDescriptionStyle,
          error: controlDescriptionStyle,
          input: { background, borderColor },
          label: controlChoiceLabelStyle,
        };
      },
    }),
    Combobox: Combobox.extend({
      defaultProps: {
        radius: "md",
        shadow: "md",
      },
      styles: {
        dropdown: controlDropdownStyle,
        empty: controlDescriptionStyle,
        option: controlOptionStyle,
      },
    }),
    Divider: Divider.extend({
      styles: {
        label: controlDescriptionStyle,
      },
    }),
    Drawer: Drawer.extend({
      defaultProps: {
        radius: "xl",
        shadow: "lg",
      },
      styles: {
        body: {
          color: cssVar("textPrimaryColor"),
          fontFamily: bodyTypography.fontFamily,
          fontSize: bodyTypography.fontSize,
          lineHeight: bodyTypography.lineHeight,
        },
        content: {
          background: cssVar("backgroundPrimaryColor"),
          color: cssVar("textPrimaryColor"),
        },
        header: {
          background: cssVar("backgroundPrimaryColor"),
        },
        title: modalTitleStyle,
      },
    }),
    Menu: Menu.extend({
      defaultProps: {
        shadow: "md",
        radius: "md",
      },
      styles: {
        divider: {
          borderColor: cssVar("borderColor"),
        },
        dropdown: menuDropdownStyle,
        itemLabel: menuItemLabelStyle,
        itemSection: menuItemSectionStyle,
        item: menuItemTextStyle,
        label: menuLabelTextStyle,
      },
    }),
    Modal: Modal.extend({
      defaultProps: {
        radius: "xl",
        shadow: "lg",
        zIndex: cssVar("zIndexModal"),
      },
      styles: {
        body: {
          color: cssVar("textPrimaryColor"),
          fontFamily: bodyTypography.fontFamily,
          fontSize: bodyTypography.fontSize,
          lineHeight: bodyTypography.lineHeight,
        },
        content: {
          background: cssVar("backgroundPrimaryColor"),
          color: cssVar("textPrimaryColor"),
        },
        header: {
          background: cssVar("backgroundPrimaryColor"),
        },
        title: modalTitleStyle,
      },
    }),
    MultiSelect: MultiSelect.extend({
      defaultProps: {
        radius: "md",
      },
      styles: {
        description: controlDescriptionStyle,
        dropdown: controlDropdownStyle,
        error: controlDescriptionStyle,
        input: controlInputStyle,
        label: controlLabelStyle,
        option: controlOptionStyle,
        pill: {
          fontFamily: bodySmallTypography.fontFamily,
          fontSize: bodySmallTypography.fontSize,
          lineHeight: bodySmallTypography.lineHeight,
        },
      },
    }),
    NavLink: NavLink.extend({
      defaultProps: {
        autoContrast: true,
        color: "myoxus",
        variant: "light",
      },
      styles: {
        description: controlDescriptionStyle,
        label: {
          fontFamily: navTypography.fontFamily,
          fontSize: navTypography.fontSize,
          fontWeight: navTypography.fontWeight,
          lineHeight: navTypography.lineHeight,
        },
      },
    }),
    Notification: Notification.extend({
      defaultProps: {
        radius: "lg",
        withBorder: true,
      },
      styles: {
        description: controlTypographyStyle,
        root: {
          background: cssVar("backgroundOverlayPanelColor"),
          borderColor: cssVar("borderColor"),
          color: cssVar("textPrimaryColor"),
        },
        title: controlTypographyStyle,
      },
    }),
    NumberInput: NumberInput.extend({
      defaultProps: {
        radius: "md",
      },
      styles: {
        description: controlDescriptionStyle,
        error: controlDescriptionStyle,
        input: controlInputStyle,
        label: controlLabelStyle,
      },
    }),
    PasswordInput: PasswordInput.extend({
      defaultProps: {
        radius: "md",
      },
      styles: {
        description: controlDescriptionStyle,
        error: controlDescriptionStyle,
        input: controlInputStyle,
        label: controlLabelStyle,
      },
    }),
    Popover: Popover.extend({
      defaultProps: {
        radius: "md",
        shadow: "md",
        zIndex: cssVar("zIndexPopover"),
      },
      styles: {
        dropdown: controlDropdownStyle,
      },
    }),
    Radio: Radio.extend({
      styles: {
        description: controlDescriptionStyle,
        error: controlDescriptionStyle,
        label: controlChoiceLabelStyle,
      },
    }),
    SegmentedControl: SegmentedControl.extend({
      defaultProps: {
        radius: "md",
      },
      classNames: {
        control: "myoxus-mantine-segmented-control-item",
        label: "myoxus-mantine-segmented-control-label",
        root: "myoxus-mantine-segmented-control",
      },
      styles: {
        label: buttonTextStyle,
      },
    }),
    Select: Select.extend({
      defaultProps: {
        radius: "md",
      },
      styles: {
        description: controlDescriptionStyle,
        dropdown: controlDropdownStyle,
        error: controlDescriptionStyle,
        input: controlInputStyle,
        label: controlLabelStyle,
        option: controlOptionStyle,
      },
    }),
    Slider: Slider.extend({
      defaultProps: {
        color: "myoxus",
      },
    }),
    Stepper: Stepper.extend({
      defaultProps: {
        autoContrast: true,
        color: "myoxus",
        radius: "xl",
        size: "sm",
      },
      styles: {
        root: {
          color: cssVar("textPrimaryColor"),
          fontFamily: bodyTypography.fontFamily,
        },
        separator: {
          backgroundColor: cssVar("borderColor"),
        },
        stepDescription: stepperDescriptionStyle,
        stepLabel: stepperLabelStyle,
        verticalSeparator: {
          borderColor: cssVar("borderColor"),
        },
      },
    }),
    Switch: Switch.extend({
      classNames: {
        label: "myoxus-mantine-switch-label",
      },
      styles: {
        description: controlDescriptionStyle,
        error: controlDescriptionStyle,
        label: controlChoiceLabelStyle,
      },
    }),
    Tabs: Tabs.extend({
      defaultProps: {
        color: "myoxus",
        radius: "md",
      },
      styles: {
        tab: {
          ...buttonTextStyle,
          // Override on the tab: Mantine computes its own root contrast from
          // colors that can be unresolved server CSS variables.
          "--tabs-text-color": MYOXUS_BUTTON_PRIMARY_FG,
        },
      },
    }),
    Table: Table.extend({
      styles: {
        th: {
          background: MYOXUS_SURFACE_PRIMARY,
        },
      },
    }),
    Text: Text.extend({
      defaultProps: {
        c: "myoxus-text-primary",
        size: "body",
      },
      classNames: {
        root: "myoxus-mantine-text",
      },
    }),
    Textarea: Textarea.extend({
      defaultProps: {
        radius: "md",
      },
      styles: {
        description: controlDescriptionStyle,
        error: controlDescriptionStyle,
        input: controlInputStyle,
        label: controlLabelStyle,
      },
    }),
    TextInput: TextInput.extend({
      defaultProps: {
        radius: "md",
      },
      styles: {
        description: controlDescriptionStyle,
        error: controlDescriptionStyle,
        input: controlInputStyle,
        label: controlLabelStyle,
      },
    }),
    Timeline: Timeline.extend({
      defaultProps: {
        active: -1,
        align: "left",
        autoContrast: true,
        color: "myoxus",
        radius: "xl",
      },
      styles: {
        item: {
          color: cssVar("textPrimaryColor"),
        },
        itemBullet: {
          background: cssVar("backgroundPrimaryColor"),
          borderColor: cssVar("borderColor"),
          color: cssVar("iconColor"),
        },
        itemContent: controlDescriptionStyle,
        itemTitle: controlLabelStyle,
      },
    }),
    Title: Title.extend({
      defaultProps: {
        c: "myoxus-text-primary",
      },
      classNames: {
        root: "myoxus-mantine-title",
      },
    }),
    Typography: Typography.extend({
      defaultProps: {
        c: "myoxus-text-primary",
      },
      styles: {
        root: {
          fontFamily: bodyTypography.fontFamily,
          fontSize: bodyTypography.fontSize,
          lineHeight: bodyTypography.lineHeight,
        },
      },
    }),
    Tooltip: Tooltip.extend({
      defaultProps: {
        color: "myoxus",
        radius: "md",
        withArrow: true,
        // Availability hints must stay above their owning menu or modal.
        zIndex: `calc(${cssVar("zIndexPopover")} + 1)`,
      },
      styles: {
        tooltip: {
          fontFamily: bodySmallTypography.fontFamily,
          fontSize: bodySmallTypography.fontSize,
          fontWeight: bodySmallTypography.fontWeight,
          lineHeight: bodySmallTypography.lineHeight,
        },
      },
    }),
  },
});

export type MyoxusThemeMode = "dark" | "light" | "system";

export type MyoxusThemeModeProviderProps = PropsWithChildren<{
  themes?: string[];
  enableSystem?: boolean;
  defaultTheme?: MyoxusThemeMode;
  storageKey?: string;
  persist?: boolean;
}>;

export type MyoxusThemeContextValue = {
  theme: MyoxusThemeMode;
  resolvedTheme: "dark" | "light";
  setTheme: (theme: MyoxusThemeMode) => void;
};

const DEFAULT_THEME: MyoxusThemeMode = "system";
const DEFAULT_STORAGE_KEY = "myoxus-theme";
const ThemeModeContext = createContext<MyoxusThemeContextValue | null>(null);

function normalizeThemeMode(
  value: string | null | undefined,
  enableSystem = true,
): MyoxusThemeMode | null {
  if (value === "dark" || value === "light") return value;
  if (enableSystem && value === "system") return value;
  return null;
}

function systemColorScheme(): "dark" | "light" {
  if (typeof window === "undefined" || !window.matchMedia) {
    return "light";
  }
  return window.matchMedia("(prefers-color-scheme: dark)").matches
    ? "dark"
    : "light";
}

function resolveThemeMode(theme: MyoxusThemeMode): "dark" | "light" {
  return theme === "system" ? systemColorScheme() : theme;
}

function readStoredTheme(
  storageKey: string,
  defaultTheme: MyoxusThemeMode,
  enableSystem: boolean,
): MyoxusThemeMode {
  if (typeof window === "undefined") return defaultTheme;
  try {
    return (
      normalizeThemeMode(
        window.localStorage.getItem(storageKey),
        enableSystem,
      ) ?? defaultTheme
    );
  } catch {
    return defaultTheme;
  }
}

function writeStoredTheme(storageKey: string, theme: MyoxusThemeMode) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(storageKey, theme);
  } catch {
    // Storage can be unavailable in locked-down browser contexts; the in-memory
    // state still keeps the current tab usable.
  }
}

function applyDocumentTheme(resolvedTheme: "dark" | "light") {
  if (typeof document === "undefined") return;
  document.documentElement.dataset.theme = resolvedTheme;
  document.documentElement.style.colorScheme = resolvedTheme;
}

function readDocumentResolvedTheme(): "dark" | "light" {
  if (typeof document !== "undefined") {
    const explicit = document.documentElement.dataset.theme;
    if (explicit === "dark" || explicit === "light") return explicit;
  }
  return systemColorScheme();
}

function subscribeToSystemTheme(onChange: () => void) {
  if (typeof window === "undefined" || !window.matchMedia) {
    return () => undefined;
  }
  const query = window.matchMedia("(prefers-color-scheme: dark)");
  query.addEventListener?.("change", onChange);
  query.addListener?.(onChange);
  return () => {
    query.removeEventListener?.("change", onChange);
    query.removeListener?.(onChange);
  };
}

export function MyoxusThemeModeProvider({
  children,
  enableSystem = true,
  defaultTheme = DEFAULT_THEME,
  storageKey = DEFAULT_STORAGE_KEY,
  persist = true,
}: MyoxusThemeModeProviderProps) {
  const normalizedDefault =
    normalizeThemeMode(defaultTheme, enableSystem) ?? "light";
  const [theme, setThemeState] = useState<MyoxusThemeMode>(() =>
    persist
      ? readStoredTheme(storageKey, normalizedDefault, enableSystem)
      : normalizedDefault,
  );
  const [systemTheme, setSystemTheme] = useState<"dark" | "light">(
    systemColorScheme,
  );

  const resolvedTheme = theme === "system" ? systemTheme : theme;

  const setTheme = useCallback(
    (nextTheme: MyoxusThemeMode) => {
      const normalized = normalizeThemeMode(nextTheme, enableSystem);
      if (!normalized) return;
      if (persist) writeStoredTheme(storageKey, normalized);
      setThemeState(normalized);
    },
    [enableSystem, persist, storageKey],
  );

  useEffect(() => {
    applyDocumentTheme(resolvedTheme);
  }, [resolvedTheme]);

  useEffect(() => {
    return subscribeToSystemTheme(() => {
      setSystemTheme(systemColorScheme());
    });
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return undefined;
    if (!persist) return undefined;
    const onStorage = (event: StorageEvent) => {
      if (event.key !== storageKey) return;
      setThemeState(
        normalizeThemeMode(event.newValue, enableSystem) ?? normalizedDefault,
      );
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, [enableSystem, normalizedDefault, persist, storageKey]);

  const value = useMemo<MyoxusThemeContextValue>(
    () => ({ theme, resolvedTheme, setTheme }),
    [resolvedTheme, setTheme, theme],
  );

  return (
    <ThemeModeContext.Provider value={value}>
      {children}
    </ThemeModeContext.Provider>
  );
}

export function useMyoxusTheme(): MyoxusThemeContextValue {
  const context = useContext(ThemeModeContext);
  if (context) return context;
  const resolvedTheme = readDocumentResolvedTheme();
  return {
    theme: resolvedTheme,
    resolvedTheme,
    setTheme: (theme) => {
      const resolved = resolveThemeMode(theme);
      applyDocumentTheme(resolved);
      writeStoredTheme(DEFAULT_STORAGE_KEY, theme);
    },
  };
}

function useObservedResolvedTheme() {
  const [resolvedTheme, setResolvedTheme] = useState<"dark" | "light">(
    readDocumentResolvedTheme,
  );

  useEffect(() => {
    if (typeof document === "undefined") return undefined;
    const update = () => setResolvedTheme(readDocumentResolvedTheme());
    const observer = new MutationObserver(update);
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme"],
    });
    const unsubscribeSystem = subscribeToSystemTheme(update);
    window.addEventListener("storage", update);
    return () => {
      observer.disconnect();
      unsubscribeSystem();
      window.removeEventListener("storage", update);
    };
  }, []);

  return resolvedTheme;
}

function normalizeMantineColorScheme(theme?: string): "dark" | "light" {
  return theme === "dark" ? "dark" : "light";
}

type MyoxusMantineProviderProps = PropsWithChildren<{
  colorScheme?: "dark" | "light";
  cssVariablesSelector?: string;
  /** Selects Mantine's supported deterministic environment for test harnesses. */
  env?: "default" | "test";
  getRootElement?: () => HTMLElement | undefined;
  withCssVariables?: boolean;
  withGlobalClasses?: boolean;
}>;

function MyoxusMantineProvider({
  children,
  colorScheme: colorSchemeOverride,
  cssVariablesSelector,
  env,
  getRootElement,
  withCssVariables,
  withGlobalClasses,
}: MyoxusMantineProviderProps) {
  const themeContext = useContext(ThemeModeContext);
  const observedTheme = useObservedResolvedTheme();
  const colorScheme =
    colorSchemeOverride ??
    normalizeMantineColorScheme(themeContext?.resolvedTheme ?? observedTheme);

  return (
    <MantineProvider
      theme={myoxusMantineTheme}
      cssVariablesResolver={myoxusMantineCssVariablesResolver}
      cssVariablesSelector={cssVariablesSelector}
      env={env}
      getRootElement={getRootElement}
      withCssVariables={withCssVariables}
      withGlobalClasses={withGlobalClasses}
      forceColorScheme={colorScheme}
      defaultColorScheme={colorScheme}
    >
      {children}
    </MantineProvider>
  );
}

const NotificationHostContext = createContext(false);

export function MyoxusUIProvider({
  children,
  env,
}: PropsWithChildren<{ env?: "default" | "test" }>) {
  const hasNotificationHost = useContext(NotificationHostContext);
  return (
    <NotificationHostContext.Provider value={true}>
      <MyoxusMantineProvider env={env}>
        {/* INV-NOTIF-01 + INV-NOTIF-04: this is the only transient notification
          portal in the product. Product roots must not mount their own
          `<Notifications />` or wrap the Facade renderer; the Facade `notify`
          API is the single entry point and routes through here. */}
        {/* Nested settings providers inherit the application host. */}
        {/* Native default clips persistent results at 200px. Keep their
            actions/details reachable without product-specific size props. */}
        {!hasNotificationHost && (
          <Notifications
            position="bottom-center"
            limit={5}
            notificationMaxHeight="calc(100dvh - var(--mantine-spacing-xl) * 2)"
            styles={{
              notification: { overflowY: "auto", alignItems: "flex-start" },
            }}
          />
        )}
        {children}
      </MyoxusMantineProvider>
    </NotificationHostContext.Provider>
  );
}

/**
 * Mantine/Facade context for React roots embedded inside another renderer.
 *
 * Embedded roots inherit the nearest renderer theme (when supplied) or the
 * application theme. A caller with a renderer-local light/dark boundary can
 * provide a root selector to materialize Mantine and Facade variables against
 * the server-owned Myoxus roles inherited at that boundary. Global responsive
 * classes remain owned by the application provider. Embedded roots never
 * mutate the application root or mount global portals such as Notifications.
 */
export function MyoxusEmbeddedUIProvider({
  children,
  colorScheme,
  cssVariablesSelector,
  getRootElement,
}: PropsWithChildren<{
  colorScheme?: "dark" | "light";
  /**
   * Materializes Facade roles at a renderer-local root. Omit when the embedded
   * surface always shares the application theme.
   */
  cssVariablesSelector?: string;
  getRootElement: () => HTMLElement | undefined;
}>) {
  return (
    <MyoxusMantineProvider
      colorScheme={colorScheme}
      cssVariablesSelector={cssVariablesSelector}
      getRootElement={getRootElement}
      withCssVariables={Boolean(cssVariablesSelector)}
      withGlobalClasses={false}
    >
      {children}
    </MyoxusMantineProvider>
  );
}

export const myoxusSettingsMantineTheme = myoxusMantineTheme;
export const MyoxusSettingsMantineProvider = MyoxusUIProvider;
