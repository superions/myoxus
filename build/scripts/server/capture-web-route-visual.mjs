#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later

import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { chromium, request as playwrightRequest } from "playwright";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../..",
);

const args = process.argv.slice(2);

function values(name) {
  const prefix = `${name}=`;
  const out = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === name) {
      out.push(args[index + 1]);
      index += 1;
    } else if (arg.startsWith(prefix)) {
      out.push(arg.slice(prefix.length));
    }
  }
  return out.filter((value) => value !== undefined);
}

function value(name, fallback) {
  return values(name).at(-1) ?? fallback;
}

function hasFlag(name) {
  return args.includes(name);
}

function fail(message) {
  console.error(`[FAIL] ${message}`);
  process.exit(1);
}

function usage() {
  console.log(`Usage:
  build/scripts/server/capture-web-route-visual.sh \\
    --url=/workspace/<id>/all \\
    --name=all-docs-view-toggle \\
    --viewport=desktop:1440x1000 \\
    --theme=light \\
    --wait-selector='[data-myoxus-ui-role="settings-radio-group"]' \\
    --require-probe='view-toggle=[data-myoxus-ui-role="settings-radio-group"]' \\
    --expect-zero='legacy=[class*="view-toggle"]'

Options:
  --url=<url>                 Required. Absolute URL or path relative to --base-url.
  --base-url=<url>            Default: MYOXUS_FRONTEND_BASE_URL or http://127.0.0.1:3011.
  --api-url=<url>             Default: --base-url. Used for optional API sign-in.
  --name=<slug>               Output file prefix. Defaults to a URL-derived slug.
  --output-dir=<dir>          Default: output/playwright/web-route-visual-<timestamp>.
  --viewport=<label:WxH>      Repeatable. Default: desktop:1440x1000.
  --theme=<light|dark|system> Repeatable. Default: light. System stores the
                              preference and lets the app resolve light/dark.
  --headed                    Run Chromium with a visible display. Use with
                              xvfb-run on headless hosts when transformed GPU
                              editor layers make headless captures unreliable.
  --settle-ms=<milliseconds>  Additional paint-settling delay after network
                              idle. Default: 350; maximum: 30000.
  --wait-selector=<selector>  Repeatable selector waited for before capture.
  --post-interaction-wait-selector=<selector>
                               Repeatable selector waited for after all interactions.
  --click-selector=<selector> Repeatable selector clicked after wait selectors.
  --dblclick-selector=<selector>
                              Repeatable selector double-clicked after clicks.
  --fill-selector=<selector>  Repeatable selector filled after clicks. Pair each
                              occurrence with one --fill-value in the same order.
  --fill-value=<text>         Repeatable value paired with --fill-selector.
  --press-key=<key>           Repeatable Playwright keyboard key pressed after fills.
  --hover-selector=<selector> Repeatable selector hovered after clicks.
  --focus-selector=<selector> Repeatable selector focused after clicks/hovers.
  --probe=<label=selector>    Repeatable optional DOM probe recorded in report.
  --require-probe=<label=selector>
                              Repeatable DOM probe that must match at least one
                              visible node in every capture. Prefer this for
                              slice-critical Facade roles so stale selectors do
                              not produce false-positive visual evidence.
  --require-exists=<label=selector>
                              Repeatable DOM probe that must match at least one
                              node in every capture, even when that node is not
                              visible. Use for mounted portals or measurement
                              sentinels that can have zero height by design.
  --expect-zero=<label=selector>
                               Repeatable selector that must match zero nodes.
  --local-storage=<key=value>  Repeatable localStorage entry applied before navigation.
  --storage-state=<file>      Optional Playwright storage state.
  --auth                      Sign in through API before navigation.
  --no-fail-on-overflow       Do not fail on horizontal overflow.
  --no-fail-on-theme-mismatch Do not fail when the page resolves a different
                              data-theme than the requested --theme. Use only
                              for explicitly documented server-owned theme
                              override checks.
  --no-fail-on-console-error  Do not fail on browser console/page errors.

Authentication:
  Set MYOXUS_VISUAL_EMAIL and MYOXUS_VISUAL_PASSWORD when --auth is used.
  The script solves the same ALTCHA challenge contract as the smoke tests.`);
}

if (hasFlag("--help") || hasFlag("-h")) {
  usage();
  process.exit(0);
}

