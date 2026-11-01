// SPDX-License-Identifier: AGPL-3.0-or-later

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, test } from "vitest";

const repoRoot = process.cwd();
const signInRoot = "client/libs/core/src/mobile/components/sign-in";
const deletedLocalChromePaths = [
  "background.css",
  "background.styles.ts",
  "background.tsx",
  "layout.css",
  "layout.styles.ts",
  "art-dark.inline.svg",
  "art-light.inline.svg",
].map((path) => `${signInRoot}/${path}`);

function readRepoFile(path: string): string {
  return readFileSync(join(repoRoot, path), "utf8");
}

describe("mobile sign-in facade contract", () => {
  test("uses the shared auth shell instead of mobile-local background chrome", () => {
    const layout = readRepoFile(`${signInRoot}/layout.tsx`);

    for (const path of deletedLocalChromePaths) {
      expect(existsSync(join(repoRoot, path)), path).toBe(false);
    }

    for (const primitive of [
      "AuthBackgroundArt",
      "SignInPageContainer",
      "Stack",
    ]) {
      expect(layout, primitive).toContain(primitive);
    }

    expect(layout).toContain('data-myoxus-ui-role="mobile-sign-in-content"');
  });

  test("does not reintroduce mobile sign-in style modules, SVG art or manual responsiveness", () => {
    const layout = readRepoFile(`${signInRoot}/layout.tsx`);
    const index = readRepoFile(`${signInRoot}/index.tsx`);
    const combined = `${layout}\n${index}`;

    for (const forbidden of [
      "SignInBackground",
      "background.styles",
      "layout.styles",
      "art-dark.inline.svg",
      "art-light.inline.svg",
      "style={{",
      "matchMedia",
      "innerWidth",
      "innerHeight",
    ]) {
      expect(combined).not.toContain(forbidden);
    }

    expect(combined).not.toMatch(/\b\d+(?:\.\d+)?px\b/);
  });
});
