#!/usr/bin/env node
import fs from "node:fs/promises";
import { createReadStream } from "node:fs";
import http from "node:http";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { chromium } from "playwright";

const args = new Map();
const rawArgs = process.argv.slice(2);
for (let index = 0; index < rawArgs.length; index += 1) {
  const arg = rawArgs[index];
  if (arg.includes("=")) {
    const [key, value = "true"] = arg.split("=");
    args.set(key, value);
  } else if (arg.startsWith("--") && rawArgs[index + 1] && !rawArgs[index + 1].startsWith("--")) {
    args.set(arg, rawArgs[index + 1]);
    index += 1;
  } else {
    args.set(arg, "true");
  }
}

const fixturesDir = args.get("--fixtures");
const outDir = args.get("--out") || "tmp/public-render-visual";
const verifySearch = args.has("--search");
const searchQuery = args.get("--search-query") || "public";
const siteRoot = args.get("--site-root") || defaultSiteRoot(fixturesDir);
if (!fixturesDir) {
  console.error(
    "Usage: verify-public-render.mjs --fixtures=<dir> [--out=<dir>] [--search] [--search-query=<term>] [--site-root=<dir>]",
  );
  process.exit(2);
}

async function findHtmlFiles(dir) {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await findHtmlFiles(fullPath)));
    } else if (entry.isFile() && entry.name.endsWith(".html")) {
      files.push(fullPath);
    }
  }
  return files.sort();
}

const htmlFiles = await findHtmlFiles(fixturesDir);
if (htmlFiles.length === 0) {
  throw new Error(`No HTML fixtures found in ${fixturesDir}`);
}

await fs.mkdir(outDir, { recursive: true });
const staticServer = verifySearch ? await startStaticServer(siteRoot) : null;
const browser = await chromium.launch();
const failures = [];

for (const file of htmlFiles) {
  for (const viewport of [
    { name: "desktop", width: 1440, height: 1100 },
    { name: "mobile", width: 390, height: 900 },
  ]) {
    const page = await browser.newPage({ viewport });
    const consoleErrors = [];
    page.on("console", (message) => {
      if (message.type() === "error") {
        consoleErrors.push(message.text());
      }
    });
    page.on("pageerror", (error) => {
      consoleErrors.push(error.message);
    });
    await page.goto(pageUrl(file, siteRoot, staticServer), { waitUntil: "domcontentloaded" });
    await page.waitForLoadState("load", { timeout: 5000 }).catch(() => undefined);
    const metrics = await page.evaluate(() => {
      const shell = document.querySelector(".mx-public-shell");
      const header = document.querySelector("[data-myoxus-role='public-header']");
      const content = document.querySelector("[data-pagefind-body]");
      const body = document.body;
      return {
        shellHeight: shell?.getBoundingClientRect().height ?? 0,
        headerHeight: header?.getBoundingClientRect().height ?? 0,
        contentWidth: content?.getBoundingClientRect().width ?? 0,
        overflowX: body.scrollWidth > document.documentElement.clientWidth + 1,
      };
    });
    if (verifySearch) {
      await verifyPagefindSearch(page, file, searchQuery, failures);
    }

    const base = `${safeScreenshotBase(fixturesDir, file)}-${viewport.name}`;
    try {
      await page.screenshot({
        path: path.join(outDir, `${base}.png`),
        fullPage: true,
        animations: "disabled",
        timeout: 15000,
      });
    } catch (error) {
      failures.push(`${base}: screenshot failed: ${error.message}`);
    }
    await page.close();

    if (consoleErrors.length > 0) {
      failures.push(`${base}: console errors: ${consoleErrors.join(" | ")}`);
    }
    if (metrics.shellHeight <= 0 || metrics.headerHeight <= 0 || metrics.contentWidth <= 0) {
      failures.push(`${base}: shell/header/content did not render: ${JSON.stringify(metrics)}`);
    }
    if (metrics.overflowX) {
      failures.push(`${base}: horizontal overflow detected`);
    }
  }
}

