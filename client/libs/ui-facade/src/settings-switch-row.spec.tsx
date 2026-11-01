// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * @vitest-environment happy-dom
 */

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";

import { SettingsSwitchRow, Switch } from "./index";
import { MyoxusSettingsMantineProvider } from "./provider";

describe("SettingsSwitchRow", () => {
  afterEach(() => cleanup());

  test("preserves native checked semantics for standalone switches", () => {
    render(
      <MyoxusSettingsMantineProvider>
        <Switch checked={true} testId="standalone-switch" />
      </MyoxusSettingsMantineProvider>,
    );

    const switchInput = screen.getByTestId("standalone-switch");
    expect(switchInput.dataset.myoxusUiRole).toBe("settings-switch");
    expect((screen.getByRole("switch") as HTMLInputElement).checked).toBe(true);
  });

  test("renders a labeled settings row backed by the shared pill switch", () => {
    const onCheckedChange = vi.fn();

    render(
      <MyoxusSettingsMantineProvider>
        <SettingsSwitchRow
          checked={true}
          label="Show type icon"
          onCheckedChange={onCheckedChange}
          testId="show-type-icon-switch"
        />
      </MyoxusSettingsMantineProvider>,
    );

    const row = screen
      .getByText("Show type icon")
      .closest('[data-myoxus-ui-role="settings-switch-row"]');
    const switchInput = screen.getByTestId("show-type-icon-switch");

    expect(row).not.toBeNull();
    expect(switchInput).not.toBeNull();
    expect(switchInput.dataset.myoxusUiRole).toBe("settings-switch");
    expect(
      switchInput.getAttribute("aria-label") ??
        switchInput.querySelector("input")?.getAttribute("aria-label"),
    ).toBe("Show type icon");
  });

  test("renders optional description with shared settings typography roles", () => {
    render(
      <MyoxusSettingsMantineProvider>
        <SettingsSwitchRow
          checked={false}
          label="Public"
          description="Allow public access to workspace pages"
          testId="public-switch"
        />
      </MyoxusSettingsMantineProvider>,
    );

    expect(screen.getByText("Public").dataset.myoxusUiRole).toBe(
      "settings-switch-row-label",
    );
    expect(
      screen.getByText("Allow public access to workspace pages").dataset
        .myoxusUiRole,
    ).toBe("settings-switch-row-description");
    expect(screen.getByTestId("public-switch")).not.toBeNull();
  });

  test("uses native Stack, Group and Divider structure for an optional separator", () => {
    render(
      <MyoxusSettingsMantineProvider>
        <SettingsSwitchRow
          checked={true}
          label="Require version check"
          rowTestId="version-check-row"
          separated
        />
      </MyoxusSettingsMantineProvider>,
    );

    const row = screen.getByTestId("version-check-row");
    expect(row.dataset.myoxusUiRole).toBe("settings-switch-row");
    expect(row.className).toContain("mantine-Stack-root");
    expect(
      row.querySelector('[data-myoxus-ui-role="settings-switch-row-content"]')
        ?.className,
    ).toContain("mantine-Group-root");
    expect(
      row.querySelector('[data-myoxus-ui-role="settings-switch-row-divider"]')
        ?.className,
    ).toContain("mantine-Divider-root");
  });
});
