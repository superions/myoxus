#!/usr/bin/env node
import { existsSync } from "node:fs";

import { chromium, request as playwrightRequest } from "playwright";

const baseURL = process.env.MYOXUS_FRONTEND_BASE_URL ?? "http://127.0.0.1:3011";
const email = process.env.MYOXUS_ADMIN_EMAIL ?? "admin@myoxus.local";
const password = process.env.MYOXUS_ADMIN_PASSWORD;
const chromePath =
  process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ??
  (existsSync("/usr/bin/google-chrome") ? "/usr/bin/google-chrome" : undefined);

const routes = [
  ["dashboard", "/adminfrontend/dashboard"],
  ["organization", "/adminfrontend/organization"],
  ["documents", "/adminfrontend/documents"],
  ["documents-status", "/adminfrontend/documents?tab=status"],
  ["documents-versioning", "/adminfrontend/documents?tab=versioning"],
  ["documents-audit", "/adminfrontend/documents?tab=audit"],
  ["templates", "/adminfrontend/templates"],
  ["templates-import", "/adminfrontend/templates?tab=import"],
  ["templates-versions", "/adminfrontend/templates?tab=versions"],
  ["system", "/adminfrontend/system"],
  ["system-logging", "/adminfrontend/system?tab=logging"],
];

const fatalConsolePattern =
  /A component was suspended by an uncached promise|pageerror|ReferenceError|TypeError|Unhandled/i;

async function signIn() {
  if (!password) {
    throw new Error(
      "MYOXUS_ADMIN_PASSWORD is required; provision local dev users via build/scripts/test/seed-test-users.sh",
    );
  }
  const api = await playwrightRequest.newContext({ baseURL });
  try {
    const login = await api.post("/api/auth/sign-in", {
      data: { email, password },
    });
    if (!login.ok()) {
      throw new Error(`admin login failed: HTTP ${login.status()}`);
    }
    return await api.storageState();
  } finally {
    await api.dispose();
  }
}

const storageState = await signIn();
const browser = await chromium.launch({
  headless: true,
  ...(chromePath ? { executablePath: chromePath } : {}),
});

const results = [];
try {
  for (const [name, path] of routes) {
    const context = await browser.newContext({
      baseURL,
      storageState,
      viewport: { width: 1440, height: 1100 },
    });
    const page = await context.newPage();
    const entries = [];
    page.on("console", (msg) => {
      entries.push({
        type: msg.type(),
        text: msg.text(),
        location: msg.location(),
      });
    });
    page.on("pageerror", (err) => {
      entries.push({ type: "pageerror", text: err.message, location: {} });
    });

    await page.goto(path, { waitUntil: "domcontentloaded" });
    await page
      .waitForLoadState("networkidle", { timeout: 10_000 })
      .catch(() => {
        // Long-polling routes may never become fully idle; the console gate still
        // waits below so React runtime errors can surface.
      });
    await page.waitForTimeout(500);

    const errors = entries.filter(
      (entry) =>
        entry.type === "pageerror" ||
        (entry.type === "error" && fatalConsolePattern.test(entry.text)),
    );
    results.push({ name, url: page.url(), errors });
    await context.close();
  }
} finally {
  await browser.close();
}

console.log(JSON.stringify(results, null, 2));

const failed = results.filter((result) => result.errors.length > 0);
if (failed.length > 0) {
  console.error(
    `[FAIL] Admin runtime console smoke found ${failed.length} failing routes`,
  );
  process.exit(1);
}

console.log("[PASS] Admin runtime console smoke passed");
