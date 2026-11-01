import { DebugLogger } from "@myoxus/debug";
import { reserveAutomaticRetry } from "@myoxus/infra/retry";
import { nanoid } from "nanoid";
import { Observable, ReplaySubject, share, Subject } from "rxjs";
import {
  decodeStateVector,
  diffUpdate,
  encodeStateVector,
  encodeStateVectorFromUpdate,
} from "yjs";

import type {
  DocRecord,
  DocStorage,
  DocSyncStorage,
  PageRegistrationState,
} from "../../storage";
import { AsyncPriorityQueue } from "../../utils/async-priority-queue";
import { ClockMap } from "../../utils/clock";
import { isEmptyUpdate } from "../../utils/is-empty-update";
import { throwIfAborted } from "../../utils/throw-if-aborted";
import { DocSyncProtocolError } from "./error";

type ReconcilePhase = "inspect" | "pull" | "apply" | "push" | "reconcile";

interface DocReconcileState {
  pageRegistration?: PageRegistrationState | null;
  generation: number;
  inFlightGeneration: number | null;
  dirty: boolean;
  needsPull: boolean;
  confirmedServerStateVector: Uint8Array | null;
  pendingError: Error | null;
  remoteMissing: boolean;
}

interface Status {
  docs: Set<string>;
  connectedDocs: Set<string>;
  docFailures: Map<string, DocFailureState>;
  reconcileQueue: AsyncPriorityQueue;
  reconciles: Map<string, DocReconcileState>;
  remoteClocks: ClockMap;
  syncing: boolean;
  retrying: boolean;
  skipped: boolean;
  errorMessage: string | null;
}

interface PeerState {
  unregisteredDocs?: string[];
  total: number;
  syncing: number;
  retrying: boolean;
  synced: boolean;
  errorMessage: string | null;
}

interface PeerDocState {
  pageRegistration?: PageRegistrationState | null;
  degraded: boolean;
  remoteMissing: boolean;
  syncing: boolean;
  synced: boolean;
  retrying: boolean;
  errorMessage: string | null;
}

interface SyncLogger {
  debug(message: string, ...args: unknown[]): void;
  info(message: string, ...args: unknown[]): void;
  warn(message: string, ...args: unknown[]): void;
}

interface DocSyncPeerOptions {
  logger?: SyncLogger;
  /** The storage owner drains every peer before purging shared local data. */
  deleteLocalDoc?: (docId: string) => Promise<void>;
}

interface DocFailureState {
  attempt: number;
  errorMessage: string;
  phase: ReconcilePhase;
  retryTimer: ReturnType<typeof setTimeout> | null;
}

class LocalDocumentStateError extends Error {
  constructor() {
    super("Local document state cannot be decoded");
    this.name = "LocalDocumentStateError";
  }
}

class ReconcileFailure extends Error {
  constructor(
    readonly phase: ReconcilePhase,
    override readonly cause: unknown,
    readonly operationId: string,
    readonly generation: number,
    readonly durationMs: number,
  ) {
    super("Document reconciliation failed");
    this.name = "ReconcileFailure";
  }
}

const DOC_RETRY_DELAYS_MS = [5_000, 15_000, 60_000, 300_000] as const;
const EMPTY_STATE_VECTOR = encodeStateVector(new Map<number, number>());
const MIN_RETRY_AFTER_MS = 100;
const MAX_RETRY_AFTER_MS = 300_000;

function syncErrorName(cause: unknown): string {
  const name = cause instanceof Error ? cause.name : "Error";
  return /^[A-Za-z][A-Za-z0-9_.-]{0,40}$/.test(name) ? name : "Error";
}

function publicSyncError(phase: ReconcilePhase, cause: unknown): string {
  return `Document sync ${phase} failed (${syncErrorName(cause)})`;
}

function localStateVector(record: DocRecord | null): Uint8Array {
  if (!record || isEmptyUpdate(record.bin)) {
    return EMPTY_STATE_VECTOR;
  }
  try {
    return encodeStateVectorFromUpdate(record.bin);
  } catch {
    throw new LocalDocumentStateError();
  }
}

