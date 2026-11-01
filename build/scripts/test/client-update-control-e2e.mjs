import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import { chromium, request as playwrightRequest } from "playwright";

const baseUrl =
  process.env.MYOXUS_UPDATE_E2E_BASE_URL ?? "http://127.0.0.1:3010";
const workspaceId = process.env.MYOXUS_UPDATE_E2E_WORKSPACE_ID;
const apiContainer = process.env.MYOXUS_UPDATE_E2E_API_CONTAINER;
const outputDir =
  process.env.MYOXUS_UPDATE_E2E_OUTPUT_DIR ??
  "output/playwright/client-update-control";
if (!workspaceId) throw new Error("MYOXUS_UPDATE_E2E_WORKSPACE_ID is required");
if (!apiContainer) {
  throw new Error("MYOXUS_UPDATE_E2E_API_CONTAINER is required");
}
const workspaceUrl = `${baseUrl}/workspace/${workspaceId}/all`;
const profileDir = path.resolve(outputDir, "profile");
const email = process.env.MYOXUS_VISUAL_EMAIL;
const password = process.env.MYOXUS_VISUAL_PASSWORD;
if (!email || !password) {
  throw new Error(
    "MYOXUS_VISUAL_EMAIL and MYOXUS_VISUAL_PASSWORD are required",
  );
}

function solve(challenge) {
  const algorithm = challenge.algorithm.toLowerCase().replaceAll("-", "");
  for (let number = 0; number <= (challenge.maxnumber ?? 100_000); number++) {
    if (
      createHash(algorithm)
        .update(`${challenge.salt}${number}`)
        .digest("hex") === challenge.challenge
    ) {
      return Buffer.from(
        JSON.stringify({ ...challenge, number }),
        "utf8",
      ).toString("base64");
    }
  }
  throw new Error("Unable to solve local ALTCHA challenge");
}

async function signInCookies() {
  const request = await playwrightRequest.newContext();
  try {
    const challengeResponse = await request.get(
      `${baseUrl}/api/auth/challenge`,
    );
    const headers =
      challengeResponse.status() === 503
        ? {}
        : { "x-captcha-token": solve(await challengeResponse.json()) };
    const response = await request.post(`${baseUrl}/api/auth/sign-in`, {
      data: { email, password },
      headers,
    });
    if (!response.ok()) {
      throw new Error(`Sign-in failed: ${response.status()}`);
    }
    return response
      .headersArray()
      .filter(({ name }) => name.toLowerCase() === "set-cookie")
      .map(({ value }) => {
        const [pair] = value.split(";");
        const separator = pair.indexOf("=");
        return {
          name: pair.slice(0, separator),
          value: pair.slice(separator + 1),
          url: baseUrl,
        };
      });
  } finally {
    await request.dispose();
  }
}

function cli(...args) {
  return execFileSync(
    "docker",
    ["exec", apiContainer, "myoxus-cli", "client-update", ...args],
    { encoding: "utf8" },
  );
}

function beginLimited({ maxAttempts = 2, retryAfterMs = 1_000 } = {}) {
  const operationId = randomUUID();
  cli(
    "limit-retry",
    "--operation-id",
    operationId,
    "--max-attempts",
    String(maxAttempts),
    "--retry-after-ms",
    String(retryAfterMs),
  );
  return operationId;
}

function complete(operationId, action) {
  cli("update-success", "--operation-id", operationId, "--action", action);
}

async function startReset(page) {
  const operationId = beginLimited();
  await waitForLimited(page, 2);
  complete(operationId, "reset-local-cache");
  return operationId;
}

function status() {
  return JSON.parse(cli("status", "--json"));
}

function suspend(operationId) {
  cli("no-retry", "--operation-id", operationId);
}

async function waitForLimited(page, remaining) {
  await page.waitForFunction(
    (expected) =>
      [...document.querySelectorAll('[role="alert"]')].some((element) =>
        new RegExp(`(^|\\D)${expected}(\\D|$)`).test(element.textContent ?? ""),
      ),
    remaining,
  );
}

