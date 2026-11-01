// SPDX-License-Identifier: AGPL-3.0-or-later

import { copyFile, mkdir } from "node:fs/promises";
import path from "node:path";

import { type BrowserContext, expect, type Page, test } from "@playwright/test";

import {
  DEFAULT_SMOKE_USER_EMAIL,
  DEFAULT_SMOKE_USER_PASSWORD,
  signInViaApi,
  signOutViaApi,
} from "../../shared/auth-helper";
import {
  type AuthenticatedPreferenceTarget,
  getAccountColorMode,
  setAccountColorMode,
} from "../../shared/user-preferences-helper";
import { getSmokeWorkspaceId } from "../../shared/workspace-helper";

const FRONTEND = process.env.E2E_BASE_URL ?? "http://localhost:3010";
const API = process.env.E2E_API_BASE_URL ?? "http://localhost:3001";
const GQL = `${API}/graphql`;
const QA_DIR = path.join(
  process.cwd(),
  "playwright",
  ".qa",
  `web-settings-theme-toggle-${process.env.MYOXUS_VISUAL_QA_RUN_ID ?? process.pid}`,
);

let apiSessionCookies: string[] | undefined;
let originalColorMode: "dark" | "light" | "system" | null | undefined;

async function injectCookies(
  context: BrowserContext,
  rawCookies: string[],
): Promise<void> {
  for (const raw of rawCookies) {
    const [nameVal] = raw.split(";");
    const [name, ...rest] = nameVal.split("=");
    await context.addCookies([
      {
        name: name.trim(),
        value: rest.join("=").trim(),
        url: FRONTEND,
        httpOnly: false,
        secure: false,
        sameSite: "Lax",
      },
    ]);
  }
}

async function openAllDocs(page: Page, workspaceId: string): Promise<void> {
  await page.addInitScript((id) => {
    localStorage.setItem("last_workspace_id", id);
  }, workspaceId);
  await page
    .evaluate((id) => {
      localStorage.setItem("last_workspace_id", id);
    }, workspaceId)
    .catch(() => undefined);

  await page.goto(`${FRONTEND}/workspace/${workspaceId}/all`, {
    waitUntil: "load",
    timeout: 20_000,
  });
  await expect(page.getByTestId("main-container")).toBeVisible({
    timeout: 20_000,
  });
  await expect(page.getByTestId("sidebar-new-page-button")).toBeVisible({
    timeout: 20_000,
  });
}

async function captureSettings(
  page: Page,
  testInfoPath: string,
): Promise<void> {
  const modal = page.getByTestId("setting-modal");
  await expect(modal).toBeVisible({ timeout: 10_000 });
  await modal.screenshot({ path: testInfoPath });
  await copyFile(testInfoPath, path.join(QA_DIR, path.basename(testInfoPath)));
}

async function expectThemeState(
  page: Page,
  target: AuthenticatedPreferenceTarget,
  accountColorMode: "dark" | "light" | "system",
  resolvedTheme: "dark" | "light",
): Promise<void> {
  await expect
    .poll(() => getAccountColorMode(target), { timeout: 5_000 })
    .toBe(accountColorMode);
  await expect
    .poll(
      async () =>
        page.evaluate(() => ({
          resolved: document.documentElement.dataset.theme,
          colorScheme: document.documentElement.style.colorScheme,
        })),
      { timeout: 5_000 },
    )
    .toEqual({
      resolved: resolvedTheme,
      colorScheme: resolvedTheme,
    });
}