function mergeStateVectors(
  current: Uint8Array | null,
  next: Uint8Array,
): Uint8Array {
  try {
    const merged = current
      ? new Map<number, number>(decodeStateVector(current))
      : new Map<number, number>();
    for (const [client, clock] of decodeStateVector(next)) {
      if ((merged.get(client) ?? 0) < clock) {
        merged.set(client, clock);
      }
    }
    return encodeStateVector(merged);
  } catch {
    throw new DocSyncProtocolError(
      "INVALID_STATE_VECTOR",
      "Server state vector cannot be decoded",
      false,
    );
  }
}

function stateVectorFromServerUpdate(update: Uint8Array): Uint8Array {
  try {
    return encodeStateVectorFromUpdate(update);
  } catch {
    throw new DocSyncProtocolError(
      "INVALID_YJS_UPDATE",
      "Server update cannot be decoded",
      false,
    );
  }
}

function equalUpdates(left: Uint8Array, right: Uint8Array): boolean {
  return (
    left.byteLength === right.byteLength &&
    left.every((value, index) => value === right[index])
  );
}

function retryContract(cause: unknown): {
  retryable: boolean;
  retryAfterMs?: number;
} {
  if (cause instanceof LocalDocumentStateError) {
    return { retryable: false };
  }
  if (cause instanceof DocSyncProtocolError) {
    return {
      retryable: cause.retryable,
      retryAfterMs: cause.retryAfterMs,
    };
  }
  return { retryable: true };
}

function retryDelayMs(configured: number, requested?: number): number {
  if (requested === undefined || !Number.isFinite(requested)) return configured;
  return Math.min(MAX_RETRY_AFTER_MS, Math.max(MIN_RETRY_AFTER_MS, requested));
}

/**
 * Synchronizes one local document store with one remote peer.
 *
 * Each document owns exactly one bounded reconcile record. `generation`
 * advances for every local or server signal, `inFlightGeneration` identifies
 * the state captured by the current request, and `dirty`/`needsPull` are
 * boolean follow-up promises. Raw local updates are never queued. The last
 * server-confirmed state vector exists only in memory and is intentionally
 * discarded on reconnect, failed ACK, or storage disconnect; the next run must
 * pull before it may derive an optional local diff.
 */
export class DocSyncPeer {
  private readonly retiredDocs = new Set<string>();
  private readonly inFlight = new Map<string, Promise<void>>();

  /** Invalidate first, then drain work that could repopulate local data/clocks. */
  async retireDoc(docId: string): Promise<void> {
    this.retiredDocs.add(docId);
    this.status.reconcileQueue.remove(docId);
    this.clearDocFailure(docId);
    // The running reconcile loop owns error handling; this wait only drains it.
    await this.inFlight.get(docId)?.catch(() => {});
    this.status.remoteClocks.delete(docId);
    this.status.docs.delete(docId);
    this.status.connectedDocs.delete(docId);
    this.status.reconciles.delete(docId);
    this.statusUpdatedSubject$.next(docId);
  }

  retryDeletion(docId: string, error: unknown) {
    this.retiredDocs.delete(docId);
    this.status.docs.add(docId);
    this.ensureReconcile(docId).pageRegistration = "deleted";
    this.handleDocFailure(docId, error);
  }

  private readonly uniqueId = `sync:${this.peerId}:${nanoid()}`;
  private readonly prioritySettings = new Map<string, number>();
  private readonly logger: SyncLogger;

  constructor(
    readonly peerId: string,
    readonly local: DocStorage,
    readonly syncMetadata: DocSyncStorage,
    readonly remote: DocStorage,
    readonly options: DocSyncPeerOptions = {},
  ) {
    this.logger = options.logger ?? new DebugLogger("myoxus:storage:doc-sync");
  }

  private status: Status = this.createStatus();

  private createStatus(previousError: string | null = null): Status {
    return {
      docs: new Set(),
      connectedDocs: new Set(),
      docFailures: new Map(),
      reconcileQueue: new AsyncPriorityQueue(),
      reconciles: new Map(),
      remoteClocks: new ClockMap(new Map()),
      syncing: false,
      retrying: previousError !== null,
      skipped: false,
      errorMessage: previousError,
    };
  }

