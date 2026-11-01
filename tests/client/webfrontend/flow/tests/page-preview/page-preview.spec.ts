// SPDX-License-Identifier: AGPL-3.0-or-later

import { createHash } from "node:crypto";

import { expect, test, type Locator } from "@playwright/test";

import { injectSessionCookies } from "../../../../adminfrontend/e2e/fixtures/auth";
import {
  DEFAULT_SMOKE_USER_EMAIL,
  DEFAULT_SMOKE_USER_PASSWORD,
  signInViaApi,
} from "../../../shared/auth-helper";
import {
  getAccountLocale,
  setAccountLocale,
} from "../../../shared/user-preferences-helper";
import {
  getSmokeWorkspaceId,
  smokeGql,
  waitForWorkspaceReady,
} from "../../../shared/workspace-helper";

const frontend =
  process.env.MYOXUS_FRONTEND_BASE_URL ?? "http://localhost:3010";
const api = process.env.MYOXUS_API_BASE_URL ?? "http://localhost:3001";
const graphql = `${frontend}/graphql`;
let cookies: string[];
let workspaceId: string;
let docId: string | undefined;
let originalLocale: string | null | undefined;

async function displayedSvg(card: Locator) {
  await expect(card.locator("[data-page-preview]")).toHaveAttribute(
    "data-page-preview",
    "ready",
  );
  return card
    .locator("img[data-myoxus-ui-role=media-preview-image]")
    .evaluate(async (image: HTMLImageElement) => {
      await image.decode();
      if (!image.src.startsWith("blob:"))
        throw new Error("Expected private image blob");
      return (await fetch(image.src)).text();
    });
}

test.beforeAll(async ({ request }) => {
  cookies = await signInViaApi(
    request,
    api,
    DEFAULT_SMOKE_USER_EMAIL,
    DEFAULT_SMOKE_USER_PASSWORD,
  );
  workspaceId = await getSmokeWorkspaceId(request, graphql, cookies);
  const preferenceTarget = { request, gqlEndpoint: graphql, cookies };
  originalLocale = await getAccountLocale(preferenceTarget);
  await setAccountLocale(preferenceTarget, "en");
});

test.afterAll(async ({ request }) => {
  if (originalLocale !== undefined) {
    await setAccountLocale(
      { request, gqlEndpoint: graphql, cookies },
      originalLocale,
    );
  }
});

