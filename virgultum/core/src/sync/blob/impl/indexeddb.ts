import { type IDBPDatabase, openDB } from "idb";

import type { BlobSource } from "../source.js";

export class IndexedDBBlobSource implements BlobSource {
  private blobDbPromise: Promise<IDBPDatabase> | null = null;

  private mimeTypeDbPromise: Promise<IDBPDatabase> | null = null;

  readonly = false;

  constructor(readonly name: string) {}

  /** Closes cached handles so the source can be discarded or its databases deleted. */
  async close() {
    const databases = await Promise.all(
      [this.blobDbPromise, this.mimeTypeDbPromise].filter(
        (promise): promise is Promise<IDBPDatabase> => promise !== null,
      ),
    );
    databases.forEach((database) => database.close());
    this.blobDbPromise = null;
    this.mimeTypeDbPromise = null;
  }

  async delete(key: string) {
    const blobDb = await this.getBlobDb();
    await blobDb.delete("blob", key);
    const mimeTypeDb = await this.getMimeTypeDb();
    await mimeTypeDb.delete("blob_mime", key);
  }

  async get(key: string) {
    const blobDb = await this.getBlobDb();
    const res = (await blobDb.get("blob", key)) as ArrayBuffer | undefined;
    if (res) {
      const mimeTypeDb = await this.getMimeTypeDb();
      return new Blob([res], {
        type: (await mimeTypeDb.get("blob_mime", key)) as string | undefined,
      });
    }
    return null;
  }

  async list() {
    const db = await this.getBlobDb();
    return (await db.getAllKeys("blob")) as string[];
  }

  async set(key: string, value: Blob) {
    const blobDb = await this.getBlobDb();
    await blobDb.put("blob", await value.arrayBuffer(), key);
    const mimeTypeDb = await this.getMimeTypeDb();
    await mimeTypeDb.put("blob_mime", value.type, key);
    return key;
  }

  private getBlobDb() {
    this.blobDbPromise ??= openDB(`${this.name}_blob`, undefined, {
      upgrade(db) {
        if (!db.objectStoreNames.contains("blob")) {
          db.createObjectStore("blob");
        }
      },
      terminated: () => {
        this.blobDbPromise = null;
      },
    });
    return this.blobDbPromise;
  }

  private getMimeTypeDb() {
    this.mimeTypeDbPromise ??= openDB(`${this.name}_blob_mime`, undefined, {
      upgrade(db) {
        if (!db.objectStoreNames.contains("blob_mime")) {
          db.createObjectStore("blob_mime");
        }
      },
      terminated: () => {
        this.mimeTypeDbPromise = null;
      },
    });
    return this.mimeTypeDbPromise;
  }
}
