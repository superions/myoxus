#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later

import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { chromium } from "playwright";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../..",
);

function argValue(name, fallback) {
  const prefix = `${name}=`;
  const hit = process.argv
    .slice(2)
    .find((arg) => arg === name || arg.startsWith(prefix));
  if (!hit) return fallback;
  if (hit === name) return "1";
  return hit.slice(prefix.length);
}

const baseURL = argValue(
  "--base-url",
  process.env.MYOXUS_ADMIN_BASE_URL ??
    process.env.MYOXUS_FRONTEND_BASE_URL ??
    "http://127.0.0.1:3011",
);
const outputDir = path.resolve(
  repoRoot,
  argValue(
    "--output-dir",
    process.env.MYOXUS_ADMIN_BOOTSTRAP_OUTPUT_DIR ??
      `output/playwright/admin-bootstrap-visual-${new Date().toISOString().replace(/[:.]/g, "-")}`,
  ),
);
const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE;

function screenshotName(theme, id) {
  return (
    `${theme}-${id}`.replace(/[^a-z0-9._-]+/gi, "-").toLowerCase() + ".png"
  );
}

function importantConsole(msg) {
  const text = msg.text();
  if (/Sentry Logger \[warn\]: No DSN provided/.test(text)) return false;
  if (/Download the React DevTools/.test(text)) return false;
  if (/React Router Future Flag Warning/.test(text)) return false;
  return msg.type() === "error" || msg.type() === "warning";
}

function serverInfo(initialized) {
  return {
    version: "0.30.0",
    baseUrl: baseURL,
    name: "Myoxus",
    features: [],
    type: "selfhosted",
    deploymentType: "selfhosted",
    initialized,
    credentialsRequirement: {
      password: { minLength: 8, maxLength: 128 },
    },
    i18n: {
      defaultLocale: "de",
      availableLocales: ["en", "de", "fr", "es", "it"],
    },
    availableUpgrade: null,
    availableUserFeatures: ["Admin"],
    availableWorkspaceFeatures: [],
  };
}

function adminUpdateResponse() {
  return {
    data: {
      admin: {
        adminUpdateConfig: {
          applied: true,
          fieldErrors: [],
          config: { modules: [] },
        },
      },
    },
  };
}

async function installBootstrapMocks(page, scenario) {
  await page.route("**/api/setup/create-admin-user", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ ok: true }),
    });
  });

  await page.route("**/graphql", async (route) => {
    const request = route.request();
    let body = {};
    try {
      body = JSON.parse(request.postData() || "{}");
    } catch {
      body = {};
    }
    const operation = body.operationName ?? "";
    let payload;

    if (operation === "adminServerConfig") {
      payload = {
        data: { admin: { serverInfo: serverInfo(scenario.initialized) } },
      };
    } else if (operation === "serverSetupStatus") {
      payload = {
        data: {
          serverSetupStatus: {
            isConfigured: false,
            missingCritical: ["server.origin", "crypto.private_key"],
            warnings: ["mailer.smtp"],
          },
        },
      };
    } else if (operation === "getCurrentUserFeatures") {
      payload = {
        data: {
          currentUser: scenario.noAdmin
            ? {
                id: "user-no-admin",
                name: "Non Admin",
                email: "no-admin@myoxus.local",
                emailVerified: true,
                avatarUrl: null,
                features: [],
              }
            : null,
        },
      };
    } else if (operation === "adminConfigValues") {
      payload = {
        data: { admin: { adminConfigValues: { modules: [] } } },
      };
    } else if (operation === "adminUpdateConfig") {
      payload = adminUpdateResponse();
    } else if (operation === "sendTestEmail") {
      payload = { data: { admin: { sendTestEmail: true } } };
    } else {
      payload = { data: {} };
    }

    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(payload),
    });
  });
}

async function settle(page) {
  await page
    .waitForLoadState("networkidle", { timeout: 10_000 })
    .catch(() => {});
  await page.waitForTimeout(700);
}

