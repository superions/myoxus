import { filter, firstValueFrom, type Observable, take } from "rxjs";
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  applyUpdate,
  diffUpdate,
  Doc as YDoc,
  encodeStateAsUpdate,
  encodeStateVectorFromUpdate,
  mergeUpdates,
} from "yjs";

import { DummyConnection } from "../../../connection";
import { shouldSyncCloudDoc } from "../../../impls/cloud/doc";
import type {
  DocClock,
  DocClocks,
  DocDiff,
  DocRecord,
  DocStorage,
  DocUpdate,
} from "../../../storage";
import { DummyDocSyncStorage } from "../../../storage/dummy/doc-sync";
import { MANUALLY_STOP } from "../../../utils/throw-if-aborted";
import { DocSyncProtocolError } from "../error";
import { type DocSyncDocState, DocSyncImpl } from "../index";
import { DocSyncPeer } from "../peer";

const HEALTHY_DOC_ID = "z-healthy-content";
const BROKEN_DOC_ID = "a-broken-helper";
const REMOTE_CLOCK = new Date("2026-07-18T12:00:00.000Z");

interface FailurePlan {
  docId: string;
  error: Error;
  remaining?: number;
}

interface SyncLogEntry {
  level: "debug" | "info" | "warn";
  message: string;
  details: Record<string, unknown>;
}

function createTestLogger(entries: SyncLogEntry[]) {
  const append =
    (level: SyncLogEntry["level"]) =>
    (message: string, ...args: unknown[]) => {
      entries.push({
        level,
        message,
        details: (args[0] as Record<string, unknown> | undefined) ?? {},
      });
    };
  return {
    debug: append("debug"),
    info: append("info"),
    warn: append("warn"),
  };
}

class MemoryDocStorage implements DocStorage {
  readonly storageType = "doc";
  readonly spaceId = "synthetic-workspace";
  readonly connection = new DummyConnection();
  readonly getDocDiffCalls = new Map<string, number>();
  getDocTimestampsCalls = 0;
  readonly pushDocUpdateCalls = new Map<string, number>();
  readonly pushPayloads: DocUpdate[] = [];
  beforeGetDocDiffReturn?: (docId: string, call: number) => Promise<void>;
  beforePushAck?: (update: DocUpdate, call: number) => Promise<void>;

  private readonly deleteSubscribers = new Set<(docId: string) => void>();
  subscribeDocDelete(callback: (docId: string) => void) {
    this.deleteSubscribers.add(callback);
    return () => {
      this.deleteSubscribers.delete(callback);
    };
  }
  emitDelete(docId: string) {
    for (const callback of this.deleteSubscribers) callback(docId);
  }

  private clockOffset = 0;
  private readonly subscribers = new Set<
    (update: DocRecord, origin?: string) => void
  >();

  constructor(
    readonly isReadonly: boolean,
    readonly records: Map<string, DocRecord> = new Map(),
    private readonly failure?: FailurePlan,
    readonly shouldSyncDoc: (docId: string) => boolean = () => true,
  ) {}

  getDoc(docId: string) {
    return Promise.resolve(this.records.get(docId) ?? null);
  }

  async getDocDiff(docId: string, state?: Uint8Array): Promise<DocDiff | null> {
    const call = (this.getDocDiffCalls.get(docId) ?? 0) + 1;
    this.getDocDiffCalls.set(docId, call);
    if (
      docId === this.failure?.docId &&
      (this.failure.remaining === undefined || this.failure.remaining > 0)
    ) {
      if (this.failure.remaining !== undefined) this.failure.remaining--;
      throw this.failure.error;
    }
    const record = this.records.get(docId);
    const result = record
      ? {
          docId,
          missing: state ? diffUpdate(record.bin, state) : record.bin,
          state: encodeStateVectorFromUpdate(record.bin),
          timestamp: record.timestamp,
          pageRegistration: record.pageRegistration,
        }
      : null;
    await this.beforeGetDocDiffReturn?.(docId, call);
    return result;
  }

  async pushDocUpdate(update: DocUpdate, origin?: string): Promise<DocClock> {
    const call = (this.pushDocUpdateCalls.get(update.docId) ?? 0) + 1;
    this.pushDocUpdateCalls.set(update.docId, call);
    this.pushPayloads.push(update);
    const previous = this.records.get(update.docId);
    const record = {
      docId: update.docId,
      bin: previous ? mergeUpdates([previous.bin, update.bin]) : update.bin,
      timestamp: new Date(REMOTE_CLOCK.getTime() + ++this.clockOffset),
    };
    this.records.set(update.docId, record);
    for (const subscriber of this.subscribers) subscriber(record, origin);
    await this.beforePushAck?.(update, call);
    return record;
  }

  getDocTimestamp(docId: string): Promise<DocClock | null> {
    return Promise.resolve(this.records.get(docId) ?? null);
  }

  getDocTimestamps(after?: Date): Promise<DocClocks> {
    this.getDocTimestampsCalls += 1;
    return Promise.resolve(
      Object.fromEntries(
        [...this.records]
          .filter(([, record]) => !after || record.timestamp > after)
          .map(([docId, record]) => [docId, record.timestamp]),
      ),
    );
  }

  deleteDoc(docId: string): Promise<void> {
    this.records.delete(docId);
    this.emitDelete(docId);
    return Promise.resolve();
  }

  subscribeDocUpdate(
    callback: (update: DocRecord, origin?: string) => void,
  ): () => void {
    this.subscribers.add(callback);
    return () => this.subscribers.delete(callback);
  }

  emitExternalUpdate(record: DocRecord) {
    this.records.set(record.docId, record);
    for (const subscriber of this.subscribers) {
      subscriber(record, "synthetic-remote-update");
    }
  }
}

function createRecord(docId: string, value = docId): DocRecord {
  const doc = new YDoc();
  doc.getMap("content").set("value", value);
  return {
    docId,
    bin: encodeStateAsUpdate(doc),
    timestamp: REMOTE_CLOCK,
  };
}

