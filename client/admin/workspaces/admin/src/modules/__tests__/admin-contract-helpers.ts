// SPDX-License-Identifier: AGPL-3.0-or-later
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { expect } from "vitest";

const __dirnameResolved =
  typeof __dirname !== "undefined"
    ? __dirname
    : dirname(fileURLToPath(import.meta.url));

export const adminSrc = resolve(__dirnameResolved, "..", "..");
export const repoRoot = resolve(adminSrc, "..", "..", "..", "..", "..");
export const uiFacadeSrc = resolve(
  repoRoot,
  "client",
  "libs",
  "ui-facade",
  "src",
);
export const adminProductGlobalCssPath = resolve(adminSrc, "global.css");
export const adminAppCssPath = resolve(uiFacadeSrc, "admin-app.css");
export const scanRoots = [resolve(adminSrc, "modules")];
export const productScanRoots = [
  resolve(adminSrc, "modules"),
  resolve(adminSrc, "components"),
];

const fullscreenRouteModules = new Set(["auth", "config-wizard", "setup"]);

export function listSourceFiles(root: string): string[] {
  return readdirSync(root).flatMap((entry) => {
    const path = join(root, entry);
    const stat = statSync(path);
    if (stat.isDirectory()) return listSourceFiles(path);
    return /\.(ts|tsx)$/.test(path) ? [path] : [];
  });
}

export function lineNumberForMatch(
  source: string,
  match: RegExpMatchArray,
): number {
  return source.slice(0, match.index ?? 0).split("\n").length;
}

function lazyRouteModules(): string[] {
  const appSource = readFileSync(resolve(adminSrc, "app.tsx"), "utf8");
  return [
    ...appSource.matchAll(/import\([^)]*["']\.\/modules\/([^"']+)["'][^)]*\)/g),
  ].map((match) => match[1]);
}

export function shellRouteModules(): string[] {
  return lazyRouteModules().filter(
    (moduleName) => !fullscreenRouteModules.has(moduleName),
  );
}

export function usesSharedScroll(source: string, moduleName: string): boolean {
  if (/<AdminPageScroll\b/.test(source)) return true;
  // Typography embeds the shared page layout in a reusable editor surface.
  return (
    moduleName === "typography" &&
    /<ScopedTypographyEditor\b[\s\S]*?layout="page"/.test(source)
  );
}

export function productSourceFiles(): string[] {
  return productScanRoots
    .flatMap(listSourceFiles)
    .filter(
      (file) => !(file.includes("/__tests__/") || /\.spec\.tsx?$/.test(file)),
    );
}

export function cssRuleBody(css: string, selector: string): string {
  const escapedSelector = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`${escapedSelector}\\s*{([^}]*)}`).exec(css);
  expect(match, `CSS rule must exist: ${selector}`).toBeTruthy();
  return match?.[1] ?? "";
}

export function readAdminAppCss(): string {
  return readFileSync(adminAppCssPath, "utf8");
}

export function adminRelative(path: string): string {
  return relative(adminSrc, path);
}
