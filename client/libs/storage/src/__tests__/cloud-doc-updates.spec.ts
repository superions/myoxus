import { afterEach, describe, expect, test } from "vitest";

import {
  configureMyoxusStorageClientContext,
  MYOXUS_STORAGE_SOCKET_CLIENT_CONTEXT,
  resetMyoxusStorageClientContext,
} from "../impls/cloud/client-context";
import { CloudDocStorage } from "../impls/cloud/doc";
import { DocSyncProtocolError } from "../sync/doc/error";

const base64UpdateA = "AQID";
const base64UpdateB = "BAUG";

describe("CloudDocStorage broadcast updates", () => {
  afterEach(() => {
    resetMyoxusStorageClientContext();
  });

  test("deletion notifications are scoped and carry the visible ID", () => {
    const storage = new CloudDocStorage({
      id: "space-1",
      serverBaseUrl: "http://localhost",
      isSelfHosted: true,
      type: "workspace",
    });
    (storage as any).connection.idConverter = {
      oldIdToNewId: (id: string) => `visible-${id}`,
      newIdToOldId: (id: string) => id,
    };
    const received: string[] = [];
    const dispose = storage.subscribeDocDelete((id) => received.push(id));
    storage.onServerDocDelete({
      spaceId: "other-space",
      spaceType: "workspace",
      docId: "deleted",
    });
    expect(received).toEqual([]);
    storage.onServerDocDelete({
      spaceId: "space-1",
      spaceType: "workspace",
      docId: "deleted",
    });
    expect(received).toEqual(["visible-deleted"]);
    dispose();
    storage.onServerDocDelete({ docId: "legacy-notification" });
    expect(received).toEqual(["visible-deleted"]);
  });

  test("emits updates from batch payload", () => {
    const storage = new CloudDocStorage({
      id: "space-1",
      serverBaseUrl: "http://localhost",
      isSelfHosted: true,
      type: "workspace",
      readonlyMode: true,
    });

    (storage as any).connection.idConverter = {
      oldIdToNewId: (id: string) => id,
      newIdToOldId: (id: string) => id,
    };

    const received: Uint8Array[] = [];
    storage.subscribeDocUpdate((update) => {
      received.push(update.bin);
    });

    storage.onServerUpdates({
      spaceType: "workspace",
      spaceId: "space-1",
      docId: "doc-1",
      updates: [base64UpdateA, base64UpdateB],
      timestamp: Date.now(),
    });

    expect(received).toEqual([
      new Uint8Array([1, 2, 3]),
      new Uint8Array([4, 5, 6]),
    ]);
  });

  test("deleteDoc emits the server-side subdoc id from the active converter", async () => {
    const emitted: Array<{ event: string; payload: unknown }> = [];
    const storage = new CloudDocStorage({
      id: "space-1",
      serverBaseUrl: "http://localhost",
      isSelfHosted: true,
      type: "workspace",
      readonlyMode: false,
    });

    (storage as any).connection.idConverter = {
      oldIdToNewId: (id: string) =>
        id === "server-subdoc-1" ? "visible-page-1" : id,
      newIdToOldId: (id: string) =>
        id === "visible-page-1" ? "server-subdoc-1" : id,
    };
    (storage as any).connection._inner = {
      socket: {
        emit: (event: string, payload: unknown) => {
          emitted.push({ event, payload });
        },
      },
      disconnect: () => {},
    };

    await storage.deleteDoc("visible-page-1");

    expect(emitted).toEqual([
      {
        event: "space:delete-doc",
        payload: {
          spaceType: "workspace",
          spaceId: "space-1",
          docId: "server-subdoc-1",
          ...MYOXUS_STORAGE_SOCKET_CLIENT_CONTEXT,
        },
      },
    ]);
  });

  test("doc socket operations carry native metadata client context", async () => {
    const emitted: Array<{ event: string; payload: unknown }> = [];
    const storage = new CloudDocStorage({
      id: "space-1",
      serverBaseUrl: "http://localhost",
      isSelfHosted: true,
      type: "workspace",
      readonlyMode: false,
    });

    (storage as any).connection.idConverter = {
      oldIdToNewId: (id: string) => id,
      newIdToOldId: (id: string) =>
        id === "visible-page-1" ? "server-subdoc-1" : id,
    };
    (storage as any).connection._inner = {
      socket: {
        emitWithAck: async (event: string, payload: unknown) => {
          emitted.push({ event, payload });
          if (event === "space:load-doc-timestamps") {
            return { data: {} };
          }
          if (event === "space:push-doc-update") {
            return { data: { timestamp: 1700000000000 } };
          }
          return {
            data: {
              missing: "",
              state: "",
              timestamp: 1700000000000,
            },
          };
        },
      },
      disconnect: () => {},
    };

    await storage.getDocSnapshot("visible-page-1");
    await storage.getDocDiff("visible-page-1", new Uint8Array([1, 2, 3]));
    await storage.pushDocUpdate({
      docId: "visible-page-1",
      bin: new Uint8Array([4, 5, 6]),
    });
    await storage.getDocTimestamp("visible-page-1");
    await storage.getDocTimestamps(new Date(1700000000000));

    expect(emitted.map(({ event }) => event)).toEqual([
      "space:load-doc",
      "space:load-doc",
      "space:push-doc-update",
      "space:load-doc",
      "space:load-doc-timestamps",
    ]);
    for (const { payload } of emitted) {
      expect(payload).toMatchObject(MYOXUS_STORAGE_SOCKET_CLIENT_CONTEXT);
    }
    expect(emitted[2]?.payload).not.toHaveProperty("initialDocumentProvenance");
  });

  test("preserves the server retry contract for document reconcile errors", async () => {
    const storage = new CloudDocStorage({
      id: "space-1",
      serverBaseUrl: "http://localhost",
      isSelfHosted: true,
      type: "workspace",
      readonlyMode: false,
    });

    (storage as any).connection.idConverter = {
      oldIdToNewId: (id: string) => id,
      newIdToOldId: (id: string) => id,
    };
    (storage as any).connection._inner = {
      socket: {
        emitWithAck: async () => ({
          error: {
            name: "SYNC_BUSY",
            message: "bounded decoder capacity reached",
            retryable: true,
            retryAfterMs: 275,
          },
        }),
      },
      disconnect: () => {},
    };

    await expect(
      storage.getDocDiff("visible-page-1", new Uint8Array([0])),
    ).rejects.toSatisfy(
      (error) =>
        error instanceof DocSyncProtocolError &&
        error.name === "SYNC_BUSY" &&
        error.protocolName === "SYNC_BUSY" &&
        error.retryable &&
        error.retryAfterMs === 275,
    );
  });

  test("preserves server Move evidence on both load and rejected push", async () => {
    const storage = new CloudDocStorage({
      id: "space-1",
      serverBaseUrl: "http://localhost",
      isSelfHosted: true,
      type: "workspace",
    });
    (storage as any).connection.idConverter = {
      oldIdToNewId: (id: string) => id,
      newIdToOldId: (id: string) => id,
    };
    (storage as any).connection._inner = {
      socket: {
        emitWithAck: async () => ({
          error: {
            name: "DOC_MOVED",
            message: "document moved from this workspace",
            retryable: false,
          },
        }),
      },
      disconnect: () => {},
    };
    for (const operation of [
      () => storage.getDocDiff("moved-page"),
      () =>
        storage.pushDocUpdate({
          docId: "moved-page",
          bin: new Uint8Array([0, 0]),
        }),
    ]) {
      await expect(operation()).rejects.toMatchObject({
        protocolName: "DOC_MOVED",
        retryable: false,
        pageRegistration: "moved",
      });
    }
  });

  test("pushDocUpdate preserves explicit initial document provenance", async () => {
    const emitted: Array<{
      event: string;
      payload: { initialDocumentProvenance?: Record<string, unknown> };
    }> = [];
    const storage = new CloudDocStorage({
      id: "space-1",
      serverBaseUrl: "http://localhost",
      isSelfHosted: true,
      type: "workspace",
      readonlyMode: false,
    });

    (storage as any).connection.idConverter = {
      oldIdToNewId: (id: string) => id,
      newIdToOldId: (id: string) => id,
    };
    (storage as any).connection._inner = {
      socket: {
        emitWithAck: async (event: string, payload: unknown) => {
          emitted.push({
            event,
            payload: payload as {
              initialDocumentProvenance?: Record<string, unknown>;
            },
          });
          return { data: { timestamp: 1700000000000 } };
        },
      },
      disconnect: () => {},
    };

    await storage.pushDocUpdate({
      docId: "doc-1",
      bin: new Uint8Array([4, 5, 6]),
      initialDocumentProvenance: {
        provenanceMode: "offline_sync",
        clientInstanceId: "019c60d3-4952-7b74-bb0f-4af803c60dd9",
        clientCreatedAt: "2026-05-26T12:00:00.000Z",
        clientUpdatedAt: "2026-05-26T12:01:00.000Z",
      },
    });

    expect(emitted).toHaveLength(1);
    expect(emitted[0]?.payload.initialDocumentProvenance).toMatchObject({
      clientFamily: "storage",
      clientVersion: BUILD_CONFIG.appVersion,
      provenanceMode: "offline_sync",
      clientInstanceId: "019c60d3-4952-7b74-bb0f-4af803c60dd9",
      clientCreatedAt: "2026-05-26T12:00:00.000Z",
      clientUpdatedAt: "2026-05-26T12:01:00.000Z",
    });
    expect(emitted[0]?.payload.initialDocumentProvenance).not.toHaveProperty(
      "idempotencyKey",
    );
  });

  test("pushDocUpdate does not synthesize provenance from converted server doc id", async () => {
    const emitted: Array<{
      event: string;
      payload: { initialDocumentProvenance?: Record<string, unknown> };
    }> = [];
    const storage = new CloudDocStorage({
      id: "space-1",
      serverBaseUrl: "http://localhost",
      isSelfHosted: true,
      type: "workspace",
      readonlyMode: false,
    });

    (storage as any).connection.idConverter = {
      oldIdToNewId: (id: string) => id,
      newIdToOldId: (id: string) =>
        id === "visible-page-1" ? "server-subdoc-1" : id,
    };
    (storage as any).connection._inner = {
      socket: {
        emitWithAck: async (event: string, payload: unknown) => {
          emitted.push({
            event,
            payload: payload as {
              initialDocumentProvenance?: Record<string, unknown>;
            },
          });
          return { data: { timestamp: 1700000000000 } };
        },
      },
      disconnect: () => {},
    };

    await storage.pushDocUpdate({
      docId: "visible-page-1",
      bin: new Uint8Array([4, 5, 6]),
      initialDocumentProvenance: {
        provenanceMode: "offline_sync",
        clientInstanceId: "019c60d3-4952-7b74-bb0f-4af803c60dd9",
        clientCreatedAt: "2026-05-26T12:00:00.000Z",
        clientUpdatedAt: "2026-05-26T12:01:00.000Z",
      },
    });

    expect(emitted[0]?.payload.initialDocumentProvenance).not.toHaveProperty(
      "idempotencyKey",
    );
    expect(
      JSON.stringify(emitted[0]?.payload.initialDocumentProvenance),
    ).not.toContain("server-subdoc-1");
  });

  test("pushDocUpdate derives initial provenance family from storage client context", async () => {
    configureMyoxusStorageClientContext({ client: "myoxus-electron" });
    const emitted: Array<{
      event: string;
      payload: { initialDocumentProvenance?: Record<string, unknown> };
    }> = [];
    const storage = new CloudDocStorage({
      id: "space-1",
      serverBaseUrl: "http://localhost",
      isSelfHosted: true,
      type: "workspace",
      readonlyMode: false,
    });

    (storage as any).connection.idConverter = {
      oldIdToNewId: (id: string) => id,
      newIdToOldId: (id: string) => id,
    };
    (storage as any).connection._inner = {
      socket: {
        emitWithAck: async (event: string, payload: unknown) => {
          emitted.push({
            event,
            payload: payload as {
              initialDocumentProvenance?: Record<string, unknown>;
            },
          });
          return { data: { timestamp: 1700000000000 } };
        },
      },
      disconnect: () => {},
    };

    await storage.pushDocUpdate({
      docId: "doc-1",
      bin: new Uint8Array([4, 5, 6]),
      initialDocumentProvenance: {
        provenanceMode: "offline_sync",
        clientInstanceId: "019c60d3-4952-7b74-bb0f-4af803c60dd9",
        clientCreatedAt: "2026-05-26T12:00:00.000Z",
      },
    });

    expect(emitted[0]?.payload.initialDocumentProvenance).toMatchObject({
      clientFamily: "myoxus-electron",
      provenanceMode: "offline_sync",
      clientInstanceId: "019c60d3-4952-7b74-bb0f-4af803c60dd9",
      clientCreatedAt: "2026-05-26T12:00:00.000Z",
    });
    expect(emitted[0]?.payload.initialDocumentProvenance).not.toHaveProperty(
      "clientUpdatedAt",
    );
  });
});

