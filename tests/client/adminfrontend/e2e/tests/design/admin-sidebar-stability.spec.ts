// SPDX-License-Identifier: AGPL-3.0-or-later

import { mkdirSync } from "node:fs";
import path from "node:path";

import type { APIRequestContext, BrowserContext, Page } from "@playwright/test";

import {
  ADMIN_FRONTEND_BASE,
  API_BASE,
  injectRequestSessionCookies,
} from "../../fixtures/auth";
import { expect, test } from "../../fixtures/index";

type ThemeMode = "light" | "dark" | "system";
type EffectiveThemeProfile = {
  themeMode: ThemeMode;
  theme: { slug: string };
};
type Rect = { x: number; y: number; width: number; height: number };

const QA_DIR = path.resolve(
  process.cwd(),
  "playwright/.qa/admin-sidebar-stability-20260523",
);
const EVIDENCE_PHASE =
  process.env.MYOXUS_UI_EVIDENCE_PHASE === "before" ? "before" : "after";
const GEOMETRY_TOLERANCE_PX = 0.5;
const MIN_TEXT_CONTRAST = 4.5;

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
    `query AdminSidebarStabilityEffectiveThemeProfile {
      admin {
        effectiveThemeProfile {
          themeMode
          theme { slug }
        }
      }
    }`,
  );
  return data.admin.effectiveThemeProfile;
}

async function setThemeProfile(
  request: APIRequestContext,
  input: { themeSlug: string; themeMode: ThemeMode },
): Promise<void> {
  const data = await gql<{ admin: { setThemeProfile: EffectiveThemeProfile } }>(
    request,
    `mutation AdminSidebarStabilitySetThemeProfile($input: SetThemeProfileInput!) {
      admin {
        setThemeProfile(input: $input) {
          themeMode
          theme { slug }
        }
      }
    }`,
    { input },
  );
  expect(data.admin.setThemeProfile.theme.slug).toBe(input.themeSlug);
  expect(data.admin.setThemeProfile.themeMode).toBe(input.themeMode);
}

async function signInAsAdmin(
  context: BrowserContext,
  request: APIRequestContext,
) {
  await injectRequestSessionCookies(context, request);
}

async function openDashboard(page: Page) {
  await page.goto(`${ADMIN_FRONTEND_BASE}/dashboard`, {
    waitUntil: "load",
  });
  await expect(page.locator(".admin-sidebar--expanded")).toBeVisible({
    timeout: 15_000,
  });
  await expect(page.locator(".admin-nav-item--expanded").first()).toBeVisible({
    timeout: 15_000,
  });
}

function diffRect(before: Rect, after: Rect): Rect {
  return {
    x: Math.abs(before.x - after.x),
    y: Math.abs(before.y - after.y),
    width: Math.abs(before.width - after.width),
    height: Math.abs(before.height - after.height),
  };
}

function assertStableRect(before: Rect, after: Rect) {
  const diff = diffRect(before, after);
  expect(
    diff.x,
    `sidebar hover must not move horizontally by ${diff.x}px`,
  ).toBeLessThanOrEqual(GEOMETRY_TOLERANCE_PX);
  expect(
    diff.y,
    `sidebar hover must not move vertically by ${diff.y}px`,
  ).toBeLessThanOrEqual(GEOMETRY_TOLERANCE_PX);
  expect(
    diff.width,
    `sidebar hover must not resize width by ${diff.width}px`,
  ).toBeLessThanOrEqual(GEOMETRY_TOLERANCE_PX);
  expect(
    diff.height,
    `sidebar hover must not resize height by ${diff.height}px`,
  ).toBeLessThanOrEqual(GEOMETRY_TOLERANCE_PX);
}

function parseRgb(value: string): [number, number, number] {
  const match = value.match(/rgba?\(([^)]+)\)/);
  if (!match) {
    throw new Error(`Unsupported color value: ${value}`);
  }
  const [r, g, b] = match[1]
    .split(",")
    .slice(0, 3)
    .map((part) => Number.parseFloat(part.trim()));
  return [r, g, b];
}

function relativeLuminance([r, g, b]: [number, number, number]): number {
  const channel = (value: number) => {
    const normalized = value / 255;
    return normalized <= 0.03928
      ? normalized / 12.92
      : Math.pow((normalized + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

function contrastRatio(foreground: string, background: string): number {
  const l1 = relativeLuminance(parseRgb(foreground));
  const l2 = relativeLuminance(parseRgb(background));
  const lighter = Math.max(l1, l2);
  const darker = Math.min(l1, l2);
  return (lighter + 0.05) / (darker + 0.05);
}

test.describe("Admin sidebar stability", () => {
  test.beforeEach(async ({ context, adminRequest }) => {
    await context.addInitScript(() => {
      Object.defineProperty(navigator, "language", {
        configurable: true,
        get: () => "de",
      });
      Object.defineProperty(navigator, "languages", {
        configurable: true,
        get: () => ["de"],
      });
    });
    await signInAsAdmin(context, adminRequest);
    mkdirSync(QA_DIR, { recursive: true });
  });

  for (const themeMode of ["light", "dark"] as const) {
    test(`sidebar hover stays stable and readable in ${themeMode} mode`, async ({
      page,
      adminRequest,
    }) => {
      const original = await readEffectiveThemeProfile(adminRequest);

      try {
        await setThemeProfile(adminRequest, {
          themeSlug: original.theme.slug,
          themeMode,
        });
        await openDashboard(page);

        const hoverTarget = page
          .locator(
            ".admin-sidebar--expanded .admin-nav-item--expanded:not([data-active])",
          )
          .first();
        await expect(hoverTarget).toBeVisible({ timeout: 10_000 });

        await page.locator(".admin-sidebar").screenshot({
          path: path.join(QA_DIR, `${EVIDENCE_PHASE}-${themeMode}-normal.png`),
        });

        const before = (await hoverTarget.boundingBox()) as Rect | null;
        expect(before).not.toBeNull();
        await hoverTarget.hover();
        await expect(hoverTarget).toBeVisible();
        await page.locator(".admin-sidebar").screenshot({
          path: path.join(QA_DIR, `${EVIDENCE_PHASE}-${themeMode}-hover.png`),
        });

        const after = (await hoverTarget.boundingBox()) as Rect | null;
        expect(after).not.toBeNull();
        assertStableRect(before!, after!);

        const colors = await hoverTarget.evaluate((element) => {
          const style = window.getComputedStyle(element);
          return {
            color: style.color,
            backgroundColor: style.backgroundColor,
          };
        });
        const contrast = contrastRatio(colors.color, colors.backgroundColor);
        expect(
          contrast,
          `sidebar hover text/background contrast in ${themeMode} mode`,
        ).toBeGreaterThanOrEqual(MIN_TEXT_CONTRAST);
      } finally {
        await setThemeProfile(adminRequest, {
          themeSlug: original.theme.slug,
          themeMode: original.themeMode,
        });
      }
    });
  }
});
