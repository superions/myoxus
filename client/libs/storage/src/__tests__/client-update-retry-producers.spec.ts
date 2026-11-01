// SPDX-License-Identifier: AGPL-3.0-or-later

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, test } from "vitest";

const repoRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../../..",
);

function source(path: string) {
  return readFileSync(resolve(repoRoot, path), "utf8");
}

describe("Browser Web automatic retry producer contract", () => {
  test.each([
    [
      "connections",
      "client/libs/storage/src/connection/connection.ts",
      'reserveAutomaticRetry("connection")',
    ],
    [
      "document sync",
      "client/libs/storage/src/sync/doc/peer.ts",
      'reserveAutomaticRetry("document-sync")',
    ],
    [
      "blob sync",
      "client/libs/storage/src/sync/blob/peer.ts",
      'reserveAutomaticRetry("blob-sync")',
    ],
    [
      "indexer sync",
      "client/libs/storage/src/sync/indexer/index.ts",
      'reserveAutomaticRetry("indexer-sync")',
    ],
    [
      "telemetry",
      "client/libs/storage/src/telemetry/manager.ts",
      'reserveAutomaticRetry("telemetry")',
    ],
    [
      "SWR",
      "client/libs/core/src/components/providers/swr-config-provider.tsx",
      'reserveAutomaticRetry("swr")',
    ],
    [
      "desktop workspace recovery",
      "client/libs/core/src/desktop/pages/workspace/index.tsx",
      'reserveAutomaticRetry("livedata")',
    ],
    [
      "compact workspace recovery",
      "client/libs/core/src/mobile/pages/workspace/index.tsx",
      'reserveAutomaticRetry("livedata")',
    ],
  ])(
    "%s reserves through the shared admission boundary",
    (_name, path, call) => {
      expect(source(path)).toContain(call);
    },
  );

  test("only the Browser Web worker installs client update control", () => {
    expect(source("client/web/workspaces/web/src/storage.worker.ts")).toContain(
      "startClientUpdateControlRuntime",
    );
    for (const path of [
      "client/apps/mobile/src/storage.worker.ts",
      "client/apps/android/src/storage.worker.ts",
      "client/apps/ios/src/storage.worker.ts",
      "client/apps/electron-renderer/src/background-worker/index.ts",
    ]) {
      expect(source(path)).not.toContain("startClientUpdateControlRuntime");
    }
  });
});
