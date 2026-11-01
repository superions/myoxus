// SPDX-License-Identifier: AGPL-3.0-or-later

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, test } from "vitest";

const repoRoot = process.cwd();

const signInProductFiles = [
  "client/libs/core/src/components/sign-in/add-standalone.tsx",
  "client/libs/core/src/components/sign-in/auth-context.tsx",
  "client/libs/core/src/components/sign-in/captcha.tsx",
  "client/libs/core/src/components/sign-in/sign-in.tsx",
  "client/libs/core/src/components/sign-in/sign-in-with-email.tsx",
  "client/libs/core/src/components/sign-in/sign-in-with-password.tsx",
];

function readRepoFile(path: string): string {
  return readFileSync(join(repoRoot, path), "utf8");
}

describe("sign-in facade contract", () => {
  test("keeps auth chrome behind the shared Facade instead of local product CSS", () => {
    expect(
      existsSync(
        join(repoRoot, "client/libs/core/src/components/sign-in/style.css"),
      ),
    ).toBe(false);
    expect(
      existsSync(
        join(
          repoRoot,
          "client/libs/core/src/components/sign-in/style.styles.ts",
        ),
      ),
    ).toBe(false);
    expect(
      existsSync(
        join(
          repoRoot,
          "client/libs/core/src/components/sign-in/background-arts/style.css",
        ),
      ),
    ).toBe(false);
    expect(
      existsSync(
        join(
          repoRoot,
          "client/libs/core/src/components/sign-in/background-arts/style.styles.ts",
        ),
      ),
    ).toBe(false);

    for (const file of signInProductFiles) {
      const source = readRepoFile(file);
      expect(source, file).not.toContain("./style.styles");
      expect(source, file).not.toContain("style.");
      expect(source, file).not.toContain("styles.");
      expect(source, file).not.toContain("suffixStyle");
      expect(source, file).not.toMatch(/\b\d+px\b/);
      expect(source, file).not.toMatch(/from ['"]@mantine\//);
    }

    expect(
      readRepoFile("client/libs/core/src/components/sign-in/sign-in.tsx"),
    ).toContain("AuthDivider");
    expect(
      readRepoFile("client/libs/core/src/components/sign-in/captcha.tsx"),
    ).toContain("AuthCaptchaFallbackButton");
    expect(
      readRepoFile("client/libs/core/src/components/sign-in/auth-context.tsx"),
    ).toContain("AuthNotice");
  });
});
