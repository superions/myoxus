import { subscribeSynchronousEvents } from "@myoxus/infra/utils";
import { Subject } from "rxjs";
import {
  applyUpdate,
  Doc,
  diffUpdate,
  encodeStateAsUpdate,
  encodeStateVectorFromUpdate,
} from "yjs";

import type { Connection } from "../connection";
import { isEmptyUpdate } from "../utils/is-empty-update";
import { type Locker, SingletonLocker } from "./lock";
import { type Storage } from "./storage";

export class DocDeletedError extends Error {
  constructor() {
    super("Document permanently deleted");
    this.name = "DOC_DELETED";
  }
}

export interface BlockInfo {
  blockId: string;
  flavour: string;
  content?: string[];
  blob?: string[];
  refDocId?: string[];
  refInfo?: string[];
  parentFlavour?: string;
  parentBlockId?: string;
  additional?: string;
}

export interface CrawlResult {
  blocks: BlockInfo[];
  title: string;
  summary: string;
}

export type PageRegistrationState =
  "legacy" | "unresolved" | "pending" | "registered" | "deleted" | "moved";

export interface DocClock {
  docId: string;
  timestamp: Date;
  /** Server lifecycle evidence, independent of a durable byte acknowledgement. */
  pageRegistration?: PageRegistrationState | null;
}

export type DocClocks = Record<string, Date>;
export interface DocRecord extends DocClock {
  bin: Uint8Array;
  editor?: string;
}

export interface DocDiff extends DocClock {
  missing: Uint8Array;
  state: Uint8Array;
}

export type InitialDocumentProvenanceMode = "offline_sync" | "explicit_import";

export interface InitialDocumentProvenance {
  idempotencyKey?: string;
  clientFamily?: string;
  clientVersion?: string;
  clientInstanceId?: string;
  provenanceMode?: InitialDocumentProvenanceMode;
  clientCreatedAt?: string;
  clientUpdatedAt?: string;
  clientCreatedBy?: string;
  clientUpdatedBy?: string;
  historicalUserMappingId?: string;
  sourcePropertyDocRevision?: string;
}

export interface DocUpdate {
  docId: string;
  bin: Uint8Array;
  editor?: string;
  initialDocumentProvenance?: InitialDocumentProvenance;
}

export interface Editor {
  name: string;
  avatarUrl: string | null;
}

export interface DocStorageOptions {
  mergeUpdates?: (updates: Uint8Array[]) => Promise<Uint8Array> | Uint8Array;
  id: string;

  /**
   * open as readonly mode.
   */
  readonlyMode?: boolean;
}

export interface DocStorage extends Storage {
  readonly storageType: "doc";
  readonly isReadonly: boolean;
  readonly spaceId: string;
  /**
   * Selects documents that may cross this storage's sync boundary.
   * Storages opt out explicitly; absence means every document is syncable.
   */
  shouldSyncDoc?(docId: string): boolean;
  /**
   * Get a doc record with latest binary.
   */
  getDoc(docId: string): Promise<DocRecord | null>;
  /**
   * Get a yjs binary diff with the given state vector.
   */
  getDocDiff(docId: string, state?: Uint8Array): Promise<DocDiff | null>;
  /**
   * Push updates into storage
   *
   * @param origin - Internal identifier to recognize the source in the "update" event. Will not be stored or transferred.
   */
  pushDocUpdate(update: DocUpdate, origin?: string): Promise<DocClock>;

  /**
   * Get the timestamp of the latest update of a doc.
   */
  getDocTimestamp(docId: string): Promise<DocClock | null>;

  /**
   * Get all docs timestamps info. especially for useful in sync process.
   */
  getDocTimestamps(after?: Date): Promise<DocClocks>;

  /**
   * Delete a specific doc data with all snapshots and updates
   */
  deleteDoc(docId: string): Promise<void>;

  /**
   * Subscribe on doc updates emitted from storage itself.
   *
   * NOTE:
   *
   *   There is not always update emitted from storage itself.
   *
   *   For example, in Sqlite storage, the update will only come from user's updating on docs,
   *   in other words, the update will never somehow auto generated in storage internally.
   *
   *   But for Cloud storage, there will be updates broadcasted from other clients,
   *   so the storage will emit updates to notify the client to integrate them.
   */
  subscribeDocUpdate(
    callback: (update: DocRecord, origin?: string) => void,
  ): () => void;

  /** A confirmed permanent deletion, never mere remote absence. */
  subscribeDocDelete?(callback: (docId: string) => void): () => void;

  crawlDocData?(docId: string): Promise<CrawlResult | null>;
}

export abstract class DocStorageBase<Opts = {}> implements DocStorage {
  get isReadonly(): boolean {
    return this.options.readonlyMode ?? false;
  }
  private readonly events = new Subject<{ event: string; args: any[] }>();
  protected readonly deletedDocs = new Set<string>();

  subscribeDocDelete(callback: (docId: string) => void): () => void {
    return this.subscribeEvent("delete", callback);
  }

  protected emitDocDelete(docId: string): void {
    this.events.next({ event: "delete", args: [docId] });
  }

  protected assertDocWritable(docId: string): void {
    if (this.deletedDocs.has(docId)) throw new DocDeletedError();
  }

  readonly storageType = "doc";
  abstract readonly connection: Connection;
  protected readonly locker: Locker = new SingletonLocker();
  readonly spaceId = this.options.id;

  constructor(protected readonly options: Opts & DocStorageOptions) {}

  shouldSyncDoc(_docId: string): boolean {
    return true;
  }