// A late converter load must not attach document listeners after the shared
// room owner has been disposed. Tasks retain their independently owned lease.
test("aborted cloud document load releases its lease without late listeners", async () => {
  const { SocketConnection } = await import("../impls/cloud/socket");
  const { acquireCloudSpaceRoom } = await import("../impls/cloud/space-room");
  const { vi } = await import("vitest");
  const socket = {
    id: "late-doc-load",
    connected: true,
    emit: vi.fn(),
    emitWithAck: vi.fn().mockResolvedValue({
      data: { clientId: "late-doc-load", success: true },
    }),
    on: vi.fn(),
    off: vi.fn(),
  };
  const disconnect = vi.fn();
  const connect = vi
    .spyOn(SocketConnection.prototype, "doConnect")
    .mockResolvedValue({ socket: socket as any, disconnect });
  const storage = new CloudDocStorage({
    id: "alpha",
    serverBaseUrl: "http://localhost",
    isSelfHosted: true,
    type: "workspace",
  });
  let resolveConverter!: (value: any) => void;
  let entered!: () => void;
  const converterEntered = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const converter = vi
    .spyOn(storage.connection, "getIdConverter")
    .mockImplementation(() => {
      entered();
      return new Promise((resolve) => {
        resolveConverter = resolve;
      });
    });
  const tasks = acquireCloudSpaceRoom(socket as any, "workspace", "alpha");
  await tasks.ready;
  const abort = new AbortController();
  try {
    const pending = storage.connection.doConnect(abort.signal);
    const rejected = expect(pending).rejects.toBe("disposed");
    await converterEntered;
    abort.abort("disposed");
    resolveConverter({
      oldIdToNewId: (id: string) => id,
      newIdToOldId: (id: string) => id,
    });
    await rejected;
    expect(socket.on).not.toHaveBeenCalled();
    expect(disconnect).toHaveBeenCalledTimes(1);
    expect(socket.emit).not.toHaveBeenCalled();
    expect(socket.emitWithAck).toHaveBeenCalledTimes(1);
  } finally {
    tasks.release();
    converter.mockRestore();
    connect.mockRestore();
  }
  expect(socket.emit).toHaveBeenCalledWith(
    "space:leave",
    expect.objectContaining({ spaceId: "alpha" }),
  );
});
