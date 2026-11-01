import type { SharedStorageSnapshot } from "@myoxus/desktop-api-contract";
import { WorkspaceInitialContentPolicy } from "@myoxus/graphql";
import { GlobalState, writeGlobalStateConfirmed } from "../../storage";
import type { EmptyWorkspaceCreation } from "../../workspace/providers/flavour";
import {
  localWorkspaceInitialContentPolicyKey,
  localWorkspaceAssistanceKey,
} from "../../workspace/metadata";
import { toArrayBuffer } from "@myoxus/core/utils/array-buffer";
import { DebugLogger } from "@myoxus/debug";
import { getDesktopBridge } from "@myoxus/desktop-api-contract/bridge";
import { type FrameworkProvider, LiveData, Service } from "@myoxus/infra";
import {
  type BlobStorage,
  type DocStorage,
  type ListedBlobRecord,
  universalId,
} from "@myoxus/storage";
import {
  IndexedDBBlobStorage,
  IndexedDBBlobSyncStorage,
  IndexedDBDocStorage,
  IndexedDBDocSyncStorage,
  IndexedDBIndexerStorage,
  IndexedDBIndexerSyncStorage,
} from "@myoxus/storage/idb";
import {
  SqliteBlobStorage,
  SqliteBlobSyncStorage,
  SqliteDocStorage,
  SqliteDocSyncStorage,
  SqliteIndexerStorage,
  SqliteIndexerSyncStorage,
} from "@myoxus/storage/sqlite";
import type { WorkerInitOptions } from "@myoxus/storage/worker/client";
import { isEqual } from "lodash-es";
import { nanoid } from "nanoid";
import { Observable } from "rxjs";
import { Doc as YDoc, encodeStateAsUpdate } from "yjs";

import { DesktopApiService } from "../../desktop-api";
import type {
  WorkspaceFlavourProvider,
  WorkspaceFlavoursProvider,
  WorkspaceMetadata,
  WorkspaceProfileInfo,
} from "../../workspace";
import { WorkspaceImpl } from "../../workspace/impls/workspace";
import { canUseLocalWorkspaces } from "../../workspace/local-workspace-capability";
import { getWorkspaceProfileWorker } from "./out-worker";
import {
  dedupeWorkspaceIds,
  normalizeWorkspaceIds,
} from "./workspace-id-utils";

export const LOCAL_WORKSPACE_LOCAL_STORAGE_KEY = "myoxus-local-workspace";
export const LOCAL_WORKSPACE_GLOBAL_STATE_KEY =
  "workspace-engine:local-workspace-ids:v1";
const LOCAL_WORKSPACE_CHANGED_BROADCAST_CHANNEL_KEY =
  "myoxus-local-workspace-changed";

const logger = new DebugLogger("local-workspace");

function getElectronGlobalStateStorage() {
  if (!BUILD_CONFIG.isElectron) {
    return null;
  }
  return getDesktopBridge()?.sharedStorage.globalState ?? null;
}

function getLegacyLocalWorkspaceIds(): string[] {
  try {
    return normalizeWorkspaceIds(
      JSON.parse(
        localStorage.getItem(LOCAL_WORKSPACE_LOCAL_STORAGE_KEY) ?? "[]",
      ),
    );
  } catch (e) {
    logger.error("Failed to get local workspace ids", e);
    return [];
  }
}

export function getLocalWorkspaceIds(): string[] {
  if (!canUseLocalWorkspaces()) {
    return [];
  }

  const globalState = getElectronGlobalStateStorage();
  if (globalState) {
    const value = globalState.get(LOCAL_WORKSPACE_GLOBAL_STATE_KEY);
    if (value !== undefined) {
      return normalizeWorkspaceIds(value);
    }
  }

  return getLegacyLocalWorkspaceIds();
}

export function setLocalWorkspaceIds(
  idsOrUpdater: string[] | ((ids: string[]) => string[]),
) {
  if (!canUseLocalWorkspaces()) {
    logger.warn(
      "Ignoring local workspace id write because this runtime does not support local workspaces",
    );
    return;
  }

  const next = normalizeWorkspaceIds(
    typeof idsOrUpdater === "function"
      ? idsOrUpdater(getLocalWorkspaceIds())
      : idsOrUpdater,
  );
  const deduplicated = dedupeWorkspaceIds(next);

  const globalState = getElectronGlobalStateStorage();
  if (globalState) {
    globalState.set(LOCAL_WORKSPACE_GLOBAL_STATE_KEY, deduplicated);
    return;
  }

  try {
    localStorage.setItem(
      LOCAL_WORKSPACE_LOCAL_STORAGE_KEY,
      JSON.stringify(deduplicated),
    );
  } catch (e) {
    logger.error("Failed to set local workspace ids", e);
  }
}