const baseUrl = value(
  "--base-url",
  process.env.MYOXUS_FRONTEND_BASE_URL ?? "http://127.0.0.1:3011",
);
const apiUrl = value("--api-url", process.env.MYOXUS_API_BASE_URL ?? baseUrl);
const inputUrl = value("--url");
if (!inputUrl) fail("--url is required");

const url = inputUrl.startsWith("http")
  ? inputUrl
  : new URL(inputUrl, baseUrl).toString();
const urlSlug = new URL(url).pathname.replace(/^\/+|\/+$/g, "") || "root";
const name = value("--name", urlSlug.replace(/[^a-z0-9._-]+/gi, "-"));
const outputDir = path.resolve(
  repoRoot,
  value(
    "--output-dir",
    `output/playwright/web-route-visual-${new Date().toISOString().replace(/[:.]/g, "-")}`,
  ),
);
const storageState = value("--storage-state");
const themes = values("--theme");
const viewports = values("--viewport");
const settleMs = Number(value("--settle-ms", "350"));
if (!Number.isFinite(settleMs) || settleMs < 0 || settleMs > 30_000) {
  fail("--settle-ms must be a number between 0 and 30000");
}
const waitSelectors = values("--wait-selector");
const postInteractionWaitSelectors = values("--post-interaction-wait-selector");
const clickSelectors = values("--click-selector");
const doubleClickSelectors = values("--dblclick-selector");
const fillSelectors = values("--fill-selector");
const fillValues = values("--fill-value");
const pressKeys = values("--press-key");
const hoverSelectors = values("--hover-selector");
const focusSelectors = values("--focus-selector");
const probes = values("--probe");
const requiredProbes = values("--require-probe");
const requiredExists = values("--require-exists");
const expectZero = values("--expect-zero");
const localStorageEntries = values("--local-storage");
const failOnOverflow = !hasFlag("--no-fail-on-overflow");
const failOnThemeMismatch = !hasFlag("--no-fail-on-theme-mismatch");
const failOnConsoleError = !hasFlag("--no-fail-on-console-error");
const headed = hasFlag("--headed");
const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE;
const authRequested =
  hasFlag("--auth") ||
  Boolean(
    process.env.MYOXUS_VISUAL_EMAIL && process.env.MYOXUS_VISUAL_PASSWORD,
  );

if (fillSelectors.length !== fillValues.length) {
  fail(
    `--fill-selector and --fill-value must have equal counts (got ${fillSelectors.length} and ${fillValues.length})`,
  );
}

function parseViewport(raw) {
  const [label, size] = raw.includes(":")
    ? raw.split(":", 2)
    : ["viewport", raw];
  const match = /^(\d+)x(\d+)$/i.exec(size);
  if (!match) fail(`Invalid --viewport value: ${raw}`);
  return {
    height: Number(match[2]),
    label: label || "viewport",
    width: Number(match[1]),
  };
}

function parseLabeledSelector(raw, fallbackPrefix) {
  const separator = raw.indexOf("=");
  if (separator === -1) {
    return {
      label: `${fallbackPrefix}-${createHash("sha1").update(raw).digest("hex").slice(0, 8)}`,
      selector: raw,
    };
  }
  return {
    label: raw.slice(0, separator).trim(),
    selector: raw.slice(separator + 1).trim(),
  };
}

function parseKeyValue(raw, optionName) {
  const separator = raw.indexOf("=");
  if (separator === -1 || separator === 0) {
    fail(`Invalid ${optionName} value: ${raw}`);
  }
  return {
    key: raw.slice(0, separator),
    value: raw.slice(separator + 1),
  };
}

function screenshotName({ theme, viewport }) {
  return `${name}-${theme}-${viewport.label}.png`
    .replace(/[^a-z0-9._-]+/gi, "-")
    .toLowerCase();
}

function importantConsole(msg) {
  const text = msg.text();
  if (/Download the React DevTools/.test(text)) return false;
  if (/React Router Future Flag Warning/.test(text)) return false;
  if (/Unknown project config/.test(text)) return false;
  return msg.type() === "error";
}

function hashAlgorithm(algorithm) {
  const normalized = algorithm.toLowerCase().replace(/-/g, "");
  if (["sha256", "sha384", "sha512"].includes(normalized)) return normalized;
  throw new Error(`Unsupported CAPTCHA algorithm: ${algorithm}`);
}

