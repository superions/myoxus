import { Entity } from "@myoxus/infra";
import type {
  StoreClient,
  WorkerInitOptions,
} from "@myoxus/storage/worker/client";

import type { DocumentLifecycleStore } from "../../doc/stores/document-lifecycle";
import type { FeatureFlagService } from "../../feature-flag";
import type { StoreService } from "../../storage";
import { WorkspaceEngineBeforeStart } from "../events";
import type { WorkspaceService } from "../services/workspace";

export class WorkspaceEngine extends Entity<{
  isSharedMode?: boolean;
  engineWorkerInitOptions: WorkerInitOptions;
}> {
  client?: StoreClient;
  started = false;

  constructor(
    private readonly workspaceService: WorkspaceService,
    private readonly storeService: StoreService,
    private readonly featureFlagService: FeatureFlagService,
    private readonly documentLifecycle: DocumentLifecycleStore,
  ) {
    super();
  }

  get doc() {
    if (!this.client) {
      throw new Error("Engine is not initialized");
    }
    return this.client.docFrontend;
  }

  get blob() {
    if (!this.client) {
      throw new Error("Engine is not initialized");
    }
    return this.client.blobFrontend;
  }

  get indexer() {
    if (!this.client) {
      throw new Error("Engine is not initialized");
    }
    return this.client.indexerFrontend;
  }

  get awareness() {
    if (!this.client) {
      throw new Error("Engine is not initialized");
    }
    return this.client.awarenessFrontend;
  }

  start() {
    if (this.started) {
      throw new Error("Engine is already started");
    }
    this.started = true;

    const { store, dispose } = this.storeService.openStore(
      (this.props.isSharedMode ? "shared:" : "") +
        `workspace:${this.workspaceService.workspace.flavour}:${this.workspaceService.workspace.id}`,
      this.props.engineWorkerInitOptions,
    );
    if (
      this.featureFlagService.flags.enable_battery_save_mode.value &&
      this.workspaceService.workspace.flavour !== "local"
    ) {
      store.enableBatterySaveMode().catch((err) => {
        console.error("error enabling battery save mode", err);
      });
    }
    this.client = store;
    this.disposables.push(dispose);
    if (this.workspaceService.workspace.flavour !== "local") {
      // Confirmed local purge may arrive before root membership changes. End
      // requests before consumers start; a terminal route alone is insufficient.
      const disposeDelete = this.doc.storage.subscribeDocDelete?.((docId) =>
        this.documentLifecycle.markNotFound(docId),
      );
      if (disposeDelete) this.disposables.push(disposeDelete);
    }
    this.eventBus.emit(WorkspaceEngineBeforeStart, this);

    const rootDoc = this.workspaceService.workspace.docCollection.doc;
    // priority load root doc
    this.doc.addPriority(rootDoc.guid, 100);
    this.indexer.addPriority(rootDoc.guid, 100);
    this.doc.start();
    this.disposables.push(() => this.doc.stop());

    // fully migrate blobs from v1 to v2, its won't do anything if v1 storage is not exist
    store.blobFrontend.fullDownload("v1").catch(() => {
      // should never reach here
    });
  }
}
