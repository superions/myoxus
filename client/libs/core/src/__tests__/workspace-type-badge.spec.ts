// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, test } from "vitest";

const REPO_ROOT = fileURLToPath(new URL("../../../../../", import.meta.url));

function readRepoFile(path: string) {
  return readFileSync(`${REPO_ROOT}${path}`, "utf8");
}

describe("workspace type badge visible copy", () => {
  test("uses localized labels instead of rendering backend enum values", () => {
    const source = readRepoFile(
      "client/libs/core/src/components/workspace-selector/workspace-card/index.tsx",
    );

    expect(source).toContain("com.myoxus.workspace.type.shared");
    expect(source).toContain("com.myoxus.workspace.type.user-owned");
    expect(source).not.toContain("com.myoxus.workspace.type.team");
    expect(source).not.toMatch(
      new RegExp(
        String.raw`data-workspace-type=\\{type\\}>\\s*\\{type\\}\\s*</span>`,
      ),
    );

    const de = JSON.parse(
      readRepoFile("client/libs/i18n/src/resources/de.json"),
    ) as Record<string, string>;
    const en = JSON.parse(
      readRepoFile("client/libs/i18n/src/resources/en.json"),
    ) as Record<string, string>;

    expect(de["com.myoxus.workspace.type.shared"]).toBe("Geteilt");
    expect(de["com.myoxus.workspace.type.user-owned"]).toBe("Benutzereigen");
    expect(en["com.myoxus.workspace.type.shared"]).toBe("Shared");
    expect(en["com.myoxus.workspace.type.user-owned"]).toBe("User-owned");
    expect(en["com.myoxus.workspace.type.team"]).toBeUndefined();
  });
});
