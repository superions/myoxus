#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { chromium } from "playwright";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../..",
);

function argValue(name, fallback) {
  const prefix = `${name}=`;
  const args = process.argv.slice(2);
  const index = args.findIndex((arg) => arg === name || arg.startsWith(prefix));
  if (index === -1) return fallback;
  const hit = args[index];
  if (hit.startsWith(prefix)) return hit.slice(prefix.length);
  const next = args[index + 1];
  return next && !next.startsWith("--") ? next : "1";
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
    process.env.MYOXUS_ADMIN_VISUAL_OUTPUT_DIR ??
      `output/playwright/admin-visual-baseline-${new Date().toISOString().replace(/[:.]/g, "-")}`,
  ),
);
const matrixPath = path.resolve(
  repoRoot,
  argValue(
    "--matrix",
    process.env.MYOXUS_ADMIN_ROUTE_MATRIX ??
      "docs/dev/clients/adminfrontend/admin-ui-facade-route-matrix.json",
  ),
);
const session = process.env.MYOXUS_ADMIN_SESSION;
const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE;
const routeFilter = new Set(
  (argValue("--routes", process.env.MYOXUS_ADMIN_VISUAL_ROUTES ?? "") || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean),
);
const themeFilter = (
  argValue(
    "--themes",
    process.env.MYOXUS_ADMIN_VISUAL_THEMES ?? "light,dark",
  ) || "light,dark"
)
  .split(",")
  .map((item) => item.trim())
  .filter(Boolean);
const fullPage =
  argValue(
    "--viewport-only",
    process.env.MYOXUS_ADMIN_VISUAL_VIEWPORT_ONLY ?? "",
  ) !== "1";
const viewportSpec = argValue(
  "--viewport",
  process.env.MYOXUS_ADMIN_VISUAL_VIEWPORT ?? "1440x1100",
);
const viewportMatch = /^(\d+)x(\d+)$/.exec(viewportSpec);
if (!viewportMatch) {
  throw new Error("--viewport must use WIDTHxHEIGHT, for example 1440x900");
}
const viewport = {
  width: Number(viewportMatch[1]),
  height: Number(viewportMatch[2]),
};
const outputFormat = argValue(
  "--output-format",
  process.env.MYOXUS_ADMIN_VISUAL_OUTPUT_FORMAT ?? "png",
).toLowerCase();
if (!new Set(["png", "webp"]).has(outputFormat)) {
  throw new Error("--output-format must be png or webp");
}
const servedSourceRoot = path.resolve(
  argValue("--served-source-root", repoRoot),
);
const sourceCommit = execFileSync(
  "git",
  ["-C", servedSourceRoot, "rev-parse", "HEAD"],
  { encoding: "utf8" },
).trim();
const sourceDirty = Boolean(
  execFileSync("git", ["-C", servedSourceRoot, "status", "--porcelain"], {
    encoding: "utf8",
  }).trim(),
);
const requireClean =
  argValue(
    "--require-clean",
    process.env.MYOXUS_ADMIN_VISUAL_REQUIRE_CLEAN ?? "",
  ) === "1";
if (requireClean && sourceDirty) {
  throw new Error("--require-clean rejects a dirty source worktree");
}

if (!session) {
  throw new Error(
    "MYOXUS_ADMIN_SESSION is required. Use build/scripts/server/capture-admin-visual-baseline.sh unless you intentionally provide a session cookie.",
  );
}
if (!existsSync(matrixPath)) {
  throw new Error(`Admin route matrix not found: ${matrixPath}`);
}

const matrix = JSON.parse(readFileSync(matrixPath, "utf8"));
const classFamilies = [
  "admin-ui-",
  "admin-role-",
  "admin-org-",
  "admin-workspace-",
  "admin-system-",
  "admin-design-",
  "admin-typography-",
  "admin-documents-",
  "admin-templates-",
  "admin-security-",
  "admin-storage-",
  "admin-ui-page-hero",
  "admin-ui-page-hero-grid",
  "admin-ui-tab-panel-stack",
  "admin-ui-empty-muted",
  "admin-ui-callout-muted",
  "admin-ui-callout-error",
  "admin-ui-callout-success",
  "admin-ui-callout-warning",
  "admin-ui-table-scroll",
  "admin-ui-table--wide",
  "admin-ui-table-td--",
  "admin-ui-table-tabular",
  "admin-queue-",
];

