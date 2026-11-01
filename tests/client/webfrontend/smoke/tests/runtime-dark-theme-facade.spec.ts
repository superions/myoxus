// SPDX-License-Identifier: AGPL-3.0-or-later

import { copyFile, mkdir } from "node:fs/promises";
import path from "node:path";

import { type BrowserContext, expect, test } from "@playwright/test";

import {
  DEFAULT_SMOKE_USER_EMAIL,
  DEFAULT_SMOKE_USER_PASSWORD,
  signInViaApi,
  signOutViaApi,
} from "../../shared/auth-helper";
import {
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
  `web-runtime-dark-theme-facade-${process.env.MYOXUS_VISUAL_QA_RUN_ID ?? process.pid}`,
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

function luminanceFromRgb(value: string): number {
  const match = value.match(/rgba?\(([^)]+)\)/);
  if (!match) throw new Error(`Unsupported color value: ${value}`);
  const [r, g, b] = match[1]
    .split(",")
    .slice(0, 3)
    .map((part) => Number.parseFloat(part.trim()))
    .map((component) => {
      const normalized = component / 255;
      return normalized <= 0.03928
        ? normalized / 12.92
        : Math.pow((normalized + 0.055) / 1.055, 2.4);
    });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrastRatio(foreground: string, background: string): number {
  const fg = luminanceFromRgb(foreground);
  const bg = luminanceFromRgb(background);
  const bright = Math.max(fg, bg);
  const dark = Math.min(fg, bg);
  return (bright + 0.05) / (dark + 0.05);
}

test.describe("Web runtime dark theme facade bridge", () => {
  test.afterAll(async ({ request }) => {
    if (apiSessionCookies && originalColorMode !== undefined) {
      await setAccountColorMode(
        { request, gqlEndpoint: GQL, cookies: apiSessionCookies },
        originalColorMode,
      );
    }
    await signOutViaApi(request, API, apiSessionCookies);
  });

  test("authenticated workspace dark mode uses server Myoxus tokens for visible app and Mantine chrome", async ({
    context,
    page,
    request,
  }, testInfo) => {
    await mkdir(QA_DIR, { recursive: true });

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
    await setAccountColorMode(preferenceTarget, "dark");
    await injectCookies(context, apiSessionCookies);

    const workspaceId = await getSmokeWorkspaceId(
      request,
      GQL,
      apiSessionCookies,
    );
    await page.goto(`${FRONTEND}/workspace/${workspaceId}/all`, {
      waitUntil: "load",
      timeout: 30_000,
    });

    await expect(page.getByTestId("main-container")).toBeVisible({
      timeout: 20_000,
    });
    await expect(page.getByTestId("sidebar-new-page-button")).toBeVisible({
      timeout: 20_000,
    });
    await expect
      .poll(
        () =>
          page.evaluate(
            () =>
              document.getElementById("myoxus-branding-css")?.dataset
                .myoxusBrandingSource,
          ),
        { timeout: 10_000 },
      )
      .toBe("api");

    const visualState = await page.evaluate(() => {
      const computedPair = (backgroundVar: string, colorVar: string) => {
        const element = document.createElement("div");
        element.style.cssText = [
          "position: fixed",
          "left: -10000px",
          "top: -10000px",
          `background: var(${backgroundVar})`,
          `color: var(${colorVar})`,
        ].join(";");
        document.body.append(element);
        const style = getComputedStyle(element);
        const result = {
          background: style.backgroundColor,
          color: style.color,
        };
        element.remove();
        return result;
      };

      const bodyStyle = getComputedStyle(document.body);
      const main = document.querySelector('[data-testid="main-container"]');
      const mainStyle = main ? getComputedStyle(main) : null;
      const rootStyle = getComputedStyle(document.documentElement);
      const centerElement = document.elementFromPoint(
        window.innerWidth / 2,
        window.innerHeight / 2,
      );
      const centerStyle = centerElement
        ? getComputedStyle(centerElement)
        : null;

      return {
        rootTheme: document.documentElement.dataset.theme,
        mantineScheme: document.documentElement.getAttribute(
          "data-mantine-color-scheme",
        ),
        colorScheme: document.documentElement.style.colorScheme,
        brandingSource: document.getElementById("myoxus-branding-css")?.dataset
          .myoxusBrandingSource,
        rootVars: {
          myoxusSurface: rootStyle
            .getPropertyValue("--myoxus-background-primary-color")
            .trim(),
          myoxusText: rootStyle
            .getPropertyValue("--myoxus-text-primary-color")
            .trim(),
          mantineBody: rootStyle
            .getPropertyValue("--mantine-color-body")
            .trim(),
          mantineText: rootStyle
            .getPropertyValue("--mantine-color-text")
            .trim(),
        },
        body: {
          background: bodyStyle.backgroundColor,
          color: bodyStyle.color,
        },
        main: {
          background: mainStyle?.backgroundColor ?? "",
          color: mainStyle?.color ?? "",
        },
        center: {
          tag: centerElement?.tagName ?? "",
          background: centerStyle?.backgroundColor ?? "",
          color: centerStyle?.color ?? "",
        },
        mantine: computedPair("--mantine-color-body", "--mantine-color-text"),
        myoxus: computedPair(
          "--myoxus-background-primary-color",
          "--myoxus-text-primary-color",
        ),
      };
    });

    expect(visualState.rootTheme).toBe("dark");
    expect(visualState.mantineScheme).toBe("dark");
    expect(visualState.colorScheme).toBe("dark");
    expect(visualState.brandingSource).toBe("api");
    expect(visualState.rootVars.mantineBody).toBe(
      visualState.rootVars.myoxusSurface,
    );
    expect(visualState.rootVars.mantineText).toBe(
      visualState.rootVars.myoxusText,
    );
    expect(visualState.mantine.background).toBe(visualState.myoxus.background);
    expect(visualState.mantine.color).toBe(visualState.myoxus.color);
    expect(
      luminanceFromRgb(visualState.body.background),
      `body must be visibly dark: ${JSON.stringify(visualState)}`,
    ).toBeLessThan(0.08);
    expect(
      contrastRatio(visualState.body.color, visualState.body.background),
      `body text contrast must remain readable: ${JSON.stringify(visualState)}`,
    ).toBeGreaterThanOrEqual(4.5);

    const screenshot = testInfo.outputPath("workspace-all-dark-theme.png");
    await page.screenshot({ path: screenshot, fullPage: true });
    await copyFile(screenshot, path.join(QA_DIR, path.basename(screenshot)));
  });
});
