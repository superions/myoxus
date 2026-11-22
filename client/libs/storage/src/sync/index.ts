import { DummyIndexerStorage } from "../storage/dummy/indexer";
import { DummyIndexerSyncStorage } from "../storage/dummy/indexer-sync";
import type { SpaceStorage } from "../storage";
import { IndexerSyncImpl } from "./indexer";
import { TransportSync } from "./transport";
import type { PeerStorageOptions } from "./types";
export type * from "./transport";

/** Native/local sessions add search to the shared document/blob transport. */
export class Sync extends TransportSync {
  private pauseTimer?: ReturnType<typeof setTimeout>;
  private paused = false;
  scheduleIndexPause() {
    if (!this.pauseTimer && !this.paused)
      this.pauseTimer = setTimeout(() => {
        this.paused = true;
        this.indexer.pauseSync();
        this.pauseTimer = undefined;
      }, 1000);
  }
  resumeIndex() {
    clearTimeout(this.pauseTimer);
    this.pauseTimer = undefined;
    if (this.paused) this.indexer.resumeSync();
    this.paused = false;
  }
  readonly indexer: IndexerSyncImpl;
  constructor(storages: PeerStorageOptions<SpaceStorage>) {
    super(storages);
    this.indexer = new IndexerSyncImpl(
      storages.local.get("doc"),
      {
        local: storages.local.optional("indexer") ?? new DummyIndexerStorage(),
        remotes: Object.fromEntries(
          Object.entries(storages.remotes).map(([id, remote]) => [
            id,
            remote.optional("indexer") ?? new DummyIndexerStorage(),
          ]),
        ),
      },
      storages.local.optional("indexerSync") ?? new DummyIndexerSyncStorage(),
    );
  }
  override start() {
    super.start();
    this.indexer.start();
  }
  override stop() {
    super.stop();
    this.indexer.stop();
  }
  override async stopAndWait() {
    clearTimeout(this.pauseTimer);
    super.stop();
    await this.indexer.stopAndWait();
  }
}
