// SPDX-License-Identifier: AGPL-3.0-or-later

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

describe("Database ownership boundary", () => {
  test("keeps the server-backed Database UI outside Virgultum", () => {
    const manifest = JSON.parse(
      readFileSync(join(process.cwd(), "package.json"), "utf8"),
    ) as {
      dependencies?: Record<string, string>;
      exports?: Record<string, string>;
    };

    expect(manifest.dependencies).not.toHaveProperty("@myoxus/ui-facade");
    expect(manifest.exports).not.toHaveProperty(
      "./view-presets/database-table",
    );
    expect(
      existsSync(
        join(process.cwd(), "src/view-presets/database-table/index.ts"),
      ),
    ).toBe(false);
  });
});