function routeTargets() {
  const targets = [];
  for (const route of matrix.routes ?? []) {
    if (route.routeKind !== "authenticated") continue;
    if (routeFilter.size > 0 && !routeFilter.has(route.id)) continue;
    const tabs = Array.isArray(route.tabs) ? route.tabs : [];
    if (tabs.length === 0) {
      targets.push({
        id: route.id,
        routeId: route.id,
        tab: null,
        path: route.path,
        typography: route.typography,
        dashboard: route.dashboard,
        securityJourney: route.securityJourney,
        aiProviders: [],
      });
      continue;
    }
    for (const tab of tabs) {
      const url = new URL(route.path, "http://myoxus.local");
      url.searchParams.set("tab", tab);
      const target = {
        id: `${route.id}-${tab}`,
        routeId: route.id,
        tab,
        path: `${url.pathname}${url.search}`,
        aiProviders: route.aiProviders ?? [],
        aiEmbedding: Boolean(route.aiEmbedding),
        aiScrollHeading: route.aiScrollHeading,
        brandingIdentityError: route.brandingIdentityError === true,
        aiScrollFooter: Boolean(route.aiScrollFooter),
        aiDetails: route.aiDetails ?? [],
        typography: route.typography,
        securityJourney: route.securityJourney,
      };
      const profileStates =
        route.id === "git-sync" && tab === "profiles"
          ? (route.profileStates ?? [])
          : [];
      if (tab === "activity" && route.activityWorkspace) {
        targets.push({
          ...target,
          activityWorkspace: route.activityWorkspace,
          activityPaths: route.activityPaths ?? [],
          activityRunIndex: route.activityRunIndex,
          activityRunJob: route.activityRunJob,
          activityConfirm: route.activityConfirm,
        });
        continue;
      }
      if (profileStates.length === 0) targets.push(target);
      for (const profile of profileStates) {
        if (
          !profile.workspace ||
          !["readonly", "edit", "rotation"].includes(profile.state)
        ) {
          throw new Error(
            "Git profile capture requires workspace and readonly/edit/rotation state",
          );
        }
        targets.push({
          ...target,
          id: `${target.id}-${profile.state}`,
          profile,
        });
      }
    }
  }
  return targets;
}

function screenshotName(theme, id, extension) {
  return (
    `${theme}-${id}`.replace(/[^a-z0-9._-]+/gi, "-").toLowerCase() +
    `.${extension}`
  );
}

function stripWebpMetadata(webp) {
  if (
    webp.toString("ascii", 0, 4) !== "RIFF" ||
    webp.toString("ascii", 8, 12) !== "WEBP"
  ) {
    throw new Error("Screenshot encoder returned an invalid WebP container");
  }

  const chunks = [];
  for (let offset = 12; offset + 8 <= webp.length;) {
    const type = webp.toString("ascii", offset, offset + 4);
    const size = webp.readUInt32LE(offset + 4);
    const paddedSize = size + (size % 2);
    const end = offset + 8 + paddedSize;
    if (end > webp.length) throw new Error("Truncated WebP screenshot chunk");
    if (!new Set(["ICCP", "EXIF", "XMP "]).has(type)) {
      const chunk = Buffer.from(webp.subarray(offset, end));
      if (type === "VP8X" && size >= 1) chunk[8] &= ~0x2c;
      chunks.push(chunk);
    }
    offset = end;
  }

  const body = Buffer.concat(chunks);
  const output = Buffer.alloc(12 + body.length);
  output.write("RIFF", 0, "ascii");
  output.writeUInt32LE(output.length - 8, 4);
  output.write("WEBP", 8, "ascii");
  body.copy(output, 12);
  return output;
}

async function screenshotBuffer(page) {
  const png = await page.screenshot({ fullPage, animations: "disabled" });
  if (outputFormat === "png") return png;

  const dataUrl = await page.evaluate(
    async (source) => {
      const image = new Image();
      image.src = source;
      await image.decode();
      const canvas = document.createElement("canvas");
      canvas.width = image.naturalWidth;
      canvas.height = image.naturalHeight;
      const context = canvas.getContext("2d");
      if (!context)
        throw new Error("Unable to create screenshot canvas context");
      context.drawImage(image, 0, 0);
      return canvas.toDataURL("image/webp", 0.88);
    },
    `data:image/png;base64,${png.toString("base64")}`,
  );

  return stripWebpMetadata(
    Buffer.from(dataUrl.slice(dataUrl.indexOf(",") + 1), "base64"),
  );
}

