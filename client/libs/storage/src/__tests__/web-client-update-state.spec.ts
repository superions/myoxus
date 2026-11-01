import "fake-indexeddb/auto";

import { describe, expect, test } from "vitest";

import {
  normalizeClientUpdateEndpoint,
  readAppliedClientUpdateState,
  updateAppliedClientUpdateState,
} from "../impls/cloud/web-client-update-state";

describe("Browser Web client update state", () => {
  test("normalizes only equivalent endpoint spellings", () => {
    expect(
      normalizeClientUpdateEndpoint(
        "HTTPS://EXAMPLE.COM:443/api/?ignored=1#fragment",
      ),
    ).toBe("https://example.com/api");
    expect(normalizeClientUpdateEndpoint("https://example.com/api")).toBe(
      "https://example.com/api",
    );
    expect(normalizeClientUpdateEndpoint("https://example.com:8443/api")).toBe(
      "https://example.com:8443/api",
    );
    expect(() => normalizeClientUpdateEndpoint("file:///tmp/socket")).toThrow(
      /HTTP/,
    );
    expect(() =>
      normalizeClientUpdateEndpoint("https://user:secret@example.com"),
    ).toThrow(/credentials/);
  });

  test("keeps one overwritten recovery state per normalized endpoint", async () => {
    const seed = crypto.randomUUID();
    const endpoint = `https://${seed}.example.test/api/`;
    const otherEndpoint = `https://${seed}.example.test:8443/api`;

    await expect(readAppliedClientUpdateState(endpoint)).resolves.toEqual({
      observedOperationId: null,
      appliedCompletionOperationId: null,
      appliedCacheEpoch: 0,
      resetInProgressEpoch: null,
      cloudDatabaseRegistryInitialized: false,
      registeredCloudDatabases: [],
    });

    await updateAppliedClientUpdateState(endpoint, (current) => ({
      ...current,
      observedOperationId: "operation-a",
    }));
    await updateAppliedClientUpdateState(
      endpoint.replace(/\/$/, ""),
      (current) => ({
        ...current,
        appliedCompletionOperationId: "operation-a",
      }),
    );

    await expect(readAppliedClientUpdateState(endpoint)).resolves.toMatchObject(
      {
        observedOperationId: "operation-a",
        appliedCompletionOperationId: "operation-a",
      },
    );
    await expect(
      readAppliedClientUpdateState(otherEndpoint),
    ).resolves.toMatchObject({
      observedOperationId: null,
      appliedCompletionOperationId: null,
    });
  });

  test("schema upgrade removes the obsolete Browser profile identity store", async () => {
    await readAppliedClientUpdateState(
      `https://${crypto.randomUUID()}.example.test`,
    );
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("myoxus-web-client-identity", 3);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    try {
      expect(Array.from(db.objectStoreNames)).not.toContain(
        "endpoint-client-ids",
      );
      expect(Array.from(db.objectStoreNames)).toContain(
        "endpoint-update-state",
      );
    } finally {
      db.close();
    }
  });
});
