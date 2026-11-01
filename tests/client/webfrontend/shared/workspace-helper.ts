// SPDX-License-Identifier: AGPL-3.0-or-later

import { type APIRequestContext, expect, type Page } from "@playwright/test";

export type SmokeWorkspace = {
  id: string;
  initialized?: boolean;
  name?: string | null;
  workspaceType?: "Personal" | "UserOwned" | "Shared";
};

function cookieHeader(cookies: string[]): string {
  return cookies.map((cookie) => cookie.split(";")[0]).join("; ");
}

export async function smokeGql<T>(
  request: APIRequestContext,
  gqlEndpoint: string,
  cookies: string[],
  query: string,
  variables: Record<string, unknown> = {},
): Promise<T> {
  const res = await request.post(gqlEndpoint, {
    data: { query, variables },
    headers: {
      "Content-Type": "application/json",
      Cookie: cookieHeader(cookies),
    },
    timeout: 15_000,
  });
  if (!res.ok()) throw new Error(`GQL request failed: HTTP ${res.status()}`);
  const body = (await res.json()) as { data?: T; errors?: unknown[] };
  if (body.errors?.length) {
    throw new Error(`GQL errors: ${JSON.stringify(body.errors)}`);
  }
  if (!body.data) throw new Error("GQL response did not contain data");
  return body.data;
}

export async function getSmokeWorkspaceId(
  request: APIRequestContext,
  gqlEndpoint: string,
  cookies: string[],
): Promise<string> {
  const data = await smokeGql<{ workspaces: SmokeWorkspace[] }>(
    request,
    gqlEndpoint,
    cookies,
    `query WebSmokeWorkspaces { workspaces { id initialized workspaceType name } }`,
  );
  const preferredName = process.env.E2E_WORKSPACE_NAME ?? "Admin";
  // Browser Web smoke, editor-flow and visual-evidence suites create and delete
  // disposable documents. The default seed's Alpha/Beta spaces may be shared
  // through organization units, so use the writable admin-owned workspace
  // unless a test explicitly opts into another workspace through
  // E2E_WORKSPACE_NAME.
  const workspace =
    data.workspaces.find(
      (candidate) =>
        candidate.initialized &&
        candidate.name?.toLowerCase() === preferredName.toLowerCase(),
    ) ??
    data.workspaces.find(
      (candidate) =>
        candidate.initialized && candidate.workspaceType === "Shared",
    ) ??
    data.workspaces.find((candidate) => candidate.initialized) ??
    data.workspaces[0];
  if (!workspace) throw new Error("No workspace found for test user");
  if (!workspace.initialized) {
    throw new Error(
      `Workspace ${workspace.id} is not initialized; Browser Web Playwright suites need an initialized cloud workspace`,
    );
  }
  return workspace.id;
}

/** Settle workspace metadata and document content before disposing their worker. */
export async function waitForWorkspaceDocSync(
  page: Page,
  docId: string,
): Promise<void> {
  await page.evaluate(async (docId) => {
    const workspace = (
      window as Window & {
        currentWorkspace?: {
          id: string;
          engine: {
            doc: {
              waitForSynced(id: string, signal: AbortSignal): Promise<void>;
            };
          };
        };
      }
    ).currentWorkspace;
    if (!workspace)
      throw new Error("No active workspace for write acknowledgement");
    const signal = AbortSignal.timeout(30_000);
    await workspace.engine.doc.waitForSynced(workspace.id, signal);
    await workspace.engine.doc.waitForSynced(docId, signal);
  }, docId);
}

export async function waitForWorkspaceReady(
  page: Page,
  options: { allDocs?: boolean; timeout?: number } = {},
): Promise<void> {
  const timeout = options.timeout ?? 20_000;
  const fallback = page.locator(
    '[data-myoxus-ui-role="app-sidebar-fallback-body"][aria-busy="true"]',
  );

  try {
    await expect(fallback).toBeHidden({ timeout });
    await expect(page.getByTestId("main-container")).toBeVisible({ timeout });
    if (options.allDocs) {
      await expect(page.getByTestId("all-docs-body")).toBeVisible({ timeout });
    }
    await expect(page.getByTestId("sidebar-new-page-button")).toBeVisible({
      timeout,
    });
  } catch (error) {
    const diagnostics = await page
      .evaluate(() => {
        const describe = (selector: string) => {
          const element = document.querySelector(selector);
          if (!(element instanceof HTMLElement)) return "missing";
          const rect = element.getBoundingClientRect();
          const style = getComputedStyle(element);
          return `${Math.round(rect.width)}x${Math.round(rect.height)} display=${style.display} visibility=${style.visibility} ariaBusy=${element.getAttribute("aria-busy") ?? "none"}`;
        };
        return {
          url: location.href,
          fallback: describe(
            '[data-myoxus-ui-role="app-sidebar-fallback-body"]',
          ),
          main: describe('[data-testid="main-container"]'),
          allDocs: describe('[data-testid="all-docs-body"]'),
          create: describe('[data-testid="sidebar-new-page-button"]'),
          recentScripts: performance
            .getEntriesByType("resource")
            .map((entry) => entry.name)
            .filter((name) => /\.(?:js|mjs)(?:\?|$)/.test(name))
            .slice(-8),
        };
      })
      .catch((diagnosticError: unknown) => ({
        diagnosticError: String(diagnosticError),
        url: page.url(),
      }));
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Workspace did not reach its interactive shell within ${timeout}ms: ${message}; diagnostics=${JSON.stringify(diagnostics)}`,
    );
  }
}