export class LocalWorkspaceFlavourProvider implements WorkspaceFlavourProvider {
  constructor(private readonly framework: FrameworkProvider) {
    if (BUILD_CONFIG.isElectron) {
      void this.ensureWorkspaceIdsMigrated().catch((error) =>
        logger.error("Failed to migrate local workspace ids", error),
      );
    }
  }

  private migration: Promise<SharedStorageSnapshot> | null = null;
  private migrated = false;

  private async ensureWorkspaceIdsMigrated(): Promise<
    SharedStorageSnapshot | undefined
  > {
    if (!BUILD_CONFIG.isElectron || this.migrated) return;
    if (this.migration) return this.migration;
    this.migration = (async () => {
      const api = this.framework.get(DesktopApiService);
      const scannedIds = await api.handler.workspace.listLocalWorkspaceIds();
      // Read after the scan: every scan-visible Empty root already has its
      // durable policy. Preload's optimistic cache/readiness cannot prove that.
      const snapshot = await api.handler.sharedStorage.getAllGlobalState();
      const ids = dedupeWorkspaceIds([
        ...normalizeWorkspaceIds(snapshot[LOCAL_WORKSPACE_GLOBAL_STATE_KEY]),
        ...getLegacyLocalWorkspaceIds(),
        ...scannedIds,
      ]);
      const changed = !isEqual(
        ids,
        normalizeWorkspaceIds(snapshot[LOCAL_WORKSPACE_GLOBAL_STATE_KEY]),
      );
      if (changed) {
        await api.handler.sharedStorage.setGlobalState(
          LOCAL_WORKSPACE_GLOBAL_STATE_KEY,
          ids,
        );
      }
      this.migrated = true;
      if (changed) this.notifyChannel.postMessage(null);
      return { ...snapshot, [LOCAL_WORKSPACE_GLOBAL_STATE_KEY]: ids };
    })().finally(() => {
      this.migration = null;
    });
    return this.migration;
  }

  readonly flavour = "local";
  readonly notifyChannel = new BroadcastChannel(
    LOCAL_WORKSPACE_CHANGED_BROADCAST_CHANNEL_KEY,
  );

  DocStorageType =
    BUILD_CONFIG.isElectron || BUILD_CONFIG.isIOS || BUILD_CONFIG.isAndroid
      ? SqliteDocStorage
      : IndexedDBDocStorage;
  BlobStorageType =
    BUILD_CONFIG.isElectron || BUILD_CONFIG.isIOS || BUILD_CONFIG.isAndroid
      ? SqliteBlobStorage
      : IndexedDBBlobStorage;
  DocSyncStorageType =
    BUILD_CONFIG.isElectron || BUILD_CONFIG.isIOS || BUILD_CONFIG.isAndroid
      ? SqliteDocSyncStorage
      : IndexedDBDocSyncStorage;
  BlobSyncStorageType =
    BUILD_CONFIG.isElectron || BUILD_CONFIG.isIOS || BUILD_CONFIG.isAndroid
      ? SqliteBlobSyncStorage
      : IndexedDBBlobSyncStorage;
  IndexerStorageType =
    BUILD_CONFIG.isElectron || BUILD_CONFIG.isIOS || BUILD_CONFIG.isAndroid
      ? SqliteIndexerStorage
      : IndexedDBIndexerStorage;
  IndexerSyncStorageType = BUILD_CONFIG.isElectron
    ? SqliteIndexerSyncStorage
    : IndexedDBIndexerSyncStorage;

  async deleteWorkspace(id: string): Promise<void> {
    setLocalWorkspaceIds((ids) => ids.filter((x) => x !== id));

    // TODO(@forehalo): deleting logic for indexeddb workspaces
    if (BUILD_CONFIG.isElectron) {
      const electronApi = this.framework.get(DesktopApiService);
      await electronApi.handler.workspace.moveToTrash(
        universalId({ peer: "local", type: "workspace", id }),
      );
    }
    // notify all browser tabs, so they can update their workspace list
    this.notifyChannel.postMessage(id);
  }

  async updateWorkspaceName(
    _metadata: WorkspaceMetadata,
    name: string,
  ): Promise<string> {
    return name;
  }

