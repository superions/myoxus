// SPDX-License-Identifier: AGPL-3.0-or-later
/** @vitest-environment happy-dom */

import { Framework, LiveData, type Identifier } from "@myoxus/infra";
import { DocFrontend } from "@myoxus/storage/frontend";
import {
  DocStorageBase,
  SpaceStorage,
  DummyConnection,
  type DocClock,
  type DocRecord,
  type DocUpdate,
} from "@myoxus/storage";
import { Sync } from "@myoxus/storage/sync";
import type { StoreClient } from "@myoxus/storage/worker/client";
import { firstValueFrom } from "rxjs";
import { afterEach, describe, expect, test, vi } from "vitest";
import { Doc as YDoc } from "yjs";

import { DocCommentEntity } from "../../comment/entities/doc-comment";
import { DocCommentStore } from "../../comment/entities/doc-comment-store";
import { SnapshotHelper } from "../../comment/services/snapshot-helper";
import { DocDisplayMetaService } from "../../doc-display-meta";
import { DocumentLifecycleStore } from "../../doc/stores/document-lifecycle";
import { FeatureFlagService } from "../../feature-flag";
import { StoreService } from "../../storage";
import { configureWorkspaceModule } from "../index";
import { WorkspaceEngineBeforeStart } from "../events";
import { WorkspaceMetaImpl } from "../impls/meta";
import { WorkspaceScope } from "../scopes/workspace";
import { WorkspaceService } from "../services/workspace";
import { WorkspaceEngine } from "./engine";

// The transport is inert; the confirmed-deletion event and its frontend/Core
// consumers are real. Root membership deliberately remains unchanged.
class ConfirmedDeletionStorage extends DocStorageBase {
  readonly connection = new DummyConnection();

  constructor(id: string) {
    super({ id, readonlyMode: true });
  }

  override async getDoc(_id: string): Promise<DocRecord | null> {
    return null;
  }
  async pushDocUpdate(update: DocUpdate): Promise<DocClock> {
    return { docId: update.docId, timestamp: new Date() };
  }
  async getDocTimestamp(_id: string): Promise<DocClock | null> {
    return null;
  }
  async getDocTimestamps() {
    return {};
  }
  async deleteDoc(id: string) {
    this.emitDocDelete(id);
  }
  protected async getDocSnapshot(_id: string): Promise<DocRecord | null> {
    return null;
  }
  protected async setDocSnapshot() {
    return false;
  }
  protected async getDocUpdates() {
    return [];
  }
  protected async markUpdatesMerged() {
    return 0;
  }
}

