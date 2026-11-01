import type { ReactElement } from "react";
import type { ThemeDefinition } from "../../../theme/theme-contract";
/** @vitest-environment happy-dom */
import { MyoxusUIProvider } from "@myoxus/ui-facade/provider";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import enJson from "../../../../../../../../libs/i18n/src/resources/en.json";

const en: Record<string, string> = enJson;

const apiMocks = vi.hoisted(() => ({
  setColorSchemaValues: vi.fn(),
}));

vi.mock("@myoxus/i18n", () => ({
  useI18n: () => ({
    t: (key: string, values?: Record<string, string>): string => {
      let value = en[key] ?? key;
      for (const [token, replacement] of Object.entries(values ?? {})) {
        value = value.replace(`{{${token}}}`, replacement);
      }
      return value;
    },
  }),
}));

vi.mock("../../../theme/theme-api", () => ({
  useSetColorSchemaValuesMutation: () => ({
    setColorSchemaValues: apiMocks.setColorSchemaValues,
    isMutating: false,
  }),
}));

import { ColorsTab } from "../colors-tab";

function renderWithFacade(ui: ReactElement) {
  return render(<MyoxusUIProvider>{ui}</MyoxusUIProvider>);
}

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
  "accent-primary": "#f59e0b",
  "link-default": "#f59e0b",
};

const THEME: ThemeDefinition = {
  slug: "atlas",
  name: "Atlas",
  origin: "system",
  locked: true,
  isDefault: true,
  colors: { light: LIGHT, dark: DARK },
  typographyStyles: [],
};

describe("ColorsTab", () => {
  beforeEach(() => {
    apiMocks.setColorSchemaValues.mockReset();
    apiMocks.setColorSchemaValues.mockResolvedValue({ theme: THEME });
  });

  afterEach(cleanup);

  test("rebases sibling profile changes without discarding dirty tokens", () => {
    const view = renderWithFacade(<ColorsTab theme={THEME} />);
    fireEvent.change(screen.getByTestId("colors-tab-input-light-paper"), {
      target: { value: "#123456" },
    });
    const next = {
      ...THEME,
      slug: "workspace-clone",
      colors: {
        light: { ...LIGHT, rule: "#abcdef" },
        dark: DARK,
      },
    };
    view.rerender(
      <MyoxusUIProvider>
        <ColorsTab theme={next} />
      </MyoxusUIProvider>,
    );
    expect(screen.getByTestId("colors-tab-input-light-paper")).toHaveProperty(
      "value",
      "#123456",
    );
    expect(screen.getByTestId("colors-tab-input-light-rule")).toHaveProperty(
      "value",
      "#abcdef",
    );
    fireEvent.click(screen.getByTestId("colors-tab-reset"));
    expect(screen.getByTestId("colors-tab-input-light-paper")).toHaveProperty(
      "value",
      LIGHT.paper,
    );
  });

  test("inv_dark_mode_switch_reads_dark_catalog_tokens", () => {
    renderWithFacade(<ColorsTab theme={THEME} />);

    expect(screen.getByTestId("colors-tab-input-light-paper")).toHaveProperty(
      "value",
      "#faf7f2",
    );
    fireEvent.click(screen.getByTestId("colors-tab-mode-dark"));
    expect(screen.getByTestId("colors-tab-input-dark-paper")).toHaveProperty(
      "value",
      "#111827",
    );
    expect(
      screen.getByTestId("colors-tab-input-dark-accent-primary"),
    ).toHaveProperty("value", "#f59e0b");
  });

  test("inv_invalid_or_missing_theme_does_not_fallback_to_client_presets", () => {
    renderWithFacade(<ColorsTab theme={null} />);

    expect(screen.getByTestId("design-colors-tab")).toBeTruthy();
    expect(screen.getByText(en["admin.design.colors.no-theme"]!)).toBeTruthy();
    expect(screen.getAllByDisplayValue("").length).toBeGreaterThan(0);
    expect(screen.getByTestId("colors-tab-save")).toHaveProperty(
      "disabled",
      true,
    );
  });

  test("inv_saves_only_changed_tokens_through_adminroot_color_mutation", async () => {
    renderWithFacade(<ColorsTab theme={THEME} workspaceId="workspace-1" />);

    fireEvent.change(
      screen.getByTestId("colors-tab-input-light-link-default"),
      {
        target: { value: "#ABCDEF" },
      },
    );
    expect(
      screen
        .getByTestId("colors-tab-preview")
        .style.getPropertyValue("--authoring-color-link"),
    ).toBe("#abcdef");
    expect(
      screen.getByTestId("colors-tab-input-light-accent-primary"),
    ).toHaveProperty("value", LIGHT["accent-primary"]);
    expect(screen.getAllByRole("link")).toHaveLength(2);
    fireEvent.click(screen.getByTestId("colors-tab-mode-dark"));
    fireEvent.change(
      screen.getByTestId("colors-tab-input-dark-accent-primary"),
      {
        target: { value: "#123456" },
      },
    );
    fireEvent.click(screen.getByTestId("colors-tab-save"));

    await waitFor(() => {
      expect(apiMocks.setColorSchemaValues).toHaveBeenCalledWith({
        workspaceId: "workspace-1",
        colors: [
          { mode: "light", tokenKey: "link-default", value: "#abcdef" },
          { mode: "dark", tokenKey: "accent-primary", value: "#123456" },
        ],
      });
    });
  });

  test("inv_blocks_invalid_hex_before_adminroot_mutation", async () => {
    renderWithFacade(<ColorsTab theme={THEME} />);

    fireEvent.change(screen.getByTestId("colors-tab-input-light-paper"), {
      target: { value: "red" },
    });
    fireEvent.click(screen.getByTestId("colors-tab-save"));

    expect(
      await screen.findByTestId("colors-tab-error-light-paper"),
    ).toBeTruthy();
    expect(apiMocks.setColorSchemaValues).not.toHaveBeenCalled();
  });
});