  private shouldSyncDoc(docId: string): boolean {
    return (
      !this.retiredDocs.has(docId) &&
      (this.remote.shouldSyncDoc?.(docId) ?? true)
    );
  }

  private readonly statusUpdatedSubject$ = new Subject<string | true>();

  peerState$ = new Observable<PeerState>((subscribe) => {
    const next = () => {
      if (this.status.skipped) {
        subscribe.next({
          total: 0,
          syncing: 0,
          synced: true,
          retrying: false,
          errorMessage: null,
        });
        return;
      }
      if (!this.status.syncing) {
        subscribe.next({
          total: this.status.docs.size,
          syncing: this.status.docs.size,
          synced: false,
          retrying: this.status.retrying,
          errorMessage: this.status.errorMessage,
        });
        return;
      }
      const syncing = [...this.status.docs].filter(
        (docId) => !this.getDocState(docId).synced,
      ).length;
      const failed = this.status.docFailures.values().next().value as
        DocFailureState | undefined;
      subscribe.next({
        total: this.status.docs.size,
        syncing,
        unregisteredDocs: [...this.status.reconciles]
          .filter(
            ([, state]) =>
              state.pageRegistration === "unresolved" ||
              state.pageRegistration === "legacy",
          )
          .map(([id]) => id),
        retrying:
          this.status.retrying ||
          [...this.status.docFailures.values()].some(
            (failure) => failure.retryTimer !== null,
          ),
        errorMessage: this.status.errorMessage ?? failed?.errorMessage ?? null,
        synced: syncing === 0,
      });
    };
    next();
    const dispose = this.statusUpdatedSubject$.subscribe(next);
    return () => dispose.unsubscribe();
  }).pipe(
    share({
      connector: () => new ReplaySubject(1),
    }),
  );

  docState$(docId: string) {
    return new Observable<PeerDocState>((subscribe) => {
      const next = () => {
        if (this.status.skipped) {
          subscribe.next({
            degraded: false,
            remoteMissing: false,
            syncing: false,
            synced: true,
            retrying: false,
            errorMessage: null,
          });
          return;
        }
        subscribe.next(this.getDocState(docId));
      };
      next();
      return this.statusUpdatedSubject$.subscribe((updatedId) => {
        if (updatedId === true || updatedId === docId) next();
      });
    });
  }

  private getDocState(docId: string): PeerDocState {
    if (!this.shouldSyncDoc(docId)) {
      return {
        pageRegistration: this.retiredDocs.has(docId) ? "deleted" : undefined,
        degraded: false,
        remoteMissing: false,
        syncing: false,
        synced: true,
        retrying: false,
        errorMessage: null,
      };
    }
    const failure = this.status.docFailures.get(docId);
    const reconcile = this.status.reconciles.get(docId);
    const pending =
      reconcile !== undefined &&
      (this.status.reconcileQueue.has(docId) ||
        reconcile.inFlightGeneration !== null ||
        reconcile.dirty ||
        reconcile.needsPull ||
        reconcile.pendingError !== null);
    const connected = this.status.connectedDocs.has(docId);
    const degraded = failure !== undefined;
    if (reconcile?.pageRegistration === "moved" && !pending) {
      // Settled remote retirement is not acknowledgement of retained local edits.
      return {
        pageRegistration: "moved",
        remoteMissing: true,
        degraded: false,
        syncing: false,
        synced: false,
        retrying: false,
        errorMessage: null,
      };
    }
    return {
      degraded,
      remoteMissing: reconcile?.remoteMissing ?? false,
      pageRegistration: reconcile?.pageRegistration,
      syncing: degraded
        ? pending && failure.retryTimer === null
        : !connected || pending,
      synced: !degraded && connected && !pending,
      retrying:
        (failure !== undefined && failure.retryTimer !== null) ||
        this.status.retrying,
      errorMessage: failure?.errorMessage ?? this.status.errorMessage,
    };
  }

