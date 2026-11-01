// SPDX-License-Identifier: AGPL-3.0-or-later

import { type BrowserContext, expect, type Page, test } from "@playwright/test";
import { io as createSocket } from "socket.io-client";

import {
  DEFAULT_SMOKE_USER_EMAIL,
  DEFAULT_SMOKE_USER_PASSWORD,
  signInViaApi,
  signOutViaApi,
} from "../../shared/auth-helper";
import {
  getSmokeWorkspaceId,
  waitForWorkspaceReady,
} from "../../shared/workspace-helper";

const FRONTEND = process.env.E2E_BASE_URL ?? "http://localhost:3010";
const API = process.env.E2E_API_BASE_URL ?? "http://localhost:3001";
const GQL = `${FRONTEND}/graphql`;

const FATAL_ERROR_PATTERNS = [
  /not found in container/i,
  /ComponentNotFoundError/i,
  /Uncaught Error/i,
  /Cannot read properties of undefined/i,
  /Cannot read properties of null/i,
  /ReferenceError/i,
  /index error, retry in 5s/i,
  /blocks is not defined/i,
  /VirgultumError/i,
  /block id is not found/i,
  /ChunkLoadError/i,
  /Loading chunk/i,
];

function collectFatalErrors(page: Page): () => string[] {
  const errors: string[] = [];
  page.on("console", (msg) => {
    if (msg.type() === "error") {
      const text = msg.text();
      if (FATAL_ERROR_PATTERNS.some((pattern) => pattern.test(text))) {
        errors.push(text);
      }
    }
  });
  page.on("pageerror", (err) => {
    errors.push(err.message);
  });
  return () => errors;
}

function cookieHeader(cookies: string[]): string {
  return cookies.map((cookie) => cookie.split(";")[0]).join("; ");
}

async function injectCookies(
  context: BrowserContext,
  rawCookies: string[],
): Promise<void> {
  for (const raw of rawCookies) {
    const nameVal = raw.split(";")[0];
    const [name, ...rest] = nameVal.split("=");
    await context.addCookies([
      {
        name: name.trim(),
        value: rest.join("=").trim(),
        url: FRONTEND,
        httpOnly: false,
        secure: false,
        sameSite: "Lax",
      },
    ]);
  }
}

async function cleanupRegressionDoc(
  workspaceId: string,
  cookies: string[],
  docId: string,
): Promise<void> {
  const socket = createSocket(API, {
    auth: {},
    extraHeaders: { Cookie: cookieHeader(cookies) },
    forceNew: true,
    reconnection: false,
    timeout: 10_000,
    transports: ["polling", "websocket"],
  });

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("Timed out connecting cleanup socket")),
      10_000,
    );
    socket.once("connect", () => {
      clearTimeout(timer);
      resolve();
    });
    socket.once("connect_error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });

  try {
    await new Promise<void>((resolve, reject) => {
      socket.emit(
        "space:join",
        {
          clientVersion: "0.30.0",
          spaceId: workspaceId,
          spaceType: "workspace",
        },
        (response: { error?: { message?: string } }) => {
          if (response?.error) {
            reject(
              new Error(
                response.error.message ?? "Could not join workspace cleanup",
              ),
            );
            return;
          }
          resolve();
        },
      );
    });

    socket.emit("space:delete-doc", {
      docId,
      spaceId: workspaceId,
      spaceType: "workspace",
    });
  } finally {
    socket.disconnect();
  }
}