async function mutateRecord(
  storage: MemoryDocStorage,
  docId: string,
  value: string,
) {
  const doc = new YDoc();
  const current = storage.records.get(docId);
  if (current) applyUpdate(doc, current.bin);
  doc.getMap("content").set("value", value);
  await storage.pushDocUpdate(
    { docId, bin: encodeStateAsUpdate(doc) },
    "synthetic-user-update",
  );
}

function readValue(storage: MemoryDocStorage, docId: string) {
  const doc = new YDoc();
  const record = storage.records.get(docId);
  if (record) applyUpdate(doc, record.bin);
  return doc.getMap("content").get("value");
}

async function waitFor(
  predicate: () => boolean,
  message: string,
  attempts = 300,
) {
  for (let index = 0; index < attempts; index++) {
    if (predicate()) return;
    await Promise.resolve();
  }
  throw new Error(`Timed out waiting for ${message}`);
}

async function waitForDocAttempt(
  storage: MemoryDocStorage,
  docId: string,
  expectedAttempts = 1,
) {
  await waitFor(
    () => (storage.getDocDiffCalls.get(docId) ?? 0) >= expectedAttempts,
    `sync attempt for ${docId}`,
  );
}

async function waitForPush(
  storage: MemoryDocStorage,
  docId: string,
  expectedPushes = 1,
) {
  await waitFor(
    () => (storage.pushDocUpdateCalls.get(docId) ?? 0) >= expectedPushes,
    `push for ${docId}`,
  );
}

async function waitForState(
  state$: Observable<DocSyncDocState>,
  predicate: (state: DocSyncDocState) => boolean,
) {
  for (let index = 0; index < 300; index++) {
    const state = await firstValueFrom(state$.pipe(take(1)));
    if (predicate(state)) return state;
    await Promise.resolve();
  }
  throw new Error("Timed out waiting for document sync state");
}

async function stopPeer(abort: AbortController, loop: Promise<void>) {
  abort.abort(MANUALLY_STOP);
  try {
    await loop;
  } catch (error) {
    if (error !== MANUALLY_STOP) throw error;
  }
}

