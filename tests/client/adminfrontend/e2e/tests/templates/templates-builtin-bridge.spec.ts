/**
 * E2E: Template Registry Builtin Bridge (P125-TPL-A-09).
 *
 * Verifies the admin-frontend extension for code-built ("Builtin") templates
 * end-to-end against a live stack:
 *
 *  1. Source filter chip "Built-in" narrows the catalog to builtin templates
 *     (server seeds at least one — currently 11 — via the migration / builder).
 *  2. Detail drawer for a builtin entry shows the read-only banner
 *     (`role="status"`) and the "Bump Builder Version" action.
 *  3. Default Policies tab persists toggle state via
 *     `setTemplateDefaultPolicy` — verified by reloading and observing the
 *     switch keep its new state.  The test restores the original state on
 *     teardown so the dev DB stays clean.
 *
 * Selectors are locale-independent (data-testid + role + UUID) so the test
 * is stable regardless of which language the admin-frontend is rendering in.
 *
 * Prerequisites:
 *   - Stack running: build/scripts/server/stack-up.sh
 *   - Admin user exists (ensured in beforeAll via /api/setup/create-admin-user)
 *
 * Authentication: mirrors the already authenticated request context into the
 * browser, matching templates-navigation without an extra sign-in call.
 */

import type { APIRequestContext, BrowserContext, Page } from "@playwright/test";

import {
  ADMIN_FRONTEND_BASE,
  API_BASE,
  type ApiUser,
  createTestUser,
  deleteTestUser,
  ensureAdminUser,
  gqlRequest,
  injectRequestSessionCookies,
} from "../../fixtures/auth";
import { expect, test } from "../../fixtures/index";

const TEMPLATES_URL = `${ADMIN_FRONTEND_BASE}/templates`;

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

async function signInAsAdmin(
  context: BrowserContext,
  request: APIRequestContext,
): Promise<void> {
  await ensureAdminUser(request);
  await injectRequestSessionCookies(context, request);
}

interface BuiltinPolicy {
  templateId: string;
  applyToNewWorkspaces: boolean;
  selectionMode: string;
  provisioningMode: string;
}

/** Reads the raw default-policy rows so the test can pick a real templateId
 *  to mutate and later restore. */
async function fetchDefaultPolicies(
  request: APIRequestContext,
): Promise<BuiltinPolicy[]> {
  const data = await gqlRequest<{
    admin: { templateDefaultPolicies: BuiltinPolicy[] };
  }>(
    request,
    `query AdminTemplateDefaultPolicies {
       admin {
         templateDefaultPolicies {
           templateId
           applyToNewWorkspaces
           selectionMode
           provisioningMode
         }
       }
     }`,
  );
  return data.admin.templateDefaultPolicies ?? [];
}

/** Restores a previously-modified default policy.  Wrapped in try/catch so
 *  cleanup never fails the test. */
async function restoreDefaultPolicy(
  request: APIRequestContext,
  policy: BuiltinPolicy,
): Promise<void> {
  try {
    await gqlRequest(
      request,
      `mutation RestorePolicy($templateId: String!, $applyToNewWorkspaces: Boolean!, $selectionMode: SelectionModeType!, $provisioningMode: ProvisioningModeType!) {
         admin {
           setTemplateDefaultPolicy(input: {
             templateId: $templateId,
             applyToNewWorkspaces: $applyToNewWorkspaces,
             selectionMode: $selectionMode,
             provisioningMode: $provisioningMode,
           })
         }
       }`,
      {
        templateId: policy.templateId,
        applyToNewWorkspaces: policy.applyToNewWorkspaces,
        selectionMode: policy.selectionMode,
        provisioningMode: policy.provisioningMode,
      },
    );
  } catch {
    // afterAll cleanup must never fail the test.
  }
}

async function gotoTemplatesPage(page: Page): Promise<void> {
  await page.goto(TEMPLATES_URL, { waitUntil: "networkidle", timeout: 20_000 });
  // Wait for the tab list to render before any further interaction.
  await expect(page.locator('[role="tablist"]')).toBeVisible({
    timeout: 10_000,
  });
}

