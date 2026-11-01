import { share } from "../../connection";
import {
  type DocClock,
  type DocClocks,
  type DocRecord,
  DocStorageBase,
  type DocUpdate,
} from "../../storage";
import { IDBConnection, type IDBConnectionOptions } from "./db";
import type { DocStorageSchema } from "./schema";

interface UpdateChannelMessage {
  type: "update";
  update: DocRecord;
  origin?: string;
}

type ChannelMessage = UpdateChannelMessage | { type: "delete"; docId: string };

export class IndexedDBDocStorage extends DocStorageBase<IDBConnectionOptions> {
  static readonly identifier = "IndexedDBDocStorage";

  readonly connection = share(new IDBConnection(this.options));

  get db() {
    return this.connection.inner.db;
  }

  get channel() {
    return this.connection.inner.channel;
  }

  // IDB transactions release on worker termination. Legacy lease records remain
  // inert; async merging must run outside the database transaction's lifetime.
  override async getDoc(docId: string): Promise<DocRecord | null> {
    if (this.deletedDocs.has(docId)) return null;
    const read = this.db.transaction(["snapshots", "updates"], "readonly");
    const [snapshot, updates] = await this.finishTransaction(
      read.done,
      Promise.all([
        read.objectStore("snapshots").get(docId),
        read.objectStore("updates").index("docId").getAll(docId),
      ]),
    );
    if (this.deletedDocs.has(docId)) return null;
    const previous = snapshot
      ? { docId, bin: snapshot.bin, timestamp: snapshot.updatedAt }
      : null;
    if (!updates.length) return previous;
    const records = updates.map((update) => ({
      docId,
      bin: update.bin,
      timestamp: update.createdAt,
    }));
    const merged = {
      ...(await this.squash(previous ? [previous, ...records] : records)),
      spaceId: this.spaceId,
    };
    if (this.deletedDocs.has(docId)) return null;
    if (!this.isReadonly) {
      const write = this.db.transaction(["snapshots", "updates"], "readwrite");
      await this.finishTransaction(
        write.done,
        (async () => {
          const [current, remaining] = await Promise.all([
            write.objectStore("snapshots").get(docId),
            Promise.all(
              updates.map((update) =>
                write.objectStore("updates").get([docId, update.createdAt]),
              ),
            ),
          ]);
          // Revalidate the whole capture atomically. Concurrent appends stay queued;
          // a replacement snapshot, consumed update or deletion invalidates this merge.
          if (
            sameSnapshot(current, snapshot) &&
            remaining.every(
              (update, i) =>
                update !== undefined && sameBytes(update.bin, updates[i].bin),
            )
          ) {
            await write.objectStore("snapshots").put({
              docId,
              bin: merged.bin,
              createdAt: snapshot?.createdAt ?? merged.timestamp,
              updatedAt: merged.timestamp,
            });
            await Promise.all(
              updates.map((update) =>
                write.objectStore("updates").delete([docId, update.createdAt]),
              ),
            );
          }
          write.commit();
        })(),
      );
    }
    return this.deletedDocs.has(docId) ? null : merged;
  }

  // The primary request error (notably ConstraintError) owns retry semantics;
  // consume the transaction's secondary abort rejection as well.
  private async finishTransaction<T>(
    done: Promise<void>,
    requests: Promise<T>,
  ): Promise<T> {
    const [transaction, request] = await Promise.allSettled([done, requests]);
    if (request.status === "rejected") throw request.reason;
    if (transaction.status === "rejected") throw transaction.reason;
    return request.value;
  }

  override async pushDocUpdate(update: DocUpdate, origin?: string) {
    let timestamp = new Date();

    let retry = 0;

    while (true) {
      // A collision retry must not revive a document retired while it waited.
      this.assertDocWritable(update.docId);
      try {
        const trx = this.db.transaction(["updates", "clocks"], "readwrite");

        await this.finishTransaction(
          trx.done,
          (async () => {
            await trx
              .objectStore("updates")
              .add({ ...update, createdAt: timestamp });
            await trx
              .objectStore("clocks")
              .put({ docId: update.docId, timestamp });
            trx.commit();
          })(),
        );
      } catch (e) {
        if (e instanceof Error && e.name === "ConstraintError") {
          retry++;
          if (retry < 10) {
            timestamp = new Date(timestamp.getTime() + 1);
            continue;
          }
        }
        throw e;
      }
      break;
    }

    this.emit(
      "update",
      {
        docId: update.docId,
        bin: update.bin,
        timestamp,
        editor: update.editor,
      },
      origin,
    );

    this.channel.postMessage({
      type: "update",
      update: {
        docId: update.docId,
        bin: update.bin,
        timestamp,
        editor: update.editor,
      },
      origin,
    } satisfies ChannelMessage);

    return { docId: update.docId, timestamp };
  }

  protected override async getDocSnapshot(docId: string) {
    const trx = this.db.transaction("snapshots", "readonly");
    const record = await this.finishTransaction(trx.done, trx.store.get(docId));

    if (!record) {
      return null;
    }

    return {
      docId,
      bin: record.bin,
      timestamp: record.updatedAt,
    };
  }