  async getDoc(docId: string) {
    await using _lock = this.isReadonly
      ? undefined
      : await this.lockDocForUpdate(docId);

    if (this.deletedDocs.has(docId)) return null;
    const snapshot = await this.getDocSnapshot(docId);
    const updates = await this.getDocUpdates(docId);

    if (updates.length) {
      const { timestamp, bin, editor } = await this.squash(
        snapshot ? [snapshot, ...updates] : updates,
      );

      const newSnapshot = {
        spaceId: this.spaceId,
        docId,
        bin,
        timestamp,
        editor,
      };

      // if is readonly, we will not set the new snapshot
      if (!this.isReadonly) {
        await this.setDocSnapshot(newSnapshot, snapshot);

        // always mark updates as merged unless throws
        await this.markUpdatesMerged(docId, updates);
      }

      return newSnapshot;
    }

    return snapshot;
  }

  async getDocDiff(docId: string, state?: Uint8Array) {
    const doc = await this.getDoc(docId);

    if (!doc) {
      return null;
    }

    return {
      docId,
      missing: state && state.length > 0 ? diffUpdate(doc.bin, state) : doc.bin,
      state: encodeStateVectorFromUpdate(doc.bin),
      timestamp: doc.timestamp,
    };
  }

  abstract pushDocUpdate(update: DocUpdate, origin?: string): Promise<DocClock>;

  abstract getDocTimestamp(docId: string): Promise<DocClock | null>;

  abstract getDocTimestamps(after?: Date): Promise<DocClocks>;

  abstract deleteDoc(docId: string): Promise<void>;

  subscribeDocUpdate(callback: (update: DocRecord, origin?: string) => void) {
    return this.subscribeEvent("update", callback);
  }

  async crawlDocData(_docId: string): Promise<CrawlResult | null> {
    return null;
  }

  // REGION: api for internal usage
  protected on(
    event: "update",
    callback: (update: DocRecord, origin: string) => void,
  ): () => void;
  protected on(
    event: "snapshot",
    callback: (snapshot: DocRecord, prevSnapshot: DocRecord | null) => void,
  ): () => void;
  protected on(event: string, callback: (...args: any[]) => void): () => void {
    return this.subscribeEvent(event, callback);
  }

  protected emit(event: "update", update: DocRecord, origin?: string): void;
  protected emit(
    event: "snapshot",
    snapshot: DocRecord,
    prevSnapshot: DocRecord | null,
  ): void;
  protected emit(event: string, ...args: any[]): void {
    this.events.next({ event, args });
  }

  private subscribeEvent(
    event: string,
    callback: (...args: any[]) => void,
  ): () => void {
    const subscription = subscribeSynchronousEvents(this.events, (message) => {
      if (message.event === event) callback(...message.args);
    });
    return () => subscription.unsubscribe();
  }

  /**
   * Get a doc snapshot from storage
   */
  protected abstract getDocSnapshot(docId: string): Promise<DocRecord | null>;
  /**
   * Set the doc snapshot into storage
   *
   * @safety
   * be careful when implementing this method.
   *
   * It might be called with outdated snapshot when running in multi-thread environment.
   *
   * A common solution is update the snapshot record is DB only when the coming one's timestamp is newer.
   *
   * @example
   * ```ts
   * await using _lock = await this.lockDocForUpdate(docId);
   * // set snapshot
   *
   * ```
   */
  protected abstract setDocSnapshot(
    snapshot: DocRecord,
    prevSnapshot: DocRecord | null,
  ): Promise<boolean>;

  /**
   * Get all updates of a doc that haven't been merged into snapshot.
   *
   * Updates queue design exists for a performace concern:
   * A huge amount of write time will be saved if we don't merge updates into snapshot immediately.
   * Updates will be merged into snapshot when the latest doc is requested.
   */
  protected abstract getDocUpdates(docId: string): Promise<DocRecord[]>;

  /**
   * Mark updates as merged into snapshot.
   */
  protected abstract markUpdatesMerged(
    docId: string,
    updates: DocRecord[],
  ): Promise<number>;

  /** Compact the captured current-state records; this does not edit document
   * history or apply a replacement to a live editor/UndoManager. */
  protected async squash(updates: DocRecord[]): Promise<DocRecord> {
    const lastUpdate = updates.at(-1);
    if (!lastUpdate) {
      throw new Error("No updates to be squashed.");
    }

    const finalUpdate = await this.mergeUpdates(updates.map((u) => u.bin));

    return {
      docId: lastUpdate.docId,
      bin: finalUpdate,
      timestamp: lastUpdate.timestamp,
      editor: lastUpdate.editor,
    };
  }

  protected mergeUpdates(updates: Uint8Array[]) {
    const meaningful = updates.filter((bin) => !isEmptyUpdate(bin));
    if (this.options?.mergeUpdates)
      return this.options.mergeUpdates(meaningful);
    // Binary merging retains deleted full values indefinitely. Integrate the
    // existing CRDT identities/delete sets with GC, as the server does, before
    // encoding the snapshot. Yjs also re-encodes unresolved dependencies, so a
    // delayed/offline update is not discarded merely because its parent is absent.
    const doc = new Doc();
    try {
      for (const update of meaningful) applyUpdate(doc, update);
      return encodeStateAsUpdate(doc);
    } finally {
      doc.destroy();
    }
  }

  protected async lockDocForUpdate(docId: string): Promise<AsyncDisposable> {
    return this.locker.lock(`workspace:${this.spaceId}:update`, docId);
  }
}
