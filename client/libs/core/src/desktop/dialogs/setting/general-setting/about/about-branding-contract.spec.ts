// SPDX-License-Identifier: AGPL-3.0-or-later

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, test } from "vitest";

const source = readFileSync(
  fileURLToPath(new URL("./index.tsx", import.meta.url)),
  "utf8",
);
const webDockerfile = readFileSync("build/web/Dockerfile", "utf8");
const adminDockerfile = readFileSync("build/admin/Dockerfile", "utf8");

describe("About Myoxus branding contract", () => {
  test("uses the fixed canonical Myoxus wordmark instead of runtime-customizable branding", () => {
    expect(source).toContain("assets/branding/myoxus_text.svg");
    expect(source).not.toContain("assets/branding/myoxus_masc_text.svg");
    expect(source).not.toContain("BrandAssetImage");
    expect(source).not.toContain("productMark");
    expect(source).not.toContain("/api/branding");
    expect(source).not.toContain("/style/");
  });

  test("keeps the fixed Myoxus logo available in split frontend containers", () => {
    expect(webDockerfile).toContain("COPY assets/ assets/");
    expect(adminDockerfile).toContain("COPY assets/ assets/");
  });
});
