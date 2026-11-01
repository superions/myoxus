// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * E2E: Theme runtime closeout gate.
 *
 * Covers the live Admin/Web boundary for the server-owned Theme DB model:
 *   - all 16 server catalog themes render as browser-visible cards,
 *   - theme selection persists via AdminRoot, not AppConfig branding keys,
 *   - Web runtime CSS projects the selected server catalog colors and typography.
 *
 * The test restores the previous effective theme/mode in a finally block and
 * intentionally avoids color/typography edits because global clone-on-write
 * writes would leave persistent custom rows in the development database.
 */
import type { APIRequestContext, BrowserContext, Page } from "@playwright/test";

import { waitForAdminRuntimeReady } from "../../fixtures/admin-ui-runtime-errors";
import {
  ADMIN_FRONTEND_BASE,
  API_BASE,
  FRONTEND_BASE,
  injectRequestSessionCookies,
} from "../../fixtures/auth";
import { expect, test } from "../../fixtures/index";
import {
  createTemporaryWorkspace,
  deleteWorkspace,
} from "../../fixtures/workspaces";

const CITY_THEMES = [
  "stuttgart",
  "hamburg",
  "hannover",
  "bremen",
  "reykjavik",
  "zuerich",
  "lisboa",
  "berlin",
  "helsinki",
  "bordeaux",
  "habana",
  "milano",
  "wien",
  "porto",
  "lyon",
  "sevilla",
] as const;

type ThemeMode = "light" | "dark" | "system";
type EffectiveThemeProfile = {
  themeMode: ThemeMode;
  theme: {
    slug: string;
    colors: Record<"light" | "dark", Record<string, string>>;
    typographyStyles: Array<{
      styleKey: string;
      fontFamily: string;
      fontWeight: number;
      sizePx: number | null;
      lineHeight: number | null;
      letterSpacingEm: number | null;
    }>;
  };
};

async function signInBrowser(
  context: BrowserContext,
  request: APIRequestContext,
): Promise<void> {
  await injectRequestSessionCookies(context, request);
}

async function openAdminSurface(page: Page, path: "design" | "typography") {
  await page.goto(`${ADMIN_FRONTEND_BASE}/${path}`, { waitUntil: "load" });
  await waitForAdminRuntimeReady(
    page,
    `[data-admin-route-anchor="admin-route-${path}"]`,
  );
}

async function gql<T>(
  request: APIRequestContext,
  query: string,
  variables?: Record<string, unknown>,
): Promise<T> {
  const response = await request.post(`${API_BASE}/graphql`, {
    data: { query, variables },
    headers: { "Content-Type": "application/json" },
  });
  expect(response.ok(), await response.text()).toBe(true);
  const body = await response.json();
  expect(body.errors ?? []).toEqual([]);
  return body.data as T;
}

async function readEffectiveThemeProfile(
  request: APIRequestContext,
): Promise<EffectiveThemeProfile> {
  const data = await gql<{
    admin: { effectiveThemeProfile: EffectiveThemeProfile };
  }>(
    request,
    `query ThemeGateEffectiveThemeProfile {
      admin {
        effectiveThemeProfile {
          themeMode
          theme {
            slug
            colors
            typographyStyles {
              styleKey
              fontFamily
              fontWeight
              sizePx
              lineHeight
              letterSpacingEm
            }
          }
        }
      }
    }`,
  );
  return data.admin.effectiveThemeProfile;
}

async function setThemeProfile(
  request: APIRequestContext,
  input: { themeSlug: string; themeMode: ThemeMode },
): Promise<EffectiveThemeProfile> {
  const data = await gql<{
    admin: { setThemeProfile: EffectiveThemeProfile };
  }>(
    request,
    `mutation ThemeGateSetThemeProfile($input: SetThemeProfileInput!) {
      admin {
        setThemeProfile(input: $input) {
          themeMode
          theme {
            slug
            colors
            typographyStyles {
              styleKey
              fontFamily
              fontWeight
              sizePx
              lineHeight
              letterSpacingEm
            }
          }
        }
      }
    }`,
    { input },
  );
  return data.admin.setThemeProfile;
}

function expectedH1Size(profile: EffectiveThemeProfile) {
  const style = profile.theme.typographyStyles.find(
    (item) => item.styleKey === "heading.h1",
  );
  expect(style?.sizePx, "selected theme must expose heading.h1 size").toEqual(
    expect.any(Number),
  );
  return `${style!.sizePx}px`;
}

function expectedH1Style(profile: EffectiveThemeProfile) {
  const style = profile.theme.typographyStyles.find(
    (item) => item.styleKey === "heading.h1",
  );
  expect(style, "selected theme must expose heading.h1 style").toBeTruthy();
  expect(style?.sizePx, "selected theme must expose heading.h1 size").toEqual(
    expect.any(Number),
  );
  return style!;
}

