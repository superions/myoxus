// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Visual-regression invariants for the Admin role shell.
 *
 * These checks intentionally avoid brittle pixel snapshots. They assert the
 * runtime properties that broke in the live review: force-mounted tabs must not
 * stack, page headings must consume the Admin display/font tokens, dark-mode
 * surfaces must stay readable, and seeded OU type packages must be grouped by
 * the server's real preset keys.
 */
import type { APIRequestContext, BrowserContext, Page } from "@playwright/test";

import {
  ADMIN_FRONTEND_BASE,
  API_BASE,
  injectRequestSessionCookies,
} from "../../fixtures/auth";
import { expect, test } from "../../fixtures/index";

async function signInAsAdmin(
  context: BrowserContext,
  request: APIRequestContext,
): Promise<void> {
  await injectRequestSessionCookies(context, request);
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

type ThemeMode = "light" | "dark" | "system";
type EffectiveThemeSnapshot = {
  themeMode: ThemeMode;
  theme: {
    slug: string;
  };
};

async function readEffectiveTheme(
  request: APIRequestContext,
): Promise<EffectiveThemeSnapshot> {
  const data = await gql<{
    admin: {
      effectiveThemeProfile: EffectiveThemeSnapshot;
    };
  }>(
    request,
    `query AdminVisualRegressionEffectiveTheme {
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
  const data = await gql<{
    admin: {
      setThemeProfile: EffectiveThemeSnapshot;
    };
  }>(
    request,
    `mutation AdminVisualRegressionSetThemeProfile($input: SetThemeProfileInput!) {
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
}

async function openAdminPage(page: Page, routePath: string) {
  await page.goto(`${ADMIN_FRONTEND_BASE}${routePath}`, {
    waitUntil: "domcontentloaded",
    timeout: 20_000,
  });
  await expect(page.locator('[data-admin-page-frame="true"]')).toBeVisible({
    timeout: 10_000,
  });
  await expect(page.locator(".org-stagger").first()).toBeVisible({
    timeout: 10_000,
  });
}

function luminance(rgb: string): number {
  const match = rgb.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
  if (!match) return 0;
  const [r, g, b] = match
    .slice(1, 4)
    .map(Number)
    .map((value) => {
      const channel = value / 255;
      return channel <= 0.03928
        ? channel / 12.92
        : ((channel + 0.055) / 1.055) ** 2.4;
    });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrastRatio(fg: string, bg: string): number {
  const a = luminance(fg);
  const b = luminance(bg);
  const [hi, lo] = a >= b ? [a, b] : [b, a];
  return (hi + 0.05) / (lo + 0.05);
}

async function visibleTabPanels(page: Page) {
  return page.locator('[role="tabpanel"]').evaluateAll((panels) =>
    panels
      .map((panel) => {
        const style = getComputedStyle(panel);
        const rect = panel.getBoundingClientRect();
        return {
          state: panel.dataset.state,
          display: style.display,
          visible:
            style.display !== "none" &&
            style.visibility !== "hidden" &&
            rect.width > 0 &&
            rect.height > 0,
        };
      })
      .filter((panel) => panel.visible),
  );
}

async function activeTabState(page: Page, testId: string) {
  return page.getByTestId(testId).evaluate((tab) => ({
    selected: tab.getAttribute("aria-selected"),
    role: tab.getAttribute("role"),
  }));
}

async function visibleTabPanelOpacity(page: Page): Promise<string | null> {
  return page.locator('[role="tabpanel"]').evaluateAll((panels) => {
    const visiblePanel = panels.find((panel) => {
      const style = getComputedStyle(panel);
      const rect = panel.getBoundingClientRect();
      return (
        style.display !== "none" &&
        style.visibility !== "hidden" &&
        rect.width > 0 &&
        rect.height > 0
      );
    });
    return visiblePanel ? getComputedStyle(visiblePanel).opacity : null;
  });
}

const DESIGN_TAB_READY_TEST_IDS = {
  overview: "theme-gallery",
  colors: "design-colors-tab",
  branding: "design-branding-tab",
  "font-library": "font-library-tab",
  "editor-fonts": "design-fonts-tab",
} as const;

const DESIGN_TAB_REVIEW_TEST_IDS = {
  overview: "theme-gallery-card-stuttgart",
  colors: "colors-tab-section-surfaces",
  branding: "design-branding-section-logo",
  "font-library": "font-library-summary-ready",
  "editor-fonts": "editor-fonts-heading-preview",
} as const;

test.describe("P-AR-DOD — Admin role visual regression gates", () => {
  test.beforeEach(async ({ context, adminRequest }) => {
    await signInAsAdmin(context, adminRequest);
  });

  test("design tabs show exactly one force-mounted panel", async ({
    page,
  }, testInfo) => {
    await openAdminPage(page, "/design");

    for (const key of [
      "overview",
      "colors",
      "branding",
      "font-library",
      "editor-fonts",
    ]) {
      await page.getByTestId(`design-tab-${key}`).click();
      await expect
        .poll(() => activeTabState(page, `design-tab-${key}`), {
          message: `${key} design tab trigger must expose the active Mantine/ARIA tab state`,
          timeout: 10_000,
        })
        .toEqual({ role: "tab", selected: "true" });
      const visible = await visibleTabPanels(page);
      expect(
        visible,
        `only the ${key} design panel may be visible`,
      ).toHaveLength(1);
      await expect
        .poll(() => visibleTabPanelOpacity(page), {
          message: `${key} visible tab panel must finish its entrance animation before screenshots`,
          timeout: 15_000,
        })
        .toBe("1");
      const readyContent = page.getByTestId(DESIGN_TAB_READY_TEST_IDS[key]);
      await expect(
        readyContent,
        `${key} design tab must render visible review content before the screenshot`,
      ).toBeVisible({ timeout: 15_000 });
      await readyContent.scrollIntoViewIfNeeded();
      await page.screenshot({
        fullPage: true,
        path: testInfo.outputPath(`design-tab-${key}.png`),
      });
      const reviewContent = page.getByTestId(DESIGN_TAB_REVIEW_TEST_IDS[key]);
      await expect(
        reviewContent,
        `${key} design tab must expose a focused visual review target`,
      ).toBeVisible({ timeout: 15_000 });
      await reviewContent.scrollIntoViewIfNeeded();
      await reviewContent.screenshot({
        path: testInfo.outputPath(`design-tab-${key}-review-target.png`),
      });
      if (key === "font-library") {
        const readyFonts = Number(
          await page
            .getByTestId("font-library-summary-ready")
            .locator("div")
            .last()
            .innerText(),
        );
        expect(
          readyFonts,
          "font library visual gate must cover server-approved bundled fonts",
        ).toBeGreaterThan(0);
      }
    }
  });

  test("visible page hero consumes active city-preset typography and theme text color", async ({
    page,
    adminRequest,
  }) => {
    const original = await readEffectiveTheme(adminRequest);
    try {
      await setThemeProfile(adminRequest, {
        themeSlug: "hamburg",
        themeMode: "light",
      });
      await openAdminPage(page, "/design");
      const header = await page
        .locator(".org-stagger .org-h1")
        .first()
        .evaluate((el) => {
          const style = getComputedStyle(el);
          const rootStyle = getComputedStyle(document.documentElement);
          return {
            className: el.getAttribute("class") ?? "",
            color: style.color,
            headingToken: rootStyle.getPropertyValue(
              "--myoxus-typography-h1-family",
            ),
            fontFamily: style.fontFamily,
            fontStyle: style.fontStyle,
          };
        });

      expect(header.className).toContain("org-h1");
      expect(header.fontStyle).not.toBe("italic");
      expect(header.headingToken).toContain("Lato");
      expect(header.fontFamily.toLowerCase()).toContain("lato");
      expect(header.color).not.toBe("rgb(0, 0, 0)");
    } finally {
      await setThemeProfile(adminRequest, {
        themeSlug: original.theme.slug,
        themeMode: original.themeMode,
      });
    }
  });

  test("shell title stays semantic-only and does not duplicate the visible hero title", async ({
    page,
  }) => {
    await openAdminPage(page, "/templates");

    await expect(page.getByTestId("admin-page-chrome")).toHaveCount(0);
    const semanticShellTitle = await page
      .getByTestId("admin-page-title")
      .evaluate((el) => ({
        text: el.textContent?.trim(),
        visible:
          getComputedStyle(el).display !== "none" &&
          el.getBoundingClientRect().width > 0 &&
          el.getBoundingClientRect().height > 0,
      }));
    const visibleHeroText = await page
      .locator(".org-stagger .org-h1")
      .first()
      .innerText();

    expect(semanticShellTitle.text).toBeTruthy();
    expect(visibleHeroText).toBeTruthy();
    expect(semanticShellTitle.visible).toBe(false);
  });

  test("top-level heroes are unnumbered h1 headings across admin routes", async ({
    page,
  }) => {
    for (const route of [
      "/dashboard",
      "/organization",
      "/workspaces",
      "/design",
      "/typography",
      "/templates",
      "/documents",
      "/pdf-export",
      "/system",
    ]) {
      await openAdminPage(page, route);
      const hero = await page
        .locator(".org-stagger header")
        .first()
        .evaluate((header) => {
          const heading = header.querySelector("h1");
          const number = header.querySelector(
            ":scope > div:first-child > .org-mono span:first-child",
          );
          const style = heading ? getComputedStyle(heading) : null;
          return {
            hasH1: Boolean(heading),
            h1Class: heading?.getAttribute("class") ?? "",
            h1Style: style?.fontStyle ?? "",
            numberText: number?.textContent?.trim() ?? null,
          };
        });

      expect(hero.hasH1, `${route} must expose an h1 page hero`).toBe(true);
      expect(hero.h1Class).toContain("org-h1");
      expect(hero.h1Style, `${route} hero must not be italic`).not.toBe(
        "italic",
      );
      expect(hero.numberText, `${route} page hero must be unnumbered`).toBe(
        null,
      );
    }
  });

  test("theme gallery previews stay isolated from the active theme", async ({
    page,
    adminRequest,
  }) => {
    const original = await readEffectiveTheme(adminRequest);
    try {
      await setThemeProfile(adminRequest, {
        themeSlug: "hamburg",
        themeMode: "light",
      });
      await openAdminPage(page, "/design");

      const cards = await page.evaluate(() => {
        const read = (testId: string) => {
          const el = document.querySelector(
            `[data-testid="${testId}"]`,
          ) as HTMLElement;
          const title = el.querySelector("h2") as HTMLElement;
          const style = getComputedStyle(el);
          const titleStyle = getComputedStyle(title);
          return {
            bg: style.backgroundColor,
            border: style.borderColor,
            family: titleStyle.fontFamily,
          };
        };
        return {
          stuttgart: read("theme-gallery-card-stuttgart"),
          hamburg: read("theme-gallery-card-hamburg"),
        };
      });

      expect(cards.hamburg.family.toLowerCase()).toContain("lato");
      expect(cards.stuttgart.family.toLowerCase()).toContain("inter");
      expect(cards.stuttgart.bg).not.toBe(cards.hamburg.bg);
    } finally {
      await setThemeProfile(adminRequest, {
        themeSlug: original.theme.slug,
        themeMode: original.themeMode,
      });
    }
  });

  test("dashboard never exposes raw tone token names as status labels", async ({
    page,
  }) => {
    await openAdminPage(page, "/dashboard");
    const visibleText = await page.locator("body").innerText();
    expect(visibleText).not.toMatch(/\b(mint|peach|rose|sky|ink)\b/i);
    await expect(
      page
        .getByText(
          /stable|watch|critical|active|stabil|beobachten|kritisch|aktiv/i,
        )
        .first(),
    ).toBeVisible();
  });

  test("dark-mode organization surfaces keep readable contrast", async ({
    page,
    adminRequest,
  }) => {
    const original = await readEffectiveTheme(adminRequest);
    try {
      await setThemeProfile(adminRequest, {
        themeSlug: original.theme.slug,
        themeMode: "dark",
      });
      await openAdminPage(page, "/organization");
      await page.getByTestId("organization-tab-unit-types").click();
      await expect(
        page.getByTestId("organization-unit-type-package-default"),
      ).toBeVisible();

      const contrast = await page
        .getByTestId("organization-unit-type-package-default")
        .evaluate((card) => {
          const heading = card.querySelector(".org-h5, .org-h4, .org-display");
          if (!heading)
            return { color: "rgb(0, 0, 0)", background: "rgb(0, 0, 0)" };
          const headingStyle = getComputedStyle(heading);
          const cardStyle = getComputedStyle(card);
          return {
            color: headingStyle.color,
            background: cardStyle.backgroundColor,
          };
        });

      expect(
        contrastRatio(contrast.color, contrast.background),
        `package heading contrast ${JSON.stringify(contrast)}`,
      ).toBeGreaterThanOrEqual(4.5);
    } finally {
      await setThemeProfile(adminRequest, {
        themeSlug: original.theme.slug,
        themeMode: original.themeMode,
      });
    }
  });

  test("dark-mode workspaces shell does not render the old light page gradient", async ({
    page,
    adminRequest,
  }) => {
    const original = await readEffectiveTheme(adminRequest);
    try {
      await setThemeProfile(adminRequest, {
        themeSlug: original.theme.slug,
        themeMode: "dark",
      });
      await openAdminPage(page, "/workspaces");

      const background = await page
        .getByTestId("workspaces-page-shell")
        .evaluate((shell) => getComputedStyle(shell).backgroundImage);

      expect(
        background,
        "workspace shell must be tokenized and must not contain hard-coded light hex colors",
      ).not.toMatch(/#fbfaf6|#f2efe7|251,\s*250,\s*246|242,\s*239,\s*231/i);
    } finally {
      await setThemeProfile(adminRequest, {
        themeSlug: original.theme.slug,
        themeMode: original.themeMode,
      });
    }
  });

  test("dark-mode default action buttons keep accessible contrast", async ({
    page,
    adminRequest,
  }) => {
    const original = await readEffectiveTheme(adminRequest);
    try {
      await setThemeProfile(adminRequest, {
        themeSlug: original.theme.slug,
        themeMode: "dark",
      });
      await openAdminPage(page, "/system");

      const styles = await page
        .getByRole("button", { name: /speichern|save/i })
        .first()
        .evaluate((button) => {
          const style = getComputedStyle(button);
          return {
            color: style.color,
            background: style.backgroundColor,
          };
        });

      expect(
        contrastRatio(styles.color, styles.background),
        `default action contrast ${JSON.stringify(styles)}`,
      ).toBeGreaterThanOrEqual(4.5);
    } finally {
      await setThemeProfile(adminRequest, {
        themeSlug: original.theme.slug,
        themeMode: original.themeMode,
      });
    }
  });

  test("server-seeded OU type presets are not collapsed into default", async ({
    page,
  }) => {
    await openAdminPage(page, "/organization");
    await page.getByTestId("organization-tab-unit-types").click();

    for (const key of ["default", "kvg", "kvk", "wt", "mx"]) {
      await expect(
        page.getByTestId(`organization-unit-type-package-${key}`),
      ).toBeVisible();
      const count = Number(
        await page
          .getByTestId(`organization-unit-type-package-${key}`)
          .getAttribute("data-count"),
      );
      expect(
        count,
        `${key} preset package must contain server presets`,
      ).toBeGreaterThan(0);
    }
  });
});