test("Page cards consume fresh private SVGs without preview writes", async ({
  page,
  context,
}, testInfo) => {
  test.setTimeout(120_000);
  await injectSessionCookies(context, cookies);
  await page.emulateMedia({ colorScheme: "light" });
  const listing = `${frontend}/workspace/${workspaceId}/all`;
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const hash = (svg: string) => createHash("sha256").update(svg).digest("hex");
  await page.goto(listing);
  await waitForWorkspaceReady(page, { allDocs: true });
  await page.getByTestId("sidebar-new-page-button").click();
  const title = `Preview journey ${Date.now()}`;
  await page.locator("doc-title .inline-editor").first().fill(title);
  docId = new URL(page.url()).pathname.split("/").at(-1)!;
  const body = page
    .locator("myoxus-paragraph .inline-editor[contenteditable=true]")
    .first();
  await body.click();
  await page.keyboard.insertText(
    "Amber river: the first persisted preview sentence.",
  );
  await page.getByTestId("all-docs-sidebar-filter-all").click();
  await page
    .getByRole("radio", { name: "Grid", exact: true })
    .locator("..")
    .click();
  const card = page.locator(`a[href$="/${docId}"]`);
  await expect(card).toContainText(title);
  const before = await displayedSvg(card);
  expect(before).toContain("<svg");
  expect(before).not.toMatch(/<text\b|<foreignObject\b/);

  await card.click();
  await body.click();
  await page.keyboard.press("ControlOrMeta+a");
  await page.keyboard.insertText(
    "Cobalt meadow: replacement content must change the visible image.",
  );
  await page.getByTestId("all-docs-sidebar-filter-all").click();
  await expect
    .poll(async () => hash(await displayedSvg(card)))
    .not.toBe(hash(before));
  const edited = await displayedSvg(card);
  const previewUrl = `/api/workspaces/${workspaceId}/docs/${docId}/preview`;
  const read = () =>
    page.evaluate(async (url) => {
      const response = await fetch(`${url}?colorScheme=light`);
      if (!response.ok) throw new Error(`Preview HTTP ${response.status}`);
      return {
        revision: response.headers.get("x-doc-revision"),
        svg: await response.text(),
      };
    }, previewUrl);
  const stable = await read();
  expect(stable.svg).toBe(edited);
  expect(stable.revision).not.toBeNull();
  await page.reload();
  expect(await displayedSvg(card)).toBe(edited);
  expect((await read()).revision).toBe(stable.revision);

  // Observe native networking before any routing: Playwright interception
  // disables the browser HTTP cache and cannot prove body reuse after a 304.
  const cdp = await context.newCDPSession(page);
  await cdp.send("Network.enable");
  const network = new Map<
    string,
    { status?: number; encodedBodyBytes: number }
  >();
  cdp.on("Network.requestWillBeSent", ({ requestId, request }) => {
    if (request.url.includes(`${previewUrl}?colorScheme=light`))
      network.set(requestId, { encodedBodyBytes: 0 });
  });
  cdp.on("Network.responseReceivedExtraInfo", ({ requestId, statusCode }) => {
    const entry = network.get(requestId);
    if (entry) entry.status = statusCode;
  });
  cdp.on("Network.dataReceived", ({ requestId, encodedDataLength }) => {
    const entry = network.get(requestId);
    if (entry) entry.encodedBodyBytes += encodedDataLength;
  });
  await displayedSvg(card);
  const mountedCard = await card.elementHandle();
  if (!mountedCard) throw new Error("Expected mounted preview card");
  const scrollOwner = await card.evaluateHandle((element) => {
    let parent = element.parentElement;
    while (
      parent &&
      (!/(auto|scroll)/.test(getComputedStyle(parent).overflowY) ||
        parent.scrollHeight <= parent.clientHeight)
    )
      parent = parent.parentElement;
    if (!parent) throw new Error("Missing product scroll owner");
    return parent;
  });
  const scroll = await scrollOwner.evaluate(
    (parent, cardBottom) => {
      const viewport = parent.getBoundingClientRect();
      return {
        top: viewport.top,
        delta: cardBottom - viewport.top + 20,
        available: parent.scrollHeight - parent.clientHeight - parent.scrollTop,
      };
    },
    await card.evaluate((element) => element.getBoundingClientRect().bottom),
  );
  expect(scroll.available).toBeGreaterThan(scroll.delta);
  network.clear();
  const mountedSrc = await card
    .locator("img[data-myoxus-ui-role=media-preview-image]")
    .getAttribute("src");
  await scrollOwner.evaluate(
    (parent, delta) => parent.scrollBy(0, delta),
    scroll.delta,
  );
  await expect
    .poll(async () =>
      mountedCard.evaluate((element) => element.getBoundingClientRect().bottom),
    )
    .toBeLessThan(scroll.top);
  expect(await mountedCard.evaluate((element) => element.isConnected)).toBe(
    true,
  );
  await scrollOwner.evaluate(
    (parent, delta) => parent.scrollBy(0, -delta),
    scroll.delta,
  );
  await expect(card).toBeInViewport();
  expect(
    await card
      .locator("img[data-myoxus-ui-role=media-preview-image]")
      .getAttribute("src"),
  ).toBe(mountedSrc);
  expect(
    network.size,
    "mounted ready cards must not refetch on visibility changes",
  ).toBe(0);
  await scrollOwner.dispose();

  // Switching list/grid destroys the card and proves real remount revalidation.
  await page
    .getByRole("radio", { name: "List", exact: true })
    .locator("..")
    .click();
  await expect
    .poll(() => mountedCard.evaluate((element) => element.isConnected))
    .toBe(false);
  await page
    .getByRole("radio", { name: "Grid", exact: true })
    .locator("..")
    .click();
  expect(await displayedSvg(card)).toBe(edited);
  await expect
    .poll(
      () =>
        [...network.values()].filter((entry) => entry.status === 304).length,
    )
    .toBeGreaterThan(0);
  expect(
    [...network.values()].every(
      (entry) => entry.status === 304 && entry.encodedBodyBytes === 0,
    ),
  ).toBe(true);
  await testInfo.attach("preview-http-revalidation", {
    body: JSON.stringify([...network.values()], null, 2),
    contentType: "application/json",
  });
  await cdp.detach();

  // Only inject a failure, never a substitute image. Recovery consumes the
  // real authenticated server response and must not navigate away.
  const pattern = `**/docs/${docId}/preview*`;
  await page.route(pattern, (route) =>
    route.fulfill({ status: 500, body: "Synthetic failure" }),
  );
  await card.click();
  await page.getByTestId("all-docs-sidebar-filter-all").click();
  await expect(
    card.getByRole("button", { name: "Retry", exact: true }),
  ).toBeVisible();
  await card.click();
  await expect(body).toHaveText(
    "Cobalt meadow: replacement content must change the visible image.",
  );
  await page.getByTestId("all-docs-sidebar-filter-all").click();
  await expect(
    card.getByRole("button", { name: "Retry", exact: true }),
  ).toBeVisible();
  await page.unroute(pattern);
  await card.getByRole("button", { name: "Retry", exact: true }).click();
  await displayedSvg(card);
  expect(page.url()).toBe(listing);
  await card.click();
  await expect(body).toHaveText(
    "Cobalt meadow: replacement content must change the visible image.",
  );
  expect(errors).toEqual([]);
});

test.afterEach(async ({ page, request }) => {
  const listing = `${frontend}/workspace/${workspaceId}/all`;
  if (docId) {
    await page.unrouteAll({ behavior: "wait" });
    await page.goto(listing);
    await page
      .getByRole("radio", { name: "List", exact: true })
      .locator("..")
      .click();
    const item = page.locator(
      `[data-testid="doc-list-item"][data-doc-id="${docId}"]`,
    );
    await item.hover();
    await item.getByTestId("doc-list-operation-button").click();
    await page.getByTestId("doc-list-operation-trash").click();
    await page.getByRole("dialog").getByTestId("confirm-modal-confirm").click();
    await expect(item).toHaveCount(0);
    const unavailable = await page.evaluate(
      async (url) => (await fetch(url)).status,
      `/api/workspaces/${workspaceId}/docs/${docId}/preview`,
    );
    expect([403, 404]).toContain(unavailable);
    const deleted = await smokeGql<{
      deleteDocumentPermanently: { deleted: number; failed: number };
    }>(
      request,
      graphql,
      cookies,
      `mutation CleanupPreview($input: DeleteDocumentPermanentlyInput!) {
          deleteDocumentPermanently(input: $input) { deleted failed }
        }`,
      { input: { workspaceId, docId } },
    );
    expect(deleted.deleteDocumentPermanently).toEqual({
      deleted: 1,
      failed: 0,
    });
  }
});
