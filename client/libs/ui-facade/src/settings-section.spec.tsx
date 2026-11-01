// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * @vitest-environment happy-dom
 */

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test } from "vitest";

import {
  SettingsPanelTitle,
  SettingsSection,
  SettingsSidebarTitle,
} from "./index";
import { MyoxusSettingsMantineProvider } from "./provider";

describe("SettingsSection", () => {
  afterEach(() => cleanup());

  test("uses the shared native Card and Stack hierarchy for a titled section", () => {
    render(
      <MyoxusSettingsMantineProvider>
        <SettingsSection
          title="Sharing defaults"
          description="Control how this workspace is shared."
          actions={<button type="button">Save changes</button>}
          testId="sharing-section"
        >
          Settings content
        </SettingsSection>
      </MyoxusSettingsMantineProvider>,
    );

    const section = screen.getByTestId("sharing-section");
    const heading = section.querySelector(
      '[data-myoxus-ui-role="settings-section-heading"]',
    );

    expect(section.className).toContain("mantine-Card-root");
    expect(section.dataset.myoxusUiRole).toBe("settings-panel");
    expect(heading?.className).toContain("mantine-Stack-root");
    const title = screen.getByRole("heading", { name: "Sharing defaults" });
    expect(title.tagName).toBe("H3");
    expect(title.className).toContain("mantine-Title-root");
    expect(title.style.getPropertyValue("--title-fz")).toContain(
      "--mantine-font-size-card-title",
    );
    expect(title.style.fontSize).toBe("");
    expect(screen.getByRole("button", { name: "Save changes" })).not.toBeNull();
  });

  test("keeps danger border semantics and makes disabled sections inert", () => {
    render(
      <MyoxusSettingsMantineProvider>
        <SettingsSection
          danger
          testId="danger-section"
          title="Delete workspace"
        >
          Danger content
        </SettingsSection>
        <SettingsSidebarTitle>Workspace settings</SettingsSidebarTitle>
        <SettingsPanelTitle danger>Destructive actions</SettingsPanelTitle>
        <SettingsSection
          disabled
          testId="disabled-section"
          title="Compliance lock"
        >
          Disabled content
        </SettingsSection>
      </MyoxusSettingsMantineProvider>,
    );

    const danger = screen.getByTestId("danger-section");
    const disabled = screen.getByTestId("disabled-section");

    expect(danger.dataset.myoxusUiRole).toBe("settings-danger-zone");
    expect(danger.getAttribute("style")).toContain("border-color");
    expect(disabled.getAttribute("aria-disabled")).toBe("true");
    expect(disabled.hasAttribute("inert")).toBe(true);
    const sidebarTitle = screen.getByRole("heading", {
      name: "Workspace settings",
      level: 2,
    });
    expect(sidebarTitle.style.getPropertyValue("--title-fz")).toContain(
      "--mantine-font-size-heading-small",
    );
    expect(sidebarTitle.style.fontSize).toBe("");
    expect(screen.getByText("Destructive actions").style.color).toContain(
      "--mantine-color-myoxus-text-danger-text",
    );
  });
});
