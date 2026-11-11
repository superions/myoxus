import {
  combineLatest,
  filter,
  first,
  lastValueFrom,
  map,
  type Observable,
  of,
  ReplaySubject,
  share,
  throttleTime,
} from "rxjs";

import type {
  DocStorage,
  DocSyncStorage,
  DocUpdate,
  PageRegistrationState,
} from "../../storage";
import { DummyDocStorage } from "../../storage/dummy/doc";
import { DummyDocSyncStorage } from "../../storage/dummy/doc-sync";
import { takeUntilAbort } from "../../utils/take-until-abort";
import { MANUALLY_STOP } from "../../utils/throw-if-aborted";
import type { PeerStorageOptions } from "../types";
import { DocSyncPeer } from "./peer";

export interface DocSyncState {
  unregisteredDocs?: string[];
  total: number;
  syncing: number;
  synced: boolean;
  retrying: boolean;
  errorMessage: string | null;
}

export interface DocSyncDocState {
  degraded: boolean;
  /**
   * The remote peer explicitly reported that the document did not exist during
   * the latest pull. A live workspace-root membership can legally arrive just
   * before the creating client's first leaf push, so consumers must not treat
   * this state as proof that an empty leaf is ready.
   */
  remoteMissing: boolean;
  pageRegistration?: PageRegistrationState | null;
  synced: boolean;
  syncing: boolean;
  retrying: boolean;
  errorMessage: string | null;
}

export interface DocSync {
  readonly state$: Observable<DocSyncState>;
  docState$(docId: string): Observable<DocSyncDocState>;
  waitForSynced(docId?: string, abort?: AbortSignal): Promise<void>;
  saveLocalUpdateAndWaitForSynced(
    update: DocUpdate,
    origin?: string,
    abort?: AbortSignal,
  ): Promise<void>;
  addPriority(id: string, priority: number): () => void;
  retryDoc(docId: string): Promise<void>;
  resetSync(): Promise<void>;
}

export class DocSyncImpl implements DocSync {
  private readonly peers: DocSyncPeer[] = Object.entries(
    this.storages.remotes,
  ).map(
    ([peerId, remote]) =>
      new DocSyncPeer(peerId, this.storages.local, this.sync, remote, {
        deleteLocalDoc: (docId) => this.deleteDoc(docId),
      }),
  );
  private abort: AbortController | null = null;

  private readonly _state$ = combineLatest(
    this.peers.map((peer) => peer.peerState$),
  ).pipe(
    map((allPeers) =>
      allPeers.length === 0
        ? {
            total: 0,
            syncing: 0,
            synced: true,
            retrying: false,
            errorMessage: null,
          }
        : {
            total: allPeers.reduce((acc, peer) => Math.max(acc, peer.total), 0),
            syncing: allPeers.reduce(
              (acc, peer) => Math.max(acc, peer.syncing),
              0,
            ),
            synced: allPeers.every((peer) => peer.synced),
            unregisteredDocs: [
              ...new Set(
                allPeers.flatMap((peer) => peer.unregisteredDocs ?? []),
              ),
            ],
            retrying: allPeers.some((peer) => peer.retrying),
            errorMessage:
              allPeers.find((peer) => peer.errorMessage)?.errorMessage ?? null,
          },
    ),
    share({
      connector: () => new ReplaySubject(1),
    }),
  ) as Observable<DocSyncState>;

  state$ = this._state$.pipe(
    // throttle the state to 1 second to avoid spamming the UI
    throttleTime(1000, undefined, {
      leading: true,
      trailing: true,
    }),
  );

  constructor(
    readonly storages: PeerStorageOptions<DocStorage>,
    readonly sync: DocSyncStorage,
  ) {}

  /**
   * for testing
   */
  static get dummy() {
    return new DocSyncImpl(
      {
        local: new DummyDocStorage(),
        remotes: {},
      },
      new DummyDocSyncStorage(),
    );
  }

  private _docState$(docId: string): Observable<DocSyncDocState> {
    if (this.peers.length === 0) {
      return of({
        degraded: false,
        errorMessage: null,
        remoteMissing: false,
        retrying: false,
        syncing: false,
        synced: true,
      });
    }
    return combineLatest(this.peers.map((peer) => peer.docState$(docId))).pipe(
      map((allPeers) => {
        return {
          degraded: allPeers.some((peer) => peer.degraded),
          errorMessage:
            allPeers.find((peer) => peer.errorMessage)?.errorMessage ?? null,
          retrying: allPeers.some((peer) => peer.retrying),
          remoteMissing: allPeers.some((peer) => peer.remoteMissing),
          pageRegistration:
            allPeers
              .map((peer) => peer.pageRegistration)
              .find((state) => state && state !== "registered") ??
            allPeers.find((peer) => peer.pageRegistration === "registered")
              ?.pageRegistration,
          syncing: allPeers.some((peer) => peer.syncing),
          synced:
            allPeers.every((peer) => peer.synced) &&
            !allPeers.some((peer) => peer.degraded || peer.syncing),
        };
      }),
    );
  }

  docState$(docId: string): Observable<DocSyncDocState> {
    return this._docState$(docId).pipe(
      // throttle the state to 1 second to avoid spamming the UI
      throttleTime(1000, undefined, {
        leading: true,
        trailing: true,
      }),
    );
  }

  async waitForSynced(docId?: string, abort?: AbortSignal): Promise<void> {
    // This proves that currently scheduled work for the requested sync unit was
    // acknowledged. A brand-new idle Y.Doc can already satisfy it, so create
    // coordination must observe the leaf's first local update before waiting.
    const source$: Observable<DocSyncDocState | DocSyncState> = docId
      ? this._docState$(docId)
      : this._state$;
    await lastValueFrom(
      source$.pipe(
        filter((state) => state.synced),
        takeUntilAbort(abort),
        first(),
      ),
    );
  }

  async saveLocalUpdateAndWaitForSynced(
    update: DocUpdate,
    origin?: string,
    abort?: AbortSignal,
  ): Promise<void> {
    await this.storages.local.pushDocUpdate(update, origin);
    await this.waitForSynced(update.docId, abort);
  }

  start() {
    if (this.abort) {
      this.abort.abort(MANUALLY_STOP);
    }
    const abort = new AbortController();
    this.abort = abort;
    void Promise.allSettled(
      this.peers.map((peer) => peer.mainLoop(abort.signal)),
    );
  }

  stop() {
    this.abort?.abort(MANUALLY_STOP);
    this.abort = null;
  }

  addPriority(id: string, priority: number) {
    const undo = this.peers.map((peer) => peer.addPriority(id, priority));
    return () => undo.forEach((fn) => fn());
  }

  /** Called only after authoritative deletion, or for a native local document. */
  async deleteDoc(docId: string): Promise<void> {
    await Promise.all(this.peers.map((peer) => peer.retireDoc(docId)));
    try {
      await this.storages.local.deleteDoc(docId);
    } catch (error) {
      for (const peer of this.peers) peer.retryDeletion(docId, error);
      throw error;
    }
  }

  async retryDoc(docId: string) {
    await Promise.all(this.peers.map((peer) => peer.retryDoc(docId)));
  }

  async resetSync() {
    const running = this.abort !== null;
    this.stop();
    await this.sync.clearClocks();
    if (running) {
      this.start();
    }
  }
}
