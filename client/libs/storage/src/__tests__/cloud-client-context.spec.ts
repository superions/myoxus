import { afterEach, describe, expect, test } from "vitest";

import {
  configureMyoxusStorageClientContext,
  resetMyoxusStorageClientContext,
  withMyoxusStorageClientContextHeaders,
  withMyoxusStorageSocketClientContext,
} from "../impls/cloud/client-context";

describe("cloud storage client context", () => {
  afterEach(() => {
    resetMyoxusStorageClientContext();
  });

  test("adds native document metadata headers to storage HTTP requests", () => {
    const headers = withMyoxusStorageClientContextHeaders({
      "x-myoxus-version": "0.30.0-test",
    });

    expect(headers.get("x-myoxus-client")).toBe("storage");
    expect(headers.get("x-myoxus-client-format")).toBe("myoxus-native");
    expect(headers.get("x-myoxus-client-capabilities")).toBe(
      "document-metadata,sync",
    );
    expect(headers.get("x-myoxus-version")).toBe("0.30.0-test");
  });

  test("preserves explicit storage client context overrides", () => {
    const headers = withMyoxusStorageClientContextHeaders({
      "x-myoxus-client": "electron",
      "x-myoxus-client-capabilities": "document-metadata,sync,pdf-export",
    });

    expect(headers.get("x-myoxus-client")).toBe("electron");
    expect(headers.get("x-myoxus-client-format")).toBe("myoxus-native");
    expect(headers.get("x-myoxus-client-capabilities")).toBe(
      "document-metadata,sync,pdf-export",
    );
  });

  test("allows worker entrypoints to set their native client family centrally", () => {
    const restore = configureMyoxusStorageClientContext({
      client: "myoxus-electron",
    });

    try {
      const headers = withMyoxusStorageClientContextHeaders();
      const socketPayload = withMyoxusStorageSocketClientContext({
        spaceType: "workspace",
        spaceId: "workspace-1",
      });

      expect(headers.get("x-myoxus-client")).toBe("myoxus-electron");
      expect(headers.get("x-myoxus-client-format")).toBe("myoxus-native");
      expect(socketPayload).toMatchObject({
        client: "myoxus-electron",
        clientFormat: "myoxus-native",
        clientCapabilities: "document-metadata,sync",
      });
    } finally {
      restore();
    }
  });

  test("adds native document metadata identity to socket join payloads", () => {
    const payload = withMyoxusStorageSocketClientContext({
      spaceType: "workspace",
      spaceId: "workspace-1",
      clientVersion: "0.30.0-test",
    });

    expect(payload).toEqual({
      spaceType: "workspace",
      spaceId: "workspace-1",
      clientVersion: "0.30.0-test",
      client: "storage",
      clientFormat: "myoxus-native",
      clientCapabilities: "document-metadata,sync",
    });
  });
});