function solveAltchaChallenge(challenge) {
  const algorithm = hashAlgorithm(challenge.algorithm);
  const maxNumber = challenge.maxnumber ?? 100_000;
  for (let number = 0; number <= maxNumber; number += 1) {
    const candidate = createHash(algorithm)
      .update(`${challenge.salt}${number}`)
      .digest("hex");
    if (candidate === challenge.challenge) {
      return Buffer.from(
        JSON.stringify({
          algorithm: challenge.algorithm,
          challenge: challenge.challenge,
          number,
          salt: challenge.salt,
          signature: challenge.signature,
        }),
        "utf8",
      ).toString("base64");
    }
  }
  throw new Error(`Unable to solve CAPTCHA challenge up to ${maxNumber}`);
}

async function captchaHeaders(request) {
  const res = await request.get(`${apiUrl}/api/auth/challenge`, {
    headers: { Accept: "application/json" },
  });
  if (res.status() === 503) return {};
  if (!res.ok()) {
    throw new Error(
      `Failed to fetch CAPTCHA challenge: HTTP ${res.status()} ${await res.text()}`,
    );
  }
  return {
    "x-captcha-token": solveAltchaChallenge(await res.json()),
  };
}

async function signIn() {
  const email = process.env.MYOXUS_VISUAL_EMAIL;
  const password = process.env.MYOXUS_VISUAL_PASSWORD;
  if (!email || !password) {
    fail(
      "--auth requires MYOXUS_VISUAL_EMAIL and MYOXUS_VISUAL_PASSWORD. Provision local dev users via build/scripts/test/seed-test-users.sh.",
    );
  }
  const request = await playwrightRequest.newContext();
  try {
    const res = await request.post(`${apiUrl}/api/auth/sign-in`, {
      data: { email, password },
      headers: {
        "Content-Type": "application/json",
        ...(await captchaHeaders(request)),
      },
    });
    if (!res.ok()) {
      throw new Error(
        `Sign-in failed for ${email}: HTTP ${res.status()} ${await res.text()}`,
      );
    }
    return res
      .headersArray()
      .filter((header) => header.name.toLowerCase() === "set-cookie")
      .map((header) => header.value);
  } finally {
    await request.dispose();
  }
}

function cookiesFromSetCookie(setCookieHeaders) {
  return setCookieHeaders
    .map((raw) => {
      const [pair, ...attributes] = raw.split(";");
      const separator = pair.indexOf("=");
      if (separator === -1) return null;
      const name = pair.slice(0, separator).trim();
      const value = pair.slice(separator + 1).trim();
      const cookie = {
        name,
        value,
        url: baseUrl,
      };
      for (const attribute of attributes) {
        const [key, ...rest] = attribute.trim().split("=");
        const normalized = key.toLowerCase();
        const attrValue = rest.join("=");
        if (normalized === "httponly") cookie.httpOnly = true;
        if (normalized === "secure") cookie.secure = true;
        if (normalized === "samesite" && attrValue) {
          const sameSite = attrValue.toLowerCase();
          cookie.sameSite =
            sameSite === "strict"
              ? "Strict"
              : sameSite === "none"
                ? "None"
                : "Lax";
        }
      }
      return cookie;
    })
    .filter(Boolean);
}

async function applyTheme(page, theme) {
  await page.addInitScript((mode) => {
    localStorage.setItem("myoxus-theme", mode);
    localStorage.setItem("theme", mode);
    if (mode === "system") {
      // The application ThemeModeProvider owns system-theme resolution.
      // data-theme and Mantine's color-scheme attribute must contain the
      // resolved light/dark value, never the preference name "system".
      return;
    }
    const apply = () => {
      if (!document.documentElement) return;
      document.documentElement.dataset.theme = mode;
      document.documentElement.dataset.mantineColorScheme = mode;
      document.documentElement.style.colorScheme = mode;
    };
    apply();
    document.addEventListener("DOMContentLoaded", apply, { once: true });
  }, theme);
}

async function applyLocalStorage(page, entries) {
  if (!entries.length) return;
  await page.addInitScript((items) => {
    for (const { key, value } of items) {
      localStorage.setItem(key, value);
    }
  }, entries);
}

async function settle(page) {
  await page
    .waitForLoadState("networkidle", { timeout: 8_000 })
    .catch(() => undefined);
  await page.waitForTimeout(settleMs);
}

