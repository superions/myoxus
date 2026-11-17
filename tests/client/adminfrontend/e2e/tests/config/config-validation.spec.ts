// SPDX-License-Identifier: AGPL-3.0-or-later
/** Generic settings use the authoritative config write validator. Invalid input
 * must be rejected atomically, a correction must recover, and a valid value must
 * survive reload. Restore the original origin after this live-stack journey. */
import type { Page } from "@playwright/test";
import {
  ADMIN_FRONTEND_BASE,
  API_BASE,
  loginAsAdmin,
} from "../../fixtures/auth";
import { expect, test } from "../../fixtures/index";

test.describe("Config validation — form errors and validation messages", () => {
  const validUrl = "https://valid.example.com";
  const invalidUrl = "not-a-url";
  let original: string;
  test.beforeAll(async ({ adminRequest }) => {
    const response = await adminRequest.get(
      `${API_BASE}/api/admin/config/export`,
    );
    expect(response.ok()).toBe(true);
    original = (await response.json())["server.origin"];
    expect(typeof original).toBe("string");
  });
  test.afterEach(async ({ adminRequest }) => {
    if (original === undefined) return;
    const response = await adminRequest.post(
      `${API_BASE}/api/admin/config/import`,
      {
        data: { config: { "server.origin": original } },
      },
    );
    expect(response.ok()).toBe(true);
  });
  async function openField(page: Page) {
    await loginAsAdmin(page);
    await page.goto(`${ADMIN_FRONTEND_BASE}/system`);
    const input = page.getByRole("textbox", { name: "Base URL", exact: true });
    await expect(input).toBeVisible();
    return input;
  }
  const save = (page: Page) =>
    page.getByRole("button", { name: "Save", exact: true }).click();
  const error = (page: Page) =>
    page.getByRole("alert").filter({ hasText: "server.origin" }).first();
  test("invalid externalUrl shows validation error without persisting it", async ({
    page,
    adminRequest,
  }) => {
    const field = await openField(page);
    await field.fill(invalidUrl);
    await save(page);
    await expect(error(page)).toBeVisible();
    const response = await adminRequest.get(
      `${API_BASE}/api/admin/config/export`,
    );
    expect(response.ok()).toBe(true);
    expect((await response.json())["server.origin"]).toBe(original);
  });
  test("correcting URL clears validation error", async ({ page }) => {
    const field = await openField(page);
    await field.fill(invalidUrl);
    await save(page);
    await expect(error(page)).toBeVisible();
    await field.fill("https://recovered.example.com");
    await save(page);
    await page.reload();
    await expect(
      page.getByRole("textbox", { name: "Base URL", exact: true }),
    ).toHaveValue("https://recovered.example.com");
    await expect(error(page)).toHaveCount(0);
  });
  test("valid URL saves successfully", async ({ page, adminRequest }) => {
    const field = await openField(page);
    await field.fill(validUrl);
    await save(page);
    await expect
      .poll(async () => {
        const response = await adminRequest.get(
          `${API_BASE}/api/admin/config/export`,
        );
        expect(response.ok()).toBe(true);
        return (await response.json())["server.origin"];
      })
      .toBe(validUrl);
    await page.reload();
    await expect(
      page.getByRole("textbox", { name: "Base URL", exact: true }),
    ).toHaveValue(validUrl);
    await expect(error(page)).toHaveCount(0);
  });
});