async function waitForLimitedWithRecovery(page, remaining) {
  try {
    await page.waitForFunction(
      (expected) =>
        [...document.querySelectorAll('[role="alert"]')].some((element) =>
          new RegExp(`(^|\\D)${expected}(\\D|$)`).test(
            element.textContent ?? "",
          ),
        ),
      remaining,
      { timeout: 5_000 },
    );
    return false;
  } catch (error) {
    if (error?.name !== "TimeoutError") throw error;
    await page.evaluate(() => window.dispatchEvent(new Event("online")));
    await waitForLimited(page, remaining);
    return true;
  }
}

async function waitForBoundary(page, phase) {
  await page.waitForSelector(
    `[data-myoxus-ui-role="client-update-boundary:${phase}"]`,
  );
}

async function waitForLimitedNoticeToClose(page) {
  await page.waitForFunction(
    () =>
      ![...document.querySelectorAll('[role="alert"]')].some((element) =>
        /automatic data attempts|automatische Datenversuche/i.test(
          element.textContent ?? "",
        ),
      ),
  );
}

async function waitForNormal(page) {
  await page.waitForFunction(
    () =>
      !document.querySelector('[data-myoxus-ui-role^="client-update-"]') &&
      document.body.innerText.trim().length > 100,
  );
}

async function installVisibilityProbe(page, initial) {
  await page.evaluate((initialState) => {
    let state = initialState;
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => state,
    });
    Object.defineProperty(document, "hidden", {
      configurable: true,
      get: () => state === "hidden",
    });
    globalThis.__myoxusSetE2EVisibility = (next) => {
      state = next;
      document.dispatchEvent(new Event("visibilitychange"));
    };
  }, initial);
}

