// SPDX-License-Identifier: AGPL-3.0-or-later

import { ADMIN_FRONTEND_BASE } from "../../fixtures/auth";
import { expect, test } from "../../fixtures/index";

const REDIRECTS = [
  {
    from: "/accounts",
    to: "/adminfrontend/organization?tab=members",
  },
  {
    from: "/about",
    to: "/adminfrontend/system",
  },
  {
    from: "/orphaned-workspaces",
    to: "/adminfrontend/storage?tab=orphaned",
  },
  {
    from: "/logging",
    to: "/adminfrontend/system?tab=logging",
  },
] as const;

test.describe("admin route redirects", () => {
  for (const redirect of REDIRECTS) {
    test(`P-AR-DOD-04: ${redirect.from} returns 308 to ${redirect.to}`, async ({
      request,
    }) => {
      const response = await request.get(
        `${ADMIN_FRONTEND_BASE}${redirect.from}`,
        {
          maxRedirects: 0,
        },
      );

      const location = response.headers().location;
      expect(response.status()).toBe(308);
      expect(
        location?.startsWith("http")
          ? new URL(location).pathname + new URL(location).search
          : location,
      ).toBe(redirect.to);
    });
  }
});
