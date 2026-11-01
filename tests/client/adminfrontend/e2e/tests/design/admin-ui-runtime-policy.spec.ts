// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Daniel Scharf and Myoxus contributors

import { expect, test } from "../../fixtures";
import {
  installAdminRuntimeErrorCollector,
  matchesAdminRuntimeFatal,
} from "../../fixtures/admin-ui-runtime-errors";

test.describe("Admin UI facade runtime policy", () => {
  test("fatal browser messages are classified as product findings", () => {
    for (const message of [
      "ReferenceError: blocks is not defined",
      "Hydration failed because the initial UI does not match",
      "React render error: invalid audit category",
      "index error, retry in 5s ReferenceError: blocks is not defined",
      "GraphQL response: invalid doc_id",
      "Unhandled promise rejection in admin bundle",
    ]) {
      expect(matchesAdminRuntimeFatal(message), message).toBe(true);
    }

    expect(
      matchesAdminRuntimeFatal("Expected 401 in explicit auth-negative test"),
    ).toBe(false);
  });

  test("collector turns injected fatal console errors into assertion failures", async ({
    page,
  }) => {
    const collector = installAdminRuntimeErrorCollector(page);

    await page.setContent(`
      <main data-testid="admin-route-runtime-policy">runtime policy</main>
      <script>console.error("ReferenceError: admin ui facade sentinel")</script>
    `);

    await expect.poll(() => collector.errors.length).toBe(1);
    expect(() => collector.assertNoFatal()).toThrow(/admin ui facade sentinel/);
  });

  test("collector ignores browser-cancelled selfhost font preloads", async ({
    page,
  }) => {
    const collector = installAdminRuntimeErrorCollector(page);

    await page.route("**/api/fonts/cancelled-test.woff2", (route) =>
      route.abort("aborted"),
    );
    await page.setContent(`
      <style>
        @font-face {
          font-family: "Cancelled Test";
          src: url("/api/fonts/cancelled-test.woff2") format("woff2");
        }
        body { font-family: "Cancelled Test", sans-serif; }
      </style>
      <main data-testid="admin-route-runtime-policy">runtime policy</main>
    `);
    await page.evaluate(() => document.fonts.ready.catch(() => undefined));

    collector.assertNoFatal();
  });
});