test.describe("Theme DB runtime live gate", () => {
  test.beforeEach(async ({ context, adminRequest }) => {
    await signInBrowser(context, adminRequest);
  });

  test("renders all server catalog themes as browser-visible cards", async ({
    page,
  }, testInfo) => {
    await openAdminSurface(page, "design");
    await expect(page.getByTestId("theme-gallery")).toBeVisible();

    for (const city of CITY_THEMES) {
      const card = page.getByTestId(`theme-gallery-card-${city}`);
      await expect(card, `${city} theme card must be visible`).toBeVisible();
    }

    await page.screenshot({
      path: testInfo.outputPath("theme-db-gallery.png"),
      fullPage: true,
    });
  });

  test("persists theme selection and projects catalog CSS into Web runtime", async ({
    page,
    adminRequest,
  }) => {
    const original = await readEffectiveThemeProfile(adminRequest);
    let workspaceId: string | null = null;
    try {
      workspaceId = await createTemporaryWorkspace(
        adminRequest,
        `Theme runtime gate ${Date.now()}`,
      );
      await setThemeProfile(adminRequest, {
        themeSlug: "stuttgart",
        themeMode: "light",
      });

      await openAdminSurface(page, "design");
      await page.getByTestId("theme-gallery-card-hamburg").click();
      await expect
        .poll(
          async () =>
            (await readEffectiveThemeProfile(adminRequest)).theme.slug,
          { timeout: 10_000 },
        )
        .toBe("hamburg");
      await page.reload({ waitUntil: "load" });
      await waitForAdminRuntimeReady(
        page,
        '[data-admin-route-anchor="admin-route-design"]',
      );
      await expect(
        page.getByTestId("theme-gallery-card-hamburg"),
      ).toHaveAttribute("data-active", "true");

      const selected = await readEffectiveThemeProfile(adminRequest);
      expect(selected.theme.slug).toBe("hamburg");

      // The Web app loads runtime CSS for the active workspace. A temporary
      // workspace keeps this gate isolated from existing local workspace
      // overrides while still exercising the scoped server CSS endpoint.
      await page.goto(`${FRONTEND_BASE}/workspace/${workspaceId}/all`, {
        // The workspace shell intentionally keeps workers, sync and GraphQL
        // polling alive. The gate waits for the concrete theme projection,
        // not for transport quiescence.
        waitUntil: "domcontentloaded",
      });
      await page.waitForFunction(
        ({ accent, h1Size }) => {
          const root = getComputedStyle(document.documentElement);
          return (
            root
              .getPropertyValue("--myoxus-accent-primary")
              .trim()
              .toLowerCase() === accent.toLowerCase() &&
            root
              .getPropertyValue("--myoxus-typography-h1-size")
              .trim()
              .toLowerCase() === h1Size.toLowerCase()
          );
        },
        {
          accent: selected.theme.colors.light["accent-primary"],
          h1Size: expectedH1Size(selected),
        },
        { timeout: 15_000 },
      );
    } finally {
      if (workspaceId) {
        await deleteWorkspace(adminRequest, workspaceId);
      }
      await setThemeProfile(adminRequest, {
        themeSlug: original.theme.slug,
        themeMode: original.themeMode,
      });
    }
  });

  test("projects selected catalog typography into Admin preview controls", async ({
    page,
    adminRequest,
  }, testInfo) => {
    const original = await readEffectiveThemeProfile(adminRequest);
    try {
      const selected = await setThemeProfile(adminRequest, {
        themeSlug: "hamburg",
        themeMode: "light",
      });
      const expected = expectedH1Style(selected);

      await openAdminSurface(page, "typography");
      const preview = page.getByTestId("hierarchy-h1-preview");
      await expect(preview).toBeVisible({ timeout: 15_000 });

      const rendered = await preview.evaluate((node) => {
        const style = getComputedStyle(node);
        return {
          fontFamily: style.fontFamily,
          fontSize: style.fontSize,
          fontWeight: style.fontWeight,
        };
      });

      expect(rendered.fontFamily.toLowerCase()).toContain(
        expected.fontFamily.toLowerCase(),
      );
      expect(rendered.fontSize).toBe(`${expected.sizePx}px`);
      expect(rendered.fontWeight).toBe(String(expected.fontWeight));

      for (const tab of ["body", "inline", "styles"] as const) {
        await page.getByTestId(`typography-tab-${tab}`).click();
        await page.screenshot({
          fullPage: true,
          path: testInfo.outputPath(`typography-${tab}.png`),
        });
      }
    } finally {
      await setThemeProfile(adminRequest, {
        themeSlug: original.theme.slug,
        themeMode: original.themeMode,
      });
    }
  });
});