async function createLongRegressionDoc(
  page: Page,
  workspaceId: string,
): Promise<{ docId: string; title: string }> {
  await page.goto(`${FRONTEND}/workspace/${workspaceId}/all`, {
    waitUntil: "load",
    timeout: 30_000,
  });
  await waitForWorkspaceReady(page, { allDocs: true });
  await page.getByTestId("sidebar-new-page-button").click();
  await expect(page).toHaveURL(/\/workspace\/[^/]+\/(?!all(?:$|\?))[^/?#]+/, {
    timeout: 20_000,
  });

  const docId = page.url().split("/").findLast(Boolean);
  if (!docId || docId === "all") {
    throw new Error(`Could not derive regression doc id from ${page.url()}`);
  }

  const title = `Smoke main chrome regression ${Date.now()}`;
  const titleContainer = page.locator("doc-title .doc-title-container").first();
  await expect(titleContainer).toBeVisible({ timeout: 20_000 });
  await titleContainer.click();

  const titleEditor = page.locator("doc-title .inline-editor").first();
  await expect(titleEditor).toBeVisible({ timeout: 20_000 });
  await titleEditor.fill(title);

  await page.locator("[data-myoxus-editor-container]").click({
    timeout: 20_000,
  });
  const headerTitle = page.locator(
    '[data-myoxus-ui-role="workbench-header-context-path"] h3',
  );
  expect(
    await headerTitle.textContent(),
    "Ending the inline rename must update the header without waiting for the durable sync debounce",
  ).toBe(title);
  await page.keyboard.insertText(
    Array.from(
      { length: 100 },
      (_, index) =>
        `Scroll probe line ${String(index + 1).padStart(
          2,
          "0",
        )} validates main document scrolling.`,
    ).join("\n"),
  );
  await page.waitForTimeout(750);

  return { docId, title };
}

async function documentContentColumnMetrics(page: Page) {
  return page.evaluate(() => {
    const rectFor = (selector: string) => {
      const element = document.querySelector<HTMLElement>(selector);
      if (!element) {
        throw new Error(`Missing document layout probe selector ${selector}`);
      }
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return {
        x: rect.x,
        y: rect.y,
        right: rect.right,
        bottom: rect.bottom,
        width: rect.width,
        height: rect.height,
        paddingLeft: Number.parseFloat(style.paddingLeft) || 0,
        lineHeight: Number.parseFloat(style.lineHeight) || rect.height,
      };
    };

    const metadataHeader = rectFor("[data-testid='document-metadata-header']");
    const iconButton = rectFor("[data-testid='doc-title-row'] button");
    const titleContainer = rectFor("doc-title .doc-title-container");
    const paragraph = rectFor("myoxus-paragraph");

    const metadataContentX = metadataHeader.x;
    const titleLineCenterY = titleContainer.y + titleContainer.lineHeight / 2;
    const iconOverlapsTitle =
      iconButton.y < titleContainer.bottom &&
      iconButton.bottom > titleContainer.y;
    return {
      metadataContentX,
      metadataHeaderX: metadataHeader.x,
      iconX: iconButton.x,
      iconRight: iconButton.right,
      titleX: titleContainer.x,
      paragraphX: paragraph.x,
      iconOverlapsTitle,
      iconTitleLineCenterDelta: Math.abs(
        iconButton.y + iconButton.height / 2 - titleLineCenterY,
      ),
      deltas: {
        metadataHeader: Math.abs(metadataHeader.x - metadataContentX),
        paragraph: Math.abs(paragraph.x - metadataContentX),
      },
    };
  });
}

async function scrollableCandidates(page: Page) {
  return page.evaluate(() =>
    Array.from(
      new Set([
        document.scrollingElement as HTMLElement,
        ...Array.from(document.querySelectorAll<HTMLElement>("*")),
      ]),
    )
      .filter(Boolean)
      .map((element, index) => {
        const style = getComputedStyle(element);
        return {
          index,
          className: String(element.className ?? "").slice(0, 120),
          role: element.dataset.myoxusUiRole,
          scrollTop: element.scrollTop,
          scrollHeight: element.scrollHeight,
          clientHeight: element.clientHeight,
          overflow: `${style.overflow}/${style.overflowY}`,
        };
      })
      .filter(
        (candidate) => candidate.scrollHeight > candidate.clientHeight + 80,
      )
      .sort(
        (left, right) =>
          right.scrollHeight -
          right.clientHeight -
          (left.scrollHeight - left.clientHeight),
      )
      .slice(0, 12),
  );
}