  private ensureReconcile(docId: string): DocReconcileState {
    let state = this.status.reconciles.get(docId);
    if (!state) {
      state = {
        generation: 0,
        inFlightGeneration: null,
        dirty: false,
        needsPull: true,
        confirmedServerStateVector: null,
        pendingError: null,
        remoteMissing: false,
      };
      this.status.reconciles.set(docId, state);
    }
    return state;
  }

  private queueReconcile(docId: string) {
    if (!this.shouldSyncDoc(docId)) return;
    const priority = this.prioritySettings.get(docId) ?? 0;
    this.status.reconcileQueue.push(docId, priority);
    this.statusUpdatedSubject$.next(docId);
  }

  private addDoc(docId: string) {
    if (!this.shouldSyncDoc(docId)) return;
    if (!this.status.docs.has(docId)) {
      this.status.docs.add(docId);
      this.ensureReconcile(docId);
      this.queueReconcile(docId);
    }
  }

  private clearDocFailure(docId: string) {
    const failure = this.status.docFailures.get(docId);
    if (!failure) return;
    if (failure.retryTimer !== null) clearTimeout(failure.retryTimer);
    this.status.docFailures.delete(docId);
    this.statusUpdatedSubject$.next(docId);
  }

  private clearDocRetryTimers() {
    for (const failure of this.status.docFailures.values()) {
      if (failure.retryTimer !== null) clearTimeout(failure.retryTimer);
    }
  }

  private handleDocFailure(
    docId: string,
    failureCause: unknown,
    signal?: AbortSignal,
  ) {
    const failure =
      failureCause instanceof ReconcileFailure
        ? failureCause
        : new ReconcileFailure("reconcile", failureCause, nanoid(), 0, 0);
    const cause = failure.cause;
    const previousAttempt = this.status.docFailures.get(docId)?.attempt ?? 0;
    this.clearDocFailure(docId);
    this.status.connectedDocs.delete(docId);
    this.status.reconcileQueue.remove(docId);

    const state = this.ensureReconcile(docId);
    state.confirmedServerStateVector = null;
    state.needsPull = true;
    const attempt = previousAttempt + 1;
    const contract = retryContract(cause);
    const configuredDelay =
      DOC_RETRY_DELAYS_MS[
        Math.min(attempt - 1, DOC_RETRY_DELAYS_MS.length - 1)
      ];
    const retryDelay = retryDelayMs(configuredDelay, contract.retryAfterMs);
    const docFailure: DocFailureState = {
      attempt,
      errorMessage: publicSyncError(failure.phase, cause),
      phase: failure.phase,
      retryTimer: null,
    };
    if (contract.retryable) {
      docFailure.retryTimer = setTimeout(() => {
        if (
          signal?.aborted ||
          this.status.docFailures.get(docId) !== docFailure
        ) {
          return;
        }
        docFailure.retryTimer = null;
        if (!reserveAutomaticRetry("document-sync")) {
          this.statusUpdatedSubject$.next(docId);
          return;
        }
        this.queueReconcile(docId);
      }, retryDelay);
    }
    this.status.docFailures.set(docId, docFailure);
    this.statusUpdatedSubject$.next(docId);
    this.logger.warn(
      contract.retryable
        ? "doc_sync.reconcile.retry"
        : "doc_sync.reconcile.rejected",
      {
        operationId: failure.operationId,
        generation: failure.generation,
        durationMs: failure.durationMs,
        phase: failure.phase,
        outcome: contract.retryable ? "retry_scheduled" : "terminal",
        errorName: syncErrorName(cause),
        retryAfterMs: contract.retryable ? retryDelay : undefined,
      },
    );
  }