  override async deleteDoc(docId: string) {
    await this.deleteDocData(docId, true);
  }

  private async deleteDocData(docId: string, broadcast: boolean) {
    // Fence this instance before the atomic retirement reaches the database.
    this.deletedDocs.add(docId);
    const trx = this.db.transaction(
      ["snapshots", "updates", "clocks", "peerClocks", "indexerSync"],
      "readwrite",
    );

    await this.finishTransaction(
      trx.done,
      (async () => {
        const keys = await trx
          .objectStore("updates")
          .index("docId")
          .getAllKeys(docId);
        await Promise.all(
          keys.map((key) => trx.objectStore("updates").delete(key)),
        );
        await trx.objectStore("snapshots").delete(docId);
        await trx.objectStore("clocks").delete(docId);
        await trx.objectStore("indexerSync").delete(docId);
        for await (const cursor of trx.objectStore("peerClocks").iterate()) {
          if (cursor.value.docId === docId) await cursor.delete();
        }
        trx.commit();
      })(),
    );
    this.emitDocDelete(docId);
    if (broadcast)
      this.channel.postMessage({
        type: "delete",
        docId,
      } satisfies ChannelMessage);
  }

  override async getDocTimestamps(after: Date = new Date(0)) {
    const trx = this.db.transaction("clocks", "readonly");

    const clocks = await this.finishTransaction(trx.done, trx.store.getAll());

    return clocks.reduce((ret, cur) => {
      if (cur.timestamp > after) {
        ret[cur.docId] = cur.timestamp;
      }
      return ret;
    }, {} as DocClocks);
  }

  override async getDocTimestamp(docId: string): Promise<DocClock | null> {
    const trx = this.db.transaction("clocks", "readonly");

    return (
      (await this.finishTransaction(trx.done, trx.store.get(docId))) ?? null
    );
  }

  protected override async setDocSnapshot(
    snapshot: DocRecord,
  ): Promise<boolean> {
    const trx = this.db.transaction("snapshots", "readwrite");
    await this.finishTransaction(
      trx.done,
      (async () => {
        const record = await trx.store.get(snapshot.docId);
        if (!record || record.updatedAt < snapshot.timestamp) {
          await trx.store.put({
            docId: snapshot.docId,
            bin: snapshot.bin,
            createdAt: record?.createdAt ?? snapshot.timestamp,
            updatedAt: snapshot.timestamp,
          });
        }
        trx.commit();
      })(),
    );
    return true;
  }

  protected override async getDocUpdates(docId: string): Promise<DocRecord[]> {
    const trx = this.db.transaction("updates", "readonly");
    const updates = await this.finishTransaction(
      trx.done,
      trx.store.index("docId").getAll(docId),
    );

    return updates.map((update) => ({
      docId,
      bin: update.bin,
      timestamp: update.createdAt,
    }));
  }

  protected override async markUpdatesMerged(
    docId: string,
    updates: DocRecord[],
  ): Promise<number> {
    const trx = this.db.transaction("updates", "readwrite");

    await this.finishTransaction(
      trx.done,
      (async () => {
        await Promise.all(
          updates.map((update) => trx.store.delete([docId, update.timestamp])),
        );
        trx.commit();
      })(),
    );
    return updates.length;
  }

  private docUpdateListener = 0;

  override subscribeDocUpdate(
    callback: (update: DocRecord, origin?: string) => void,
  ): () => void {
    if (this.docUpdateListener === 0) {
      this.channel.addEventListener("message", this.handleChannelMessage);
    }
    this.docUpdateListener++;

    const dispose = super.subscribeDocUpdate(callback);

    return () => {
      dispose();
      this.docUpdateListener--;
      if (this.docUpdateListener === 0) {
        this.channel.removeEventListener("message", this.handleChannelMessage);
      }
    };
  }

  override subscribeDocDelete(callback: (docId: string) => void): () => void {
    // Deletions use the same cross-tab channel as content updates.
    const disposeUpdates = this.subscribeDocUpdate(() => {});
    const dispose = super.subscribeDocDelete(callback);
    return () => {
      dispose();
      disposeUpdates();
    };
  }

  handleChannelMessage = (event: MessageEvent<ChannelMessage>) => {
    if (event.data.type === "delete") {
      void this.deleteDocData(event.data.docId, false).catch(console.error);
    } else if (
      event.data.type === "update" &&
      !this.deletedDocs.has(event.data.update.docId)
    ) {
      this.emit("update", event.data.update, event.data.origin);
    }
  };
}

type Snapshot = DocStorageSchema["snapshots"]["value"];
function sameBytes(a: Uint8Array, b: Uint8Array) {
  return a.length === b.length && a.every((byte, i) => byte === b[i]);
}
function sameSnapshot(a: Snapshot | undefined, b: Snapshot | undefined) {
  return (
    (a === undefined && b === undefined) ||
    (!!a &&
      !!b &&
      a.createdAt.getTime() === b.createdAt.getTime() &&
      a.updatedAt.getTime() === b.updatedAt.getTime() &&
      sameBytes(a.bin, b.bin))
  );
}