test.describe("Web main chrome regressions", () => {
  test("document title and page input align with metadata content column", async ({
    context,
    page,
    request,
  }, testInfo) => {
    const getErrors = collectFatalErrors(page);
    const cookies = await signInViaApi(
      request,
      API,
      DEFAULT_SMOKE_USER_EMAIL,
      DEFAULT_SMOKE_USER_PASSWORD,
    );
    await injectCookies(context, cookies);
    const workspaceId = await getSmokeWorkspaceId(request, GQL, cookies);

    let docId: string | undefined;
    try {
      const doc = await createLongRegressionDoc(page, workspaceId);
      docId = doc.docId;

      await expect(page.getByTestId("document-metadata-header")).toBeVisible({
        timeout: 20_000,
      });
      const metrics = await documentContentColumnMetrics(page);
      await testInfo.attach("document-content-column", {
        body: await page.screenshot(),
        contentType: "image/png",
      });

      expect(
        metrics.iconOverlapsTitle,
        `Expected icon controls to stay on the title line instead of above it: ${JSON.stringify(
          metrics,
        )}`,
      ).toBe(true);
      expect(
        metrics.iconRight,
        `Expected icon controls in the title gutter, not pushing the title text right: ${JSON.stringify(
          metrics,
        )}`,
      ).toBeLessThan(metrics.titleX);
      expect(
        metrics.iconTitleLineCenterDelta,
        `Expected icon controls to align with the visible title line center: ${JSON.stringify(
          metrics,
        )}`,
      ).toBeLessThanOrEqual(1);

      for (const [name, delta] of Object.entries(metrics.deltas)) {
        expect(
          delta,
          `Expected ${name} to align with metadata content column: ${JSON.stringify(
            metrics,
          )}`,
        ).toBeLessThanOrEqual(1);
      }

      expect(
        getErrors(),
        "Fatal JS errors during document layout smoke",
      ).toHaveLength(0);
    } finally {
      if (docId) {
        await cleanupRegressionDoc(workspaceId, cookies, docId);
      }
      await signOutViaApi(request, API, cookies);
    }
  });

  test("long documents scroll and all-docs row actions do not navigate the row", async ({
    context,
    page,
    request,
  }, testInfo) => {
    const getErrors = collectFatalErrors(page);
    const cookies = await signInViaApi(
      request,
      API,
      DEFAULT_SMOKE_USER_EMAIL,
      DEFAULT_SMOKE_USER_PASSWORD,
    );
    await injectCookies(context, cookies);
    const workspaceId = await getSmokeWorkspaceId(request, GQL, cookies);

    let docId: string | undefined;
    try {
      const doc = await createLongRegressionDoc(page, workspaceId);
      docId = doc.docId;

      const before = await scrollableCandidates(page);
      expect(
        before.some((candidate) =>
          candidate.className.includes("mantine-ScrollArea-viewport"),
        ),
        `Expected document detail to expose a Mantine scroll viewport, got ${JSON.stringify(
          before,
        )}`,
      ).toBe(true);

      const beforeScrollTop = Math.max(
        ...before.map((candidate) => candidate.scrollTop),
      );
      const wheelDeltaY = beforeScrollTop > 200 ? -900 : 900;
      await page.mouse.wheel(0, wheelDeltaY);
      await page.waitForTimeout(400);
      const after = await scrollableCandidates(page);
      const afterScrollTop = Math.max(
        ...after.map((candidate) => candidate.scrollTop),
      );
      expect(
        afterScrollTop,
        `Expected wheel to move a real scroll viewport, delta=${wheelDeltaY}, before=${JSON.stringify(
          before,
        )}, after=${JSON.stringify(after)}`,
      ).not.toBe(beforeScrollTop);
      await testInfo.attach("long-document-after-wheel", {
        body: await page.screenshot(),
        contentType: "image/png",
      });

      await page.goto(`${FRONTEND}/workspace/${workspaceId}/all`, {
        waitUntil: "load",
        timeout: 30_000,
      });
      const row = page.getByTestId("doc-list-item").filter({
        hasText: doc.title,
      });
      await expect(row).toBeVisible({ timeout: 20_000 });
      const beforeUrl = page.url();
      await row.getByTestId("doc-list-operation-button").click();
      await expect(
        page.getByRole("menuitem", {
          name: /favourite|favorite|Favorit/i,
        }),
      ).toBeVisible({ timeout: 5_000 });
      expect(page.url()).toBe(beforeUrl);
      await testInfo.attach("all-docs-menu-open", {
        body: await page.screenshot(),
        contentType: "image/png",
      });

      expect(
        getErrors(),
        "Fatal JS errors during main chrome regression smoke",
      ).toHaveLength(0);
    } finally {
      if (docId) {
        await cleanupRegressionDoc(workspaceId, cookies, docId);
      }
      await signOutViaApi(request, API, cookies);
    }
  });
});
