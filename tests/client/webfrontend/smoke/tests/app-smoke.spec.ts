/**
 * Web frontend smoke tests — run after every frontend rebuild.
 *
 * Invariants checked:
 *   INV-SMOKE-01  App loads at / without uncaught JS errors
 *   INV-SMOKE-02  Sign-in page renders without JS errors
 *   INV-SMOKE-03  Authenticated session loads main workspace without JS errors
 *   INV-SMOKE-04  No "Component not found in container" DI errors at any step
 *   INV-SMOKE-05  Workspace switcher renders without crash
 *   INV-SMOKE-06  Password sign-in follows the live CAPTCHA contract
 *   INV-SMOKE-07  Quick Search cannot remain as a blocking overlay
 *   INV-SMOKE-08  Not-found routes render the shared Myoxus not-found shell
 *
 * Prerequisites: stack running at localhost:3010 and localhost:3001.
 * Standard test user: the clean-stack bootstrap admin.
 */

import { type BrowserContext, expect, type Page, test } from "@playwright/test";

import {
  DEFAULT_SMOKE_USER_EMAIL,
  DEFAULT_SMOKE_USER_PASSWORD,
  signInViaApi,
  signOutViaApi,
} from "../../shared/auth-helper";
import { getSmokeWorkspaceId } from "../../shared/workspace-helper";

const FRONTEND = process.env.E2E_BASE_URL ?? "http://localhost:3010";
const API = process.env.E2E_API_BASE_URL ?? "http://localhost:3001";

const USER_EMAIL = DEFAULT_SMOKE_USER_EMAIL;
const USER_PASSWORD = DEFAULT_SMOKE_USER_PASSWORD;
let apiSessionCookies: string[] | undefined;

/** Patterns that indicate a broken app — any console error matching these is a hard failure. */
const FATAL_ERROR_PATTERNS = [
  /not found in container/i,
  /ComponentNotFoundError/i,
  /Uncaught Error/i,
  /Cannot read properties of undefined/i,
  /Cannot read properties of null/i,
  /is not a function/i,
  /ReferenceError/i,
  /index error, retry in 5s/i,
  /blocks is not defined/i,
  /ChunkLoadError/i,
  /Loading chunk/i,
];

function collectFatalErrors(page: Page): () => string[] {
  const errors: string[] = [];
  page.on("console", (msg) => {
    if (msg.type() === "error") {
      const text = msg.text();
      if (FATAL_ERROR_PATTERNS.some((p) => p.test(text))) {
        errors.push(text);
      }
    }
  });
  page.on("pageerror", (err) => {
    errors.push(err.message);
  });
  return () => errors;
}

async function injectCookies(
  context: BrowserContext,
  rawCookies: string[],
): Promise<void> {
  for (const raw of rawCookies) {
    const nameVal = raw.split(";")[0];
    const [name, ...rest] = nameVal.split("=");
    const value = rest.join("=");
    await context.addCookies([
      {
        name: name.trim(),
        value: value.trim(),
        url: FRONTEND,
        httpOnly: false,
        secure: false,
        sameSite: "Lax",
      },
    ]);
  }
}

async function signOutBrowserSession(
  context: BrowserContext,
  page: Page,
): Promise<void> {
  const csrf = (await context.cookies(FRONTEND)).find(
    (cookie) => cookie.name === "myoxus_csrf_token",
  )?.value;
  if (!csrf) return;
  const result = await page.evaluate(
    async ({ api, csrfToken }) => {
      const response = await fetch(`${api}/api/auth/sign-out`, {
        method: "POST",
        credentials: "include",
        headers: {
          "x-myoxus-csrf-token": csrfToken,
        },
      });
      return {
        ok: response.ok,
        status: response.status,
        text: await response.text(),
      };
    },
    // Browser cleanup must use the same public origin as the product UI.
    // A direct localhost:3001 fetch is a test-only cross-origin path and can
    // fail before it reaches the auth route, masking the real CAPTCHA contract.
    { api: FRONTEND, csrfToken: csrf },
  );
  if (!result.ok) {
    throw new Error(
      `Browser sign-out failed: HTTP ${result.status} ${result.text}`,
    );
  }
}