await browser.close();
if (staticServer) {
  await staticServer.close();
}
if (failures.length > 0) {
  console.error(failures.join("\n"));
  process.exit(1);
}
const searchSuffix = verifySearch ? ` with Pagefind search query "${searchQuery}"` : "";
console.log(`Verified ${htmlFiles.length} public-render fixture(s)${searchSuffix}; screenshots written to ${outDir}`);

function safeScreenshotBase(root, file) {
  const relative = path.relative(root, file).replace(/\.html$/, "");
  return relative
    .split(path.sep)
    .filter(Boolean)
    .join("__")
    .replace(/[^a-zA-Z0-9_.-]/g, "_");
}

function defaultSiteRoot(fixtures) {
  if (!fixtures) {
    return fixtures;
  }
  return path.basename(path.resolve(fixtures)) === "public" ? path.dirname(path.resolve(fixtures)) : path.resolve(fixtures);
}

function pageUrl(file, root, staticServer) {
  if (!staticServer) {
    return pathToFileURL(path.resolve(file)).href;
  }
  const relative = path.relative(path.resolve(root), path.resolve(file)).split(path.sep).join("/");
  return new URL(`/${relative}`, staticServer.origin).href;
}

async function startStaticServer(root) {
  const resolvedRoot = path.resolve(root);
  const server = http.createServer(async (request, response) => {
    const requestUrl = new URL(request.url || "/", "http://127.0.0.1");
    const decodedPath = decodeURIComponent(requestUrl.pathname);
    const candidate = path.resolve(resolvedRoot, `.${decodedPath}`);
    if (!candidate.startsWith(`${resolvedRoot}${path.sep}`) && candidate !== resolvedRoot) {
      response.writeHead(403).end("Forbidden");
      return;
    }
    const filePath = await resolveStaticFile(candidate);
    if (!filePath) {
      response.writeHead(404).end("Not found");
      return;
    }
    response.writeHead(200, { "content-type": contentType(filePath) });
    createReadStream(filePath).pipe(response);
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Could not allocate static verification server");
  }
  return {
    origin: `http://127.0.0.1:${address.port}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

async function resolveStaticFile(candidate) {
  try {
    const stat = await fs.stat(candidate);
    if (stat.isFile()) {
      return candidate;
    }
    if (stat.isDirectory()) {
      const indexPath = path.join(candidate, "index.html");
      const indexStat = await fs.stat(indexPath);
      return indexStat.isFile() ? indexPath : null;
    }
  } catch {
    return null;
  }
  return null;
}

function contentType(file) {
  if (file.endsWith(".html")) return "text/html; charset=utf-8";
  if (file.endsWith(".js")) return "text/javascript; charset=utf-8";
  if (file.endsWith(".css")) return "text/css; charset=utf-8";
  if (file.endsWith(".json")) return "application/json; charset=utf-8";
  if (file.endsWith(".wasm")) return "application/wasm";
  if (file.endsWith(".png")) return "image/png";
  if (file.endsWith(".svg")) return "image/svg+xml";
  return "application/octet-stream";
}

async function verifyPagefindSearch(page, file, query, failures) {
  const input = page.locator("[data-pagefind-search]");
  const results = page.locator("[data-pagefind-results]");
  if ((await input.count()) !== 1 || (await results.count()) !== 1) {
    failures.push(`${file}: search controls missing for --search verification`);
    return;
  }

  try {
    await page.waitForFunction(() => Boolean(window.pagefind?.search), { timeout: 5000 });
    await input.fill(query);
    await results.locator("a").first().waitFor({ state: "visible", timeout: 8000 });
    const href = await results.locator("a").first().getAttribute("href");
    const text = (await results.locator("a").first().innerText()).trim();
    if (!href || !text) {
      failures.push(`${file}: first search result is incomplete`);
    }
    if (text.includes("<mark>") || text.includes("</mark>")) {
      failures.push(`${file}: search result exposes raw Pagefind markup`);
    }
  } catch (error) {
    failures.push(`${file}: Pagefind search did not produce visible results: ${error.message}`);
  }
}
