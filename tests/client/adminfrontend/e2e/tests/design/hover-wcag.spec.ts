// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Daniel Scharf and Myoxus contributors

/**
 * Running-stack guard for Admin hover/contrast theme plumbing.
 *
 * The old test looked for generic `role="status"` badges and inline hover
 * variables. The current contract is stricter: Admin must consume the
 * server-projected branding stylesheet and keep derived hover variables inside
 * that stylesheet so dark-mode selectors are not overwritten by stale inline
 * root tokens.
 */
import {
  installAdminRuntimeErrorCollector,
  waitForAdminRuntimeReady,
} from "../../fixtures/admin-ui-runtime-errors";
import {
  ADMIN_FRONTEND_BASE,
  injectRequestSessionCookies,
} from "../../fixtures/auth";
import { expect, test } from "../../fixtures/index";

const REQUIRED_HOVER_VARS = [
  "--myoxus-btn-primary-hover-bg",
  "--myoxus-btn-primary-hover-fg",
  "--myoxus-btn-secondary-hover-bg",
  "--myoxus-btn-secondary-hover-fg",
  "--myoxus-overlay-hover-bg",
  "--myoxus-overlay-hover-fg",
] as const;

test.describe("design-page server branding hover contract", () => {
  test.beforeEach(async ({ context, adminRequest }) => {
    await injectRequestSessionCookies(context, adminRequest);
  });

  test("design route consumes API branding CSS with dark-aware hover variables", async ({
    page,
  }) => {
    const runtimeCollector = installAdminRuntimeErrorCollector(page);

    await page.goto(`${ADMIN_FRONTEND_BASE}/design`, {
      waitUntil: "load",
      timeout: 20_000,
    });
    await waitForAdminRuntimeReady(
      page,
      '[data-admin-route-anchor="admin-route-design"]',
    );

    await page.waitForFunction(
      (requiredVars) => {
        const style = document.getElementById(
          "myoxus-branding-css",
        ) as HTMLStyleElement | null;
        const text = style?.textContent ?? "";
        return (
          style?.dataset.myoxusBrandingSource === "api" &&
          requiredVars.every((name) => text.includes(`${name}:`)) &&
          /\[data-theme=(['"])dark\1\]/.test(text)
        );
      },
      REQUIRED_HOVER_VARS,
      { timeout: 15_000 },
    );

    for (const testId of [
      "design-tab-overview",
      "design-tab-colors",
      "design-tab-branding",
      "design-tab-font-library",
      "design-tab-editor-fonts",
    ]) {
      await expect(page.getByTestId(testId)).toBeVisible();
    }

    const contract = await page.evaluate((requiredVars) => {
      const style = document.getElementById(
        "myoxus-branding-css",
      ) as HTMLStyleElement | null;
      const root = document.documentElement;
      const computed = getComputedStyle(root);
      const inline = root.style;
      return {
        source: style?.dataset.myoxusBrandingSource ?? "",
        text: style?.textContent ?? "",
        inlineHoverVars: requiredVars.filter(
          (name) => inline.getPropertyValue(name).trim() !== "",
        ),
        computedBaseVars: [
          "--myoxus-sem-button-primary-bg",
          "--myoxus-sem-button-primary-fg",
          "--myoxus-sem-button-secondary-bg",
          "--myoxus-sem-button-secondary-fg",
          "--myoxus-text-primary-color",
          "--myoxus-background-primary-color",
        ].map((name) => [name, computed.getPropertyValue(name).trim()]),
      };
    }, REQUIRED_HOVER_VARS);

    expect(contract.source).toBe("api");
    expect(contract.inlineHoverVars).toEqual([]);
    for (const [name, value] of contract.computedBaseVars) {
      expect(value, `${name} must resolve from server branding CSS`).not.toBe(
        "",
      );
    }
    for (const name of REQUIRED_HOVER_VARS) {
      expect(
        contract.text,
        `${name} must be in the injected stylesheet`,
      ).toContain(`${name}:`);
    }
    expect(contract.text).toMatch(/\[data-theme=(['"])dark\1\]/);
    runtimeCollector.assertNoFatal();
  });
});
