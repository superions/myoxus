import type { ComponentProps } from "react";
import type { ThemeDefinition } from "../../theme/theme-contract";
import type { ThemeTypographyStyle } from "../../theme/theme-contract";
/** @vitest-environment happy-dom */
import { MyoxusUIProvider } from "@myoxus/ui-facade/provider";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";

import { afterEach, describe, expect, test, vi } from "vitest";

import enJson from "../../../../../../../libs/i18n/src/resources/en.json";

const en: Record<string, string> = enJson;

vi.mock("@myoxus/i18n", () => ({
  useI18n: () => ({
    t: (key: string): string => en[key] ?? key,
  }),
}));

import { ThemeGallery } from "../theme-gallery";

const LIGHT = {
  paper: "#faf7f2",
  "paper-deep": "#f0e7dc",
  "background-code-block": "#e8dfd4",
  ink: "#1f2330",
  "ink-soft": "#4a5061",
  "ink-mute": "#7a8090",
  rule: "#d9d0c5",
  "accent-primary": "#7d2841",
  "link-default": "#7d2841",
  "accent-secondary": "#35695a",
  "status-success-paper": "#e7f5ee",
  "status-success-deep": "#1d6a46",
  "status-pending-paper": "#fff5d6",
  "status-pending-deep": "#9a6200",
  "status-error-paper": "#ffe2e2",
  "status-error-deep": "#a32020",
  "status-preset-paper": "#ece8ff",
  "status-preset-deep": "#5145a8",
  "status-info-paper": "#e3f1ff",
  "status-info-deep": "#1d5f9f",
};
const DARK = {
  ...LIGHT,
  paper: "#111827",
  "paper-deep": "#1f2937",
  ink: "#f8fafc",
  "ink-soft": "#d1d5db",
  "ink-mute": "#9ca3af",
  rule: "#374151",
};

function typographyStyle(
  styleKey: string,
  family: string,
  weight: number,
  letterSpacingEm = 0,
): ThemeTypographyStyle {
  return {
    styleKey,
    fontFamilySlug: family.toLowerCase().replaceAll(" ", "-"),
    fontFamily: family,
    cssFamily: family,
    fontWeight: weight,
    fontStyle: "normal",
    sizePx: styleKey === "section.title" ? 24 : 14,
    lineHeight: styleKey === "section.title" ? 1.25 : 1.5,
    letterSpacingEm,
    textTransform: null,
    decoration: null,
    hoverDecoration: null,
    fontFeatures: {},
    fontVariations: {},
    pdfRole: null,
  };
}

function theme(
  slug: string,
  options: {
    category: string;
    previewGroup: string;
    previewOrder: number;
    headingFamily: string;
    bodyFamily: string;
    origin?: string;
    dark?: typeof DARK;
  },
): ThemeDefinition {
  const origin = options.origin ?? "system";
  return {
    slug,
    name: slug.toUpperCase(),
    category: options.category,
    previewGroup: options.previewGroup,
    previewOrder: options.previewOrder,
    taglineKey: `admin.design.theme.${slug}.tagline`,
    descriptionKey: `admin.design.theme.${slug}.description`,
    origin,
    locked: origin === "system",
    isDefault: slug === "stuttgart",
    colorSchemaSlug: slug,
    typographySlug: slug,
    colors: { light: LIGHT, dark: options.dark ?? DARK },
    typographyStyles: [
      typographyStyle("section.title", options.headingFamily, 700, -0.015),
      typographyStyle("body.default", options.bodyFamily, 400),
      typographyStyle("code.block", "JetBrains Mono", 400),
    ],
  };
}

const THEMES = [
  theme("stuttgart", {
    category: "sans-leaning",
    previewGroup: "sans-foundations",
    previewOrder: 1,
    headingFamily: "Inter",
    bodyFamily: "Inter",
  }),
  theme("berlin", {
    category: "expressive-existing",
    previewGroup: "refined-editorial",
    previewOrder: 9,
    headingFamily: "Bebas Neue",
    bodyFamily: "Lato",
  }),
  theme("lisboa", {
    category: "expressive-existing",
    previewGroup: "warm-expressive",
    previewOrder: 13,
    headingFamily: "Pattaya",
    bodyFamily: "Open Sans",
  }),
  theme("custom-light", {
    category: "sans-leaning",
    previewGroup: "sans-foundations",
    previewOrder: 100,
    headingFamily: "Lora",
    bodyFamily: "Nunito",
    origin: "custom",
    dark: { ...LIGHT, paper: "#fefefe" },
  }),
];

function renderGallery(
  overrides: Partial<ComponentProps<typeof ThemeGallery>> = {},
) {
  const onSelectPreset = vi.fn();
  const onSelectMode = vi.fn();
  render(
    <MyoxusUIProvider>
      <ThemeGallery
        themes={THEMES}
        activePreset="stuttgart"
        activeMode="system"
        onSelectPreset={onSelectPreset}
        onSelectMode={onSelectMode}
        {...overrides}
      />
    </MyoxusUIProvider>,
  );
  return { onSelectPreset, onSelectMode };
}