  private async reconcileDocument(
    docId: string,
    state: DocReconcileState,
    generation: number,
    signal?: AbortSignal,
  ) {
    const operationId = nanoid();
    const started = performance.now();
    let phase: ReconcilePhase = "inspect";
    const assertActive = () => {
      throwIfAborted(signal);
      if (this.retiredDocs.has(docId) || state.pageRegistration === "deleted")
        throw new DocSyncProtocolError(
          "DOC_DELETED",
          "Document permanently deleted",
          false,
        );
    };
    this.logger.debug("doc_sync.reconcile.started", {
      operationId,
      generation,
      phase,
      outcome: "started",
    });
    try {
      assertActive();
      if (state.pendingError) {
        const pendingError = state.pendingError;
        state.pendingError = null;
        throw pendingError;
      }

      let localRecord = await this.local.getDoc(docId);
      assertActive();
      let localVector = localStateVector(localRecord);
      const mustPull =
        state.confirmedServerStateVector === null || state.needsPull;
      state.needsPull = false;

      let confirmedServerResidual: Uint8Array | null = null;
      if (mustPull) {
        phase = "pull";
        const priorityAtPullStart = this.prioritySettings.get(docId) ?? 0;
        const remoteRecord = await this.remote.getDocDiff(docId, localVector);
        assertActive();
        if (remoteRecord) {
          state.remoteMissing = false;
          state.pageRegistration = remoteRecord.pageRegistration;
          state.confirmedServerStateVector = mergeStateVectors(
            state.confirmedServerStateVector,
            remoteRecord.state,
          );
          try {
            // A Yjs state vector does not encode its delete set. The server's
            // returned diff does, so retain its residual only for this
            // reconcile to distinguish a remote delete set from a new local
            // deletion. Persisting or queueing this update would create a
            // second sync checkpoint and is intentionally avoided.
            confirmedServerResidual = diffUpdate(
              remoteRecord.missing,
              remoteRecord.state,
            );
          } catch {
            throw new DocSyncProtocolError(
              "INVALID_YJS_UPDATE",
              "Server diff cannot be decoded",
              false,
            );
          }
          if (!isEmptyUpdate(remoteRecord.missing)) {
            phase = "apply";
            await this.local.pushDocUpdate(
              { docId, bin: remoteRecord.missing },
              this.uniqueId,
            );
            assertActive();
          }
          await this.syncMetadata.setPeerPulledRemoteClock(this.peerId, {
            docId,
            timestamp: remoteRecord.timestamp,
          });
        } else {
          state.confirmedServerStateVector = EMPTY_STATE_VECTOR;
          // Remote absence is a server observation, not a statement about the
          // local cache. A Virgultum leaf can already have an initialized local
          // Y.Doc while another client's first materializing push is still in
          // flight. Treating that local shell as remote existence lets routes
          // expose an empty document before the server has acknowledged it.
          state.remoteMissing = true;
          if ((this.prioritySettings.get(docId) ?? 0) > priorityAtPullStart) {
            // Opening a document can race the root-membership pull that began
            // before the creating peer materialized its leaf. Re-run only for
            // that observed priority transition; a genuinely absent active
            // document must not create an unbounded polling loop.
            state.confirmedServerStateVector = null;
            state.needsPull = true;
          }
        }
      }

      if (!this.remote.isReadonly) {
        localRecord = await this.local.getDoc(docId);
        assertActive();
        localVector = localStateVector(localRecord);
        if (localRecord && !isEmptyUpdate(localRecord.bin)) {
          const confirmedVector =
            state.confirmedServerStateVector ?? EMPTY_STATE_VECTOR;
          let localDiff: Uint8Array;
          try {
            localDiff = diffUpdate(localRecord.bin, confirmedVector);
          } catch {
            throw new LocalDocumentStateError();
          }
          const containsOnlyConfirmedServerDeletes =
            confirmedServerResidual !== null &&
            equalUpdates(localDiff, confirmedServerResidual);
          if (
            !isEmptyUpdate(localDiff) &&
            !containsOnlyConfirmedServerDeletes
          ) {
            phase = "push";
            const capturedStateVector = localVector;
            const capturedClock = localRecord.timestamp;
            const acknowledgement = await this.remote.pushDocUpdate(
              {
                docId,
                bin: localDiff,
              },
              this.uniqueId,
            );
            assertActive();
            state.remoteMissing = false;
            const wasRegistered = state.pageRegistration === "registered";
            state.pageRegistration = acknowledgement.pageRegistration;
            if (
              !wasRegistered &&
              state.pageRegistration === "registered" &&
              this.remote.spaceId &&
              docId !== this.remote.spaceId
            ) {
              // A first leaf ACK can create/fold its root entry server-side.
              // Pull that authoritative root even if its notification is late.
              const rootId = this.remote.spaceId;
              this.addDoc(rootId);
              const root = this.ensureReconcile(rootId);
              root.generation += 1;
              root.needsPull = true;
              this.queueReconcile(rootId);
            }
            state.confirmedServerStateVector = mergeStateVectors(
              state.confirmedServerStateVector,
              capturedStateVector,
            );
            await this.syncMetadata.setPeerPushedClock(this.peerId, {
              docId,
              timestamp: capturedClock,
            });
          } else {
            await this.syncMetadata.setPeerPushedClock(this.peerId, {
              docId,
              timestamp: localRecord.timestamp,
            });
          }
        }
      }

      assertActive();
      this.status.connectedDocs.add(docId);
      this.clearDocFailure(docId);
      this.logger.debug("doc_sync.reconcile.completed", {
        operationId,
        generation,
        durationMs: Math.round(performance.now() - started),
        phase,
        outcome: "success",
      });
    } catch (cause) {
      if (cause instanceof DocSyncProtocolError && cause.pageRegistration) {
        state.pageRegistration = cause.pageRegistration;
      }
      state.needsPull = true;
      const durationMs = Math.round(performance.now() - started);
      this.logger.debug("doc_sync.reconcile.completed", {
        operationId,
        generation,
        durationMs,
        phase,
        outcome: "failed",
        errorName: syncErrorName(cause),
      });
      throw new ReconcileFailure(
        phase,
        cause,
        operationId,
        generation,
        durationMs,
      );
    }
  }

