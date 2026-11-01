// SPDX-License-Identifier: AGPL-3.0-or-later

import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, test } from "vitest";

const repoRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../../..",
);

const clientV1Paths = [
  "client/libs/storage/src/impls/idb/v1",
  "client/libs/storage/src/impls/sqlite/v1",
  "client/apps/electron/src/helper/storage/v1",
  "client/libs/local-store/sqlite_v1",
  "client/libs/local-store/schema/src/v1.rs",
];

const clientBoundaryFiles = [
  "client/libs/storage/package.json",
  "client/libs/storage/src/impls/index.ts",
  "client/libs/core/src/modules/workspace-engine/impls/cloud.ts",
  "client/libs/core/src/modules/workspace-engine/impls/local.ts",
  "client/web/workspaces/web/src/storage.worker.ts",
  "client/apps/mobile/src/storage.worker.ts",
  "client/apps/electron-renderer/src/background-worker/index.ts",
  "client/apps/electron-renderer/src/app/setup.ts",
  "client/apps/electron/src/helper/storage/index.ts",
  "client/apps/electron/src/helper/exposed.ts",
  "client/libs/desktop-api-contract/src/index.ts",
  "client/libs/local-store/Cargo.toml",
  "client/libs/local-store/src/lib.rs",
  "client/libs/local-store/src/index.ts",
  "client/libs/local-store/index.js",
  "client/libs/local-store/native-binding.cjs",
  "client/apps/electron/scripts/ensure-native-bindings.ts",
  "Cargo.toml",
];

const prohibitedClientMarkers = [
  "@myoxus/storage/idb/v1",
  "@myoxus/storage/sqlite/v1",
  "client_sqlite_v1",
  "sqlite_v1",
  "NativeStoreV1Apis",
  "dbHandlersV1",
  "dbEventsV1",
  "SqliteConnection",
  "ValidationResult",
];

describe("client Storage-v1 cutoff", () => {
  test("removes all retired client implementation roots", () => {
    for (const path of clientV1Paths) {
      expect(existsSync(resolve(repoRoot, path)), path).toBe(false);
    }
  });

  test("keeps client configuration, workers and IPC free of v1 bindings", () => {
    for (const path of clientBoundaryFiles) {
      const source = readFileSync(resolve(repoRoot, path), "utf8");
      for (const marker of prohibitedClientMarkers) {
        expect(source, `${path} contains ${marker}`).not.toContain(marker);
      }
    }
  });

  test("preserves the canonical server-side SQLite-v1 importer", () => {
    const decoder = readFileSync(
      resolve(repoRoot, "server/crates/workspace_import/src/decoder.rs"),
      "utf8",
    );
    const tests = readFileSync(
      resolve(repoRoot, "server/crates/workspace_import/tests/decoder.rs"),
      "utf8",
    );

    expect(decoder).toContain("WorkspaceImportFormat::SqliteV1");
    expect(tests).toContain("WorkspaceImportFormat::SqliteV1");
  });

  test("preserves Electron's current local workspace persistence", () => {
    const handlers = readFileSync(
      resolve(repoRoot, "client/apps/electron/src/helper/storage/handlers.ts"),
      "utf8",
    );
    const exposed = readFileSync(
      resolve(repoRoot, "client/apps/electron/src/helper/exposed.ts"),
      "utf8",
    );
    const setup = readFileSync(
      resolve(repoRoot, "client/apps/electron-renderer/src/app/setup.ts"),
      "utf8",
    );
    const workspaceMeta = readFileSync(
      resolve(repoRoot, "client/apps/electron/src/helper/workspace/meta.ts"),
      "utf8",
    );
    const backupImport = readFileSync(
      resolve(repoRoot, "client/apps/electron/src/helper/dialog/dialog.ts"),
      "utf8",
    );

    expect(handlers).toContain("new DocStoragePool()");
    expect(handlers).toContain("getSpaceDBPath(peer, type, id)");
    expect(exposed).toContain("store: storeHandlers");
    expect(setup).toContain("const desktopBridge = getDesktopBridge()");
    expect(setup).toContain("bindNativeDBApis(desktopBridge.apis.store)");
    expect(workspaceMeta).toContain('"storage.db"');
    expect(backupImport).toContain("new DocStorage(originalPath)");
    expect(backupImport).toContain("await storage.validate()");
    expect(backupImport).toContain(
      "await copyFile(originalPath, internalFilePath)",
    );
  });
});