async function expectVisibleTheme(
  page: Page,
  resolvedTheme: "dark" | "light",
): Promise<void> {
  const visualState = await page.evaluate(() => {
    const parseRgb = (value: string) => {
      const match = value.match(/rgba?\(([^)]+)\)/);
      if (!match) throw new Error(`Unsupported color value: ${value}`);
      return match[1]
        .split(",")
        .slice(0, 3)
        .map((part) => Number.parseFloat(part.trim()));
    };
    const luminance = (value: string) => {
      const [r, g, b] = parseRgb(value);
      const channel = (component: number) => {
        const normalized = component / 255;
        return normalized <= 0.03928
          ? normalized / 12.92
          : Math.pow((normalized + 0.055) / 1.055, 2.4);
      };
      return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
    };

    const modal = document.querySelector('[data-testid="setting-modal"]');
    const modalStyle = modal ? getComputedStyle(modal) : null;
    const bodyStyle = getComputedStyle(document.body);
    const rootStyle = getComputedStyle(document.documentElement);
    const background = modalStyle?.backgroundColor ?? bodyStyle.backgroundColor;
    return {
      background,
      backgroundLuminance: luminance(background),
      bodyBackground: bodyStyle.backgroundColor,
      rootTheme: document.documentElement.dataset.theme ?? "",
      rootColorScheme: document.documentElement.style.colorScheme,
      settingsSurface: rootStyle
        .getPropertyValue("--myoxus-background-primary-color")
        .trim(),
    };
  });

  if (resolvedTheme === "dark") {
    expect(
      visualState.backgroundLuminance,
      `dark mode must visibly render a dark settings surface: ${JSON.stringify(
        visualState,
      )}`,
    ).toBeLessThan(0.2);
  } else {
    expect(
      visualState.backgroundLuminance,
      `light mode must visibly render a light settings surface: ${JSON.stringify(
        visualState,
      )}`,
    ).toBeGreaterThan(0.8);
  }
}

test.describe("Web settings theme switch", () => {
  test.afterAll(async ({ request }) => {
    if (apiSessionCookies && originalColorMode !== undefined) {
      await setAccountColorMode(
        { request, gqlEndpoint: GQL, cookies: apiSessionCookies },
        originalColorMode,
      );
    }
    await signOutViaApi(request, API, apiSessionCookies);
  });

  test("clicking Light/Dark/System applies the runtime theme and is screenshot-evidenced", async ({
    context,
    page,
    request,
  }, testInfo) => {
    await mkdir(QA_DIR, { recursive: true });
    await page.emulateMedia({ colorScheme: "dark" });

    apiSessionCookies = await signInViaApi(
      request,
      API,
      DEFAULT_SMOKE_USER_EMAIL,
      DEFAULT_SMOKE_USER_PASSWORD,
    );
    const preferenceTarget = {
      request,
      gqlEndpoint: GQL,
      cookies: apiSessionCookies,
    };
    originalColorMode = await getAccountColorMode(preferenceTarget);
    await injectCookies(context, apiSessionCookies);
    const workspaceId = await getSmokeWorkspaceId(
      request,
      GQL,
      apiSessionCookies,
    );

    await openAllDocs(page, workspaceId);
    await page.getByTestId("sidebar-user-avatar").click();
    await page.getByTestId("workspace-modal-account-settings-option").click();
    await expect(page.getByTestId("setting-modal")).toBeVisible({
      timeout: 15_000,
    });
    await page.getByTestId("appearance-panel-trigger").click();
    await expect(
      page.getByTestId("appearance-theme-segmented-control"),
    ).toBeVisible();

    await captureSettings(
      page,
      testInfo.outputPath("before-appearance-theme-control.png"),
    );

    await page.getByTestId("dark-theme-trigger").click();
    await expectThemeState(page, preferenceTarget, "dark", "dark");
    await expectVisibleTheme(page, "dark");
    await captureSettings(
      page,
      testInfo.outputPath("after-dark-theme-click.png"),
    );

    await page.getByTestId("light-theme-trigger").click();
    await expectThemeState(page, preferenceTarget, "light", "light");
    await expectVisibleTheme(page, "light");
    await captureSettings(
      page,
      testInfo.outputPath("after-light-theme-click.png"),
    );

    await page.getByTestId("system-theme-trigger").click();
    await expectThemeState(page, preferenceTarget, "system", "dark");
    await expectVisibleTheme(page, "dark");
    await captureSettings(
      page,
      testInfo.outputPath("after-system-theme-click.png"),
    );
  });
});
