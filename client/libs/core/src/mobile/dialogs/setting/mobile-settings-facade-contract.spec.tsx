// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * @vitest-environment happy-dom
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { MyoxusUIProvider } from "@myoxus/ui-facade/provider";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";

import { SettingDropdownSelect } from "./dropdown-select";

const repoRoot = process.cwd();
const settingRoot = "client/libs/core/src/mobile/dialogs/setting";

function readRepoFile(path: string): string {
  return readFileSync(join(repoRoot, path), "utf8");
}

const deletedStyleFiles = [
  "dropdown-select.css",
  "dropdown-select.styles.ts",
  "experimental/styles.css",
  "experimental/styles.styles.ts",
  "group.css",
  "group.styles.ts",
  "others/delete-account.css",
  "others/delete-account.styles.ts",
  "others/index.css",
  "others/index.styles.ts",
  "style.css",
  "style.styles.ts",
  "swipe-dialog.css",
  "swipe-dialog.styles.ts",
  "swipe-dialog.tsx",
  "user-profile/style.css",
  "user-profile/style.styles.ts",
];

const migratedSources = [
  "index.tsx",
  "group.tsx",
  "row.layout.tsx",
  "dropdown-select.tsx",
  "experimental/index.tsx",
  "user-profile/index.tsx",
  "others/delete-account.tsx",
  "appearance/language.tsx",
];

afterEach(() => cleanup());

describe("mobile settings facade migration contract", () => {
  test("keeps mobile settings off local CSS, swipe chrome and product styling escape hatches", () => {
    for (const file of deletedStyleFiles) {
      expect(existsSync(join(repoRoot, settingRoot, file)), file).toBe(false);
    }

    const sourceByFile = new Map(
      migratedSources.map((file) => [
        file,
        readRepoFile(`${settingRoot}/${file}`),
      ]),
    );
    const combinedSource = [...sourceByFile.values()].join("\n");

    for (const required of [
      "<ConfigModal",
      "<ConfigModal.Row",
      "SurfaceListItemFrame",
      "SurfaceListText",
      "<Select",
      "SettingsField",
      "SettingsFieldGroup",
      "Avatar",
      "SurfaceListItemMain",
      "SurfaceListSelectionSlot",
    ]) {
      expect(combinedSource).toContain(required);
    }

    for (const forbidden of [
      "SwipeDialog",
      "swipe-dialog",
      "styles.",
      "styles.styles",
      "classNames",
      "contentStyle",
      "contentClassName",
      "menuOptions",
      "NativeSettingDropdownSelect",
      "MobileMenu",
      "fontSize=",
      "style={{",
      "padding:",
      "margin:",
      "useMediaQuery",
      "matchMedia",
      "window.innerWidth",
      "px",
    ]) {
      expect(combinedSource, forbidden).not.toContain(forbidden);
    }
  });

  test("renders setting dropdowns through the Mantine-backed Facade Select", () => {
    const onChange = vi.fn();
    render(
      <MyoxusUIProvider>
        <SettingDropdownSelect
          aria-label="Theme"
          options={[
            { label: "System", value: "system" },
            { label: "Dark", value: "dark" },
          ]}
          value="dark"
          onChange={onChange}
        />
      </MyoxusUIProvider>,
    );

    expect(screen.getByRole("combobox", { name: "Theme" })).toBeTruthy();
    expect(
      document.querySelector('[data-myoxus-ui-role="settings-select"]'),
    ).toBeTruthy();
    expect(
      document.querySelector('[data-myoxus-ui-role="settings-select-root"]'),
    ).toBeTruthy();
    expect(
      document.querySelector('[data-testid="dropdown-select-trigger"]'),
    ).toBeTruthy();
  });
});
