// SPDX-License-Identifier: AGPL-3.0-or-later

import { readFileSync } from "node:fs";

import { describe, expect, test } from "vitest";

describe("sidebar i18n contract", () => {
  test("keeps visible sidebar status and download labels behind i18n keys", () => {
    const workspaceCard = readFileSync(
      new URL(
        "../../../../components/workspace-selector/workspace-card/index.tsx",
        import.meta.url,
      ),
      "utf8",
    );
    const downloadButton = readFileSync(
      new URL("./index.tsx", import.meta.url),
      "utf8",
    );

    expect(workspaceCard).toContain('t["com.myoxus.syncing"]()');
    expect(workspaceCard).not.toContain("Syncing...");
    expect(downloadButton).toContain(
      't["com.myoxus.other-page.nav.download-app"]()',
    );
    expect(downloadButton).not.toContain(">Download App<");
  });
});