describe("ThemeGallery", () => {
  afterEach(cleanup);

  test("shows body and link specimens without nested interactive controls", () => {
    const { onSelectPreset } = renderGallery({ activeMode: "light" });
    const card = screen.getByTestId("theme-gallery-card-stuttgart");
    expect(card.textContent).toContain(en["admin.typography.preview.body"]);
    const specimen = card.querySelector(
      "[data-myoxus-ui-role=authoring-typography-link]",
    );
    expect(specimen?.tagName).toBe("SPAN");
    expect(card.style.getPropertyValue("--theme-card-link")).toBe(
      LIGHT["link-default"],
    );
    fireEvent.click(specimen!);
    expect(onSelectPreset).toHaveBeenCalledWith("stuttgart");
  });

  test("inv_catalog_filters_use_server_metadata", () => {
    renderGallery();

    fireEvent.click(screen.getByTestId("theme-gallery-filter-sans"));
    expect(screen.getByTestId("theme-gallery-card-stuttgart")).toBeTruthy();
    expect(screen.queryByTestId("theme-gallery-card-berlin")).toBeNull();

    fireEvent.click(screen.getByTestId("theme-gallery-filter-expressive"));
    expect(screen.queryByTestId("theme-gallery-card-stuttgart")).toBeNull();
    expect(screen.getByTestId("theme-gallery-card-berlin")).toBeTruthy();
    expect(screen.getByTestId("theme-gallery-card-lisboa")).toBeTruthy();

    fireEvent.click(screen.getByTestId("theme-gallery-filter-custom"));
    expect(screen.queryByTestId("theme-gallery-card-stuttgart")).toBeNull();
    expect(screen.getByTestId("theme-gallery-card-custom-light")).toBeTruthy();
  });

  test("inv_dark_filter_uses_catalog_color_tokens", () => {
    renderGallery();

    fireEvent.click(screen.getByTestId("theme-gallery-filter-dark"));
    expect(screen.getByTestId("theme-gallery-card-stuttgart")).toBeTruthy();
    expect(screen.getByTestId("theme-gallery-card-berlin")).toBeTruthy();
    expect(screen.queryByTestId("theme-gallery-card-custom-light")).toBeNull();
  });

  test("inv_card_preview_typography_and_colors_are_card_local", () => {
    renderGallery();

    const stuttgart = screen.getByTestId("theme-gallery-card-stuttgart");
    const berlin = screen.getByTestId("theme-gallery-card-berlin");

    expect(
      stuttgart.style.getPropertyValue("--authoring-typography-h2-family"),
    ).toBe("Inter");
    expect(
      berlin.style.getPropertyValue("--authoring-typography-h2-family"),
    ).toBe("Bebas Neue");
    expect(berlin.style.getPropertyValue("--theme-card-body-family")).toBe(
      '"Lato"',
    );
    expect(berlin.style.getPropertyValue("--theme-card-accent")).toBe(
      LIGHT["accent-primary"],
    );
    expect(stuttgart.getAttribute("data-authoring-preview-kind")).toBe(
      "theme-card",
    );
    expect(stuttgart.style.getPropertyValue("--theme-card-paper")).toBe(
      LIGHT.paper,
    );
    expect(stuttgart.style.getPropertyValue("--theme-card-ink")).toBe(
      LIGHT.ink,
    );
    expect(
      stuttgart.style.getPropertyValue("--theme-card-background-code-block"),
    ).toBe(LIGHT["background-code-block"]);
    expect(
      stuttgart.style.getPropertyValue(
        "--authoring-typography-code-block-family",
      ),
    ).toBe('"JetBrains Mono"');
    expect(
      screen.getByTestId("theme-gallery-card-title-stuttgart").className,
    ).toContain("myoxus-authoring-preview-title");
  });

  test("inv_dark_preview_copy_falls_back_to_readable_theme_ink", () => {
    renderGallery({
      activeMode: "dark",
      themes: [
        theme("low-contrast-dark", {
          category: "sans-leaning",
          previewGroup: "sans-foundations",
          previewOrder: 1,
          headingFamily: "Inter",
          bodyFamily: "Inter",
          dark: {
            ...DARK,
            paper: "#08090c",
            ink: "#ece6da",
            "ink-soft": "#4b5363",
            "ink-mute": "#4b5363",
          },
        }),
      ],
    });

    const card = screen.getByTestId("theme-gallery-card-low-contrast-dark");
    expect(card.style.getPropertyValue("--theme-card-ink-soft")).toBe(
      "#ece6da",
    );
    expect(card.style.getPropertyValue("--theme-card-ink-mute")).toBe(
      "#ece6da",
    );
  });

  test("inv_active_card_and_mode_are_marked", () => {
    renderGallery({ activePreset: "berlin", activeMode: "dark" });

    expect(screen.getByTestId("theme-gallery-card-berlin").dataset.active).toBe(
      "true",
    );
    expect(
      screen.getByTestId("theme-gallery-card-stuttgart").dataset.active,
    ).toBe("false");
    expect(
      within(screen.getByTestId("theme-gallery-mode-group")).getByRole(
        "radio",
        {
          name: en["admin.design.mode.dark"],
        },
      ),
    ).toHaveProperty("checked", true);
  });

  test("inv_mode_pill_click_calls_onSelectMode", () => {
    const { onSelectMode } = renderGallery();

    fireEvent.click(screen.getByTestId("theme-gallery-mode-light"));
    expect(onSelectMode).toHaveBeenCalledWith("light");

    fireEvent.click(screen.getByTestId("theme-gallery-mode-dark"));
    expect(onSelectMode).toHaveBeenLastCalledWith("dark");
  });
});
