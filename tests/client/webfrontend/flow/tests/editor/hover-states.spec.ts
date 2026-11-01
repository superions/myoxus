/**
 * Editor hover-state E2E tests (INV-THEME-HOVER-01, EDITOR-02-G, EDITOR-03-A).
 *
 * Invariants:
 *   INV-THEME-HOVER-41  appendHoverVariables injects btn-primary-hover-bg/fg into :root
 *   INV-THEME-HOVER-42  appendHoverVariables injects btn-secondary-hover-bg/fg into :root
 *   INV-THEME-HOVER-43  appendHoverVariables injects overlay-hover-bg/fg into :root
 *   INV-THEME-HOVER-44  icon-button applies the canonical V2 hoverOverlay token
 *
 * Prerequisites: local live stack running (localhost:3010).
 *
 * Run: npx playwright test \
 *        --config tests/client/webfrontend/flow/playwright.config.ts \
 *        tests/client/webfrontend/flow/tests/editor/hover-states.spec.ts
 */

import { expect, test } from "@playwright/test";

test.describe("editor hover-state CSS invariants", () => {
  test.beforeEach(async ({ page }) => {
    // Navigate to root; theme.css injection happens for all visitors (no auth needed).
    // Use 'load' not 'networkidle' — socket.io keeps network active indefinitely.
    await page.goto("http://localhost:3010/", { waitUntil: "load" });
    // Wait for the runtime-theme JS to fetch /api/branding/theme.css and inject vars.
    // The semantic token is a reliable proxy: non-empty means the fetch completed.
    await page.waitForFunction(
      () =>
        getComputedStyle(document.documentElement)
          .getPropertyValue("--myoxus-sem-button-primary-bg")
          .trim() !== "",
      { timeout: 20_000 },
    );
  });

  test("inv_hover_41_42_43_appendHoverVariables_injects_all_pairs", async ({
    page,
  }) => {
    // appendHoverVariables (WEB-01) fetches /api/branding/theme.css, derives
    // hover pairs via deriveHoverPair, and injects --myoxus-btn-*-hover-* into :root.
    // We wait for the pairs to appear (they're set after the semantic tokens).
    await page.waitForFunction(
      () =>
        getComputedStyle(document.documentElement)
          .getPropertyValue("--myoxus-btn-primary-hover-bg")
          .trim() !== "",
      { timeout: 15_000 },
    );

    const vars = await page.evaluate(() => {
      const s = getComputedStyle(document.documentElement);
      return {
        primaryBg: s.getPropertyValue("--myoxus-btn-primary-hover-bg").trim(),
        primaryFg: s.getPropertyValue("--myoxus-btn-primary-hover-fg").trim(),
        secondaryBg: s
          .getPropertyValue("--myoxus-btn-secondary-hover-bg")
          .trim(),
        secondaryFg: s
          .getPropertyValue("--myoxus-btn-secondary-hover-fg")
          .trim(),
        overlayBg: s.getPropertyValue("--myoxus-overlay-hover-bg").trim(),
        overlayFg: s.getPropertyValue("--myoxus-overlay-hover-fg").trim(),
      };
    });

    // INV-THEME-HOVER-41
    expect(vars.primaryBg, "btn-primary-hover-bg injected").toMatch(
      /^#[0-9a-fA-F]{3,6}$/,
    );
    expect(vars.primaryFg, "btn-primary-hover-fg injected").toMatch(
      /^#[0-9a-fA-F]{3,6}$/,
    );

    // INV-THEME-HOVER-42
    expect(vars.secondaryBg, "btn-secondary-hover-bg injected").toMatch(
      /^#[0-9a-fA-F]{3,6}$/,
    );
    expect(vars.secondaryFg, "btn-secondary-hover-fg injected").toMatch(
      /^#[0-9a-fA-F]{3,6}$/,
    );

    // INV-THEME-HOVER-43
    expect(vars.overlayBg, "overlay-hover-bg injected").toMatch(
      /^#[0-9a-fA-F]{3,6}$/,
    );
    expect(vars.overlayFg, "overlay-hover-fg injected").toMatch(
      /^#[0-9a-fA-F]{3,6}$/,
    );
  });

  test("inv_hover_44_hoverOverlay_token_resolves", async ({ page }) => {
    // The hover role has exactly one public CSS-variable contract.
    // Candidate-based "any token exists" checks hid broken theme projections,
    // so this gate pins the canonical variable and verifies actual rendering.
    const resolved = await page.evaluate(() => {
      const tokenName = "--myoxus-hover-color";
      const style = getComputedStyle(document.documentElement);
      const probe = document.createElement("div");
      probe.style.background = `var(${tokenName})`;
      document.body.append(probe);
      const background = getComputedStyle(probe).backgroundColor;
      probe.remove();
      return {
        tokenName,
        tokenValue: style.getPropertyValue(tokenName).trim(),
        background,
      };
    });

    expect(
      resolved.tokenValue,
      `${resolved.tokenName} must be declared by the runtime theme`,
    ).not.toBe("");
    expect(
      resolved.background,
      `${resolved.tokenName} must resolve to a visible browser color`,
    ).not.toBe("rgba(0, 0, 0, 0)");
  });
});