  async createWorkspace(
    initial: (
      docCollection: WorkspaceImpl,
      blobStorage: BlobStorage,
      docStorage: DocStorage,
    ) => Promise<void>,
    empty?: EmptyWorkspaceCreation,
  ): Promise<WorkspaceMetadata> {
    if (!canUseLocalWorkspaces()) {
      throw new Error("Local workspaces are not supported in this runtime");
    }

    if (empty && empty.kind !== "local-empty")
      throw new Error("Invalid local creation target");
    const id = nanoid();

    if (empty?.kind === "local-empty") {
      // Persist before the first scan-visible file: native directory recovery
      // must never reopen an Empty root with the legacy seeding policy.
      const state = this.framework.get(GlobalState);
      await writeGlobalStateConfirmed(
        state,
        localWorkspaceInitialContentPolicyKey(id),
        WorkspaceInitialContentPolicy.Empty,
      );
      await writeGlobalStateConfirmed(
        state,
        localWorkspaceAssistanceKey(id),
        empty.assistanceMode,
      );
    }

    // save the initial state to local storage, then sync to cloud
    const docStorage = new this.DocStorageType({
      id: id,
      flavour: this.flavour,
      type: "workspace",
    });
    try {
      docStorage.connection.connect();
      await docStorage.connection.waitForConnected();
      const blobStorage = new this.BlobStorageType({
        id: id,
        flavour: this.flavour,
        type: "workspace",
      });
      try {
        blobStorage.connection.connect();
        await blobStorage.connection.waitForConnected();

        const docList = new Set<YDoc>();

        const docCollection = new WorkspaceImpl({
          id: id,
          rootDoc: new YDoc({ guid: id }),
          blobSource: {
            get: async (key) => {
              const record = await blobStorage.get(key);
              return record
                ? new Blob([toArrayBuffer(record.data)], { type: record.mime })
                : null;
            },
            delete: async () => {
              return;
            },
            list: async () => {
              return [];
            },
            set: async (id, blob) => {
              await blobStorage.set({
                key: id,
                data: new Uint8Array(await blob.arrayBuffer()),
                mime: blob.type,
              });
              return id;
            },
            name: "blob",
            readonly: false,
          },
          onLoadDoc(doc) {
            docList.add(doc);
          },
        });

        try {
          if (empty?.kind === "local-empty") {
            docCollection.meta.initialize();
            docCollection.doc.getMap("meta").set("name", empty.name);
          } else {
            await initial(docCollection, blobStorage, docStorage);
          }

          for (const subdocs of docList) {
            await docStorage.pushDocUpdate({
              docId: subdocs.guid,
              bin: encodeStateAsUpdate(subdocs),
            });
          }

          // save workspace id to local storage
          setLocalWorkspaceIds((ids) => [...ids, id]);

          // notify all browser tabs, so they can update their workspace list
          this.notifyChannel.postMessage(id);
        } finally {
          docCollection.dispose();
        }
      } finally {
        blobStorage.connection.disconnect();
      }
    } finally {
      docStorage.connection.disconnect();
    }

    return {
      id,
      flavour: "local",
      initialContentPolicy: empty
        ? WorkspaceInitialContentPolicy.Empty
        : WorkspaceInitialContentPolicy.LegacyDefaults,
    };
  }
  // Until the native snapshot is confirmed, an empty projection is loading,
  // not a first-start signal that may create a legacy showcase Workspace.
  isRevalidating$ = new LiveData(BUILD_CONFIG.isElectron);
  workspaces$ = LiveData.from(
    new Observable<WorkspaceMetadata[]>((subscriber) => {
      let last: WorkspaceMetadata[] | null = null;
      let generation = 0;
      let disposed = false;
      const emit = async () => {
        const requested = ++generation;
        if (!canUseLocalWorkspaces()) {
          if (!isEqual(last, [])) {
            subscriber.next([]);
            last = [];
          }
          this.isRevalidating$.value = false;
          return;
        }
        if (BUILD_CONFIG.isElectron) this.isRevalidating$.value = true;
        try {
          let value: WorkspaceMetadata[];
          if (BUILD_CONFIG.isElectron) {
            const snapshot =
              (await this.ensureWorkspaceIdsMigrated()) ??
              (await this.framework
                .get(DesktopApiService)
                .handler.sharedStorage.getAllGlobalState());
            value = normalizeWorkspaceIds(
              snapshot[LOCAL_WORKSPACE_GLOBAL_STATE_KEY],
            ).map((id) => {
              const policy =
                snapshot[localWorkspaceInitialContentPolicyKey(id)];
              if (
                policy !== undefined &&
                policy !== WorkspaceInitialContentPolicy.Empty &&
                policy !== WorkspaceInitialContentPolicy.LegacyDefaults
              )
                throw new Error("Invalid native Workspace content policy");
              return {
                id,
                flavour: "local",
                initialContentPolicy:
                  policy ?? WorkspaceInitialContentPolicy.LegacyDefaults,
              };
            });
          } else {
            value = getLocalWorkspaceIds().map((id) => ({
              id,
              flavour: "local",
              initialContentPolicy:
                this.framework
                  .get(GlobalState)
                  .get<WorkspaceInitialContentPolicy>(
                    localWorkspaceInitialContentPolicyKey(id),
                  ) ?? WorkspaceInitialContentPolicy.LegacyDefaults,
            }));
          }
          if (disposed || requested !== generation) return;
          if (!isEqual(last, value)) {
            subscriber.next(value);
            last = value;
          }
          this.isRevalidating$.value = false;
        } catch (error) {
          if (disposed || requested !== generation) return;
          // Keep native loading on failure: publishing a successful empty list
          // would let the existing first-start owner seed legacy content.
          logger.error(
            "Failed to read confirmed local Workspace metadata",
            error,
          );
        }
      };
      void emit();
      const channel = new BroadcastChannel(
        LOCAL_WORKSPACE_CHANGED_BROADCAST_CHANNEL_KEY,
      );
      const changed = () => {
        void emit();
      };
      channel.addEventListener("message", changed);
      return () => {
        disposed = true;
        generation += 1;
        channel.removeEventListener("message", changed);
        channel.close();
      };
    }),
    [],
  );
  revalidate(): void {
    // Each native emission re-reads one confirmed Main snapshot. Failed initial
    // migration remains retryable without trusting an optimistic cache.
    this.notifyChannel.postMessage(null);
  }