test.describe("Web frontend smoke suite", () => {
  test.afterAll(async ({ request }) => {
    await signOutViaApi(request, API, apiSessionCookies);
  });

  test("INV-SMOKE-01/02: app root and sign-in load without fatal JS errors", async ({
    page,
  }) => {
    const getErrors = collectFatalErrors(page);

    await page.goto(`${FRONTEND}/`, {
      waitUntil: "domcontentloaded",
      timeout: 20_000,
    });
    // Wait for React to hydrate
    await page.waitForTimeout(2_000);

    const errors = getErrors();
    expect(
      errors,
      `Fatal JS errors on load: ${errors.join("\n")}`,
    ).toHaveLength(0);
  });

  test("INV-SMOKE-03/04/05: authenticated workspace loads without DI or JS errors", async ({
    page,
    context,
    request,
  }) => {
    const getErrors = collectFatalErrors(page);

    // Sign in via API and inject session cookie
    apiSessionCookies = await signInViaApi(
      request,
      API,
      USER_EMAIL,
      USER_PASSWORD,
    );
    await injectCookies(context, apiSessionCookies);

    // Navigate to app root — should redirect to workspace.
    // Use 'load' (not 'networkidle') — the live sync connection keeps WebSockets active
    // indefinitely, so networkidle never fires on a real session.
    await page.goto(`${FRONTEND}/`, { waitUntil: "load", timeout: 30_000 });
    await page.waitForTimeout(2_000);

    // Check JS errors FIRST — these are the most informative failure signal
    const errors = getErrors();
    expect(
      errors,
      `Fatal JS errors in authenticated session:\n${errors.join("\n")}`,
    ).toHaveLength(0);

    // Must not show React error boundary ("Something is wrong")
    const bodyText = await page
      .locator("body")
      .innerText()
      .catch(() => "");
    expect(bodyText, "App showed error boundary").not.toMatch(
      /Something is wrong/i,
    );
    expect(bodyText, "App showed 500 page").not.toMatch(/\b500\b/);

    await expect(page).toHaveURL(
      /\/workspace\/[0-9a-f-]{36}\/home(?:[/?#]|$)/i,
      { timeout: 20_000 },
    );
    await expect(
      page.locator('[data-myoxus-ui-role="workspace-home-content"]'),
      "The authenticated smoke must reach synced workspace content, not merely render empty chrome",
    ).toBeVisible({ timeout: 20_000 });
  });

  test("INV-SMOKE-08: not-found routes render the shared Myoxus shell", async ({
    context,
    page,
    request,
  }) => {
    const getErrors = collectFatalErrors(page);

    apiSessionCookies = await signInViaApi(
      request,
      API,
      USER_EMAIL,
      USER_PASSWORD,
    );
    await injectCookies(context, apiSessionCookies);
    const workspaceId = await getSmokeWorkspaceId(
      request,
      `${FRONTEND}/graphql`,
      apiSessionCookies,
    );

    await page.goto(`${FRONTEND}/404`, {
      waitUntil: "load",
      timeout: 30_000,
    });
    const rootNotFound = page.locator(
      '[data-testid="not-found"], [data-testid="workbench-route-not-found"]',
    );
    await expect(rootNotFound).toBeVisible({ timeout: 20_000 });
    await expect(page.getByRole("heading").first()).toBeVisible();
    await expect(
      rootNotFound.locator('[data-myoxus-ui-role="empty-state-copy"]'),
    ).toBeVisible();
    await expect(
      rootNotFound.locator('[data-myoxus-ui-role="empty-state-copy"]'),
    ).toHaveText(/\S/);
    await expect(page.getByRole("button").last()).toBeVisible();

    await page.goto(
      `${FRONTEND}/workspace/${workspaceId}/missing-doc-route-smoke`,
      { waitUntil: "load", timeout: 30_000 },
    );
    const workspaceNotFound = page.locator(
      '[data-testid="not-found"], [data-testid="workbench-route-not-found"]',
    );
    await expect(workspaceNotFound).toBeVisible({ timeout: 20_000 });
    await expect(page.getByRole("heading").first()).toBeVisible();

    expect(
      getErrors(),
      "Fatal JS errors during not-found route smoke",
    ).toHaveLength(0);
  });

  test("INV-SMOKE-06: password sign-in honors the live CAPTCHA contract", async ({
    context,
    page,
    request,
  }) => {
    const captchaProbe = await request.get(`${API}/api/auth/challenge`, {
      headers: { Accept: "application/json" },
    });
    const captchaDisabled = captchaProbe.status() === 503;
    if (!captchaDisabled) {
      expect(captchaProbe.ok(), await captchaProbe.text()).toBe(true);
    }

    const getErrors = collectFatalErrors(page);

    await page.goto(
      `${FRONTEND}/sign-in?redirect_uri=%2Fadminfrontend&auth_context=admin`,
      { waitUntil: "domcontentloaded", timeout: 30_000 },
    );
    await page.locator("input").first().fill(USER_EMAIL);
    await page.getByTestId("continue-login-button").click();

    await expect(page.getByTestId("password-input")).toBeVisible({
      timeout: 15_000,
    });
    const widget = page.locator("altcha-widget");
    if (captchaDisabled) {
      await expect(widget).toHaveCount(0);
    } else {
      await expect(widget).toBeVisible({ timeout: 15_000 });

      await page.waitForTimeout(1_000);
      await expect
        .poll(
          () =>
            page.evaluate(() => {
              const widget = document.querySelector("altcha-widget") as
                (HTMLElement & { getState?: () => string }) | null;
              return widget?.getState?.() ?? null;
            }),
          { timeout: 5_000 },
        )
        .toBe("unverified");
      await expect(page.locator("body")).not.toContainText(
        /Verification failed|Sicherheitsprüfung fehlgeschlagen/i,
      );

      // ALTCHA v3 renders a custom checkbox SVG over the native input and wires
      // that visible hit area back to the input. Clicking the wrapper exercises
      // the same user path without depending on the library's internal z-order.
      await page.locator("altcha-widget .altcha-checkbox").click();
      await expect
        .poll(
          () =>
            page.evaluate(() => {
              const widget = document.querySelector("altcha-widget") as
                (HTMLElement & { getState?: () => string }) | null;
              if (
                !widget &&
                /Verified|Verifiziert|Verificado|Vérifié/i.test(
                  document.body.innerText,
                )
              ) {
                return "verified";
              }
              return widget?.getState?.() ?? null;
            }),
          { timeout: 30_000 },
        )
        .toBe("verified");
    }

    try {
      await page.getByTestId("password-input").fill(USER_PASSWORD);
      await page.getByTestId("sign-in-button").click();
      await page.waitForURL(/adminfrontend|workspace|\/$/, {
        timeout: 30_000,
      });

      expect(
        getErrors(),
        "Fatal JS errors during password sign-in",
      ).toHaveLength(0);
      await expect(page.locator("body")).not.toContainText(
        /captcha token missing|Verification failed|Sicherheitsprüfung fehlgeschlagen/i,
      );
    } finally {
      await signOutBrowserSession(context, page);
    }
  });

  test("INV-SMOKE-07: quick search closes on outside click, Escape and selection", async ({
    context,
    page,
    request,
  }) => {
    const getErrors = collectFatalErrors(page);

    apiSessionCookies = await signInViaApi(
      request,
      API,
      USER_EMAIL,
      USER_PASSWORD,
    );
    await injectCookies(context, apiSessionCookies);

    const workspaceId = await getSmokeWorkspaceId(
      request,
      `${FRONTEND}/graphql`,
      apiSessionCookies,
    );
    await page.addInitScript((id) => {
      window.localStorage.setItem("last_workspace_id", id);
    }, workspaceId);
    await page.goto(`${FRONTEND}/workspace/${workspaceId}/all`, {
      waitUntil: "load",
      timeout: 30_000,
    });
    await expect(
      page.getByTestId("slider-bar-quick-search-button"),
    ).toBeVisible({ timeout: 20_000 });

    const quickSearch = page.getByTestId("cmdk-quick-search");
    const openQuickSearch = async () => {
      await page.getByTestId("slider-bar-quick-search-button").click();
      await expect(quickSearch).toBeVisible({ timeout: 10_000 });
    };

    await openQuickSearch();
    const box = await quickSearch.boundingBox();
    if (!box) {
      throw new Error("Quick Search bounding box is unavailable");
    }
    // Click the modal overlay beside the command surface. This covers the
    // user-visible stuck-overlay regression better than a component-only test.
    await page.mouse.click(box.x + box.width + 40, box.y + 40);
    await expect(quickSearch).toBeHidden({ timeout: 5_000 });

    await openQuickSearch();
    await page.keyboard.press("Escape");
    await expect(quickSearch).toBeHidden({ timeout: 5_000 });

    await openQuickSearch();
    await page
      .getByRole("option", {
        name: /Heutiges Journal|Today's journal/i,
      })
      .click();
    await expect(quickSearch).toBeHidden({ timeout: 5_000 });

    expect(
      getErrors(),
      "Fatal JS errors during Quick Search dismissal smoke",
    ).toHaveLength(0);
  });
});
