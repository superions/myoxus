// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Real desktop Auth journeys. The bootstrap test requires a separate, fresh
 * instance via E2E_SETUP_FRONTEND_BASE_URL; initialized instances fail closed.
 * Screenshots and runtime errors are attached to the Playwright result.
 */
import { writeFile } from "node:fs/promises";

import type { Page, TestInfo } from "@playwright/test";

import {
  ADMIN_EMAIL,
  ADMIN_PASSWORD,
  apiSignIn,
  createTestUser,
  deleteTestUser,
  FRONTEND_BASE,
  injectSessionCookies,
} from "../../fixtures/auth";
import { expect, test } from "../../fixtures/index";

const themes = ["light", "dark"] as const;
type Theme = (typeof themes)[number];
const evidence = new WeakMap<
  Page,
  {
    consoleErrors: string[];
    pageErrors: string[];
    workerErrors: string[];
    captures: unknown[];
  }
>();

test.use({ viewport: { width: 1440, height: 900 } });

test.beforeEach(async ({ page }) => {
  const report = {
    consoleErrors: [] as string[],
    pageErrors: [] as string[],
    workerErrors: [] as string[],
    captures: [] as unknown[],
  };
  evidence.set(page, report);
  page.on("console", (message) => {
    if (message.type() === "error") {
      (message.worker() ? report.workerErrors : report.consoleErrors).push(
        message.text(),
      );
    }
  });
  page.on("pageerror", (error) => report.pageErrors.push(error.message));
  // Exercise the product's system-theme projection, not synthetic DOM colors.
  await page.addInitScript(() =>
    localStorage.setItem("myoxus-theme", "system"),
  );
});

test.afterEach(async ({ page }, testInfo) => {
  const report = evidence.get(page)!;
  const reportPath = testInfo.outputPath("auth-evidence.json");
  await writeFile(reportPath, JSON.stringify(report, null, 2));
  await testInfo.attach("auth-evidence", {
    path: reportPath,
    contentType: "application/json",
  });
  expect(report.consoleErrors, "browser console errors").toEqual([]);
  expect(report.pageErrors, "uncaught page errors").toEqual([]);
  expect(report.workerErrors, "worker console errors").toEqual([]);
});

async function capture(
  page: Page,
  testInfo: TestInfo,
  state: string,
  theme: Theme,
) {
  await page.emulateMedia({ colorScheme: theme });
  await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
  await expect(page.locator("html")).toHaveAttribute(
    "data-mantine-color-scheme",
    theme,
  );
  const hedge = page.getByTestId("auth-background-hedge");
  await expect(hedge).toBeVisible();
  const dom = await page.evaluate(() => {
    const art = document.querySelector(
      '[data-testid="auth-background-hedge"]',
    )!;
    const bounds = art.getBoundingClientRect();
    return {
      theme: document.documentElement.dataset.theme,
      mantine: document.documentElement.dataset.mantineColorScheme,
      horizontalOverflow: document.documentElement.scrollWidth > innerWidth,
      artwork: {
        tag: art.tagName.toLowerCase(),
        paths: art.querySelectorAll("path").length,
        width: bounds.width,
        height: bounds.height,
        opacity: getComputedStyle(art).opacity,
      },
    };
  });
  expect(dom.horizontalOverflow).toBe(false);
  expect(dom.artwork.tag).toBe("svg");
  expect(dom.artwork.paths).toBeGreaterThan(0);
  expect(dom.artwork.width).toBeGreaterThan(300);
  expect(dom.artwork.height).toBeGreaterThan(300);
  expect(Number(dom.artwork.opacity)).toBeGreaterThan(0);
  const screenshot = testInfo.outputPath(`${state}-${theme}.png`);
  await page.screenshot({ path: screenshot, fullPage: true });
  evidence.get(page)!.captures.push({
    state,
    theme,
    viewport: "desktop",
    finalUrl: page.url(),
    screenshot,
    dom,
  });
  await testInfo.attach(`${state}-${theme}`, {
    path: screenshot,
    contentType: "image/png",
  });
}

async function captureThemes(page: Page, testInfo: TestInfo, state: string) {
  for (const theme of themes) await capture(page, testInfo, state, theme);
}

async function signIn(page: Page, email: string, password: string) {
  await page.locator('input[type="email"]').fill(email);
  await page.locator('input[type="email"]').press("Enter");
  await page.locator('input[type="password"]').fill(password);
  await page.locator('input[type="password"]').press("Enter");
}

