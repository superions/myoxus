#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Daniel Scharf and Myoxus contributors

import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, extname, resolve } from "node:path";

import { chromium } from "playwright";
import { build, createServer, preview } from "vite";

const repoRoot = resolve(import.meta.dirname, "../../..");
const integrationRoot = resolve(repoRoot, "virgultum/integration-test");
const configFile = resolve(integrationRoot, "vite.config.ts");
const tempRoot = await mkdtemp(resolve(tmpdir(), "myoxus-vite8-"));

async function filesBelow(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  return (
    await Promise.all(
      entries.map((entry) => {
        const path = resolve(directory, entry.name);
        return entry.isDirectory() ? filesBelow(path) : [path];
      }),
    )
  ).flat();
}

function addressOf(httpServer) {
  const address = httpServer?.address();
  if (!address || typeof address === "string") {
    throw new Error("Vite did not expose a TCP listen address");
  }
  return `http://127.0.0.1:${address.port}`;
}

async function assertFontRoutes(baseUrl) {
  const font = await fetch(
    `${baseUrl}/api/fonts/bebas-neue-regular-latin.woff2`,
  );
  if (!font.ok || font.headers.get("content-type") !== "font/woff2") {
    throw new Error(`valid font route failed with ${font.status}`);
  }
  if ((await font.arrayBuffer()).byteLength === 0) {
    throw new Error("valid font route returned an empty asset");
  }

  const missing = await fetch(`${baseUrl}/api/fonts/not-present.woff2`);
  if (missing.status !== 404) {
    throw new Error(`missing font returned ${missing.status}, expected 404`);
  }
  const invalid = await fetch(`${baseUrl}/api/fonts/..%2FREADME.md`);
  if (invalid.status !== 400) {
    throw new Error(
      `invalid font path returned ${invalid.status}, expected 400`,
    );
  }
  const malformed = await fetch(`${baseUrl}/api/fonts/%E0%A4%A`);
  if (malformed.status !== 400) {
    throw new Error(
      `malformed font path returned ${malformed.status}, expected 400`,
    );
  }
}

let devServer;
let previewServer;
let wasmPreview;
let browser;
try {
  const appOutDir = resolve(tempRoot, "integration-dist");
  await build({
    configFile,
    root: integrationRoot,
    logLevel: "warn",
    build: { emptyOutDir: true, outDir: appOutDir },
  });
  const appFiles = await filesBelow(appOutDir);
  if (!appFiles.some((path) => basename(path) === "index.html")) {
    throw new Error("Vite 8 integration build did not emit index.html");
  }
  if (!appFiles.some((path) => extname(path) === ".map")) {
    throw new Error("Vite 8 integration build did not emit sourcemaps");
  }

  devServer = await createServer({
    configFile,
    root: integrationRoot,
    logLevel: "error",
    server: { host: "127.0.0.1", port: 0, strictPort: true },
  });
  await devServer.listen();
  await assertFontRoutes(addressOf(devServer.httpServer));

  previewServer = await preview({
    configFile,
    root: integrationRoot,
    logLevel: "error",
    build: { outDir: appOutDir },
    preview: { host: "127.0.0.1", port: 0, strictPort: true },
  });
  await assertFontRoutes(addressOf(previewServer.httpServer));

  const wasmRoot = resolve(tempRoot, "wasm-fixture");
  const wasmOutDir = resolve(tempRoot, "wasm-dist");
  await mkdir(wasmRoot, { recursive: true });
  await writeFile(
    resolve(wasmRoot, "answer.wasm"),
    Uint8Array.from([
      0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00, 0x01, 0x05, 0x01, 0x60,
      0x00, 0x01, 0x7f, 0x03, 0x02, 0x01, 0x00, 0x07, 0x0a, 0x01, 0x06, 0x61,
      0x6e, 0x73, 0x77, 0x65, 0x72, 0x00, 0x00, 0x0a, 0x06, 0x01, 0x04, 0x00,
      0x41, 0x2a, 0x0b,
    ]),
  );
  await writeFile(
    resolve(wasmRoot, "main.js"),
    'import { answer } from "./answer.wasm";\n' +
      "document.body.dataset.wasmAnswer = String(answer());\n",
  );
  await writeFile(
    resolve(wasmRoot, "index.html"),
    '<!doctype html><body><script type="module" src="/main.js"></script></body>\n',
  );
  await build({
    configFile,
    root: wasmRoot,
    logLevel: "warn",
    build: {
      assetsInlineLimit: 0,
      emptyOutDir: true,
      outDir: wasmOutDir,
    },
  });
  const wasmFiles = await filesBelow(wasmOutDir);
  if (!wasmFiles.some((path) => extname(path) === ".wasm")) {
    throw new Error("Vite 8 WASM build did not emit a WebAssembly asset");
  }

  wasmPreview = await preview({
    configFile,
    root: wasmRoot,
    logLevel: "error",
    build: { outDir: wasmOutDir },
    preview: { host: "127.0.0.1", port: 0, strictPort: true },
  });
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  const pageErrors = [];
  page.on("console", (message) => {
    if (message.type() === "error") pageErrors.push(message.text());
  });
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.goto(addressOf(wasmPreview.httpServer), {
    waitUntil: "networkidle",
  });
  const answer = await page.locator("body").getAttribute("data-wasm-answer");
  if (answer !== "42" || pageErrors.length) {
    throw new Error(
      `WASM preview failed: answer=${answer}, errors=${pageErrors.join("; ")}`,
    );
  }

  console.log(
    "Vite 8 build, sourcemap, Dev/Preview font routes and WASM runtime verified.",
  );
} finally {
  await browser?.close();
  await wasmPreview?.close();
  await previewServer?.close();
  await devServer?.close();
  await rm(tempRoot, { force: true, recursive: true });
}