async function metrics(page) {
  return await page.evaluate(() => {
    const isVisible = (el) => {
      const style = getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      return (
        style.display !== "none" &&
        style.visibility !== "hidden" &&
        style.opacity !== "0" &&
        rect.width > 0 &&
        rect.height > 0
      );
    };
    const families = [
      "admin-onboarding-",
      "admin-config-",
      "admin-ui-",
      "admin-role-",
      "admin-workspace-",
    ];
    const visibleClassHits = Object.fromEntries(
      families.map((family) => [family, 0]),
    );
    for (const el of Array.from(document.querySelectorAll("[class]"))) {
      if (!isVisible(el)) continue;
      const className = String(el.className || "");
      for (const family of families) {
        if (className.includes(family)) visibleClassHits[family] += 1;
      }
    }
    const bodyText = document.body.innerText || "";
    return {
      title: document.title,
      h1: Array.from(
        document.querySelectorAll("h1,[role='heading'][aria-level='1']"),
      )
        .filter(isVisible)
        .map((el) => el.textContent?.replace(/\s+/g, " ").trim())
        .filter(Boolean)
        .slice(0, 5),
      keyLeaks: (bodyText.match(/admin\.[a-z0-9_.-]+/gi) || []).slice(0, 20),
      fatalText:
        /unerwarteter Fehler|unexpected error|Irgendetwas stimmt nicht|can't access property|ReferenceError|TypeError/i.test(
          bodyText,
        ),
      horizontalOverflow: Math.max(
        0,
        document.body.scrollWidth - document.documentElement.clientWidth,
      ),
      visibleClassHits,
    };
  });
}

async function captureState(context, theme, state) {
  const page = await context.newPage();
  const consoleMessages = [];
  const pageErrors = [];
  page.on("console", (msg) => {
    if (importantConsole(msg)) {
      consoleMessages.push({
        type: msg.type(),
        text: msg.text(),
        location: msg.location(),
      });
    }
  });
  page.on("pageerror", (err) => {
    pageErrors.push(String(err?.stack || err?.message || err));
  });

  const entry = {
    theme,
    id: state.id,
    path: state.path,
    consoleMessages,
    pageErrors,
  };
  try {
    await installBootstrapMocks(page, state.scenario);
    await page.goto(state.path, {
      waitUntil: "domcontentloaded",
      timeout: 30_000,
    });
    await page.evaluate((mode) => {
      document.documentElement.dataset.theme = mode;
      document.documentElement.style.colorScheme = mode;
    }, theme);
    await settle(page);
    await state.act?.(page);
    await settle(page);
    if (state.expectedText) {
      await page
        .getByText(state.expectedText, { exact: false })
        .first()
        .waitFor({
          timeout: 10_000,
        });
      entry.expectedText = state.expectedText;
    }
    Object.assign(entry, await metrics(page));
    const file = screenshotName(theme, state.id);
    await page.screenshot({ path: path.join(outputDir, file), fullPage: true });
    entry.screenshot = file;
  } catch (error) {
    entry.error = String(error?.stack || error?.message || error);
  } finally {
    await page.close();
  }
  return entry;
}

