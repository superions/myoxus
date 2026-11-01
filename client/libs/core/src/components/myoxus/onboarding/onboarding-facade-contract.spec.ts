// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, test } from "vitest";

const root = process.cwd();
const onboardingRoot = "client/libs/core/src/components/myoxus/onboarding";
const onboardingSource = `${onboardingRoot}/onboarding.tsx`;

const removedLegacyFiles = [
  "animate-in-tooltip.css",
  "animate-in-tooltip.styles.ts",
  "animate-in-tooltip.tsx",
  "articles/blocks.css",
  "articles/blocks.styles.ts",
  "articles/index.tsx",
  "curve-paper/paper.css",
  "curve-paper/paper.styles.ts",
  "curve-paper/paper.tsx",
  "paper-steps.tsx",
  "steps/animate-in.css",
  "steps/animate-in.styles.ts",
  "steps/edgeless-switch.css",
  "steps/edgeless-switch.styles.ts",
  "steps/unfolding.css",
  "steps/unfolding.styles.ts",
  "style.css",
  "style.styles.ts",
  "switch-widgets/counter-note.css",
  "switch-widgets/counter-note.styles.ts",
  "switch-widgets/style.css",
  "switch-widgets/style.styles.ts",
  "types.ts",
];

function read(relPath: string) {
  return readFileSync(path.join(root, relPath), "utf8");
}

describe("Electron onboarding facade contract", () => {
  test("keeps the first-run screen on shared facade primitives", () => {
    const source = read(onboardingSource);

    expect(source).toContain('@myoxus/ui-facade";');
    expect(source).toContain("OnboardingProgressBars");
    expect(source).toContain("OnboardingProgressList");
    expect(source).toContain("BrandAssetImage");
    expect(source).not.toMatch(/@mantine\//);
    expect(source).not.toMatch(/\.css["']/);
    expect(source).not.toMatch(/\.styles["']/);
    expect(source).not.toMatch(/\bclassName=/);
    expect(source).not.toMatch(/\bstyle=\{/);
    expect(source).not.toMatch(/\b\d+px\b/);
  });

  test("removes the legacy paper animation CSS implementation", () => {
    for (const relPath of removedLegacyFiles) {
      expect(
        existsSync(path.join(root, onboardingRoot, relPath)),
        relPath,
      ).toBe(false);
    }
  });
});
