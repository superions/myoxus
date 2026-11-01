// SPDX-License-Identifier: AGPL-3.0-or-later

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, test } from "vitest";

const repoRoot = process.cwd();
const mobileDetailRoot = "client/libs/core/src/mobile/pages/workspace/detail";

function readRepoFile(path: string): string {
  return readFileSync(join(repoRoot, path), "utf8");
}

function expectDeleted(path: string) {
  expect(existsSync(join(repoRoot, path)), path).toBe(false);
}

describe("mobile workspace detail menu facade migration", () => {
  test("keeps retired mobile detail chrome CSS deleted", () => {
    for (const file of [
      `${mobileDetailRoot}/journal-conflict-block.css`,
      `${mobileDetailRoot}/journal-conflict-block.styles.ts`,
      `${mobileDetailRoot}/menu/journal-conflicts.css`,
      `${mobileDetailRoot}/menu/journal-conflicts.styles.ts`,
      `${mobileDetailRoot}/menu/journal-today-activity.css`,
      `${mobileDetailRoot}/menu/journal-today-activity.styles.ts`,
      `${mobileDetailRoot}/menu/mode-switch.css`,
      `${mobileDetailRoot}/menu/mode-switch.styles.ts`,
      `${mobileDetailRoot}/page-header-more-button.css`,
      `${mobileDetailRoot}/page-header-more-button.styles.ts`,
      `${mobileDetailRoot}/page-header-share-button.css`,
      `${mobileDetailRoot}/page-header-share-button.styles.ts`,
    ]) {
      expectDeleted(file);
    }
  });

  test("uses existing facade menu, badge and navigation roles without local numeric chrome", () => {
    const conflictBlock = readRepoFile(
      `${mobileDetailRoot}/journal-conflict-block.tsx`,
    );
    const journalConflicts = readRepoFile(
      `${mobileDetailRoot}/menu/journal-conflicts.tsx`,
    );
    const todayActivity = readRepoFile(
      `${mobileDetailRoot}/menu/journal-today-activity.tsx`,
    );
    const modeSwitch = readRepoFile(`${mobileDetailRoot}/menu/mode-switch.tsx`);
    const moreButton = readRepoFile(
      `${mobileDetailRoot}/page-header-more-button.tsx`,
    );
    const shareButton = readRepoFile(
      `${mobileDetailRoot}/page-header-share-button.tsx`,
    );

    for (const source of [
      conflictBlock,
      journalConflicts,
      todayActivity,
      modeSwitch,
      moreButton,
      shareButton,
    ]) {
      expect(source).toContain('from "@myoxus/ui-facade"');
      expect(source).not.toMatch(/\\.styles["']/);
      expect(source).not.toContain("styles.");
      expect(source).not.toContain("style={{");
      expect(source).not.toMatch(/[0-9]+px/);
    }

    expect(conflictBlock).toContain("NavigationLink");
    expect(conflictBlock).toContain("SurfaceList");
    expect(conflictBlock).toContain("Badge");
    expect(conflictBlock).toContain("preventDefault()");
    expect(conflictBlock).toContain("stopPropagation()");
    expect(conflictBlock).toContain("onClick={preventNav}");
    expect(journalConflicts).toContain("MenuInlineText");
    expect(journalConflicts).toContain("Badge");
    expect(todayActivity).toContain("MenuSectionLabel");
    expect(todayActivity).toContain("MenuInlineText");
    expect(modeSwitch).toContain("<RadioGroup block");
    expect(modeSwitch).not.toContain("itemHeight=");
    expect(modeSwitch).not.toContain("borderRadius=");
    expect(modeSwitch).not.toContain("padding=");
    expect(modeSwitch).not.toContain("gap=");
    expect(moreButton).not.toContain("size={24}");
    expect(shareButton).not.toContain("size={24}");
  });
});