function createFixture(
  flavour = "affine-cloud",
  workspaceId = "deletion-workspace",
) {
  const root = new YDoc({ guid: workspaceId });
  const meta = new WorkspaceMetaImpl(root);
  meta.initialize();
  meta.addDocMeta({
    id: "deleted-leaf",
    title: "Deleted leaf",
    createDate: 1,
    tags: [],
  });
  meta.addDocMeta({
    id: "other-leaf",
    title: "Other leaf",
    createDate: 1,
    tags: [],
  });
  const storage = new ConfirmedDeletionStorage(workspaceId);
  const sync = new Sync({
    local: new SpaceStorage({ doc: storage }),
    remotes: {},
  });
  const frontend = new DocFrontend(storage, sync.doc);
  const closeStore = vi.fn();
  const listComments = vi.fn().mockResolvedValue({
    comments: [],
    hasNextPage: false,
    startCursor: "",
    endCursor: "",
  });
  const framework = new Framework();
  configureWorkspaceModule(framework);
  framework
    .scope(WorkspaceScope)
    .override(
      WorkspaceService as unknown as Identifier<WorkspaceService>,
      () =>
        ({
          workspace: {
            id: workspaceId,
            flavour,
            docCollection: { doc: root, meta },
          },
        }) as unknown as WorkspaceService,
    )
    .service(
      StoreService,
      () =>
        ({
          openStore: () => ({
            store: {
              docFrontend: frontend,
              indexerFrontend: { addPriority: vi.fn() },
              blobFrontend: {
                fullDownload: vi.fn().mockResolvedValue(undefined),
              },
            } as unknown as StoreClient,
            dispose: closeStore,
          }),
        }) as unknown as StoreService,
    )
    .service(
      FeatureFlagService,
      () =>
        ({
          flags: { enable_battery_save_mode: { value: false } },
        }) as unknown as FeatureFlagService,
    )
    .store(DocumentLifecycleStore)
    .service(SnapshotHelper, () => ({}) as SnapshotHelper)
    .service(
      DocDisplayMetaService,
      () =>
        ({
          title$: () => new LiveData("Deleted leaf"),
        }) as unknown as DocDisplayMetaService,
    )
    .entity(
      DocCommentStore,
      () =>
        ({
          listComments,
          listCommentChanges: vi.fn(),
        }) as unknown as DocCommentStore,
    )
    .entity(DocCommentEntity, [
      SnapshotHelper,
      DocDisplayMetaService,
      DocumentLifecycleStore,
    ]);
  const scope = framework.provider().createScope(WorkspaceScope, {
    openOptions: { metadata: { id: workspaceId, flavour } },
    engineWorkerInitOptions: { local: {}, remotes: {} },
  });
  const engine = scope.createEntity(WorkspaceEngine, {
    engineWorkerInitOptions: { local: {}, remotes: {} },
  });
  const lifecycle = scope.get(DocumentLifecycleStore);
  return {
    storage,
    frontend,
    root,
    meta,
    scope,
    engine,
    lifecycle,
    listComments,
    closeStore,
    close() {
      sync.stop();
      engine.dispose();
      scope.dispose();
      root.destroy();
    },
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("workspace engine confirmed deletion", () => {
  test("aborts requests and stops a retained comment consumer before root removal", async () => {
    const f = createFixture();
    const leaf = new YDoc({ guid: "deleted-leaf" });
    const other = createFixture("affine-cloud", "another-workspace");
    const comment = f.scope.createEntity(DocCommentEntity, {
      docId: leaf.guid,
      std: null,
    });
    try {
      f.engine.start();
      f.frontend.connectDoc(leaf);
      await vi.waitFor(async () =>
        expect(
          (await firstValueFrom(f.frontend.docState$(leaf.guid))).loaded,
        ).toBe(true),
      );
      vi.useFakeTimers();
      comment.start();
      await vi.advanceTimersByTimeAsync(10_000);
      expect(f.listComments).toHaveBeenCalledTimes(2);

      const metadataSignal = f.lifecycle.requestSignal(leaf.guid);
      const graphSignal = f.lifecycle.requestSignal(
        leaf.guid,
        new AbortController().signal,
      );
      const unrelated = f.lifecycle.signal("other-leaf");
      const sameIdElsewhere = other.lifecycle.signal(leaf.guid);
      await f.storage.deleteDoc(leaf.guid);
      expect(metadataSignal.aborted).toBe(true);
      expect(graphSignal.aborted).toBe(true);
      expect(f.lifecycle.state(leaf.guid)).toBe("not-found");
      expect(
        (await firstValueFrom(f.frontend.docState$(leaf.guid))).loaded,
      ).toBe(false);
      expect(f.meta.getDocMeta(leaf.guid)?.id).toBe(leaf.guid);
      expect(unrelated.aborted).toBe(false);
      expect(sameIdElsewhere.aborted).toBe(false);

      await f.storage.deleteDoc(leaf.guid);
      await vi.advanceTimersByTimeAsync(25_000);
      expect(f.listComments).toHaveBeenCalledTimes(2);
      expect(f.lifecycle.state(leaf.guid)).toBe("not-found");

      f.lifecycle.beginAvailableLifecycle(leaf.guid, "created");
      await vi.advanceTimersByTimeAsync(0);
      expect(f.lifecycle.signal(leaf.guid)).not.toBe(metadataSignal);
      expect(f.lifecycle.signal(leaf.guid).aborted).toBe(false);
      expect(f.listComments).toHaveBeenCalledTimes(3);
    } finally {
      comment.dispose();
      f.close();
      other.close();
      leaf.destroy();
    }
  });

  test("subscribes before engine-start consumers can observe confirmed deletion", async () => {
    const f = createFixture();
    const signal = f.lifecycle.signal("deleted-leaf");
    const off = f.engine.eventBus.on(WorkspaceEngineBeforeStart, () => {
      void f.storage.deleteDoc("deleted-leaf");
    });
    try {
      f.engine.start();
      expect(signal.aborted).toBe(true);
      expect(f.lifecycle.state("deleted-leaf")).toBe("not-found");
    } finally {
      off();
      f.close();
    }
  });

  test("local deletion keeps the native-local request lifecycle available", async () => {
    const f = createFixture("local");
    const signal = f.lifecycle.signal("deleted-leaf");
    try {
      f.engine.start();
      await f.storage.deleteDoc("deleted-leaf");
      expect(f.lifecycle.state("deleted-leaf")).toBe("available");
      expect(signal.aborted).toBe(false);
    } finally {
      f.close();
    }
  });

  test("disposal prevents an old store from terminating a replacement generation", async () => {
    const f = createFixture();
    try {
      f.engine.start();
      await f.storage.deleteDoc("deleted-leaf");
      expect(f.lifecycle.state("deleted-leaf")).toBe("not-found");
      f.engine.dispose();
      expect(f.closeStore).toHaveBeenCalledOnce();
      f.lifecycle.beginAvailableLifecycle("deleted-leaf", "created");
      const fresh = f.lifecycle.signal("deleted-leaf");
      await f.storage.deleteDoc("deleted-leaf");
      expect(f.lifecycle.state("deleted-leaf")).toBe("available");
      expect(fresh.aborted).toBe(false);
    } finally {
      f.close();
    }
  });
});