  readonly events = {
    localUpdated: ({
      docId,
    }: {
      docId: string;
      update: Uint8Array;
      clock: Date;
    }) => {
      if (!this.shouldSyncDoc(docId)) return;
      this.addDoc(docId);
      this.clearDocFailure(docId);
      const state = this.ensureReconcile(docId);
      state.generation += 1;
      state.dirty = true;
      this.queueReconcile(docId);
    },
    remoteUpdated: ({
      docId,
      update,
      remoteClock,
    }: {
      docId: string;
      update: Uint8Array;
      remoteClock: Date;
    }) => {
      if (!this.shouldSyncDoc(docId)) return;
      this.addDoc(docId);
      this.clearDocFailure(docId);
      const state = this.ensureReconcile(docId);
      state.generation += 1;
      state.needsPull = true;
      state.pendingError = null;
      state.remoteMissing = false;
      this.status.remoteClocks.setIfBigger(docId, remoteClock);
      try {
        state.confirmedServerStateVector = mergeStateVectors(
          state.confirmedServerStateVector,
          stateVectorFromServerUpdate(update),
        );
      } catch (error) {
        state.pendingError =
          error instanceof Error ? error : new Error("Invalid server update");
      }
      this.queueReconcile(docId);
    },
  };

  async mainLoop(signal?: AbortSignal) {
    while (true) {
      try {
        await this.retryLoop(signal);
      } catch (error) {
        if (signal?.aborted) return;
        const errorMessage = `Document sync session failed (${syncErrorName(error)})`;
        this.status.errorMessage = errorMessage;
        this.statusUpdatedSubject$.next(true);
        this.logger.warn("session failed", {
          operationId: nanoid(),
          generation: 0,
          outcome: "retry_scheduled",
          errorName: syncErrorName(error),
          retryAfterMs: 5_000,
        });
      } finally {
        const previousError = this.status.errorMessage;
        this.clearDocRetryTimers();
        this.status = this.createStatus(previousError);
        this.statusUpdatedSubject$.next(true);
      }
      const retryAdmitted = await Promise.race([
        new Promise<boolean>((resolve) =>
          setTimeout(
            () => resolve(reserveAutomaticRetry("document-sync")),
            5_000,
          ),
        ),
        new Promise((_, reject) => {
          if (signal?.aborted) reject(signal.reason);
          signal?.addEventListener("abort", () => reject(signal.reason), {
            once: true,
          });
        }),
      ]);
      if (!retryAdmitted) return;
    }
  }

