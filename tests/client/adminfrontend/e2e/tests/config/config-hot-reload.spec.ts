// SPDX-License-Identifier: AGPL-3.0-or-later
/** Runtime language changes must reach the served Admin without an API restart.
 * server.name is restart-required; its persistence belongs to config-roundtrip.
 */
import {
  ADMIN_FRONTEND_BASE,
  API_BASE,
  loginAsAdmin,
} from "../../fixtures/auth";
import { expect, test } from "../../fixtures/index";

test("config hot-reload persists and projects the Admin language without restart", async ({
  page,
  adminRequest,
}) => {
  const exported = await adminRequest.get(
    `${API_BASE}/api/admin/config/export`,
  );
  expect(exported.ok()).toBe(true);
  const original = (await exported.json())["admin_i18n.default_locale"];
  expect(typeof original).toBe("string");
  const language = original === "de" ? "en" : "de";
  try {
    await loginAsAdmin(page);
    await page.goto(`${ADMIN_FRONTEND_BASE}/system?tab=localization`);
    const control = page.getByRole("combobox", {
      name: /Admin.*(?:language|Sprache)|Sprache.*Admin/i,
    });
    await control.click();
    await page
      .getByRole("option", {
        name: language === "de" ? /^(German|Deutsch)$/ : /^(English|Englisch)$/,
      })
      .click();
    await page.getByRole("button", { name: /^(Save|Speichern)$/ }).click();
    await expect
      .poll(async () => {
        const response = await adminRequest.get(
          `${API_BASE}/api/admin/config/export`,
        );
        expect(response.ok()).toBe(true);
        return (await response.json())["admin_i18n.default_locale"];
      })
      .toBe(language);
    await page.reload({ waitUntil: "networkidle" });
    await expect(
      page.getByRole("tab", {
        name: language === "de" ? "Lokalisierung" : "Localization",
        exact: true,
      }),
    ).toBeVisible();
  } finally {
    const restored = await adminRequest.post(
      `${API_BASE}/api/admin/config/import`,
      { data: { config: { "admin_i18n.default_locale": original } } },
    );
    expect(restored.ok()).toBe(true);
  }
});
