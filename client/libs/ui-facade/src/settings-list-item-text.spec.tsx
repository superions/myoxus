// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * @vitest-environment happy-dom
 */

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test } from "vitest";

import {
  SettingsListItemMeta,
  SettingsListItemTitle,
  SettingsSectionDescription,
  SettingsSectionHeading,
} from "./index";
import { MyoxusSettingsMantineProvider } from "./provider";

describe("Settings list item text roles", () => {
  afterEach(() => cleanup());

  test("exposes shared title and muted meta roles without route-local classes", () => {
    render(
      <MyoxusSettingsMantineProvider>
        <SettingsListItemTitle>Alpha</SettingsListItemTitle>
        <SettingsListItemMeta>Owner: admin@myoxus.local</SettingsListItemMeta>
      </MyoxusSettingsMantineProvider>,
    );

    expect(screen.getByText("Alpha").dataset.myoxusUiRole).toBe(
      "settings-list-item-title",
    );
    expect(
      screen.getByText("Owner: admin@myoxus.local").dataset.myoxusUiRole,
    ).toBe("settings-list-item-meta-muted");
  });

  test("keeps active and error meta states semantic for status rows", () => {
    render(
      <MyoxusSettingsMantineProvider>
        <SettingsListItemMeta tone="active">Gespeichert</SettingsListItemMeta>
        <SettingsListItemMeta tone="error">Fehler</SettingsListItemMeta>
      </MyoxusSettingsMantineProvider>,
    );

    expect(screen.getByText("Gespeichert").dataset.myoxusUiRole).toBe(
      "settings-list-item-meta-active",
    );
    expect(screen.getByText("Fehler").dataset.myoxusUiRole).toBe(
      "settings-list-item-meta-error",
    );
  });

  test("uses provider-owned text tones and keeps narrow content overflow hooks", () => {
    render(
      <MyoxusSettingsMantineProvider>
        <SettingsListItemTitle
          lineClamp={2}
          previewFontFamily="Preview Family"
          title="Font preview"
        >
          Font preview
        </SettingsListItemTitle>
        <SettingsListItemMeta breakAnywhere tone="active">
          https://myoxus.local/a-very-long-share-url
        </SettingsListItemMeta>
      </MyoxusSettingsMantineProvider>,
    );

    const title = screen.getByText("Font preview");
    const active = screen.getByText(
      "https://myoxus.local/a-very-long-share-url",
    );

    expect(title.getAttribute("style")).toContain(
      "color: var(--mantine-color-myoxus-text-primary-text)",
    );
    expect(title.getAttribute("style")).toContain(
      'font-family: "Preview Family"',
    );
    expect(title.getAttribute("style")).toContain("--text-line-clamp: 2");
    expect(title.getAttribute("title")).toBe("Font preview");
    expect(active.getAttribute("style")).toContain(
      "color: var(--mantine-color-myoxus-text-emphasis-text)",
    );
    expect(active.getAttribute("style")).toContain("overflow-wrap: anywhere");
  });

  test("exposes semantic section headings and descriptions through shared typography roles", () => {
    render(
      <MyoxusSettingsMantineProvider>
        <SettingsSectionHeading level={1}>Organisation</SettingsSectionHeading>
        <SettingsSectionDescription>
          Verwaltet Organisationseinheiten.
        </SettingsSectionDescription>
      </MyoxusSettingsMantineProvider>,
    );

    const heading = screen.getByRole("heading", {
      level: 1,
      name: "Organisation",
    });
    expect(heading.dataset.myoxusUiRole).toBe(
      "settings-section-heading-level-1",
    );
    expect(
      screen.getByText("Verwaltet Organisationseinheiten.").dataset
        .myoxusUiRole,
    ).toBe("settings-section-description");
  });
});