function importantConsole(msg) {
  const text = msg.text();
  if (/Sentry Logger \[warn\]: No DSN provided/.test(text)) return false;
  if (/Download the React DevTools/.test(text)) return false;
  return msg.type() === "error" || msg.type() === "warning";
}

async function settle(page) {
  await page
    .waitForLoadState("networkidle", { timeout: 10_000 })
    .catch(() => {});
  await page.waitForTimeout(800);
}

async function openProfileState(page, profile) {
  // Operate the public inventory, never inject selection into component state.
  const row = page
    .locator('[role="listitem"], [data-myoxus-ui-role="surface-list-item"]')
    .filter({
      has: page.getByText(profile.workspace, { exact: true }),
    });
  await row.getByRole("button").click();
  await page.locator("#git-token-rotation-renew-before").waitFor();
  if (profile.state === "edit") {
    await page
      .getByRole("button", { name: "Edit", exact: true })
      .last()
      .click();
    await page.getByLabel("Repository URL", { exact: true }).waitFor();
  } else if (profile.state === "rotation") {
    await page
      .getByRole("heading", { name: "Project token rotation", exact: true })
      .scrollIntoViewIfNeeded();
  }
  await settle(page);
}

async function openActivityDisclosure(page, disclosure) {
  const panelId = await disclosure.getAttribute("aria-controls");
  await disclosure.click();
  await page.waitForFunction((id) => {
    const panel = document.getElementById(id);
    if (!panel || panel.getBoundingClientRect().height === 0) return false;
    const root = panel.closest(".mantine-Accordion-root");
    for (
      let element = panel;
      element && element !== root;
      element = element.parentElement
    ) {
      if (
        getComputedStyle(element).overflow === "hidden" &&
        element.clientHeight + 1 < element.scrollHeight
      )
        return false;
    }
    return true;
  }, panelId);
}

async function routeMetrics(page) {
  return await page.evaluate((families) => {
    const html = document.documentElement;
    const body = document.body;
    const bodyText = body.innerText || "";
    const all = Array.from(document.querySelectorAll("[class]"));
    const classHits = Object.fromEntries(families.map((family) => [family, 0]));
    const visibleClassHits = Object.fromEntries(
      families.map((family) => [family, 0]),
    );
    const sampleHits = Object.fromEntries(
      families.map((family) => [family, []]),
    );
    const isVisible = (el) => {
      const style = getComputedStyle(el);
      if (
        style.display === "none" ||
        style.visibility === "hidden" ||
        style.opacity === "0"
      ) {
        return false;
      }
      const rect = el.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    };
    const isPreview = (el) =>
      Boolean(
        el.closest(
          [
            "[data-myoxus-preview]",
            '[data-admin-visual-role*="preview" i]',
            '[data-myoxus-ui-role*="preview" i]',
            '[class*="preview" i]',
            '[class*="theme-card" i]',
            '[class*="typography-sample" i]',
            '[class*="font-sample" i]',
          ].join(","),
        ),
      );

    for (const el of all) {
      const className = String(el.className || "");
      const visible = isVisible(el);
      for (const family of families) {
        if (className.includes(family)) {
          classHits[family] += 1;
          if (visible) visibleClassHits[family] += 1;
          if (sampleHits[family].length < 5) sampleHits[family].push(className);
        }
      }
    }

    const signatures = new Map();
    const chromeSignatures = new Map();
    const tinyVisibleText = [];
    const textNodes = Array.from(
      document.querySelectorAll(
        "h1,h2,h3,h4,h5,h6,p,button,a,label,th,td,span,strong",
      ),
    )
      .filter(isVisible)
      .slice(0, 5000);
    for (const el of textNodes) {
      const style = getComputedStyle(el);
      const sig = `${style.fontFamily}|${style.fontSize}|${style.fontWeight}|${style.lineHeight}|${style.letterSpacing}|${style.textTransform}`;
      signatures.set(sig, (signatures.get(sig) || 0) + 1);
      if (!isPreview(el)) {
        chromeSignatures.set(sig, (chromeSignatures.get(sig) || 0) + 1);
      }
      const fontSize = Number.parseFloat(style.fontSize);
      const text = el.textContent?.replace(/\s+/g, " ").trim() ?? "";
      if (
        text &&
        fontSize > 0 &&
        fontSize < 10 &&
        tinyVisibleText.length < 20
      ) {
        tinyVisibleText.push({
          text: text.slice(0, 80),
          fontSize: style.fontSize,
          selector:
            el.getAttribute("data-myoxus-ui-role") ||
            el.getAttribute("data-testid") ||
            el.className?.toString().slice(0, 100) ||
            el.tagName.toLowerCase(),
        });
      }
    }

    return {
      title: document.title,
      h1: Array.from(document.querySelectorAll("h1"))
        .filter(isVisible)
        .map((el) => el.textContent?.trim())
        .filter(Boolean)
        .slice(0, 4),
      keyLeaks: (bodyText.match(/admin\.[a-z0-9_.-]+/gi) || []).slice(0, 20),
      fatalText:
        /unerwarteter Fehler|unexpected error|Irgendetwas stimmt nicht|can't access property|ReferenceError|TypeError/i.test(
          bodyText,
        ),
      horizontalOverflow: Math.max(0, body.scrollWidth - html.clientWidth),
      verticalScrollable: body.scrollHeight > html.clientHeight + 8,
      classHits,
      visibleClassHits,
      sampleHits,
      typographySignatureCount: signatures.size,
      chromeTypographySignatureCount: chromeSignatures.size,
      topTypographySignatures: Array.from(signatures.entries())
        .sort((a, b) => b[1] - a[1])
        .slice(0, 12),
      topChromeTypographySignatures: Array.from(chromeSignatures.entries())
        .sort((a, b) => b[1] - a[1])
        .slice(0, 12),
      tinyVisibleText,
    };
  }, classFamilies);
}

