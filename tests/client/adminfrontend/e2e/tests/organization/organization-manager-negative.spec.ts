/**
 * E2E ORG-I-09 — Manager-negative: an unauthenticated request to the
 * caller-scoped Organization queries returns null/empty (or
 * AuthenticationRequired). Admin endpoints reject non-admin sessions.
 *
 * We verify the negative path via the API to keep the test stable —
 * the visible UI behaviour follows from the same gate.
 */

import { API_BASE, ensureAdminUserExists } from "../../fixtures/auth";
import { expect, test } from "../../fixtures/index";

test.describe("ORG-I-09 — Manager-negative cases", () => {
  test.beforeAll(async ({ request }) => {
    await ensureAdminUserExists(request);
  });

  test("unauthenticated GET on admin.organization is rejected", async ({
    request,
  }) => {
    const resp = await request.post(`${API_BASE}/graphql`, {
      data: { query: "{ admin { organization { id } } }" },
      headers: { "content-type": "application/json" },
    });
    const body = await resp.json();
    // Either an explicit errors array or a null payload — both are
    // acceptable as long as the organization payload is NOT delivered.
    const errors = body.errors as { message: string }[] | undefined;
    const orgPayload = body?.data?.admin?.organization;
    expect(
      orgPayload == null,
      `unauthenticated request must not return organization data, got: ${JSON.stringify(body)}`,
    ).toBeTruthy();
    if (errors) {
      expect(errors.length).toBeGreaterThan(0);
    }
  });

  test("unauthenticated GET on myOrganizationUnits is rejected", async ({
    request,
  }) => {
    const resp = await request.post(`${API_BASE}/graphql`, {
      data: { query: "{ myOrganizationUnits { id } }" },
      headers: { "content-type": "application/json" },
    });
    const body = await resp.json();
    const list = body?.data?.myOrganizationUnits;
    // Either null (auth-error rejected) or an empty array — never a
    // populated list of arbitrary OUs.
    if (Array.isArray(list)) {
      expect(list.length).toBe(0);
    } else {
      expect(
        list == null,
        `unauthenticated request must not return OU data, got: ${JSON.stringify(body)}`,
      ).toBeTruthy();
    }
  });
});