// ---------------------------------------------------------------------------
// INV-TPL-E2E-BB-01: Source filter "Built-in" lists only builtin entries
// ---------------------------------------------------------------------------

test.describe("INV-TPL-E2E-BB-01: Built-in source filter", () => {
  test('selecting "Built-in" filter narrows the catalog to builtin entries', async ({
    page,
    context,
    request,
  }) => {
    await signInAsAdmin(context, request);
    await gotoTemplatesPage(page);

    // Catalog tab is the default — wait for the table to render.
    await expect(page.locator("tbody tr").first()).toBeVisible({
      timeout: 10_000,
    });

    // Total row count before filtering.
    const allRowsBefore = await page.locator("tbody tr").count();

    // Click the "Built-in" filter button.
    const builtinFilter = page.getByTestId("templates-source-filter-builtin");
    await expect(builtinFilter).toBeVisible({ timeout: 5_000 });
    await builtinFilter.click();

    // After clicking, the button is pressed.
    await expect(builtinFilter).toHaveAttribute("aria-pressed", "true");

    // Filtered rows: at least one builtin must exist.  Exact count is left
    // open so the test stays valid as the builder evolves.
    const filteredCount = await page.locator("tbody tr").count();
    expect(filteredCount).toBeGreaterThan(0);
    expect(filteredCount).toBeLessThanOrEqual(allRowsBefore);
  });
});

// ---------------------------------------------------------------------------
// INV-TPL-E2E-BB-02: Builtin detail drawer is read-only
// ---------------------------------------------------------------------------

