// SPDX-License-Identifier: AGPL-3.0-or-later

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, test } from "vitest";

const repoRoot = process.cwd();

const navigationConsumers = [
  "client/libs/core/src/components/structure-tree/nodes/doc/index.tsx",
  "client/libs/core/src/components/structure-tree/nodes/folder/index.tsx",
  "client/libs/core/src/mobile/components/navigation/nodes/doc/index.tsx",
  "client/libs/core/src/mobile/components/navigation/nodes/folder/index.tsx",
];

function readRepoFile(path: string): string {
  return readFileSync(join(repoRoot, path), "utf8");
}

describe("emoji icon feature contract", () => {
  test("folder and document emoji icons are product features, not experimental flags", () => {
    const flags = readRepoFile(
      "client/libs/core/src/modules/feature-flag/constant.ts",
    );
    expect(flags).not.toContain("enable_emoji_folder_icon");
    expect(flags).not.toContain("enable_emoji_doc_icon");

    for (const file of navigationConsumers) {
      const source = readRepoFile(file);
      expect(source, file).not.toContain("enable_emoji_folder_icon");
      expect(source, file).not.toContain("enable_emoji_doc_icon");
      expect(source, file).toContain("extractEmojiAsIcon");
    }
  });

  test("desktop navigation filters emoji extraction props before DOM forwarding", () => {
    const source = readRepoFile(
      "client/libs/core/src/components/structure-tree/tree/node.tsx",
    );

    expect(source).toMatch(
      /extractEmojiAsIcon:\s*_[A-Za-z0-9]+,[\s\S]*\.\.\.otherProps/,
    );
    expect(source).not.toMatch(
      /<div[\s\S]*\{\.\.\.otherProps\}[\s\S]*extractEmojiAsIcon/,
    );
  });

  test("experimental settings locales no longer expose emoji icon entries", () => {
    const resourcesDir = join(repoRoot, "client/libs/i18n/src/resources");
    const localeFiles = readdirSync(resourcesDir).filter((file) =>
      file.endsWith(".json"),
    );

    for (const file of localeFiles) {
      const source = readFileSync(join(resourcesDir, file), "utf8");
      expect(source, file).not.toContain("enable-emoji-folder-icon");
      expect(source, file).not.toContain("enable-emoji-doc-icon");
    }
  });
});
