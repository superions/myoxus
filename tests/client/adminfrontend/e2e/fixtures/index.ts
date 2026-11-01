/**
 * Custom Playwright fixtures for E2E tests.
 *
 * Provides `adminRequest` — a function-scoped `APIRequestContext` seeded with
 * a cached authenticated admin storage state. Import `test` and `expect` from
 * this module instead of `@playwright/test` in any test file that needs admin
 * API access inside individual `test()` blocks.
 *
 * Why: Playwright's built-in `request` fixture is function-scoped and does
 * NOT share cookie state set in `test.beforeAll`.  Any sign-in performed in
 * `beforeAll({ request })` is invisible to subsequent `test({ request })` calls.
 * The initial sign-in is shared per worker process so visual suites with many
 * small tests do not consume CAPTCHA per-account/per-IP rate limits.
 */

import { type APIRequestContext, test as base } from "@playwright/test";

import { getCachedAdminStorageState } from "./auth";

export { expect } from "@playwright/test";

interface AdminFixtures {
  /** An authenticated admin APIRequestContext, ready to use in each test. */
  adminRequest: APIRequestContext;
}

export const test = base.extend<AdminFixtures>({
  adminRequest: async ({ playwright }, use) => {
    const ctx = await playwright.request.newContext({
      storageState: await getCachedAdminStorageState(playwright.request),
    });
    await use(ctx);
    await ctx.dispose();
  },
});
