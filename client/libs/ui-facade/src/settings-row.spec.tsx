// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * @vitest-environment happy-dom
 */

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";

import { SettingsRow, Slider } from "./index";
import { MyoxusSettingsMantineProvider } from "./provider";

describe("SettingsRow", () => {
  afterEach(() => cleanup());

  test("keeps the label/control layout and implicit control name in native Mantine roles", () => {
    render(
      <MyoxusSettingsMantineProvider>
        <SettingsRow
          name="Base font size"
          desc="Choose a comfortable default reading size."
          testId="font-size-row"
        >
          <Slider min={12} max={24} value={16} />
        </SettingsRow>
      </MyoxusSettingsMantineProvider>,
    );

    const row = screen.getByTestId("font-size-row");
    const copy = row.querySelector('[data-myoxus-ui-role="settings-row-copy"]');
    const control = row.querySelector(
      '[data-myoxus-ui-role="settings-row-control"]',
    );

    expect(row.className).toContain("mantine-Group-root");
    expect(copy?.className).toContain("mantine-Stack-root");
    expect(control?.className).toContain("mantine-Group-root");
    expect(
      screen.getByText("Choose a comfortable default reading size.").dataset
        .myoxusUiRole,
    ).toBe("settings-row-description");
    expect(
      screen.getByRole("slider", { name: "Base font size" }),
    ).not.toBeNull();
  });

  test("uses a native button for rows with one row-level action", () => {
    const onClick = vi.fn();

    render(
      <MyoxusSettingsMantineProvider>
        <SettingsRow
          name="Release notes"
          desc="Read what changed in the most recent update."
          onClick={onClick}
          testId="release-notes-row"
        >
          →
        </SettingsRow>
      </MyoxusSettingsMantineProvider>,
    );

    const row = screen.getByRole("button", { name: /release notes/i });
    fireEvent.click(row);

    expect(row.tagName).toBe("BUTTON");
    expect(row.className).toContain("mantine-UnstyledButton-root");
    expect(row.dataset.myoxusUiRole).toBe("settings-row");
    expect(onClick).toHaveBeenCalledTimes(1);
  });
});