mkdirSync(outputDir, { recursive: true });
const targets = routeTargets();
if (targets.length === 0) {
  throw new Error(
    "No authenticated admin route targets selected. Check matrix or --routes filter.",
  );
}

const browser = await chromium.launch({
  headless: true,
  ...(executablePath ? { executablePath } : {}),
});

const base = new URL(baseURL);
const report = {
  generatedAt: new Date().toISOString(),
  sourceCommit,
  sourceDirty,
  servedSourceRoot,
  baseURL,
  matrix: path.relative(repoRoot, matrixPath),
  themes: themeFilter,
  viewport,
  outputFormat,
  routeCount: targets.length,
  classFamilies,
  screenshotsDir: path.relative(repoRoot, outputDir),
  routes: [],
};

try {
  const context = await browser.newContext({
    baseURL,
    viewport,
    deviceScaleFactor: 1,
  });
  await context.addCookies([
    {
      name: "affine_session",
      value: session,
      domain: base.hostname,
      path: "/",
      sameSite: "Lax",
    },
  ]);

  for (const theme of themeFilter) {
    for (const target of targets) {
      const page = await context.newPage();
      const consoleMessages = [];
      const pageErrors = [];
      const requestFailures = [];
      const httpErrors = [];
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
      page.on("requestfailed", (request) => {
        const url = new URL(request.url());
        requestFailures.push({
          method: request.method(),
          url: `${url.origin}${url.pathname}`,
          error: request.failure()?.errorText ?? "unknown request failure",
        });
      });
      page.on("response", (response) => {
        if (response.status() < 400) return;
        const url = new URL(response.url());
        httpErrors.push({
          method: response.request().method(),
          url: `${url.origin}${url.pathname}`,
          status: response.status(),
        });
      });
      const entry = {
        theme,
        viewport,
        ...target,
        path: target.path,
        consoleMessages,
        pageErrors,
        requestFailures,
        httpErrors,
      };
      const releaseDashboardResponses = [];
      try {
        let dashboardResponseState = target.dashboard?.initialFailure
          ? "error"
          : "real";
        if (target.dashboard) {
          await page.route("**/graphql*", async (route) => {
            if (
              route.request().postDataJSON()?.operationName !== "adminDashboard"
            ) {
              await route.continue();
              return;
            }
            if (dashboardResponseState === "pending") {
              await new Promise((resolve) => {
                releaseDashboardResponses.push(resolve);
              });
            }
            if (dashboardResponseState === "error") {
              await route.fulfill({
                status: 200,
                contentType: "application/json",
                body: JSON.stringify({
                  errors: [{ message: "QA: dashboard refresh rejected" }],
                  data: null,
                }),
              });
            } else if (dashboardResponseState === "incomplete") {
              await route.fulfill({
                status: 200,
                contentType: "application/json",
                body: JSON.stringify({
                  data: {
                    admin: {
                      adminDashboard: { generatedAt: new Date().toISOString() },
                    },
                  },
                }),
              });
            } else if (target.dashboard.sampleHistory) {
              const response = await route.fetch();
              const body = await response.json();
              const model = body.data?.admin?.adminDashboard;
              if (!model)
                throw new Error(
                  "Dashboard fixture needs a successful real server projection",
                );
              if (model.syncActiveUsersTimeline) {
                const from = Date.parse(model.syncWindow.from);
                const span = Date.parse(model.syncWindow.to) - from;
                model.syncActiveUsersTimeline = Array.from(
                  { length: 12 },
                  (_, index) => ({
                    minute: new Date(from + (span * index) / 11).toISOString(),
                    activeUsers: index % 4 === 0 ? 0 : index,
                  }),
                );
                const start = Date.parse(model.storageWindow.from);
                model.workspaceStorageHistory = Array.from(
                  { length: 12 },
                  (_, index) => ({
                    date: new Date(start + index * 86400000)
                      .toISOString()
                      .slice(0, 10),
                    value: index * 1024,
                  }),
                );
                model.blobStorageHistory = model.workspaceStorageHistory
                  .filter((_, index) => index !== 4 && index !== 5)
                  .map((point, index) => ({
                    date: point.date,
                    value: index * 2048,
                  }));
                if (target.dashboard.missingPool) model.dbPool = null;
              }
              await route.fulfill({ response, body: JSON.stringify(body) });
            } else {
              await route.continue();
            }
          });
        }
        if (target.typography?.rejectSave) {
          await page.route("**/graphql*", async (route) => {
            if (
              route.request().postDataJSON()?.operationName !==
              "adminSetTypographyStyles"
            ) {
              await route.continue();
              return;
            }
            await route.fulfill({
              status: 200,
              contentType: "application/json",
              body: JSON.stringify({
                errors: [
                  {
                    message:
                      "QA: typography write rejected (no server mutation)",
                  },
                ],
                data: null,
              }),
            });
          });
        }
        if (target.brandingIdentityError) {
          await page.route("**/graphql*", async (route) => {
            const body = route.request().postDataJSON();
            if (body?.operationName !== "adminUpdateOrganizationIdentity") {
              await route.continue();
              return;
            }
            await route.fulfill({
              status: 200,
              contentType: "application/json",
              body: JSON.stringify({
                errors: [
                  {
                    message: "QA: identity write rejected (no server mutation)",
                  },
                ],
                data: null,
              }),
            });
          });
        }
        await page.addInitScript((mode) => {
          // Seed the public preference before React initializes both providers.
          localStorage.setItem("myoxus-theme", mode);
        }, theme);
        await page.goto(target.path, {
          waitUntil: "domcontentloaded",
          timeout: 30_000,
        });
        entry.finalUrl = page.url();
        await settle(page);
        await page.waitForFunction((mode) => {
          // The persisted choice remains system; both rendering providers
          // publish its resolved light/dark value on the document.
          const resolved =
            mode === "system"
              ? window.matchMedia("(prefers-color-scheme: dark)").matches
                ? "dark"
                : "light"
              : mode;
          return (
            localStorage.getItem("myoxus-theme") === mode &&
            document.documentElement.dataset.theme === resolved &&
            document.documentElement.dataset.mantineColorScheme === resolved
          );
        }, theme);
        entry.effectiveTheme = await page.evaluate(() => ({
          preference: localStorage.getItem("myoxus-theme"),
          myoxus: document.documentElement.dataset.theme,
          mantine: document.documentElement.dataset.mantineColorScheme,
        }));
        if (target.securityJourney) {
          const scenario = target.securityJourney;
          const readSelection = async () => ({
            url: page.url(),
            selected: await page
              .getByRole("tab", { selected: true })
              .textContent(),
          });
          entry.securityJourney = [];
          if (scenario.draft) {
            await page.getByTestId("security-oauth-provider-google").click();
            await page.locator("#google-client-id").fill("qa-unsaved-client");
            await page.getByTestId("security-tab-trigger-cors").click();
            await page
              .getByTestId("security-tab-trigger-cors")
              .press("ArrowLeft");
            await page
              .locator("#google-client-id")
              .waitFor({ state: "visible" });
            const retained =
              (await page.locator("#google-client-id").inputValue()) ===
              "qa-unsaved-client";
            entry.securityJourney.push({
              draftRetained: retained,
              ...(await readSelection()),
            });
            if (scenario.requireCorrect && !retained)
              throw new Error("OAuth draft lost on tab reactivation");
          }
          if (scenario.history) {
            await page.getByTestId("security-tab-trigger-cors").click();
            await page.getByTestId("security-tab-trigger-captcha").click();
            entry.securityJourney.push({
              action: "pointer-captcha",
              ...(await readSelection()),
            });
            if (new URL(page.url()).searchParams.get("tab") !== "captcha") {
              entry.securityJourney.push({
                finding: "tab URL not updated; no tab history exists",
              });
              if (scenario.requireCorrect)
                throw new Error("Security tab URL is stale");
            } else {
              await page.goBack();
              await page.getByTestId("security-tab-trigger-cors").waitFor();
              await page.waitForFunction(
                () =>
                  document
                    .querySelector('[data-testid="security-tab-trigger-cors"]')
                    ?.getAttribute("aria-selected") === "true",
              );
              entry.securityJourney.push({
                action: "back",
                ...(await readSelection()),
              });
              await page.goForward();
              await page.waitForFunction(
                () =>
                  document
                    .querySelector(
                      '[data-testid="security-tab-trigger-captcha"]',
                    )
                    ?.getAttribute("aria-selected") === "true",
              );
              entry.securityJourney.push({
                action: "forward",
                ...(await readSelection()),
              });
              await page.reload();
              await settle(page);
              await page.waitForFunction(
                () =>
                  document
                    .querySelector(
                      '[data-testid="security-tab-trigger-captcha"]',
                    )
                    ?.getAttribute("aria-selected") === "true",
              );
              entry.securityJourney.push({
                action: "reload",
                ...(await readSelection()),
              });
            }
          }
          entry.finalUrl = page.url();
        }
        if (target.dashboard) {
          const scenario = target.dashboard;
          entry.dashboardJourney = [];
          for (const [id, value, unit] of [
            ["sync-history-window", scenario.syncHours, "hours"],
            ["storage-history-window", scenario.storageDays, "days"],
          ]) {
            if (value === undefined) continue;
            const keyboardSelection =
              scenario.keyboard && id === "sync-history-window" && value === 6;
            if (keyboardSelection) {
              await page.locator(`#${id}`).press("ArrowDown");
              await page
                .getByRole("option", { name: "48 hours", exact: true })
                .waitFor();
            } else {
              await page.locator(`#${id}`).click();
            }
            const response = page.waitForResponse((response) => {
              if (!response.url().includes("/graphql")) return false;
              const body = response.request().postDataJSON();
              return (
                body?.operationName === "adminDashboard" &&
                body.variables.input[
                  id === "sync-history-window"
                    ? "syncHistoryHours"
                    : "storageHistoryDays"
                ] === value
              );
            });
            if (
              scenario.keyboard &&
              id === "sync-history-window" &&
              value === 6
            ) {
              await page.locator(`#${id}`).press("ArrowUp");
              await page.locator(`#${id}`).press("ArrowUp");
              await page.locator(`#${id}`).press("ArrowUp");
              await page.locator(`#${id}`).press("Enter");
            } else {
              await page
                .getByRole("option", { name: `${value} ${unit}`, exact: true })
                .click();
            }
            const readback = (await (await response).json()).data.admin
              .adminDashboard;
            const window =
              id === "sync-history-window"
                ? readback.syncWindow
                : readback.storageWindow;
            entry.dashboardJourney.push({
              control: id,
              requested: value,
              serverWindow: window,
              keyboard: Boolean(
                scenario.keyboard && id === "sync-history-window",
              ),
            });
            await settle(page);
          }
          if (scenario.refreshState) {
            dashboardResponseState = scenario.refreshState;
            await page
              .getByRole("button", { name: "Refresh", exact: true })
              .click();
            await page.getByTestId("dashboard-data-status").waitFor();
            if (scenario.refreshState !== "pending") {
              await page
                .getByTestId("dashboard-data-status")
                .getByRole("button", { name: "Retry", exact: true })
                .waitFor();
            }
            entry.dashboardJourney.push({
              refreshState: scenario.refreshState,
              notice: await page
                .getByTestId("dashboard-data-status")
                .innerText(),
            });
          }
          if (scenario.initialFailure) {
            await page.getByTestId("dashboard-data-error").waitFor();
            dashboardResponseState = "real";
            await page
              .getByRole("button", { name: "Retry", exact: true })
              .click();
            await page.locator("#sync-history-window").waitFor();
            entry.dashboardJourney.push({
              initialFailure: true,
              retryRecovered: true,
            });
          }
          if (scenario.sampleHistory)
            entry.dashboardJourney.push({
              supplementalFixture:
                "history samples on real operational projection",
            });
          if (scenario.scrollHeading)
            await page
              .getByRole("heading", {
                name: scenario.scrollHeading,
                exact: true,
              })
              .scrollIntoViewIfNeeded();
          if (scenario.openDetails) {
            await page
              .getByRole("link", {
                name: `Details: ${scenario.openDetails}`,
                exact: true,
              })
              .press("Enter");
            await settle(page);
            entry.finalUrl = page.url();
            entry.dashboardJourney.push({
              details: scenario.openDetails,
              finalUrl: entry.finalUrl,
            });
          }
        }
        if (target.typography) {
          const scenario = target.typography;
          if (scenario.workspaceId) {
            await page
              .getByTestId(`workspace-soft-row-${scenario.workspaceId}`)
              .click();
            await page
              .getByRole("tab", { name: "Branding", exact: true })
              .click();
          }
          const editor = scenario.workspaceId
            ? page.getByTestId("workspace-typography-editor")
            : page;
          await editor
            .getByTestId(`typography-tab-${scenario.tab ?? "hierarchy"}`)
            .click();
          if (scenario.draftFamily) {
            const family = editor.locator("#h1-family");
            await family.fill(scenario.draftFamily);
            await family.press("ArrowDown");
            await family.press("Enter");
          }
          if (scenario.draftSize !== undefined) {
            await editor.locator("#h1-size").fill(String(scenario.draftSize));
          }
          if (scenario.rejectSave) {
            await editor.getByTestId("typography-save").click();
            await editor.getByTestId("typography-save-error").waitFor();
            if (
              (await editor.locator("#h1-size").inputValue()) !==
              String(scenario.draftSize)
            )
              throw new Error("Rejected typography draft was lost");
          }
          if (scenario.workspaceId) {
            await editor
              .getByRole("heading", {
                name: "Workspace typography",
                exact: true,
              })
              .scrollIntoViewIfNeeded();
          }
          if (scenario.draftFamily) {
            // Flush the new preview style before awaiting its font-loading cycle.
            await editor
              .getByTestId("hierarchy-h1-preview")
              .evaluate((frame) => frame.getBoundingClientRect().width);
            await page.evaluate(async () => {
              await document.fonts.ready;
            });
            entry.typographyPreview = await editor
              .getByTestId("hierarchy-h1-preview")
              .evaluate((frame) => {
                const text = frame.querySelector("p");
                const style = getComputedStyle(text);
                const glyphs = document.createRange();
                glyphs.selectNodeContents(text);
                return {
                  family: style.fontFamily,
                  size: style.fontSize,
                  weight: style.fontWeight,
                  loaded: document.fonts.check(
                    `${style.fontWeight} ${style.fontSize} ${style.fontFamily}`,
                  ),
                  fontFaces: Array.from(document.fonts)
                    .filter(
                      (face) =>
                        face.family.replaceAll('"', "") ===
                        style.fontFamily.replaceAll('"', ""),
                    )
                    .map((face) => ({
                      family: face.family,
                      weight: face.weight,
                      status: face.status,
                    })),
                  fontFaceCount: document.fonts.size,
                  glyphBounds: glyphs.getBoundingClientRect().toJSON(),
                  frameBounds: frame.getBoundingClientRect().toJSON(),
                };
              });
          }
        }
        if (target.brandingIdentityError) {
          await page
            .getByLabel("Legal name", { exact: true })
            .fill(
              "Myoxus isolated QA: long legal name retained after rejected Save",
            );
          await page
            .getByLabel("Address lines", { exact: true })
            .fill(
              "Test Street 1\nLong additional address line for isolated visual QA\n12345 Test City",
            );
          await page.getByRole("button", { name: "Save", exact: true }).click();
          await page
            .getByText("QA: identity write rejected (no server mutation)", {
              exact: true,
            })
            .first()
            .waitFor();
          entry.identityDraftRetained =
            (await page
              .getByLabel("Legal name", { exact: true })
              .inputValue()) ===
            "Myoxus isolated QA: long legal name retained after rejected Save";
          if (!entry.identityDraftRetained)
            throw new Error("Rejected identity draft was lost");
        }
        if (target.profile) await openProfileState(page, target.profile);
        for (const id of target.aiDetails ?? []) {
          const control = page.getByTestId(id);
          if (await control.count())
            await openActivityDisclosure(page, control);
        }
        if (target.aiScrollHeading) {
          await page
            .getByRole("heading", { name: target.aiScrollHeading, exact: true })
            .scrollIntoViewIfNeeded();
        }
        if (target.aiScrollFooter) {
          await page
            .getByRole("button", { name: "Save", exact: true })
            .scrollIntoViewIfNeeded();
        }
        for (const providerId of target.aiProviders) {
          const row = page.getByTestId(`provider-card-${providerId}`);
          const control = row.getByRole("button", { expanded: false });
          const panelId = await control.getAttribute("aria-controls");
          if (panelId) await openActivityDisclosure(page, control);
          else await control.click();
          await page.locator(`#${providerId}-apiKey`).waitFor();
        }
        if (target.aiProviders.length) {
          await page
            .getByTestId(`provider-card-${target.aiProviders.at(-1)}`)
            .scrollIntoViewIfNeeded();
        }
        if (target.aiEmbedding) {
          const control = page.getByTestId("embedding-section-toggle");
          const panelId = await control.getAttribute("aria-controls");
          if (panelId) await openActivityDisclosure(page, control);
          else await control.click();
          await page.getByTestId("embedding-model-input").waitFor();
          await page
            .getByTestId("embedding-model-input")
            .scrollIntoViewIfNeeded();
        }
        if (target.activityWorkspace) {
          const picker = page.getByTestId("git-sync-activity-workspace-picker");
          await picker.getByRole("combobox").fill(target.activityWorkspace);
          await page
            .getByRole("option")
            .filter({ hasText: target.activityWorkspace })
            .click();
          await page
            .getByRole("heading", { name: "Document conflicts", exact: true })
            .waitFor();
          // Both candidates use public disclosure controls; the baseline exposes details inline.
          for (const label of target.activityPaths) {
            await page.getByText(label, { exact: true }).waitFor();
            const disclosure = page.getByRole("button", {
              name: label,
              exact: false,
            });
            if (await disclosure.count()) {
              await openActivityDisclosure(page, disclosure);
            }
          }
          if (target.activityRunJob) {
            const details = page.getByRole("button", {
              name: "Technical details",
              exact: true,
            });
            if (await details.count())
              await openActivityDisclosure(
                page,
                details.nth(target.activityRunIndex ?? 0),
              );
            await page
              .getByText(target.activityRunJob, { exact: true })
              .scrollIntoViewIfNeeded();
          }
          if (target.activityConfirm) {
            await page
              .getByRole("button", {
                name: target.activityConfirm,
                exact: true,
              })
              .click();
            await page.getByRole("dialog").waitFor();
          }
        }
        Object.assign(entry, await routeMetrics(page));
        const file = screenshotName(theme, target.id, outputFormat);
        writeFileSync(path.join(outputDir, file), await screenshotBuffer(page));
        entry.screenshot = file;
        if (releaseDashboardResponses.length) {
          // Release delayed responses after the screenshot, before closing the page.
          for (const release of releaseDashboardResponses) release();
          await page
            .getByTestId("dashboard-data-status")
            .waitFor({ state: "hidden" });
        }
      } catch (error) {
        entry.error = String(error?.stack || error?.message || error);
      } finally {
        for (const release of releaseDashboardResponses) release();
        await page.close();
      }
      report.routes.push(entry);
      const residual = entry.visibleClassHits
        ? Object.values(entry.visibleClassHits).reduce(
            (sum, count) => sum + count,
            0,
          )
        : 0;
      console.log(
        `${theme.padEnd(5)} ${target.id.padEnd(32)} ${entry.error ? "ERROR" : "ok"} console=${consoleMessages.length} pageErrors=${pageErrors.length} requestFailures=${requestFailures.length} httpErrors=${httpErrors.length} residualClasses=${residual}`,
      );
      if (entry.error) console.error(entry.error);
    }
  }
  await context.close();
} finally {
  await browser.close();
}

const reportPath = path.join(outputDir, "report.json");
writeFileSync(reportPath, JSON.stringify(report, null, 2));
console.log(
  `admin visual baseline report: ${path.relative(repoRoot, reportPath)}`,
);

const fatalRoutes = report.routes.filter(
  (route) => route.error || route.pageErrors.length || route.fatalText,
);
if (
  fatalRoutes.length > 0 &&
  process.env.MYOXUS_ADMIN_VISUAL_FAIL_ON_FATAL === "1"
) {
  console.error(
    `[FAIL] ${fatalRoutes.length} admin visual route(s) reported fatal errors`,
  );
  process.exit(1);
}