const states = [
  {
    id: "setup-welcome",
    path: "/adminfrontend/setup",
    scenario: { initialized: false },
    expectedText: "Willkommen bei Myoxus",
  },
  {
    id: "setup-create-admin",
    path: "/adminfrontend/setup",
    scenario: { initialized: false },
    expectedText: "Administratorkonto erstellen",
    act: async (page) => {
      await page.getByRole("button").last().click();
      await page.waitForSelector("#email", { timeout: 10_000 });
    },
  },
  {
    id: "setup-complete",
    path: "/adminfrontend/setup",
    scenario: { initialized: false },
    expectedText: "Alle Einstellungen abgeschlossen",
    act: async (page) => {
      await page.getByRole("button").last().click();
      await page.waitForSelector("#email", { timeout: 10_000 });
      await page.locator("#name").fill("Admin");
      await page.locator("#email").fill("admin@myoxus.local");
      await page.locator("#password").fill("AdminMyoxus2026");
      await page.getByRole("button").last().click();
      await page
        .getByRole("heading", {
          name: /All Settings Done|Alle Einstellungen abgeschlossen|Konfiguration abgeschlossen/i,
        })
        .waitFor({
          timeout: 10_000,
        });
    },
  },
  {
    id: "config-wizard-provider-selection",
    path: "/adminfrontend/config-wizard",
    scenario: { initialized: true },
    expectedText: "Authentifizierungsmethode",
    act: async (page) => {
      const step = page.locator("[data-myoxus-ui-role='config-wizard-step']");
      await step.locator("input[type='url']").fill(baseURL);
      await step.locator("button").last().click();
      await page.waitForSelector("input[type='password']", { timeout: 10_000 });
      await page
        .locator("[data-myoxus-ui-role='config-wizard-step'] button")
        .filter({
          hasText: /Generate|Generieren|Erzeugen|Sicheren Schlüssel erzeugen/i,
        })
        .click();
      await page
        .locator("[data-myoxus-ui-role='config-wizard-step'] button")
        .last()
        .click();
      await page.waitForSelector(
        "[data-myoxus-ui-role='config-wizard-actions']",
        {
          timeout: 10_000,
        },
      );
      await page
        .locator("[data-myoxus-ui-role='config-wizard-actions'] button")
        .last()
        .click();
      await page.waitForSelector("[data-myoxus-ui-role='button:card-row']", {
        timeout: 10_000,
      });
    },
  },
  {
    id: "no-admin-access",
    path: "/adminfrontend/templates",
    scenario: { initialized: true, noAdmin: true },
    expectedText: "Administratorzugriff erforderlich",
    act: async (page) => {
      await page.waitForSelector("[data-myoxus-ui-role='auth-panel-frame']", {
        timeout: 20_000,
      });
    },
  },
];

mkdirSync(outputDir, { recursive: true });
const browser = await chromium.launch({
  headless: true,
  ...(executablePath ? { executablePath } : {}),
});
const report = {
  generatedAt: new Date().toISOString(),
  baseURL,
  screenshotsDir: path.relative(repoRoot, outputDir),
  routeCount: states.length * 2,
  routes: [],
};

try {
  const context = await browser.newContext({
    baseURL,
    viewport: { width: 1440, height: 1100 },
    deviceScaleFactor: 1,
  });
  for (const theme of ["light", "dark"]) {
    for (const state of states) {
      const entry = await captureState(context, theme, state);
      report.routes.push(entry);
      const residual = entry.visibleClassHits
        ? Object.values(entry.visibleClassHits).reduce(
            (sum, count) => sum + count,
            0,
          )
        : 0;
      console.log(
        `${theme.padEnd(5)} ${state.id.padEnd(34)} ${entry.error ? "ERROR" : "ok"} console=${entry.consoleMessages.length} pageErrors=${entry.pageErrors.length} residualClasses=${residual}`,
      );
    }
  }
  await context.close();
} finally {
  await browser.close();
}

const reportPath = path.join(outputDir, "report.json");
writeFileSync(reportPath, JSON.stringify(report, null, 2));
const bad = report.routes.filter((route) => {
  const residual = route.visibleClassHits
    ? Object.values(route.visibleClassHits).reduce(
        (sum, count) => sum + count,
        0,
      )
    : 0;
  return (
    route.error ||
    route.pageErrors.length ||
    route.consoleMessages.length ||
    route.fatalText ||
    route.horizontalOverflow > 0 ||
    route.keyLeaks?.length ||
    residual > 0
  );
});
console.log(
  `admin bootstrap visual report: ${path.relative(repoRoot, reportPath)} bad=${bad.length}`,
);
if (bad.length > 0 && process.env.MYOXUS_ADMIN_VISUAL_FAIL_ON_FATAL === "1") {
  process.exit(1);
}