function startPeer(
  local: MemoryDocStorage,
  remote: MemoryDocStorage,
  options: ConstructorParameters<typeof DocSyncPeer>[4] = {},
) {
  const peer = new DocSyncPeer(
    "synthetic-peer",
    local,
    new DummyDocSyncStorage(),
    remote,
    options,
  );
  const abort = new AbortController();
  return { peer, abort, loop: peer.mainLoop(abort.signal) };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("DocSyncPeer bounded reconciliation", () => {
  test.each([
    { kind: "reopened legacy cache", registration: "unresolved" as const },
    {
      kind: "Native offline first transmission",
      registration: "registered" as const,
    },
  ])(
    "preserves registration separately from byte ACK for $kind",
    async ({ registration }) => {
      const record = createRecord("registration-page", "retained content");
      if (registration === "registered") {
        const doc = new YDoc();
        applyUpdate(doc, record.bin);
        doc.getMap("meta").set("pageCreationId", record.docId);
        doc.getMap("meta").set("pageCreationIntent", "native-offline-create");
        record.bin = encodeStateAsUpdate(doc);
        doc.destroy();
      }
      const local = new MemoryDocStorage(
        false,
        new Map([[record.docId, record]]),
      );
      const remote = new MemoryDocStorage(false);
      remote.beforePushAck = async () => {
        remote.records.get(record.docId)!.pageRegistration = registration;
      };
      const first = startPeer(local, remote);
      try {
        const state = await waitForState(
          first.peer.docState$(record.docId),
          (state) => state.synced,
        );
        expect(state.pageRegistration).toBe(registration);
        expect(local.records.get(record.docId)?.bin).toEqual(record.bin);
        expect(readValue(remote, record.docId)).toBe("retained content");
      } finally {
        await stopPeer(first.abort, first.loop);
      }
      const reopened = startPeer(local, remote);
      try {
        const state = await waitForState(
          reopened.peer.docState$(record.docId),
          (state) => state.synced,
        );
        expect(state.pageRegistration).toBe(registration);
        expect(remote.pushDocUpdateCalls.get(record.docId)).toBe(1);
        expect(local.records.get(record.docId)?.bin).toEqual(record.bin);
      } finally {
        await stopPeer(reopened.abort, reopened.loop);
      }
    },
  );

  test("retains rejected page content with explicit unresolved feedback", async () => {
    const record = createRecord("rejected-page");
    const local = new MemoryDocStorage(
      false,
      new Map([[record.docId, record]]),
    );
    const remote = new MemoryDocStorage(false);
    const error = new DocSyncProtocolError(
      "NOT_FOUND",
      "document rejected",
      false,
    );
    error.pageRegistration = "unresolved";
    vi.spyOn(remote, "pushDocUpdate").mockRejectedValue(error);
    const running = startPeer(local, remote);
    try {
      const state = await waitForState(
        running.peer.docState$(record.docId),
        (state) => state.degraded,
      );
      expect(state.synced).toBe(false);
      expect(state.pageRegistration).toBe("unresolved");
      expect(local.records.get(record.docId)?.bin).toEqual(record.bin);
      expect(remote.records.has(record.docId)).toBe(false);
    } finally {
      await stopPeer(running.abort, running.loop);
    }
    const reopened = startPeer(local, remote);
    try {
      const state = await waitForState(
        reopened.peer.docState$(record.docId),
        (state) => state.degraded,
      );
      expect(state.pageRegistration).toBe("unresolved");
      expect(state.synced).toBe(false);
      expect([...local.records.keys()]).toEqual([record.docId]);
      expect(local.records.get(record.docId)?.bin).toEqual(record.bin);
      expect(remote.records.size).toBe(0);
    } finally {
      await stopPeer(reopened.abort, reopened.loop);
    }
  });
  test.each(["pull", "push"])(
    "retains offline edits without false recovery after Move during %s",
    async (phase) => {
      const record = createRecord("moved-page", "unsent offline content");
      const local = new MemoryDocStorage(
        false,
        new Map([[record.docId, record]]),
      );
      const remote = new MemoryDocStorage(false);
      const moved = new DocSyncProtocolError(
        "DOC_MOVED",
        "document moved",
        false,
      );
      const rejecting =
        phase === "pull"
          ? vi.spyOn(remote, "getDocDiff").mockRejectedValue(moved)
          : vi.spyOn(remote, "pushDocUpdate").mockRejectedValue(moved);
      for (let reopen = 0; reopen < 2; reopen++) {
        const running = startPeer(local, remote);
        try {
          const state = await waitForState(
            running.peer.docState$(record.docId),
            (state) => state.pageRegistration === "moved" && !state.syncing,
          );
          expect(state.errorMessage).toBeNull();
          expect(state.remoteMissing).toBe(true);
          expect(state.degraded).toBe(false);
          expect(state.synced).toBe(false);
          expect((await firstValueFrom(running.peer.peerState$)).synced).toBe(
            true,
          );
          expect(
            (await firstValueFrom(running.peer.peerState$)).unregisteredDocs,
          ).not.toContain(record.docId);
          expect(local.records.get(record.docId)?.bin).toEqual(record.bin);
          expect(readValue(local, record.docId)).toBe("unsent offline content");
          expect(remote.records.size).toBe(0);
        } finally {
          await stopPeer(running.abort, running.loop);
        }
      }
      rejecting.mockRestore();
      remote.records.set(record.docId, {
        ...record,
        pageRegistration: "registered",
      });
      const returned = startPeer(local, remote);
      try {
        const state = await waitForState(
          returned.peer.docState$(record.docId),
          (state) => state.pageRegistration === "registered" && state.synced,
        );
        expect(state.remoteMissing).toBe(false);
      } finally {
        await stopPeer(returned.abort, returned.loop);
      }
    },
  );

  test("coalesces 10,000 local and remote signals into one bounded document state", () => {
    const local = new MemoryDocStorage(false);
    const remote = new MemoryDocStorage(false);
    const peer = new DocSyncPeer(
      "synthetic-peer",
      local,
      new DummyDocSyncStorage(),
      remote,
    );
    const record = createRecord(HEALTHY_DOC_ID);

    for (let index = 0; index < 5_000; index++) {
      peer.events.localUpdated({
        docId: HEALTHY_DOC_ID,
        update: new Uint8Array([index % 255]),
        clock: new Date(REMOTE_CLOCK.getTime() + index),
      });
      peer.events.remoteUpdated({
        docId: HEALTHY_DOC_ID,
        update: record.bin,
        remoteClock: new Date(REMOTE_CLOCK.getTime() + index),
      });
    }

    const status = (
      peer as unknown as {
        status: {
          reconciles: Map<string, Record<string, unknown>>;
          reconcileQueue: { priorityMap: Map<string, number> };
        };
      }
    ).status;
    const state = status.reconciles.get(HEALTHY_DOC_ID);

    expect(status.reconciles).toHaveLength(1);
    expect(status.reconcileQueue.priorityMap).toHaveLength(1);
    expect(state).toEqual(
      expect.objectContaining({
        generation: 10_000,
        dirty: true,
        needsPull: true,
        inFlightGeneration: null,
      }),
    );
    expect(Object.values(state ?? {}).some(Array.isArray)).toBe(false);
    expect(state).not.toHaveProperty("updates");
    expect(state).not.toHaveProperty("jobs");
  });

  test("pulls after reconnect but sends no push when local and server state match", async () => {
    const record = createRecord(HEALTHY_DOC_ID);
    const local = new MemoryDocStorage(
      false,
      new Map([[HEALTHY_DOC_ID, record]]),
    );
    const remote = new MemoryDocStorage(
      false,
      new Map([[HEALTHY_DOC_ID, record]]),
    );

    const first = startPeer(local, remote);
    await waitForState(
      first.peer.docState$(HEALTHY_DOC_ID),
      (state) => state.synced,
    );
    await stopPeer(first.abort, first.loop);

    const second = startPeer(local, remote);
    try {
      await waitForState(
        second.peer.docState$(HEALTHY_DOC_ID),
        (state) => state.synced,
      );
      expect(remote.getDocDiffCalls.get(HEALTHY_DOC_ID)).toBe(2);
      expect(remote.pushDocUpdateCalls.get(HEALTHY_DOC_ID) ?? 0).toBe(0);
    } finally {
      await stopPeer(second.abort, second.loop);
    }
  });

  test("a priority raise revalidates a leaf that was missing before its first push", async () => {
    const docId = "root-membership-before-leaf";
    const local = new MemoryDocStorage(false);
    const remote = new MemoryDocStorage(true);
    const running = startPeer(local, remote);

    // A root membership can make the client connect an empty local leaf before
    // the creating peer's first leaf update has reached the server.
    running.peer.events.localUpdated({
      docId,
      update: new Uint8Array(),
      clock: REMOTE_CLOCK,
    });

    try {
      await waitForState(
        running.peer.docState$(docId),
        (state) => state.synced && state.remoteMissing,
      );
      expect(remote.getDocDiffCalls.get(docId)).toBe(1);

      // Simulate the creating peer's durable first push without a broadcast.
      // Opening the document raises its priority and must still recover it.
      remote.records.set(docId, createRecord(docId, "materialized leaf"));
      const releasePriority = running.peer.addPriority(docId, 100);
      await waitForState(
        running.peer.docState$(docId),
        (state) => state.synced && !state.remoteMissing,
      );

      expect(remote.getDocDiffCalls.get(docId)).toBe(2);
      expect(readValue(local, docId)).toBe("materialized leaf");
      releasePriority();
    } finally {
      await stopPeer(running.abort, running.loop);
    }
  });

  test("opening an unknown remote leaf pulls it without a prior broadcast", async () => {
    const docId = "membership-without-leaf-broadcast";
    const local = new MemoryDocStorage(false);
    const remote = new MemoryDocStorage(true);
    const running = startPeer(local, remote);

    try {
      await waitFor(
        () => remote.getDocTimestampsCalls > 0,
        "initial remote timestamp scan",
      );
      remote.records.set(docId, createRecord(docId, "opened from membership"));

      const releasePriority = running.peer.addPriority(docId, 100);
      await waitForState(
        running.peer.docState$(docId),
        (state) => state.synced && !state.remoteMissing,
      );

      expect(remote.getDocDiffCalls.get(docId)).toBe(1);
      expect(readValue(local, docId)).toBe("opened from membership");
      releasePriority();
    } finally {
      await stopPeer(running.abort, running.loop);
    }
  });

  test("a priority raise during a missing pull schedules one materialization pull", async () => {
    const docId = "open-during-root-membership-pull";
    const local = new MemoryDocStorage(false);
    const remote = new MemoryDocStorage(true);
    let releaseFirstPull!: () => void;
    const firstPull = new Promise<void>((resolve) => {
      releaseFirstPull = resolve;
    });
    remote.beforeGetDocDiffReturn = async (requestedDocId, call) => {
      if (requestedDocId === docId && call === 1) await firstPull;
    };
    const running = startPeer(local, remote);

    running.peer.events.localUpdated({
      docId,
      update: new Uint8Array(),
      clock: REMOTE_CLOCK,
    });

    try {
      await waitForDocAttempt(remote, docId);

      const releasePriority = running.peer.addPriority(docId, 100);
      remote.records.set(docId, createRecord(docId, "materialized while open"));
      releaseFirstPull();

      await waitForState(
        running.peer.docState$(docId),
        (state) => state.synced && !state.remoteMissing,
      );
      expect(remote.getDocDiffCalls.get(docId)).toBe(2);
      expect(readValue(local, docId)).toBe("materialized while open");
      releasePriority();
    } finally {
      releaseFirstPull();
      await stopPeer(running.abort, running.loop);
    }
  });

  test("reports remote absence even when an initialized local leaf exists", async () => {
    const docId = "initialized-local-leaf-without-remote";
    const local = new MemoryDocStorage(
      false,
      new Map([[docId, createRecord(docId, "local shell")]]),
    );
    const remote = new MemoryDocStorage(true);
    const running = startPeer(local, remote);

    try {
      const state = await waitForState(
        running.peer.docState$(docId),
        (candidate) => candidate.synced,
      );

      expect(state.remoteMissing).toBe(true);
      expect(remote.getDocDiffCalls.get(docId)).toBe(1);
    } finally {
      await stopPeer(running.abort, running.loop);
    }
  });

  test("synchronizes A to B and B to A with one push per user edit and no echo push", async () => {
    const docId = "two-way-document";
    const localA = new MemoryDocStorage(
      false,
      new Map([[docId, createRecord(docId, "A1")]]),
    );
    const localB = new MemoryDocStorage(false);
    const remote = new MemoryDocStorage(false);

    const aToServer = startPeer(localA, remote);
    await waitForPush(remote, docId, 1);
    await waitForState(
      aToServer.peer.docState$(docId),
      (state) => state.synced,
    );
    expect(remote.pushPayloads[0]?.initialDocumentProvenance).toBeUndefined();
    await stopPeer(aToServer.abort, aToServer.loop);

    const serverToB = startPeer(localB, remote);
    await waitForState(
      serverToB.peer.docState$(docId),
      (state) => state.synced,
    );
    expect(readValue(localB, docId)).toBe("A1");
    expect(remote.pushDocUpdateCalls.get(docId)).toBe(1);

    await mutateRecord(localB, docId, "B1");
    await waitForPush(remote, docId, 2);
    await waitForState(
      serverToB.peer.docState$(docId),
      (state) => state.synced,
    );
    await stopPeer(serverToB.abort, serverToB.loop);

    const serverToA = startPeer(localA, remote);
    try {
      await waitForState(
        serverToA.peer.docState$(docId),
        (state) => state.synced,
      );
      expect(readValue(localA, docId)).toBe("B1");
      expect(remote.pushDocUpdateCalls.get(docId)).toBe(2);
    } finally {
      await stopPeer(serverToA.abort, serverToA.loop);
    }
  });

  test("sends an edit made during a pending ACK exactly once in a follow-up generation", async () => {
    const docId = "ack-race-document";
    const local = new MemoryDocStorage(
      false,
      new Map([[docId, createRecord(docId, "first")]]),
    );
    const remote = new MemoryDocStorage(false);
    let resolveFirstAck!: () => void;
    const firstAck = new Promise<void>((resolve) => {
      resolveFirstAck = resolve;
    });
    remote.beforePushAck = async (_update, call) => {
      if (call === 1) await firstAck;
    };
    const running = startPeer(local, remote);

    try {
      await waitForPush(remote, docId, 1);
      await mutateRecord(local, docId, "second");
      resolveFirstAck();
      await waitForPush(remote, docId, 2);
      await waitForState(
        running.peer.docState$(docId),
        (state) => state.synced,
      );

      expect(remote.pushDocUpdateCalls.get(docId)).toBe(2);
      expect(readValue(remote, docId)).toBe("second");
    } finally {
      resolveFirstAck();
      await stopPeer(running.abort, running.loop);
    }
  });

  test("saveLocalUpdateAndWaitForSynced resolves only after the remote ACK", async () => {
    const docId = "creation-ack-document";
    const local = new MemoryDocStorage(false);
    const remote = new MemoryDocStorage(false);
    let releaseAck!: () => void;
    const ack = new Promise<void>((resolve) => {
      releaseAck = resolve;
    });
    remote.beforePushAck = async () => ack;
    const sync = new DocSyncImpl(
      { local, remotes: { cloud: remote } },
      new DummyDocSyncStorage(),
    );
    sync.start();
    let completed = false;

    const pending = sync
      .saveLocalUpdateAndWaitForSynced(
        { docId, bin: createRecord(docId, "created").bin },
        "frontend:create",
      )
      .then(() => {
        completed = true;
      });

    await waitForPush(remote, docId);
    expect(completed).toBe(false);
    releaseAck();
    await pending;
    expect(readValue(remote, docId)).toBe("created");
    sync.stop();
  });

  test("reports corrupt local Yjs state without requesting a full-pull loop", async () => {
    vi.useFakeTimers();
    const local = new MemoryDocStorage(
      false,
      new Map([
        [
          BROKEN_DOC_ID,
          {
            docId: BROKEN_DOC_ID,
            bin: new Uint8Array([255, 255, 255]),
            timestamp: REMOTE_CLOCK,
          },
        ],
      ]),
    );
    const remote = new MemoryDocStorage(
      false,
      new Map([[BROKEN_DOC_ID, createRecord(BROKEN_DOC_ID)]]),
    );
    const logs: SyncLogEntry[] = [];
    const running = startPeer(local, remote, {
      logger: createTestLogger(logs),
    });

    try {
      const state = await waitForState(
        running.peer.docState$(BROKEN_DOC_ID),
        (value) => value.degraded,
      );
      expect(state).toEqual(
        expect.objectContaining({
          errorMessage:
            "Document sync inspect failed (LocalDocumentStateError)",
          retrying: false,
        }),
      );
      expect(remote.getDocDiffCalls.get(BROKEN_DOC_ID) ?? 0).toBe(0);
      await vi.advanceTimersByTimeAsync(600_000);
      expect(remote.getDocDiffCalls.get(BROKEN_DOC_ID) ?? 0).toBe(0);
      expect(logs.at(-1)).toEqual(
        expect.objectContaining({
          message: "doc_sync.reconcile.rejected",
          details: expect.objectContaining({
            errorName: "LocalDocumentStateError",
            outcome: "terminal",
          }),
        }),
      );
    } finally {
      await stopPeer(running.abort, running.loop);
    }
  });
});

describe("DocSyncPeer document failure containment", () => {
  test("keeps a healthy document connected while only the failing document retries", async () => {
    vi.useFakeTimers();
    const logs: SyncLogEntry[] = [];
    const remote = new MemoryDocStorage(
      true,
      new Map([
        [HEALTHY_DOC_ID, createRecord(HEALTHY_DOC_ID)],
        [BROKEN_DOC_ID, createRecord(BROKEN_DOC_ID)],
      ]),
      {
        docId: BROKEN_DOC_ID,
        error: new Error("synthetic helper failure token=private-value"),
      },
    );
    const running = startPeer(new MemoryDocStorage(false), remote, {
      logger: createTestLogger(logs),
    });

    try {
      await waitForDocAttempt(remote, HEALTHY_DOC_ID);
      await waitForDocAttempt(remote, BROKEN_DOC_ID);
      const brokenState = await waitForState(
        running.peer.docState$(BROKEN_DOC_ID),
        (state) => state.degraded,
      );
      await waitForState(
        running.peer.docState$(HEALTHY_DOC_ID),
        (state) => state.synced,
      );

      expect(brokenState).toEqual(
        expect.objectContaining({
          degraded: true,
          errorMessage: "Document sync pull failed (Error)",
          retrying: true,
          synced: false,
          syncing: false,
        }),
      );
      expect(JSON.stringify(logs)).not.toContain("private-value");

      await vi.advanceTimersByTimeAsync(5_000);
      expect(remote.getDocDiffCalls.get(BROKEN_DOC_ID)).toBe(2);
      expect(remote.getDocDiffCalls.get(HEALTHY_DOC_ID)).toBe(1);
    } finally {
      await stopPeer(running.abort, running.loop);
    }
  });

  test("uses 5, 15, 60 and capped 300 second document backoff", async () => {
    vi.useFakeTimers();
    const logs: SyncLogEntry[] = [];
    const remote = new MemoryDocStorage(
      true,
      new Map([[BROKEN_DOC_ID, createRecord(BROKEN_DOC_ID)]]),
      { docId: BROKEN_DOC_ID, error: new Error("synthetic helper failure") },
    );
    const running = startPeer(new MemoryDocStorage(false), remote, {
      logger: createTestLogger(logs),
    });

    try {
      await waitForDocAttempt(remote, BROKEN_DOC_ID);
      for (const [delay, expectedAttempts] of [
        [5_000, 2],
        [15_000, 3],
        [60_000, 4],
        [300_000, 5],
        [300_000, 6],
      ] as const) {
        await vi.advanceTimersByTimeAsync(delay - 1);
        expect(remote.getDocDiffCalls.get(BROKEN_DOC_ID)).toBe(
          expectedAttempts - 1,
        );
        await vi.advanceTimersByTimeAsync(1);
        expect(remote.getDocDiffCalls.get(BROKEN_DOC_ID)).toBe(
          expectedAttempts,
        );
      }
      expect(
        logs
          .filter((entry) => entry.message === "doc_sync.reconcile.retry")
          .map((entry) => entry.details.retryAfterMs),
      ).toEqual([5_000, 15_000, 60_000, 300_000, 300_000, 300_000]);
    } finally {
      await stopPeer(running.abort, running.loop);
    }
  });

  test("honors bounded server retryAfterMs for SYNC_BUSY", async () => {
    vi.useFakeTimers();
    const remote = new MemoryDocStorage(
      true,
      new Map([[BROKEN_DOC_ID, createRecord(BROKEN_DOC_ID)]]),
      {
        docId: BROKEN_DOC_ID,
        error: new DocSyncProtocolError("SYNC_BUSY", "busy", true, 250),
      },
    );
    const running = startPeer(new MemoryDocStorage(false), remote, {
      logger: createTestLogger([]),
    });

    try {
      await waitForDocAttempt(remote, BROKEN_DOC_ID);
      await vi.advanceTimersByTimeAsync(249);
      expect(remote.getDocDiffCalls.get(BROKEN_DOC_ID)).toBe(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(remote.getDocDiffCalls.get(BROKEN_DOC_ID)).toBe(2);
    } finally {
      await stopPeer(running.abort, running.loop);
    }
  });

  test("falls back to normal backoff for a non-finite server retry delay", async () => {
    vi.useFakeTimers();
    const remote = new MemoryDocStorage(
      true,
      new Map([[BROKEN_DOC_ID, createRecord(BROKEN_DOC_ID)]]),
      {
        docId: BROKEN_DOC_ID,
        error: new DocSyncProtocolError("SYNC_BUSY", "busy", true, NaN),
      },
    );
    const running = startPeer(new MemoryDocStorage(false), remote, {
      logger: createTestLogger([]),
    });

    try {
      await waitForDocAttempt(remote, BROKEN_DOC_ID);
      await vi.advanceTimersByTimeAsync(4_999);
      expect(remote.getDocDiffCalls.get(BROKEN_DOC_ID)).toBe(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(remote.getDocDiffCalls.get(BROKEN_DOC_ID)).toBe(2);
    } finally {
      await stopPeer(running.abort, running.loop);
    }
  });

  test("a new local update resets document backoff and retries immediately", async () => {
    vi.useFakeTimers();
    const logs: SyncLogEntry[] = [];
    const local = new MemoryDocStorage(false);
    const remote = new MemoryDocStorage(
      true,
      new Map([[BROKEN_DOC_ID, createRecord(BROKEN_DOC_ID)]]),
      { docId: BROKEN_DOC_ID, error: new Error("synthetic helper failure") },
    );
    const running = startPeer(local, remote, {
      logger: createTestLogger(logs),
    });

    try {
      await waitForDocAttempt(remote, BROKEN_DOC_ID);
      await vi.advanceTimersByTimeAsync(5_000);
      expect(remote.getDocDiffCalls.get(BROKEN_DOC_ID)).toBe(2);
      await mutateRecord(local, BROKEN_DOC_ID, "new local value");
      await waitForDocAttempt(remote, BROKEN_DOC_ID, 3);
      await waitFor(
        () =>
          logs.filter((entry) => entry.message === "doc_sync.reconcile.retry")
            .length === 3,
        "third failure log",
      );
      expect(
        logs
          .filter((entry) => entry.message === "doc_sync.reconcile.retry")
          .map((entry) => entry.details.retryAfterMs),
      ).toEqual([5_000, 15_000, 5_000]);
    } finally {
      await stopPeer(running.abort, running.loop);
    }
  });

  test("a new remote update resets document backoff and retries immediately", async () => {
    vi.useFakeTimers();
    const logs: SyncLogEntry[] = [];
    const remote = new MemoryDocStorage(
      true,
      new Map([[BROKEN_DOC_ID, createRecord(BROKEN_DOC_ID)]]),
      { docId: BROKEN_DOC_ID, error: new Error("synthetic helper failure") },
    );
    const running = startPeer(new MemoryDocStorage(false), remote, {
      logger: createTestLogger(logs),
    });

    try {
      await waitForDocAttempt(remote, BROKEN_DOC_ID);
      await vi.advanceTimersByTimeAsync(5_000);
      remote.emitExternalUpdate(createRecord(BROKEN_DOC_ID, "remote update"));
      await waitForDocAttempt(remote, BROKEN_DOC_ID, 3);
      await waitFor(
        () =>
          logs.filter((entry) => entry.message === "doc_sync.reconcile.retry")
            .length === 3,
        "third failure log",
      );
      expect(
        logs
          .filter((entry) => entry.message === "doc_sync.reconcile.retry")
          .map((entry) => entry.details.retryAfterMs),
      ).toEqual([5_000, 15_000, 5_000]);
    } finally {
      await stopPeer(running.abort, running.loop);
    }
  });

  test("a successful retry clears degraded state without affecting other documents", async () => {
    vi.useFakeTimers();
    const remote = new MemoryDocStorage(
      true,
      new Map([[BROKEN_DOC_ID, createRecord(BROKEN_DOC_ID)]]),
      {
        docId: BROKEN_DOC_ID,
        error: new Error("one synthetic failure"),
        remaining: 1,
      },
    );
    const running = startPeer(new MemoryDocStorage(false), remote, {
      logger: createTestLogger([]),
    });

    try {
      await waitForState(
        running.peer.docState$(BROKEN_DOC_ID),
        (state) => state.degraded,
      );
      await vi.advanceTimersByTimeAsync(5_000);
      await expect(
        waitForState(
          running.peer.docState$(BROKEN_DOC_ID),
          (state) => state.synced,
        ),
      ).resolves.toEqual(
        expect.objectContaining({
          degraded: false,
          errorMessage: null,
          retrying: false,
          syncing: false,
        }),
      );
      expect(remote.getDocDiffCalls.get(BROKEN_DOC_ID)).toBe(2);
    } finally {
      await stopPeer(running.abort, running.loop);
    }
  });

  test("waitForSynced resolves for a healthy target while another document is degraded", async () => {
    vi.useFakeTimers();
    const remote = new MemoryDocStorage(
      true,
      new Map([
        [HEALTHY_DOC_ID, createRecord(HEALTHY_DOC_ID)],
        [BROKEN_DOC_ID, createRecord(BROKEN_DOC_ID)],
      ]),
      { docId: BROKEN_DOC_ID, error: new Error("synthetic helper failure") },
    );
    const sync = new DocSyncImpl(
      {
        local: new MemoryDocStorage(false),
        remotes: { synthetic: remote },
      },
      new DummyDocSyncStorage(),
    );
    sync.start();

    try {
      await waitForState(
        sync.docState$(BROKEN_DOC_ID),
        (state) => state.degraded,
      );
      await expect(sync.waitForSynced(HEALTHY_DOC_ID)).resolves.toBeUndefined();
      expect(remote.getDocDiffCalls.get(HEALTHY_DOC_ID)).toBe(1);
    } finally {
      sync.stop();
      await Promise.resolve();
    }
  });
});

describe("DocSyncPeer logging", () => {
  test("emits correlated structured fields without document IDs, payloads or error messages", async () => {
    const secret = "private-document-id token=secret payload=opaque";
    const logs: SyncLogEntry[] = [];
    const remote = new MemoryDocStorage(
      true,
      new Map([[secret, createRecord(secret)]]),
      { docId: secret, error: new Error(secret) },
    );
    const running = startPeer(new MemoryDocStorage(false), remote, {
      logger: createTestLogger(logs),
    });

    try {
      await waitForState(
        running.peer.docState$(secret),
        (state) => state.degraded,
      );
      const failure = logs.find(
        (entry) => entry.message === "doc_sync.reconcile.retry",
      );
      expect(failure?.details).toEqual(
        expect.objectContaining({
          operationId: expect.any(String),
          generation: expect.any(Number),
          durationMs: expect.any(Number),
          outcome: "retry_scheduled",
          errorName: "Error",
        }),
      );
      expect(JSON.stringify(logs)).not.toContain(secret);
    } finally {
      await stopPeer(running.abort, running.loop);
    }
  });

  test("keeps browser console quiet when the default debug namespace is disabled", async () => {
    const spies = [
      vi.spyOn(console, "debug").mockImplementation(() => {}),
      vi.spyOn(console, "info").mockImplementation(() => {}),
      vi.spyOn(console, "warn").mockImplementation(() => {}),
    ];
    const docId = "quiet-console-document";
    const running = startPeer(
      new MemoryDocStorage(false),
      new MemoryDocStorage(true, new Map([[docId, createRecord(docId)]])),
    );

    try {
      await waitForState(
        running.peer.docState$(docId),
        (state) => state.synced,
      );
      expect(spies.map((spy) => spy.mock.calls.length)).toEqual([0, 0, 0]);
    } finally {
      await stopPeer(running.abort, running.loop);
    }
  });
});

describe("DocSyncPeer document selection", () => {
  const blockedDocIds = [
    "db$docProperties",
    "userdata$owner-1$documentMetadataCache",
  ];
  const allowedDocIds = [
    "synthetic-workspace",
    "content-doc-1",
    "db$folders",
    "userdata$owner-1$otherTable",
    "userdata$$documentMetadataCache",
    "userdata$owner$nested$documentMetadataCache",
  ];

  test("cloud selection blocks only the two retired metadata document forms", () => {
    expect(blockedDocIds.map(shouldSyncCloudDoc)).toEqual([false, false]);
    expect(allowedDocIds.map(shouldSyncCloudDoc)).toEqual([
      true,
      true,
      true,
      true,
      true,
      true,
    ]);
  });

  test("blocked local documents never enter pull or push planning", async () => {
    const local = new MemoryDocStorage(false);
    for (const docId of [...blockedDocIds, ...allowedDocIds]) {
      local.records.set(docId, createRecord(docId));
    }
    const remote = new MemoryDocStorage(
      false,
      new Map(),
      undefined,
      shouldSyncCloudDoc,
    );
    const running = startPeer(local, remote);

    try {
      for (const docId of allowedDocIds) await waitForDocAttempt(remote, docId);
      for (const docId of blockedDocIds) {
        expect(remote.getDocDiffCalls.has(docId)).toBe(false);
        expect(remote.pushDocUpdateCalls.has(docId)).toBe(false);
      }
      for (const docId of allowedDocIds) {
        expect(remote.getDocDiffCalls.get(docId)).toBe(1);
        expect(remote.pushDocUpdateCalls.get(docId)).toBe(1);
      }
    } finally {
      await stopPeer(running.abort, running.loop);
    }
  });

  test("blocked remote clocks and live updates never mutate the local store", async () => {
    const records = new Map<string, DocRecord>();
    for (const docId of [...blockedDocIds, ...allowedDocIds]) {
      records.set(docId, createRecord(docId));
    }
    const local = new MemoryDocStorage(false);
    const remote = new MemoryDocStorage(
      true,
      records,
      undefined,
      shouldSyncCloudDoc,
    );
    const running = startPeer(local, remote);

    try {
      for (const docId of allowedDocIds) {
        await waitForState(
          running.peer.docState$(docId),
          (state) => state.synced,
        );
      }
      for (const docId of blockedDocIds)
        remote.emitExternalUpdate(createRecord(docId));
      await Promise.resolve();

      for (const docId of blockedDocIds) {
        expect(remote.getDocDiffCalls.has(docId)).toBe(false);
        expect(local.records.has(docId)).toBe(false);
      }
      for (const docId of allowedDocIds)
        expect(local.records.has(docId)).toBe(true);
    } finally {
      await stopPeer(running.abort, running.loop);
    }
  });
});

describe("permanent deletion reconciliation", () => {
  test("server-confirmed deletion drains other peers before purging shared storage", async () => {
    const record = createRecord("delete-with-another-peer");
    const local = new MemoryDocStorage(false);
    const slow = new MemoryDocStorage(false, new Map([[record.docId, record]]));
    const server = new MemoryDocStorage(
      false,
      new Map([[record.docId, record]]),
    );
    let release!: () => void;
    let started = false;
    slow.beforeGetDocDiffReturn = async () => {
      started = true;
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    };
    vi.spyOn(server, "getDocDiff").mockImplementation(async () => {
      await vi.waitFor(() => expect(started).toBe(true));
      throw new DocSyncProtocolError("DOC_DELETED", "deleted", false);
    });
    const purge = vi.spyOn(local, "deleteDoc");
    const sync = new DocSyncImpl(
      { local, remotes: { slow, server } },
      new DummyDocSyncStorage(),
    );
    const coordinatedDelete = vi.spyOn(sync, "deleteDoc");
    sync.start();
    try {
      await vi.waitFor(() =>
        expect(coordinatedDelete).toHaveBeenCalledWith(record.docId),
      );
      expect(purge).not.toHaveBeenCalled();
      release();
      await vi.waitFor(() => expect(purge).toHaveBeenCalledWith(record.docId));
      expect(await local.getDoc(record.docId)).toBeNull();
      expect(slow.pushDocUpdateCalls.size).toBe(0);
    } finally {
      release?.();
      sync.stop();
    }
  });

  test.each(["pull", "push"])(
    "purges an old cache after server-confirmed deletion during %s",
    async (phase) => {
      const record = createRecord("permanently-deleted");
      const local = new MemoryDocStorage(
        false,
        new Map([[record.docId, record]]),
      );
      const remote = new MemoryDocStorage(false);
      const deleted = new DocSyncProtocolError(
        "DOC_DELETED",
        "document permanently deleted",
        false,
      );
      if (phase === "pull")
        vi.spyOn(remote, "getDocDiff").mockRejectedValue(deleted);
      else vi.spyOn(remote, "pushDocUpdate").mockRejectedValue(deleted);
      const running = startPeer(local, remote);
      try {
        await vi.waitFor(() =>
          expect(local.records.has(record.docId)).toBe(false),
        );
        const state = await firstValueFrom(running.peer.peerState$);
        expect(state.unregisteredDocs).not.toContain(record.docId);
        expect(state.total).toBe(0);
      } finally {
        await stopPeer(running.abort, running.loop);
      }
      const reopened = startPeer(local, remote);
      try {
        const state = await firstValueFrom(
          reopened.peer.peerState$.pipe(filter((state) => state.synced)),
        );
        expect(state.total).toBe(0);
        expect(state.unregisteredDocs).not.toContain(record.docId);
      } finally {
        await stopPeer(reopened.abort, reopened.loop);
      }
    },
  );

  test("a server deletion notification revalidates and purges an already synced document", async () => {
    const record = createRecord("deleted-on-other-browser");
    const local = new MemoryDocStorage(
      false,
      new Map([[record.docId, record]]),
    );
    const remote = new MemoryDocStorage(
      false,
      new Map([[record.docId, record]]),
    );
    const running = startPeer(local, remote);
    try {
      await waitForState(
        running.peer.docState$(record.docId),
        (state) => state.synced,
      );
      vi.spyOn(remote, "getDocDiff").mockRejectedValue(
        new DocSyncProtocolError("DOC_DELETED", "deleted", false),
      );
      remote.emitDelete(record.docId);
      await vi.waitFor(() =>
        expect(local.records.has(record.docId)).toBe(false),
      );
      expect(
        (await firstValueFrom(running.peer.peerState$)).unregisteredDocs,
      ).not.toContain(record.docId);
    } finally {
      await stopPeer(running.abort, running.loop);
    }
  });

  test("local deletion drains a delayed pull before removing the cache", async () => {
    const record = createRecord("delete-during-pull");
    const local = new MemoryDocStorage(false);
    const remote = new MemoryDocStorage(
      false,
      new Map([[record.docId, record]]),
    );
    let release!: () => void;
    let started = false;
    remote.beforeGetDocDiffReturn = async () => {
      started = true;
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    };
    const sync = new DocSyncImpl(
      { local, remotes: { server: remote } },
      new DummyDocSyncStorage(),
    );
    sync.start();
    try {
      await vi.waitFor(() => expect(started).toBe(true));
      const deleting = sync.deleteDoc(record.docId);
      release();
      await deleting;
      expect(await local.getDoc(record.docId)).toBeNull();
      expect(remote.pushDocUpdateCalls.size).toBe(0);
      expect(
        (await firstValueFrom(sync.state$)).unregisteredDocs,
      ).not.toContain(record.docId);
    } finally {
      sync.stop();
    }
  });
});

test("first registered leaf acknowledgement refreshes the root without a broadcast", async () => {
  const rootId = "synthetic-workspace",
    leafId = "z-created-leaf";
  const root = createRecord(rootId, "client-creation");
  const local = new MemoryDocStorage(false, new Map([[rootId, root]]));
  const remote = new MemoryDocStorage(false, new Map([[rootId, root]]));
  const running = startPeer(local, remote);
  const canonical = new YDoc();
  try {
    // The empty peer briefly reports synced before bootstrap discovers docs.
    // Wait for this root's completed reconciliation, not that empty state.
    await firstValueFrom(
      running.peer.docState$(rootId).pipe(filter((s) => s.synced)),
    );
    const rootPulls = remote.getDocDiffCalls.get(rootId) ?? 0;
    applyUpdate(canonical, root.bin);
    canonical.getMap("content").set("value", "server-registration");
    const push = remote.pushDocUpdate.bind(remote);
    vi.spyOn(remote, "pushDocUpdate").mockImplementation(
      async (update, origin) => {
        const acknowledgement = await push(update, origin);
        if (update.docId !== leafId) return acknowledgement;
        // Persistence changes the root, but no root event reaches this peer.
        remote.records.set(rootId, {
          docId: rootId,
          bin: encodeStateAsUpdate(canonical),
          timestamp: new Date(REMOTE_CLOCK.getTime() + 1000),
        });
        return { ...acknowledgement, pageRegistration: "registered" };
      },
    );
    const leaf = createRecord(leafId);
    await local.pushDocUpdate(
      { docId: leafId, bin: leaf.bin },
      "fixture-create",
    );
    await vi.waitFor(() =>
      expect(readValue(local, rootId)).toBe("server-registration"),
    );
    expect(remote.getDocDiffCalls.get(rootId)).toBeGreaterThan(rootPulls);
    await firstValueFrom(running.peer.peerState$.pipe(filter((s) => s.synced)));

    const afterRegistration = remote.getDocDiffCalls.get(rootId);
    await mutateRecord(local, leafId, "later-edit");
    await vi.waitFor(() =>
      expect(remote.pushDocUpdateCalls.get(leafId)).toBe(2),
    );
    await firstValueFrom(running.peer.peerState$.pipe(filter((s) => s.synced)));
    expect(remote.getDocDiffCalls.get(rootId)).toBe(afterRegistration);
  } finally {
    canonical.destroy();
    await stopPeer(running.abort, running.loop);
  }
});