async function waitForRegisteredDatabase(page) {
  for (let attempt = 0; attempt < 100; attempt++) {
    let registration = null;
    try {
      registration = await page.evaluate(async () => {
        const request = indexedDB.open("myoxus-web-client-identity", 2);
        const db = await new Promise((resolve, reject) => {
          request.onsuccess = () => resolve(request.result);
          request.onerror = () => reject(request.error);
        });
        try {
          const record = await new Promise((resolve, reject) => {
            const transaction = db.transaction(
              "endpoint-update-state",
              "readonly",
            );
            const read = transaction
              .objectStore("endpoint-update-state")
              .get(location.origin);
            read.onsuccess = () => resolve(read.result);
            read.onerror = () => reject(read.error);
          });
          if (
            record?.cloudDatabaseRegistryInitialized !== true ||
            !record.registeredCloudDatabases?.length
          ) {
            return null;
          }
          const existing = new Set(
            (await indexedDB.databases()).flatMap(({ name }) =>
              name ? [name] : [],
            ),
          );
          return (
            record.registeredCloudDatabases.find(({ name }) =>
              existing.has(name),
            ) ?? null
          );
        } finally {
          db.close();
        }
      });
    } catch (error) {
      if (!String(error).includes("Execution context was destroyed")) {
        throw error;
      }
    }
    if (registration) return registration;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("No registered Cloud database became available");
}

async function setPendingBlob(page, registration, pending) {
  await page.evaluate(
    async ({ registration, pending }) => {
      const request = indexedDB.open(registration.name);
      const db = await new Promise((resolve, reject) => {
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      try {
        const transaction = db.transaction(["blobs", "blobSync"], "readwrite");
        transaction.objectStore("blobs").put({
          key: "p-cup-06-pending",
          mime: "application/octet-stream",
          size: 0,
          createdAt: new Date(),
          deletedAt: null,
        });
        for (const peer of registration.peerIds) {
          transaction.objectStore("blobSync").put({
            peer,
            key: "p-cup-06-pending",
            uploadedAt: pending ? null : new Date(),
          });
        }
        await new Promise((resolve, reject) => {
          transaction.oncomplete = resolve;
          transaction.onerror = () => reject(transaction.error);
          transaction.onabort = () => reject(transaction.error);
        });
      } finally {
        db.close();
      }
    },
    { registration, pending },
  );
}

async function openBlocker(page, name) {
  await page.evaluate(async (databaseName) => {
    const request = indexedDB.open(databaseName);
    const database = await new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    database.onversionchange = () => {
      globalThis.__myoxusBlockedDeleteObserved = true;
      // Intentionally retain this independent connection. The production
      // reset must surface a blocked delete and preserve its durable fence.
    };
    globalThis.__myoxusBlockedDeleteObserved = false;
    globalThis.__myoxusBlockedDeleteDatabase = database;
  }, name);
}

async function databaseNames(page) {
  return page.evaluate(async () =>
    (await indexedDB.databases()).flatMap(({ name }) => (name ? [name] : [])),
  );
}

async function updateState(page) {
  return page.evaluate(async () => {
    const request = indexedDB.open("myoxus-web-client-identity", 2);
    const db = await new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    try {
      return await new Promise((resolve, reject) => {
        const read = db
          .transaction("endpoint-update-state", "readonly")
          .objectStore("endpoint-update-state")
          .get(location.origin);
        read.onsuccess = () => resolve(read.result);
        read.onerror = () => reject(read.error);
      });
    } finally {
      db.close();
    }
  });
}

async function hasBlob(page, databaseName, key) {
  return page.evaluate(
    async ({ databaseName, key }) => {
      const request = indexedDB.open(databaseName);
      const db = await new Promise((resolve, reject) => {
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      try {
        if (!db.objectStoreNames.contains("blobs")) return false;
        return await new Promise((resolve, reject) => {
          const read = db
            .transaction("blobs", "readonly")
            .objectStore("blobs")
            .get(key);
          read.onsuccess = () => resolve(Boolean(read.result));
          read.onerror = () => reject(read.error);
        });
      } finally {
        db.close();
      }
    },
    { databaseName, key },
  );
}

function collectErrors(page, report) {
  page.on("console", (message) => {
    if (message.type() !== "error") return;
    if (
      report.expectingControlledFailure &&
      /Failed to load resource|ERR_FAILED/i.test(message.text())
    ) {
      report.expectedControlledErrors.push(message.text());
      return;
    }
    report.consoleErrors.push(message.text());
  });
  page.on("pageerror", (error) => report.pageErrors.push(String(error)));
  page.on("requestfailed", (request) => {
    if (/worker/i.test(request.url())) {
      report.workerErrors.push(
        `${request.url()}: ${request.failure()?.errorText ?? "failed"}`,
      );
    }
  });
}

async function openContext(cookies) {
  const context = await chromium.launchPersistentContext(profileDir, {
    headless: true,
    viewport: { width: 1440, height: 1000 },
  });
  await context.addCookies(cookies);
  return context;
}

await fs.rm(profileDir, { recursive: true, force: true });
await fs.mkdir(outputDir, { recursive: true });
const report = {
  servedUrl: workspaceUrl,
  consoleErrors: [],
  pageErrors: [],
  workerErrors: [],
  expectedControlledErrors: [],
  expectingControlledFailure: false,
  screenshots: {},
  lifecycle: {},
  reload: {},
  reset: {},
};
const cookies = await signInCookies();

try {
  let context = await openContext(cookies);
  let page = context.pages()[0] ?? (await context.newPage());
  collectErrors(page, report);
  await page.addInitScript(() => localStorage.setItem("myoxus-theme", "light"));
  await page.goto(workspaceUrl, { waitUntil: "domcontentloaded" });
  await waitForNormal(page);
  const secondPage = await context.newPage();
  collectErrors(secondPage, report);
  await secondPage.goto(workspaceUrl, { waitUntil: "domcontentloaded" });
  await waitForNormal(secondPage);

  let operationId = beginLimited({ maxAttempts: 1, retryAfterMs: 1_000 });
  const [, secondTabRecovered] = await Promise.all([
    waitForLimited(page, 1),
    waitForLimitedWithRecovery(secondPage, 1),
  ]);
  report.lifecycle.secondTabRequiredOnlineRead = secondTabRecovered;
  report.screenshots.limited = path.resolve(
    outputDir,
    "limited-two-tabs-light.png",
  );
  await page.screenshot({ path: report.screenshots.limited, fullPage: true });

  let databaseAttempts = 0;
  const failDatabaseQuery = async (route) => {
    if ((route.request().postData() ?? "").includes("query databases(")) {
      databaseAttempts++;
      await route.abort("failed");
      return;
    }
    await route.continue();
  };
  report.expectingControlledFailure = true;
  await page.route("**/graphql", failDatabaseQuery);
  await page.goto(`${baseUrl}/workspace/${workspaceId}/databases`, {
    waitUntil: "domcontentloaded",
  });
  await waitForLimited(page, 0);
  for (let attempt = 0; attempt < 60 && databaseAttempts < 2; attempt++) {
    await page.waitForTimeout(250);
  }
  const requestsAtExhaustion = databaseAttempts;
  await page.waitForTimeout(7_000);
  const requestsAfterSuppressedAttempt = databaseAttempts;
  await page.unroute("**/graphql", failDatabaseQuery);
  report.expectingControlledFailure = false;
  report.lifecycle.retryBudget = {
    before: 1,
    databaseAttemptsAtExhaustion: requestsAtExhaustion,
    databaseAttemptsAfterSuppressedAttempt: requestsAfterSuppressedAttempt,
    nPlusOneSuppressed:
      requestsAtExhaustion === 2 &&
      requestsAfterSuppressedAttempt === requestsAtExhaustion,
  };

  suspend(operationId);
  await Promise.all([
    page.evaluate(() => window.dispatchEvent(new Event("online"))),
    secondPage.evaluate(() => window.dispatchEvent(new Event("online"))),
  ]);
  await Promise.all([
    waitForBoundary(page, "suspended"),
    waitForBoundary(secondPage, "suspended"),
  ]);
  await Promise.all([
    waitForLimitedNoticeToClose(page),
    waitForLimitedNoticeToClose(secondPage),
  ]);
  report.screenshots.suspended = path.resolve(
    outputDir,
    "suspended-two-tabs-light.png",
  );
  await page.screenshot({ path: report.screenshots.suspended, fullPage: true });

  let suspendedProductRequests = 0;
  const countSuspendedProductRequests = async (route) => {
    if ((route.request().postData() ?? "").includes("query databases(")) {
      suspendedProductRequests++;
    }
    await route.continue();
  };
  await page.route("**/graphql", countSuspendedProductRequests);
  await page.goto(`${baseUrl}/workspace/${workspaceId}/databases`, {
    waitUntil: "domcontentloaded",
  });
  await waitForBoundary(page, "suspended");
  await page.waitForTimeout(1_000);
  await page.unroute("**/graphql", countSuspendedProductRequests);
  report.lifecycle.suspended = {
    productRequests: suspendedProductRequests,
    automaticAttemptsSuppressed: suspendedProductRequests === 0,
  };
  const dropCompletionRead = async (route) => {
    if (
      (route.request().postData() ?? "").includes("query clientUpdateControl")
    ) {
      await route.abort("failed");
      return;
    }
    await route.continue();
  };
  report.expectingControlledFailure = true;
  await page.route("**/graphql", dropCompletionRead);
  complete(operationId, "none");
  await page.waitForTimeout(1_500);
  report.lifecycle.lostWakeStayedBlocked = Boolean(
    await page.$('[data-myoxus-ui-role^="client-update-boundary:"]'),
  );
  await page.unroute("**/graphql", dropCompletionRead);
  report.expectingControlledFailure = false;
  await Promise.all([
    page.evaluate(() => window.dispatchEvent(new Event("online"))),
    secondPage.evaluate(() => window.dispatchEvent(new Event("online"))),
  ]);
  await Promise.all([waitForNormal(page), waitForNormal(secondPage)]);
  report.lifecycle.successReactivated = true;
  report.lifecycle.lostWakeHealedOnReconnect = true;

  await installVisibilityProbe(secondPage, "hidden");
  let visibleLoads = 0;
  let hiddenLoads = 0;
  page.on("load", () => {
    visibleLoads++;
  });
  secondPage.on("load", () => {
    hiddenLoads++;
  });
  operationId = beginLimited();
  await Promise.all([waitForLimited(page, 2), waitForLimited(secondPage, 2)]);
  const visibleReload = page.waitForEvent("load", { timeout: 30_000 });
  complete(operationId, "reload");
  await visibleReload;
  await page.waitForTimeout(1_000);
  report.reload.visibleLoads = visibleLoads;
  report.reload.hiddenLoadsBeforeVisibility = hiddenLoads;
  report.reload.hiddenDeferred = hiddenLoads === 0;
  const hiddenReload = secondPage.waitForEvent("load", { timeout: 30_000 });
  await secondPage.evaluate(() => {
    globalThis.__myoxusSetE2EVisibility?.("visible");
  });
  await hiddenReload;
  report.reload.hiddenLoadsAfterVisibility = hiddenLoads;
  report.reload.visibleExactlyOnce = visibleLoads === 1;
  report.reload.hiddenExactlyOnce = hiddenLoads === 1;
  report.screenshots.reload = path.resolve(
    outputDir,
    "reload-completed-light.png",
  );
  await page.screenshot({ path: report.screenshots.reload, fullPage: true });
  await secondPage.close();

  page = context.pages().find((candidate) => !candidate.isClosed()) ?? page;
  await page.goto(workspaceUrl, { waitUntil: "domcontentloaded" });
  await waitForNormal(page);
  const registration = await waitForRegisteredDatabase(page);
  report.registration = registration;
  report.registeredDatabase = registration.name;

  await setPendingBlob(page, registration, true);
  operationId = await startReset(page);
  await page.waitForSelector(
    '[data-myoxus-ui-role="client-update-cache-reset:waiting"]',
  );
  await waitForLimitedNoticeToClose(page);
  report.screenshots.waiting = path.resolve(outputDir, "waiting-light.png");
  await page.screenshot({ path: report.screenshots.waiting, fullPage: true });
  report.reset.pendingProtected = (await databaseNames(page)).includes(
    registration.name,
  );

  const cleanReload = page.waitForEvent("load", { timeout: 30_000 });
  await setPendingBlob(page, registration, false);
  await cleanReload;
  await page.waitForFunction(() => {
    const entry = performance.getEntriesByType("navigation").at(-1);
    return entry?.type === "reload";
  });
  report.reset.cleanResetReloaded = true;
  report.reset.cleanTargetRecreatedWithoutPendingBlob = !(await hasBlob(
    page,
    registration.name,
    "p-cup-06-pending",
  ));

  await context.close();
  context = await openContext(cookies);
  page = context.pages()[0] ?? (await context.newPage());
  collectErrors(page, report);
  await page.addInitScript(() => localStorage.setItem("myoxus-theme", "dark"));
  await page.goto(workspaceUrl, { waitUntil: "domcontentloaded" });
  const recreated = await waitForRegisteredDatabase(page);
  const blockerPage = await context.newPage();
  await blockerPage.goto(`${baseUrl}/health`, {
    waitUntil: "domcontentloaded",
  });
  await openBlocker(blockerPage, recreated.name);
  operationId = await startReset(page);
  await page.waitForSelector(
    '[data-myoxus-ui-role="client-update-cache-reset:failed"]',
  );
  report.screenshots.failed = path.resolve(
    outputDir,
    "failed-server-theme.png",
  );
  await page.screenshot({ path: report.screenshots.failed, fullPage: true });
  report.reset.fenceAfterBlocked = await page.evaluate(async () => {
    const request = indexedDB.open("myoxus-web-client-identity", 2);
    const db = await new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    try {
      return await new Promise((resolve, reject) => {
        const read = db
          .transaction("endpoint-update-state", "readonly")
          .objectStore("endpoint-update-state")
          .get(location.origin);
        read.onsuccess = () => resolve(read.result.resetInProgressEpoch);
        read.onerror = () => reject(read.error);
      });
    } finally {
      db.close();
    }
  });

  await context.close();

  context = await openContext(cookies);
  page = context.pages()[0] ?? (await context.newPage());
  collectErrors(page, report);
  await page.goto(`${baseUrl}/health`, { waitUntil: "domcontentloaded" });
  await page.evaluate(
    async ({ target, foreign }) => {
      await new Promise((resolve, reject) => {
        const request = indexedDB.deleteDatabase(target);
        request.onsuccess = resolve;
        request.onerror = () => reject(request.error);
      });
      await new Promise((resolve, reject) => {
        const request = indexedDB.open(foreign, 1);
        request.onupgradeneeded = () =>
          request.result.createObjectStore("foreign");
        request.onsuccess = () => {
          request.result.close();
          resolve();
        };
        request.onerror = () => reject(request.error);
      });
    },
    { target: recreated.name, foreign: "p-cup-06-foreign-database" },
  );
  report.reset.targetAbsentBeforeResume = !(await databaseNames(page)).includes(
    recreated.name,
  );
  await page.goto(workspaceUrl, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => {
    const entry = performance.getEntriesByType("navigation").at(-1);
    return entry?.type === "reload";
  });
  await page.waitForFunction(() => document.body.innerText.trim().length > 100);
  await page.waitForTimeout(500);
  const namesAfterResume = await databaseNames(page);
  const resumedState = await updateState(page);
  report.reset.resumeAlreadyDeleted =
    resumedState.resetInProgressEpoch === null &&
    resumedState.appliedCacheEpoch === status().cacheEpoch;
  report.reset.foreignPreserved = namesAfterResume.includes(
    "p-cup-06-foreign-database",
  );
  report.screenshots.completed = path.resolve(
    outputDir,
    "completed-after-resume-server-theme.png",
  );
  await page.screenshot({ path: report.screenshots.completed, fullPage: true });
  report.horizontalOverflow = await page.evaluate(
    () => document.documentElement.scrollWidth > window.innerWidth,
  );
  await context.close();
} finally {
  const current = status();
  if (current.phase !== "normal" && current.operationId) {
    cli("update-abort", "--operation-id", current.operationId);
  }
  report.finalServerPhase = status().phase;
  report.cacheEpoch = status().cacheEpoch;
  await fs.writeFile(
    path.join(outputDir, "report.json"),
    `${JSON.stringify(report, null, 2)}\n`,
  );
}

const failed = [
  !report.lifecycle.retryBudget?.nPlusOneSuppressed && "retry N+1 suppression",
  !report.lifecycle.suspended?.automaticAttemptsSuppressed &&
    "suspended automatic retry suppression",
  !report.lifecycle.lostWakeStayedBlocked && "lost-wake setup",
  !report.lifecycle.lostWakeHealedOnReconnect && "lost-wake reconnect",
  !report.lifecycle.successReactivated && "success reactivation",
  !report.reload.visibleExactlyOnce && "visible reload",
  !report.reload.hiddenDeferred && "hidden reload deferral",
  !report.reload.hiddenExactlyOnce && "hidden reload",
  !report.reset.pendingProtected && "pending protection",
  !report.reset.cleanTargetRecreatedWithoutPendingBlob && "clean deletion",
  !report.reset.fenceAfterBlocked && "blocked fence",
  !report.reset.targetAbsentBeforeResume && "already-deleted setup",
  !report.reset.resumeAlreadyDeleted && "already-deleted resume",
  !report.reset.foreignPreserved && "foreign preservation",
  report.consoleErrors.length && "console errors",
  report.pageErrors.length && "page errors",
  report.workerErrors.length && "worker errors",
  report.horizontalOverflow && "horizontal overflow",
  report.finalServerPhase !== "normal" && "server restore",
].filter(Boolean);
if (failed.length) {
  throw new Error(`Client update control E2E failed: ${failed.join(", ")}`);
}