test.describe("INV-TPL-E2E-BB-02: Builtin detail drawer read-only", () => {
  test("opening details on a builtin entry shows banner + bump button", async ({
    page,
    context,
    request,
  }) => {
    await signInAsAdmin(context, request);
    await gotoTemplatesPage(page);
    await expect(page.locator("tbody tr").first()).toBeVisible({
      timeout: 10_000,
    });

    // Filter to builtins so the first row is guaranteed to be a builtin.
    await page.getByTestId("templates-source-filter-builtin").click();
    await expect(page.locator("tbody tr").first()).toBeVisible({
      timeout: 5_000,
    });

    // Open the row action menu on the first builtin row, then click Details.
    const firstRow = page.locator("tbody tr").first();
    await firstRow.getByTestId("templates-row-menu-trigger").click();
    await page.getByTestId("templates-row-menu-details").click();

    // Drawer renders the read-only banner (role=status) and bump button.
    await expect(page.getByRole("status")).toBeVisible({ timeout: 5_000 });
    await expect(
      page.getByTestId("templates-bump-builder-version"),
    ).toBeVisible({ timeout: 5_000 });

    // Read-only fields use aria-readonly="true" — at least one must exist.
    const readOnlyBoxes = page.locator('[aria-readonly="true"]');
    expect(await readOnlyBoxes.count()).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Shared helper for BB-04/05/06: sign in as a regular user and return
// their first workspace ID. Missing sign-in/workspace state is a hard E2E
// failure because these specs validate seeded template contracts end-to-end.
// ---------------------------------------------------------------------------

async function signInAsUserAndGetWorkspace(
  request: APIRequestContext,
  email: string,
  password: string,
): Promise<string> {
  const signInRes = await request.post(`${API_BASE}/api/auth/sign-in`, {
    data: { email, password },
    headers: { "Content-Type": "application/json" },
  });
  expect(signInRes.ok(), `sign-in failed for test user ${email}`).toBe(true);

  const wsData = await gqlRequest<{ workspaces: Array<{ id: string }> }>(
    request,
    `query { workspaces { id } }`,
  );

  const workspaceId = wsData.workspaces[0]?.id;
  expect(workspaceId, `test user ${email} must have a workspace`).toEqual(
    expect.any(String),
  );
  return workspaceId;
}

// ---------------------------------------------------------------------------
// INV-TPL-E2E-BB-03: Default-policy toggle persists across reload
// ---------------------------------------------------------------------------

test.describe("INV-TPL-E2E-BB-03: Default-policy toggle round-trip", () => {
  test("toggling applyToNewWorkspaces persists and survives a reload", async ({
    page,
    context,
    request,
    adminRequest,
  }) => {
    await signInAsAdmin(context, request);

    // Pre-fetch real policies via authenticated GQL so we can target a known
    // row.  We capture the original state so we can restore on teardown.
    const policies = await fetchDefaultPolicies(adminRequest);
    expect(policies.length).toBeGreaterThan(0);

    const target = policies[0];
    const originalState = target.applyToNewWorkspaces;

    try {
      await gotoTemplatesPage(page);

      // Switch to Default Policies tab via locale-independent test-id.
      await page.getByTestId("templates-tab-default-policies").click();

      // Locate the row containing the target template UUID and its switch.
      const targetRow = page.locator("tbody tr", {
        hasText: target.templateId,
      });
      await expect(targetRow).toBeVisible({ timeout: 8_000 });

      const switchEl = targetRow.getByRole("switch");
      await expect(switchEl).toHaveAttribute(
        "aria-checked",
        originalState ? "true" : "false",
      );

      // Click the switch — opens the confirm dialog (it does NOT mutate yet).
      await switchEl.click();
      const confirmBtn = page.getByTestId("confirm-dialog-confirm");
      await expect(confirmBtn).toBeVisible({ timeout: 5_000 });

      // Confirm → fires setTemplateDefaultPolicy mutation.
      await confirmBtn.click();

      // Wait for the dialog to close.
      await expect(confirmBtn).toBeHidden({ timeout: 5_000 });

      // Switch should reflect the new (inverted) state.
      const newExpected = !originalState;
      await expect(switchEl).toHaveAttribute(
        "aria-checked",
        newExpected ? "true" : "false",
        { timeout: 8_000 },
      );

      // Reload the page and verify the new state persists.
      await page.reload({ waitUntil: "networkidle" });
      await page.getByTestId("templates-tab-default-policies").click();
      const reloadedRow = page.locator("tbody tr", {
        hasText: target.templateId,
      });
      await expect(reloadedRow).toBeVisible({ timeout: 8_000 });
      const reloadedSwitch = reloadedRow.getByRole("switch");
      await expect(reloadedSwitch).toHaveAttribute(
        "aria-checked",
        newExpected ? "true" : "false",
        { timeout: 5_000 },
      );

      // Cross-check: query the server directly — DB row should match.
      const after = await fetchDefaultPolicies(adminRequest);
      const updated = after.find((p) => p.templateId === target.templateId);
      expect(updated?.applyToNewWorkspaces).toBe(newExpected);
    } finally {
      // Restore the original policy state so the dev DB is unchanged.
      await restoreDefaultPolicy(adminRequest, target);
    }
  });
});

// ---------------------------------------------------------------------------
// INV-TPL-E2E-BB-04: Disabled default policy → new workspace reconcile omits
//   that slug.  Client consequence: sidebar never shows the template doc for
//   the new workspace because the reconciler receives an empty slot for it.
// ---------------------------------------------------------------------------

test.describe("INV-TPL-E2E-BB-04: Disabled default policy excluded from new-workspace reconcile", () => {
  test("slug for disabled default policy is absent from reconcile list for a new workspace", async ({
    request,
    adminRequest,
  }) => {
    await ensureAdminUser(adminRequest);

    // Find an active builtin template via the admin catalog.
    const catalogData = await gqlRequest<{
      admin: {
        templateCatalog: Array<{ id: string; slug: string; source: string }>;
      };
    }>(
      adminRequest,
      `query {
         admin {
           templateCatalog(status: Active) {
             id
             slug
             source
           }
         }
       }`,
    );

    const builtinEntry = catalogData?.admin?.templateCatalog?.find(
      (e) => e.source === "Builtin",
    );
    if (!builtinEntry) {
      throw new Error("server must seed at least one builtin template");
    }

    // Find the default policy for this template so we can restore it.
    const policies = await fetchDefaultPolicies(adminRequest);
    const originalPolicy = policies.find(
      (p) => p.templateId === builtinEntry.id,
    );
    if (!originalPolicy) {
      throw new Error("builtin template must have a default policy");
    }

    let user: ApiUser | null = null;

    try {
      // Disable the template's default policy.
      await gqlRequest(
        adminRequest,
        `mutation DisablePolicy($templateId: String!, $sel: SelectionModeType!, $prov: ProvisioningModeType!) {
           admin {
             setTemplateDefaultPolicy(input: {
               templateId: $templateId,
               applyToNewWorkspaces: false,
               selectionMode: $sel,
               provisioningMode: $prov,
             })
           }
         }`,
        {
          templateId: builtinEntry.id,
          sel: originalPolicy.selectionMode,
          prov: originalPolicy.provisioningMode,
        },
      );

      // Create a new user — workspace is initialised without the disabled template.
      user = await createTestUser(adminRequest);

      const workspaceId = await signInAsUserAndGetWorkspace(
        request,
        user.email,
        user.password,
      );

      // Reconcile list for the new workspace must NOT contain the disabled slug.
      const reconcileData = await gqlRequest<{
        workspaceTemplateReconcileSlugs: Array<{ slug: string }>;
      }>(
        request,
        `mutation ReconcileSlugs($wid: String!, $locale: String!) {
           workspaceTemplateReconcileSlugs(workspaceId: $wid, locale: $locale) {
             slug
           }
         }`,
        { wid: workspaceId, locale: "en" },
      );

      const slugs = reconcileData.workspaceTemplateReconcileSlugs.map(
        (e) => e.slug,
      );
      expect(slugs).not.toContain(builtinEntry.slug);
    } finally {
      if (originalPolicy) {
        await restoreDefaultPolicy(adminRequest, originalPolicy);
      }
      if (user) {
        await deleteTestUser(adminRequest, user.id);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// INV-TPL-E2E-BB-05: reportTemplateBuilderApplied correctly sets hasInstance.
//   Client consequence: the Documents-View shows only docs that have been
//   applied (hasInstance=true) — server tracks which workspace docs exist so
//   the client knows whether to skip creation or render the existing doc.
// ---------------------------------------------------------------------------

test.describe("INV-TPL-E2E-BB-05: reportBuilderApplied sets hasInstance in reconcile response", () => {
  test("slug has hasInstance=false before apply and hasInstance=true after reportBuilderApplied", async ({
    request,
    adminRequest,
  }) => {
    await ensureAdminUser(adminRequest);

    let user: ApiUser | null = null;
    try {
      user = await createTestUser(adminRequest);

      const workspaceId = await signInAsUserAndGetWorkspace(
        request,
        user.email,
        user.password,
      );

      // Fresh workspace: all instances start as hasInstance=false.
      const beforeData = await gqlRequest<{
        workspaceTemplateReconcileSlugs: Array<{
          slug: string;
          hasInstance: boolean;
        }>;
      }>(
        request,
        `mutation ReconcileSlugs($wid: String!, $locale: String!) {
           workspaceTemplateReconcileSlugs(workspaceId: $wid, locale: $locale) {
             slug
             hasInstance
           }
         }`,
        { wid: workspaceId, locale: "en" },
      );

      expect(beforeData.workspaceTemplateReconcileSlugs.length).toBeGreaterThan(
        0,
      );

      const entries = beforeData.workspaceTemplateReconcileSlugs;
      // All entries start without an applied instance.
      for (const entry of entries) {
        expect(entry.hasInstance).toBe(false);
      }

      const target = entries[0];

      // Simulate the client applying the first template.
      await gqlRequest(
        request,
        `mutation ReportApplied($input: ReportBuilderAppliedInput!) {
           reportTemplateBuilderApplied(input: $input)
         }`,
        {
          input: {
            workspaceId,
            slug: target.slug,
            appliedHash: "e2e-test-hash",
            locale: "en",
            docId: null,
          },
        },
      );

      // After applying, hasInstance must be true for the target slug.
      const afterData = await gqlRequest<{
        workspaceTemplateReconcileSlugs: Array<{
          slug: string;
          hasInstance: boolean;
        }>;
      }>(
        request,
        `mutation ReconcileSlugs($wid: String!, $locale: String!) {
           workspaceTemplateReconcileSlugs(workspaceId: $wid, locale: $locale) {
             slug
             hasInstance
           }
         }`,
        { wid: workspaceId, locale: "en" },
      );

      const updated = afterData.workspaceTemplateReconcileSlugs.find(
        (e) => e.slug === target.slug,
      );
      expect(updated?.hasInstance).toBe(true);

      // Other slugs remain unapplied.
      const others = afterData.workspaceTemplateReconcileSlugs.filter(
        (e) => e.slug !== target.slug,
      );
      for (const entry of others) {
        expect(entry.hasInstance).toBe(false);
      }
    } finally {
      if (user) {
        await deleteTestUser(adminRequest, user.id);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// INV-TPL-E2E-BB-06: reportTemplateBuilderTrashed retires instance so
//   reconcile still returns the slug (policy active) but hasInstance=false.
//   Client consequence: reconciler detects hasInstance=false, checks
//   userTrashedBuiltinSlugs, and skips re-creation — template does not
//   return after hard reload.
// ---------------------------------------------------------------------------

test.describe("INV-TPL-E2E-BB-06: Trashed instance sets hasInstance=false, slug stays in reconcile list", () => {
  test("after reportBuilderTrashed the slug remains in reconcile list but hasInstance flips to false", async ({
    request,
    adminRequest,
  }) => {
    await ensureAdminUser(adminRequest);

    let user: ApiUser | null = null;

    try {
      user = await createTestUser(adminRequest);

      const workspaceId = await signInAsUserAndGetWorkspace(
        request,
        user.email,
        user.password,
      );

      // Fetch reconcile list and find an active slug.
      const initialData = await gqlRequest<{
        workspaceTemplateReconcileSlugs: Array<{ slug: string }>;
      }>(
        request,
        `mutation ReconcileSlugs($wid: String!, $locale: String!) {
           workspaceTemplateReconcileSlugs(workspaceId: $wid, locale: $locale) {
             slug
           }
         }`,
        { wid: workspaceId, locale: "en" },
      );

      expect(
        initialData.workspaceTemplateReconcileSlugs.length,
      ).toBeGreaterThan(0);

      const targetSlug = initialData.workspaceTemplateReconcileSlugs[0].slug;

      // Simulate client applying then trashing the template.
      await gqlRequest(
        request,
        `mutation ReportApplied($input: ReportBuilderAppliedInput!) {
           reportTemplateBuilderApplied(input: $input)
         }`,
        {
          input: {
            workspaceId,
            slug: targetSlug,
            appliedHash: "e2e-trash-test-hash",
            locale: "en",
            docId: null,
          },
        },
      );

      await gqlRequest(
        request,
        `mutation ReportTrashed($wid: String!, $slug: String!) {
           reportTemplateBuilderTrashed(workspaceId: $wid, slug: $slug)
         }`,
        { wid: workspaceId, slug: targetSlug },
      );

      // After trashing: slug still present (policy active), but hasInstance=false.
      const afterData = await gqlRequest<{
        workspaceTemplateReconcileSlugs: Array<{
          slug: string;
          hasInstance: boolean;
        }>;
      }>(
        request,
        `mutation ReconcileSlugs($wid: String!, $locale: String!) {
           workspaceTemplateReconcileSlugs(workspaceId: $wid, locale: $locale) {
             slug
             hasInstance
           }
         }`,
        { wid: workspaceId, locale: "en" },
      );

      const slugsAfter = afterData.workspaceTemplateReconcileSlugs.map(
        (e) => e.slug,
      );
      // Slug still appears — policy is still active.
      expect(slugsAfter).toContain(targetSlug);

      // But hasInstance is false — client will check userTrashedBuiltinSlugs
      // and skip re-creation (Case 1 of the reconcile algorithm).
      const trashedEntry = afterData.workspaceTemplateReconcileSlugs.find(
        (e) => e.slug === targetSlug,
      );
      expect(trashedEntry?.hasInstance).toBe(false);
    } finally {
      if (user) {
        await deleteTestUser(adminRequest, user.id);
      }
    }
  });
});