  private async retryLoop(signal?: AbortSignal) {
    throwIfAborted(signal);
    if (this.local.isReadonly) {
      this.status.skipped = true;
      this.statusUpdatedSubject$.next(true);
      await new Promise((_, reject) => {
        signal?.addEventListener("abort", () => reject(signal.reason), {
          once: true,
        });
      });
      return;
    }

    const abort = new AbortController();
    signal?.addEventListener("abort", () => abort.abort(signal.reason), {
      once: true,
    });
    const sessionSignal = abort.signal;
    const disposes: (() => void)[] = [];

    try {
      await Promise.race([
        Promise.all([
          this.local.connection.waitForConnected(sessionSignal),
          this.remote.connection.waitForConnected(sessionSignal),
          this.syncMetadata.connection.waitForConnected(sessionSignal),
        ]),
        new Promise<void>((_, reject) =>
          setTimeout(
            () => reject(new Error("Remote connection timeout")),
            30_000,
          ),
        ),
        new Promise((_, reject) =>
          sessionSignal.addEventListener(
            "abort",
            () => reject(sessionSignal.reason),
            { once: true },
          ),
        ),
      ]);

      this.logger.info("session started", {
        operationId: nanoid(),
        generation: 0,
        outcome: "connected",
      });
      this.status.syncing = true;
      this.status.retrying = false;
      this.statusUpdatedSubject$.next(true);

      for (const storage of [this.remote, this.local, this.syncMetadata]) {
        disposes.push(
          storage.connection.onStatusChanged((_status, error) => {
            abort.abort(`Storage disconnected:${syncErrorName(error)}`);
          }),
        );
      }

      disposes.push(
        this.local.subscribeDocUpdate((update, origin) => {
          if (
            origin === this.uniqueId ||
            origin?.startsWith(`sync:${this.peerId}:`)
          ) {
            return;
          }
          this.events.localUpdated({
            docId: update.docId,
            clock: update.timestamp,
            update: update.bin,
          });
        }),
      );
      disposes.push(
        this.remote.subscribeDocUpdate(({ bin, docId, timestamp }, origin) => {
          if (origin === this.uniqueId) return;
          this.events.remoteUpdated({
            docId,
            update: bin,
            remoteClock: timestamp,
          });
        }),
      );

      if (this.local.subscribeDocDelete)
        disposes.push(
          this.local.subscribeDocDelete((docId) => {
            void this.retireDoc(docId);
          }),
        );
      if (this.remote.subscribeDocDelete)
        disposes.push(
          this.remote.subscribeDocDelete((docId) => {
            if (!this.shouldSyncDoc(docId)) return;
            this.addDoc(docId);
            const state = this.ensureReconcile(docId);
            state.needsPull = true;
            state.generation += 1;
            this.queueReconcile(docId);
          }),
        );

      for (const docId of Object.keys(await this.local.getDocTimestamps())) {
        this.addDoc(docId);
      }
      throwIfAborted(sessionSignal);

      const cachedClocks = await this.syncMetadata.getPeerRemoteClocks(
        this.peerId,
      );
      this.status.remoteClocks.clear();
      for (const [docId, clock] of Object.entries(cachedClocks)) {
        if (this.shouldSyncDoc(docId))
          this.status.remoteClocks.set(docId, clock);
      }
      const newClocks = await this.remote.getDocTimestamps(
        this.status.remoteClocks.max,
      );
      for (const [docId, clock] of Object.entries(newClocks)) {
        if (!this.shouldSyncDoc(docId)) continue;
        this.status.remoteClocks.set(docId, clock);
        await this.syncMetadata.setPeerRemoteClock(this.peerId, {
          docId,
          timestamp: clock,
        });
      }
      for (const docId of this.status.remoteClocks.keys()) this.addDoc(docId);
      this.statusUpdatedSubject$.next(true);

      while (true) {
        throwIfAborted(sessionSignal);
        const docId = await this.status.reconcileQueue.asyncPop(
          undefined,
          sessionSignal,
        );
        const state = this.status.reconciles.get(docId);
        if (!state || state.inFlightGeneration !== null) continue;
        const generation = state.generation;
        state.inFlightGeneration = generation;
        state.dirty = false;
        try {
          const work = this.reconcileDocument(
            docId,
            state,
            generation,
            sessionSignal,
          );
          this.inFlight.set(docId, work);
          await work;
        } catch (cause) {
          if (sessionSignal.aborted) throw cause;
          this.inFlight.delete(docId);
          const error = cause instanceof ReconcileFailure ? cause.cause : cause;
          if (
            error instanceof DocSyncProtocolError &&
            error.protocolName === "DOC_MOVED"
          ) {
            // Move retires only this remote address. Keep every local byte,
            // including offline edits, but never advertise creation recovery or
            // retry pushes into the old workspace. A later server signal or
            // reconnect must still revalidate a legitimately copied-back key.
            this.clearDocFailure(docId);
            this.status.docs.delete(docId);
            this.status.remoteClocks.delete(docId);
            this.status.connectedDocs.delete(docId);
            state.pageRegistration = "moved";
            state.remoteMissing = true;
            state.confirmedServerStateVector = null;
            state.dirty = false;
            state.needsPull = false;
            state.pendingError = null;
          } else if (
            error instanceof DocSyncProtocolError &&
            error.protocolName === "DOC_DELETED"
          ) {
            await this.retireDoc(docId);
            try {
              if (this.options.deleteLocalDoc)
                await this.options.deleteLocalDoc(docId);
              else await this.local.deleteDoc(docId);
            } catch (cleanupError) {
              // A failed purge must retry after reconnect, never offer recovery.
              this.retryDeletion(docId, cleanupError);
            }
          } else if (!this.retiredDocs.has(docId)) {
            this.handleDocFailure(docId, cause, sessionSignal);
          }
        } finally {
          this.inFlight.delete(docId);
          state.inFlightGeneration = null;
          if (
            !this.status.docFailures.has(docId) &&
            (state.dirty || state.needsPull || state.pendingError)
          ) {
            this.queueReconcile(docId);
          }
          this.statusUpdatedSubject$.next(docId);
        }
      }
    } finally {
      for (const dispose of disposes) dispose();
      this.status.syncing = false;
      this.logger.info("session ended", {
        operationId: nanoid(),
        generation: 0,
        outcome: "disconnected",
      });
    }
  }