  async getWorkspaceProfile({
    id,
  }: WorkspaceMetadata): Promise<WorkspaceProfileInfo | undefined> {
    const docStorage = new this.DocStorageType({
      id: id,
      flavour: this.flavour,
      type: "workspace",
      readonlyMode: true,
    });
    docStorage.connection.connect();
    await docStorage.connection.waitForConnected();
    const localData = await docStorage.getDoc(id);

    docStorage.connection.disconnect();

    if (!localData) {
      return {
        isOwner: true,
      };
    }

    const client = getWorkspaceProfileWorker();

    const result = await client.call(
      "renderWorkspaceProfile",
      [localData.bin].filter(Boolean) as Uint8Array[],
    );

    return {
      name: result.name,
      avatar: result.avatar,
      isOwner: true,
    };
  }

  async getWorkspaceBlob(id: string, blobKey: string): Promise<Blob | null> {
    const storage = new this.BlobStorageType({
      id: id,
      flavour: this.flavour,
      type: "workspace",
    });
    storage.connection.connect();
    await storage.connection.waitForConnected();
    const blob = await storage.get(blobKey);
    return blob
      ? new Blob([toArrayBuffer(blob.data)], { type: blob.mime })
      : null;
  }

  async listBlobs(id: string): Promise<ListedBlobRecord[]> {
    const storage = new this.BlobStorageType({
      id: id,
      flavour: this.flavour,
      type: "workspace",
    });
    storage.connection.connect();
    await storage.connection.waitForConnected();

    return storage.list();
  }

  async deleteBlob(
    id: string,
    blob: string,
    permanent: boolean,
  ): Promise<void> {
    const storage = new this.BlobStorageType({
      id: id,
      flavour: this.flavour,
      type: "workspace",
    });
    storage.connection.connect();
    await storage.connection.waitForConnected();
    await storage.delete(blob, permanent);
  }

  getEngineWorkerInitOptions(workspaceId: string): WorkerInitOptions {
    return {
      local: {
        doc: {
          name: this.DocStorageType.identifier,
          opts: {
            flavour: this.flavour,
            type: "workspace",
            id: workspaceId,
          },
        },
        blob: {
          name: this.BlobStorageType.identifier,
          opts: {
            flavour: this.flavour,
            type: "workspace",
            id: workspaceId,
          },
        },
        blobSync: {
          name: this.BlobSyncStorageType.identifier,
          opts: {
            flavour: this.flavour,
            type: "workspace",
            id: workspaceId,
          },
        },
        docSync: {
          name: this.DocSyncStorageType.identifier,
          opts: {
            flavour: this.flavour,
            type: "workspace",
            id: workspaceId,
          },
        },
        awareness: {
          name: "BroadcastChannelAwarenessStorage",
          opts: {
            id: workspaceId,
          },
        },
        indexer: {
          name: this.IndexerStorageType.identifier,
          opts: {
            flavour: this.flavour,
            type: "workspace",
            id: workspaceId,
          },
        },
        indexerSync: {
          name: this.IndexerSyncStorageType.identifier,
          opts: {
            flavour: this.flavour,
            type: "workspace",
            id: workspaceId,
          },
        },
      },
      remotes: {},
    };
  }
}

export class LocalWorkspaceFlavoursProvider
  extends Service
  implements WorkspaceFlavoursProvider
{
  constructor() {
    super();
  }

  workspaceFlavours$ = new LiveData<WorkspaceFlavourProvider[]>([
    new LocalWorkspaceFlavourProvider(this.framework),
  ]);
}
