// SPDX-License-Identifier: AGPL-3.0-or-later

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, test } from "vitest";

const repoRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../../..",
);

function readRepoFile(path: string): string {
  return readFileSync(resolve(repoRoot, path), "utf8");
}

const sharedWorkerEntries = [
  "client/web/workspaces/web/src/storage.worker.ts",
  "client/apps/mobile/src/storage.worker.ts",
  "client/apps/android/src/storage.worker.ts",
  "client/apps/ios/src/storage.worker.ts",
  "client/apps/electron-renderer/src/background-worker/index.ts",
];

const workerBootstrapEntrypoints = new Map([
  ["client/web/workspaces/web/src/storage.worker.ts", null],
  ["client/apps/mobile/src/storage.worker.ts", null],
  [
    "client/apps/android/src/storage.worker.ts",
    "client/apps/android/src/setup-worker.ts",
  ],
  [
    "client/apps/ios/src/storage.worker.ts",
    "client/apps/ios/src/setup-worker.ts",
  ],
  ["client/apps/electron-renderer/src/background-worker/index.ts", null],
]);

describe("native metadata storage worker entrypoints", () => {
  test.each([...workerBootstrapEntrypoints.entries()])(
    "%s uses the DOM-free worker bootstrap",
    (entrypoint, bootstrapFile) => {
      const source = readRepoFile(entrypoint);
      const bootstrapSource = bootstrapFile
        ? readRepoFile(bootstrapFile)
        : source;

      expect(bootstrapSource).toContain("@myoxus/core/bootstrap/worker");
      expect(source).not.toContain("@myoxus/core/bootstrap/browser");
      expect(source).not.toContain("@myoxus/core/bootstrap/electron");
      expect(bootstrapSource).not.toContain("@myoxus/core/bootstrap/browser");
      expect(bootstrapSource).not.toContain("@myoxus/core/bootstrap/electron");
    },
  );

  test("worker bootstrap stays free of browser telemetry and DOM-only UI stacks", () => {
    const bootstrap = readRepoFile("client/libs/core/src/bootstrap/worker.ts");
    const workerPolyfill = readRepoFile(
      "client/libs/core/src/bootstrap/polyfill/worker.ts",
    );

    expect(bootstrap).toContain("./polyfill/worker");
    expect(bootstrap).not.toContain("./telemetry");
    expect(workerPolyfill).not.toContain("./resize-observer");
  });

  test("storage indexer boot path keeps the worker-safe reader in an async chunk", () => {
    const indexer = readRepoFile(
      "client/libs/storage/src/sync/indexer/index.ts",
    );
    const crawler = readRepoFile(
      "client/libs/storage/src/sync/indexer/crawler.ts",
    );
    const rootDocReader = readRepoFile(
      "client/libs/storage/src/sync/indexer/root-doc-reader.ts",
    );

    expect(indexer).toContain("./root-doc-reader");
    expect(indexer).not.toContain('from "@myoxus/reader"');
    expect(indexer).toContain('await import("./crawler")');
    expect(crawler).not.toContain('from "@myoxus/reader"');
    expect(crawler).toContain("readAllBlocksForIndexer");
    expect(rootDocReader).toContain('await import("@myoxus/reader")');

    const reader = readRepoFile("client/libs/reader/src/reader.ts");
    expect(reader).not.toContain("@virgultum/editor/global/di");
    expect(reader).not.toContain("@virgultum/editor/shared/adapters");
    expect(reader).not.toContain("@virgultum/editor/schemas");
  });

  test("storage worker build preserves async chunks for optional reader code", () => {
    const rspackConfig = readRepoFile("tools/cli/src/rspack/index.ts");

    expect(rspackConfig).toContain(
      'const supportsAsyncChunks = workerName === "storage"',
    );
    expect(rspackConfig).toContain("maxChunks: supportsAsyncChunks ? 2 : 1");
    expect(rspackConfig).toContain(
      "${workerName}-[name].[contenthash:8].worker-chunk.js",
    );
  });

  test.each(sharedWorkerEntries)(
    "%s consumes the shared cloud storage implementation",
    (entrypoint) => {
      const source = readRepoFile(entrypoint);

      expect(source).toContain("@myoxus/storage/cloud");
      expect(source).toContain("cloudStorages");
      expect(source).toContain("configureMyoxusStorageClientContext");
      expect(source).toContain("StoreManagerConsumer");
      expect(source).not.toMatch(/documentMetadata\s*\(/);
      expect(source).not.toMatch(/setDocumentMetadata\s*\(/);
      expect(source).not.toContain("x-myoxus-client-format");
      expect(source).not.toContain("myoxus-native");
    },
  );

  test("native mobile workers keep auth customization separate from metadata context", () => {
    for (const entrypoint of [
      "client/apps/android/src/storage.worker.ts",
      "client/apps/ios/src/storage.worker.ts",
    ]) {
      const source = readRepoFile(entrypoint);

      expect(source).toContain("configureSocketAuthMethod");
      expect(source).toContain("readEndpointToken");
      expect(source).toContain("configureMyoxusStorageClientContext");
      expect(source).not.toContain("clientCapabilities");
      expect(source).not.toContain("document-metadata,sync");
    }
  });

  test("Browser Web declares only its client class in the session-backed handshake", () => {
    const webWorker = readRepoFile(
      "client/web/workspaces/web/src/storage.worker.ts",
    );
    expect(webWorker).toContain("configureSocketAuthMethod");
    expect(webWorker).toContain('clientKind: "web"');
    expect(webWorker).not.toContain("resolveWebClientInstanceId");
    expect(webWorker).not.toContain("clientInstanceId");
    expect(webWorker).not.toContain("myoxus-web-client-identity");

    for (const entrypoint of sharedWorkerEntries) {
      expect(readRepoFile(entrypoint)).not.toContain(
        "resolveWebClientInstanceId",
      );
    }
  });

  test("app workers declare the expected storage client family", () => {
    const expectedClients = new Map([
      ["client/web/workspaces/web/src/storage.worker.ts", "web"],
      ["client/apps/mobile/src/storage.worker.ts", "mobile"],
      ["client/apps/android/src/storage.worker.ts", "android"],
      ["client/apps/ios/src/storage.worker.ts", "ios"],
      [
        "client/apps/electron-renderer/src/background-worker/index.ts",
        "myoxus-electron",
      ],
    ]);

    for (const [entrypoint, client] of expectedClients) {
      expect(readRepoFile(entrypoint)).toContain(`client: "${client}"`);
    }
  });
});