  addPriority(id: string, priority: number) {
    const oldPriority = this.prioritySettings.get(id) ?? 0;
    const nextPriority = oldPriority + priority;
    this.prioritySettings.set(id, nextPriority);
    this.status.reconcileQueue.setPriority(id, nextPriority);

    // An open route is also a demand signal for a leaf that the peer may not
    // know yet. Root membership can arrive without the corresponding leaf
    // broadcast (for example across reconnect or outbox delay). Registering the
    // ID here gives that active consumer one normal pull; absence then settles
    // as remoteMissing instead of leaving the editor in an endless sync state.
    if (priority > 0 && !this.status.docs.has(id)) {
      this.addDoc(id);
    }

    // A root-membership broadcast may beat the creating client's first leaf
    // push. In that narrow state the previous pull correctly observed a missing
    // remote, but it is not a durable empty-document checkpoint. A consumer
    // raising the priority (preview -> editor, for example) must revalidate the
    // remote instead of remaining attached to that stale absence forever.
    const state = this.status.reconciles.get(id);
    if (priority > 0 && state?.remoteMissing) {
      state.generation += 1;
      state.needsPull = true;
      this.status.connectedDocs.delete(id);
      this.queueReconcile(id);
    }
    return () => {
      const currentPriority = this.prioritySettings.get(id) ?? 0;
      const restoredPriority = currentPriority - priority;
      this.prioritySettings.set(id, restoredPriority);
      this.status.reconcileQueue.setPriority(id, restoredPriority);
    };
  }
}