for (const theme of themes) {
  test.describe(`Auth desktop ${theme}`, () => {
    test.use({ colorScheme: theme });

    test("shared sign-in preserves Admin intent and local redirect", async ({
      page,
    }, testInfo) => {
      const target = "/adminfrontend/security?tab=oauth#providers";
      await page.goto(
        `${FRONTEND_BASE}/sign-in?${new URLSearchParams({ auth_context: "admin", redirect_uri: target })}`,
      );
      await expect(page.getByTestId("auth-context-notice")).toBeVisible();
      const email = page.locator('input[type="email"]');
      await expect(email).toBeFocused();
      await capture(page, testInfo, "sign-in", theme);
      await email.fill(ADMIN_EMAIL);
      await email.press("Enter");
      await expect(page.locator('input[type="password"]')).toBeFocused();
      await capture(page, testInfo, "sign-in-password", theme);
      await page.locator('input[type="password"]').fill(ADMIN_PASSWORD);
      await page.locator('input[type="password"]').press("Enter");
      await expect(page).toHaveURL(`${FRONTEND_BASE}${target}`);
      await expect(
        page.getByRole("heading", { name: "Security", exact: true }),
      ).toBeVisible();
    });

    if (theme === "light") {
      test("non-admin denial has native heading focus and preserves sign-out return", async ({
        page,
        request,
        adminRequest,
      }, testInfo) => {
        const user = await createTestUser(adminRequest);
        const target = "/adminfrontend/security?tab=oauth#providers";
        try {
          const cookies = await apiSignIn(request, user.email, user.password);
          await injectSessionCookies(page.context(), cookies);
          await page.goto(`${FRONTEND_BASE}${target}`);
          const heading = page.getByRole("heading", {
            name: "Admin access required",
            level: 1,
          });
          await expect(heading).toBeFocused();
          await expect(page.getByRole("main")).toHaveCount(1);
          await expect(page).toHaveURL(`${FRONTEND_BASE}${target}`);
          await heading.press("Tab");
          await expect(
            page.getByRole("button", { name: "Open Myoxus", exact: true }),
          ).toBeFocused();
          await capture(page, testInfo, "no-admin-access", theme);
          await page.getByRole("button", { name: /sign out/i }).click();
          await expect(page).toHaveURL(
            (url) =>
              url.pathname === "/sign-in" &&
              url.searchParams.get("auth_context") === "admin" &&
              url.searchParams.get("redirect_uri") === target,
          );
          await expect(page.getByTestId("auth-context-notice")).toBeVisible();
        } finally {
          await deleteTestUser(adminRequest, user.id);
        }
      });
    }
  });
}

test("fresh bootstrap and persisted wizard completion are mandatory", async ({
  page,
}, testInfo) => {
  test.setTimeout(120_000);
  const fresh = process.env.E2E_SETUP_FRONTEND_BASE_URL;
  expect(fresh, "provide an isolated fresh setup frontend").toBeTruthy();
  expect(new URL(fresh!).origin).not.toBe(new URL(FRONTEND_BASE).origin);
  await page.goto(`${fresh}/adminfrontend/setup`);
  await expect(
    page.getByRole("heading", { name: "Welcome to Myoxus", exact: true }),
  ).toBeVisible();
  await expect(page).toHaveURL(`${fresh}/adminfrontend/setup`);
  await captureThemes(page, testInfo, "setup-welcome");
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await page.getByLabel(/^Name/).fill("Admin");
  await page.getByLabel(/^Email/).fill(ADMIN_EMAIL);
  const password = page.getByLabel(/^Password/);
  await password.fill("short");
  await password.press("Enter");
  await expect(password).toHaveAttribute("aria-invalid", "true");
  await expect(password).toHaveAttribute("aria-describedby", /error/);
  await captureThemes(page, testInfo, "setup-validation");
  await password.fill(ADMIN_PASSWORD);
  await expect(password).not.toHaveAttribute("aria-invalid", "true");
  await captureThemes(page, testInfo, "setup-credentials");
  await password.press("Enter");
  await expect(page).toHaveURL(/\/sign-in\?/);
  await signIn(page, ADMIN_EMAIL, ADMIN_PASSWORD);
  await expect(page).toHaveURL(`${fresh}/adminfrontend/config-wizard`);
  await expect(
    page.getByRole("heading", { name: "Public server URL", exact: true }),
  ).toBeVisible();
  await captureThemes(page, testInfo, "wizard-initial");
  await page
    .getByRole("textbox", { name: "External URL", exact: true })
    .fill("invalid-url");
  await expect(
    page.getByRole("button", { name: "Continue", exact: true }),
  ).toBeDisabled();
  await expect(page.getByText(/must start with http/i)).toBeVisible();
  await captureThemes(page, testInfo, "wizard-validation");
  await page
    .getByRole("textbox", { name: "External URL", exact: true })
    .fill(fresh!);
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Encryption key", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Back", exact: true }).click();
  await expect(
    page.getByRole("textbox", { name: "External URL", exact: true }),
  ).toHaveValue(fresh!);
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Encryption key", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Email delivery", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Skip for now", exact: true }).click();
  const email = page.getByRole("radio", { name: /Email magic link/ });
  await expect(email).toBeChecked();
  await email.focus();
  await email.press("ArrowRight");
  await expect(page.getByRole("radio", { name: /Google/ })).toBeChecked();
  await page.getByRole("radio", { name: /Google/ }).press("ArrowLeft");
  await expect(email).toBeChecked();
  await captureThemes(page, testInfo, "wizard-auth-method");
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Setup complete", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Back", exact: true }),
  ).toBeDisabled();
  await captureThemes(page, testInfo, "wizard-completed");
  await page
    .getByRole("button", { name: "Go to dashboard", exact: true })
    .click();
  await expect(page).toHaveURL(`${fresh}/adminfrontend/dashboard`);
  await page.goto(`${fresh}/adminfrontend/config-wizard`);
  await expect(page).toHaveURL(`${fresh}/adminfrontend/dashboard`);
});