async function evaluateDom(
  page,
  parsedProbes,
  parsedRequiredProbes,
  parsedRequiredExists,
  parsedExpectZero,
) {
  return await page.evaluate(
    ({
      parsedProbes,
      parsedRequiredProbes,
      parsedRequiredExists,
      parsedExpectZero,
    }) => {
      const visible = (node) => {
        const style = window.getComputedStyle(node);
        const rect = node.getBoundingClientRect();
        return (
          style.display !== "none" &&
          style.visibility !== "hidden" &&
          style.opacity !== "0" &&
          rect.width > 0 &&
          rect.height > 0
        );
      };
      const inspectSelector = ({ label, selector }) => {
        try {
          const nodes = Array.from(document.querySelectorAll(selector));
          return {
            count: nodes.length,
            label,
            rects: nodes.slice(0, 10).map((node) => {
              const rect = node.getBoundingClientRect();
              const style = window.getComputedStyle(node);
              return {
                computed: {
                  display: style.display,
                  height: style.height,
                  maxHeight: style.maxHeight,
                  minHeight: style.minHeight,
                  overflow: style.overflow,
                  paddingBlockEnd: style.paddingBlockEnd,
                  paddingBlockStart: style.paddingBlockStart,
                },
                height: Math.round(rect.height),
                text: node.textContent
                  ?.replace(/\s+/g, " ")
                  .trim()
                  .slice(0, 120),
                visible: visible(node),
                width: Math.round(rect.width),
                x: Math.round(rect.x),
                y: Math.round(rect.y),
              };
            }),
            selector,
            selectorError: null,
            visibleCount: nodes.filter(visible).length,
          };
        } catch (error) {
          return {
            count: 0,
            label,
            rects: [],
            selector,
            selectorError: String(error?.message || error),
            visibleCount: 0,
          };
        }
      };
      const documentWidth = document.documentElement.clientWidth;
      const scrollWidth = Math.max(
        document.documentElement.scrollWidth,
        document.body?.scrollWidth ?? 0,
      );
      return {
        bodyTextSample: document.body.innerText
          ?.replace(/\s+/g, " ")
          .trim()
          .slice(0, 500),
        documentTitle: document.title,
        expectZero: parsedExpectZero.map(inspectSelector),
        horizontalOverflow: scrollWidth > documentWidth,
        probes: parsedProbes.map(inspectSelector),
        requiredExists: parsedRequiredExists.map(inspectSelector),
        requiredProbes: parsedRequiredProbes.map(inspectSelector),
        themeState: {
          colorScheme: document.documentElement.style.colorScheme || null,
          computedColorScheme:
            window.getComputedStyle(document.documentElement).colorScheme ||
            null,
          dataMantineColorScheme:
            document.documentElement.dataset.mantineColorScheme || null,
          dataTheme: document.documentElement.dataset.theme || null,
          storedTheme: window.localStorage.getItem("myoxus-theme"),
        },
        viewport: {
          devicePixelRatio: window.devicePixelRatio,
          height: window.innerHeight,
          width: window.innerWidth,
        },
      };
    },
    {
      parsedExpectZero,
      parsedProbes,
      parsedRequiredExists,
      parsedRequiredProbes,
    },
  );
}

mkdirSync(outputDir, { recursive: true });

const parsedThemes = themes.length ? themes : ["light"];
const parsedViewports = viewports.length
  ? viewports.map(parseViewport)
  : [parseViewport("desktop:1440x1000")];
const parsedProbes = probes.map((raw) => parseLabeledSelector(raw, "probe"));
const parsedRequiredProbes = requiredProbes.map((raw) =>
  parseLabeledSelector(raw, "require-probe"),
);
const parsedRequiredExists = requiredExists.map((raw) =>
  parseLabeledSelector(raw, "require-exists"),
);
const parsedExpectZero = expectZero.map((raw) =>
  parseLabeledSelector(raw, "expect-zero"),
);
const parsedLocalStorageEntries = localStorageEntries.map((raw) =>
  parseKeyValue(raw, "--local-storage"),
);

const browser = await chromium.launch({
  executablePath,
  headless: !headed,
});
const report = {
  apiUrl,
  baseUrl,
  captures: [],
  failures: [],
  generatedAt: new Date().toISOString(),
  headed,
  localStorageKeys: parsedLocalStorageEntries.map(({ key }) => key),
  outputDir,
  settleMs,
  url,
};

