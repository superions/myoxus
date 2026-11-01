// SPDX-License-Identifier: AGPL-3.0-or-later

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, test } from "vitest";

const repoRoot = process.cwd();
const renameRoot = "client/libs/core/src/mobile/components/rename";
const deletedStylePaths = [
  "content.css",
  "content.styles.ts",
  "dialog.css",
  "dialog.styles.ts",
].map((path) => `${renameRoot}/${path}`);

function readRepoFile(path: string): string {
  return readFileSync(join(repoRoot, path), "utf8");
}

describe("mobile rename facade contract", () => {
  test("keeps rename dialog and content chrome on shared facade roles", () => {
    const content = readRepoFile(`${renameRoot}/content.tsx`);
    const dialog = readRepoFile(`${renameRoot}/dialog.tsx`);
    const combined = `${content}\n${dialog}`;

    for (const path of deletedStylePaths) {
      expect(existsSync(join(repoRoot, path)), path).toBe(false);
    }

    for (const primitive of [
      "Stack",
      "Group",
      "RowInput",
      "MyoxusText",
      "Button",
      "Modal",
    ]) {
      expect(combined, primitive).toContain(primitive);
    }

    expect(content).toContain('data-myoxus-ui-role="mobile-rename-content"');
    expect(content).toContain('data-myoxus-ui-role="mobile-rename-input-row"');
    expect(content).toContain("block");
    expect(dialog).toContain("title={title}");
    expect(dialog).toContain('contentOptions={{ bodyPadding: "none" }}');
  });

  test("does not reintroduce local rename styling or manual responsive fixes", () => {
    const combined = [
      readRepoFile(`${renameRoot}/content.tsx`),
      readRepoFile(`${renameRoot}/dialog.tsx`),
    ].join("\n");

    for (const forbidden of [
      "content.styles",
      "dialog.styles",
      "CloseIcon",
      "IconButton",
      "withoutCloseButton",
      "classNames(",
      "className={",
      "inputClassName",
      "inputStyle",
      "contentClassName",
      "contentStyle",
      "style: {",
      'padding: "12px 0"',
      "borderRadius: 22",
    ]) {
      expect(combined).not.toContain(forbidden);
    }

    expect(combined).not.toMatch(/\b(?:matchMedia|innerWidth|innerHeight)\b/);
    expect(combined).not.toMatch(/\b\d+(?:\.\d+)?px\b/);
  });
});
