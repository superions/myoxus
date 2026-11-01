// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, test } from "vitest";

const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));

function readRepoFile(path: string) {
  return readFileSync(join(REPO_ROOT, path), "utf8");
}

function gitLsFiles(...patterns: string[]): string[] {
  const stdout = execFileSync("git", ["ls-files", "--", ...patterns], {
    cwd: REPO_ROOT,
    encoding: "utf8",
  });
  return stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

describe("Web static export hygiene", () => {
  test("legacy tracked web/admin static mirrors are no longer an active source", () => {
    expect(
      gitLsFiles("client/web/static/**", "client/admin/static/**"),
    ).toEqual([]);
  });

  test("legacy text-logo image path is not tracked or served", () => {
    for (const path of [
      "client/libs/core/public/imgs/myoxus-text-logo.png",
      "client/branding/logo.svg",
      "client/branding/product-mark.svg",
    ]) {
      expect(existsSync(join(REPO_ROOT, path)), path).toBe(false);
      expect(gitLsFiles(path), path).toEqual([]);
    }

    for (const path of [
      "build/scripts/frontends/render-basepath-nginx.sh",
      "client/frontends/nginx/myoxus.conf",
    ]) {
      const source = readRepoFile(path);
      expect(
        source,
        `${path} must not serve the retired text-logo path`,
      ).not.toContain("myoxus-text-logo");
    }
  });

  test("all frontend container/export paths prune admin test artifacts", () => {
    for (const path of [
      "build/scripts/frontends/export-prebuilt-static.sh",
      "build/web/Dockerfile",
      "build/admin/Dockerfile",
    ]) {
      const source = readRepoFile(path);
      expect(source, `${path} must remove compiled test directories`).toContain(
        "__tests__",
      );
      expect(source, `${path} must remove compiled Vitest modules`).toContain(
        "*.spec.js",
      );
      expect(
        source,
        `${path} must remove compiled source maps, including Vitest maps`,
      ).toContain("*.map");
    }
  });
});