try {
  const setCookieHeaders = authRequested ? await signIn() : [];

  for (const theme of parsedThemes) {
    for (const viewport of parsedViewports) {
      const context = await browser.newContext({
        colorScheme:
          theme === "dark"
            ? "dark"
            : theme === "system"
              ? "no-preference"
              : "light",
        storageState,
        viewport: { width: viewport.width, height: viewport.height },
      });
      if (setCookieHeaders.length) {
        await context.addCookies(cookiesFromSetCookie(setCookieHeaders));
      }
      const page = await context.newPage();
      const consoleMessages = [];
      const pageErrors = [];
      page.on("console", (msg) => {
        if (importantConsole(msg)) {
          consoleMessages.push({
            location: msg.location(),
            text: msg.text(),
            type: msg.type(),
          });
        }
      });
      page.on("pageerror", (error) => {
        pageErrors.push(String(error?.stack || error?.message || error));
      });
      await applyTheme(page, theme);
      await applyLocalStorage(page, parsedLocalStorageEntries);

      const capture = {
        consoleMessages,
        interactionFailures: [],
        pageErrors,
        screenshot: null,
        theme,
        viewport,
        waitFailures: [],
      };
      try {
        await page.goto(url, {
          timeout: 30_000,
          waitUntil: "domcontentloaded",
        });
        for (const selector of waitSelectors) {
          try {
            await page.waitForSelector(selector, {
              state: "visible",
              timeout: 12_000,
            });
          } catch (error) {
            capture.waitFailures.push({
              error: String(error?.message || error),
              selector,
            });
          }
        }
        for (const selector of clickSelectors) {
          try {
            await page.locator(selector).first().click({ timeout: 8_000 });
            await page.waitForTimeout(150);
          } catch (error) {
            capture.interactionFailures.push({
              action: "click",
              error: String(error?.message || error),
              selector,
            });
          }
        }
        for (const selector of doubleClickSelectors) {
          try {
            await page.locator(selector).first().dblclick({ timeout: 8_000 });
            await page.waitForTimeout(150);
          } catch (error) {
            capture.interactionFailures.push({
              action: "double-click",
              error: String(error?.message || error),
              selector,
            });
          }
        }
        for (let index = 0; index < fillSelectors.length; index += 1) {
          const selector = fillSelectors[index];
          try {
            await page
              .locator(selector)
              .first()
              .fill(fillValues[index], { timeout: 8_000 });
            await page.waitForTimeout(150);
          } catch (error) {
            capture.interactionFailures.push({
              action: "fill",
              error: String(error?.message || error),
              selector,
            });
          }
        }
        for (const key of pressKeys) {
          try {
            await page.keyboard.press(key);
            await page.waitForTimeout(150);
          } catch (error) {
            capture.interactionFailures.push({
              action: "press",
              error: String(error?.message || error),
              selector: key,
            });
          }
        }
        for (const selector of hoverSelectors) {
          try {
            await page.locator(selector).first().hover({ timeout: 8_000 });
            await page.waitForTimeout(150);
          } catch (error) {
            capture.interactionFailures.push({
              action: "hover",
              error: String(error?.message || error),
              selector,
            });
          }
        }
        for (const selector of focusSelectors) {
          try {
            await page.locator(selector).first().focus({ timeout: 8_000 });
            await page.waitForTimeout(150);
          } catch (error) {
            capture.interactionFailures.push({
              action: "focus",
              error: String(error?.message || error),
              selector,
            });
          }
        }
        for (const selector of postInteractionWaitSelectors) {
          try {
            await page.waitForSelector(selector, {
              state: "visible",
              timeout: 12_000,
            });
          } catch (error) {
            capture.waitFailures.push({
              error: String(error?.message || error),
              selector,
            });
          }
        }
        await settle(page);
        capture.finalUrl = page.url();
        capture.dom = await evaluateDom(
          page,
          parsedProbes,
          parsedRequiredProbes,
          parsedRequiredExists,
          parsedExpectZero,
        );
        const screenshotPath = path.join(outputDir, screenshotName(capture));
        // Visual evidence must describe the settled DOM, not a transient GPU
        // frame from transformed editor/canvas animations. Playwright fast-
        // forwards finite animations and cancels infinite ones for the capture,
        // then restores them, so the runtime remains unchanged.
        await page.screenshot({
          animations: "disabled",
          fullPage: false,
          path: screenshotPath,
        });
        capture.screenshot = path.relative(repoRoot, screenshotPath);

        for (const waitFailure of capture.waitFailures) {
          report.failures.push(
            `${theme}/${viewport.label}: wait selector not visible ${waitFailure.selector}: ${waitFailure.error}`,
          );
        }
        for (const interactionFailure of capture.interactionFailures) {
          report.failures.push(
            `${theme}/${viewport.label}: ${interactionFailure.action} selector failed ${interactionFailure.selector}: ${interactionFailure.error}`,
          );
        }
        if (failOnOverflow && capture.dom.horizontalOverflow) {
          report.failures.push(
            `${theme}/${viewport.label}: horizontal overflow detected`,
          );
        }
        if (
          failOnThemeMismatch &&
          (theme === "light" || theme === "dark") &&
          capture.dom.themeState.dataTheme !== theme
        ) {
          report.failures.push(
            `${theme}/${viewport.label}: requested theme ${theme} but page resolved data-theme=${capture.dom.themeState.dataTheme ?? "unset"}`,
          );
        }
        if (
          failOnThemeMismatch &&
          theme === "system" &&
          (capture.dom.themeState.storedTheme !== "system" ||
            !["light", "dark"].includes(capture.dom.themeState.dataTheme))
        ) {
          report.failures.push(
            `${theme}/${viewport.label}: system preference was not resolved to light/dark (stored=${capture.dom.themeState.storedTheme ?? "unset"}, data-theme=${capture.dom.themeState.dataTheme ?? "unset"})`,
          );
        }
        for (const item of capture.dom.expectZero) {
          if (item.selectorError) {
            report.failures.push(
              `${theme}/${viewport.label}: invalid expect-zero selector ${item.label}: ${item.selectorError}`,
            );
          } else if (item.count > 0) {
            report.failures.push(
              `${theme}/${viewport.label}: expected zero matches for ${item.label}, got ${item.count}`,
            );
          }
        }
        for (const item of capture.dom.probes) {
          if (item.selectorError) {
            report.failures.push(
              `${theme}/${viewport.label}: invalid probe selector ${item.label}: ${item.selectorError}`,
            );
          }
        }
        for (const item of capture.dom.requiredProbes) {
          if (item.selectorError) {
            report.failures.push(
              `${theme}/${viewport.label}: invalid required probe selector ${item.label}: ${item.selectorError}`,
            );
          } else if (item.visibleCount === 0) {
            report.failures.push(
              `${theme}/${viewport.label}: required probe ${item.label} has no visible matches`,
            );
          }
        }
        for (const item of capture.dom.requiredExists) {
          if (item.selectorError) {
            report.failures.push(
              `${theme}/${viewport.label}: invalid required-exists selector ${item.label}: ${item.selectorError}`,
            );
          } else if (item.count === 0) {
            report.failures.push(
              `${theme}/${viewport.label}: required-exists probe ${item.label} has no matches`,
            );
          }
        }
        if (failOnConsoleError && consoleMessages.length) {
          report.failures.push(
            `${theme}/${viewport.label}: ${consoleMessages.length} console error(s)`,
          );
        }
        if (failOnConsoleError && pageErrors.length) {
          report.failures.push(
            `${theme}/${viewport.label}: ${pageErrors.length} page error(s)`,
          );
        }
      } catch (error) {
        capture.error = String(error?.stack || error?.message || error);
        report.failures.push(`${theme}/${viewport.label}: ${capture.error}`);
      } finally {
        report.captures.push(capture);
        await context.close();
      }
    }
  }
} finally {
  await browser.close();
}

const reportPath = path.join(outputDir, `${name}-report.json`);
const canonicalReportPath = path.join(outputDir, "report.json");
const serializedReport = `${JSON.stringify(report, null, 2)}\n`;
writeFileSync(reportPath, serializedReport);
// Keep the descriptive report name for multi-state evidence while also
// satisfying the canonical visual-audit input contract.
writeFileSync(canonicalReportPath, serializedReport);

console.log(`[INFO] visual report: ${path.relative(repoRoot, reportPath)}`);
console.log(
  `[INFO] canonical visual report: ${path.relative(repoRoot, canonicalReportPath)}`,
);
for (const capture of report.captures) {
  if (capture.screenshot) {
    console.log(
      `[INFO] screenshot ${capture.theme}/${capture.viewport.label}: ${capture.screenshot}`,
    );
  }
}

if (report.failures.length) {
  for (const failure of report.failures) {
    console.error(`[FAIL] ${failure}`);
  }
  process.exit(1);
}

console.log("[PASS] web route visual capture passed");
