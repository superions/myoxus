import { toArrayBuffer } from "@myoxus/core/utils/array-buffer";
import { DebugLogger } from "@myoxus/debug";
import {
  createWorkspaceMutation,
  deleteWorkspaceMutation,
  getWorkspaceInfoQuery,
  getWorkspacesQuery,
  Permission,
  ServerDeploymentType,
  ServerFeature,
  updateWorkspaceNameMutation,
} from "@myoxus/graphql";
import {
  catchErrorInto,
  effect,
  exhaustMapSwitchUntilChanged,
  fromPromise,
  LiveData,
  ObjectPool,
  onComplete,
  onStart,
  Service,
} from "@myoxus/infra";
import type {
  BlobStorage,
  DocStorage,
  ListedBlobRecord,
} from "@myoxus/storage";
import {
  CloudBlobStorage,
  cloudWorkspaceDatabaseRegistration,
  registerCloudWorkspaceDatabases,
} from "@myoxus/storage/cloud";
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
import { map, Observable, switchMap, tap } from "rxjs";
import { Doc as YDoc, encodeStateAsUpdate } from "yjs";

import {
  AccountChanged,
  AuthService,
  GraphQLService,
  type Server,
  type ServersService,
  WorkspaceServerService,
} from "../../server";
import type { GlobalState } from "../../storage";
import type {
  Workspace,
  WorkspaceFlavourProvider,
  WorkspaceFlavoursProvider,
  WorkspaceMetadata,
  WorkspaceProfileInfo,
} from "../../workspace";
import type { EmptyWorkspaceCreation } from "../../workspace/providers/flavour";
import { WorkspaceImpl } from "../../workspace/impls/workspace";
import { getWorkspaceProfileWorker } from "./out-worker";

const getCloudWorkspaceCacheKey = (serverId: string) => {
  if (serverId === "myoxus-cloud") {
    return "cloud-workspace:"; // FOR BACKWARD COMPATIBILITY
  }
  return `selfhosted-workspace-${serverId}:`;
};

const logger = new DebugLogger("myoxus:cloud-workspace-flavour-provider");

const isWorkspaceType = (
  value: string | null | undefined,
): value is NonNullable<WorkspaceProfileInfo["workspaceType"]> => {
  return value === "Personal" || value === "UserOwned" || value === "Shared";
};

const workspaceRoleFlags = (role: WorkspaceMetadata["role"] | undefined) => {
  return {
    isOwner: role === Permission.Owner,
    isAdmin: role === Permission.Admin,
  };
};

const profileFromMetadata = (
  metadata: WorkspaceMetadata,
): WorkspaceProfileInfo => {
  const roleFlags = workspaceRoleFlags(metadata.role);
  return {
    name: metadata.name,
    isOwner: metadata.isOwner ?? roleFlags.isOwner,
    isAdmin: metadata.isAdmin ?? roleFlags.isAdmin,
    workspaceType: metadata.workspaceType,
  };
};

export class CloudWorkspaceFlavourProvider implements WorkspaceFlavourProvider {
  private readonly authService: AuthService;
  private readonly graphqlService: GraphQLService;
  private readonly unsubscribeAccountChanged: () => void;

  constructor(
    private readonly globalState: GlobalState,
    private readonly server: Server,
  ) {
    this.authService = server.scope.get(AuthService);
    this.graphqlService = server.scope.get(GraphQLService);
    this.unsubscribeAccountChanged = this.server.scope.eventBus.on(
      AccountChanged,
      () => {
        this.revalidate();
      },
    );
  }

  readonly flavour = this.server.id;

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
    await this.graphqlService.gql({
      query: deleteWorkspaceMutation,
      variables: {
        id: id,
      },
    });
    // TODO(@forehalo): when deleting cloud workspace, should we delete the workspace folder in local?
    this.revalidate();
    await this.waitForLoaded();
  }

  async updateWorkspaceName(
    metadata: WorkspaceMetadata,
    name: string,
  ): Promise<string> {
    const { updateWorkspace } = await this.graphqlService.gql({
      query: updateWorkspaceNameMutation,
      variables: {
        id: metadata.id,
        name,
      },
    });
    const nextWorkspaces = this.workspaces$.value.map((workspace) =>
      workspace.id === metadata.id
        ? { ...workspace, name: updateWorkspace.name }
        : workspace,
    );
    this.workspaces$.next(nextWorkspaces);

    const accountId = this.authService.session.account$.value?.id;
    if (accountId) {
      this.globalState.set(
        getCloudWorkspaceCacheKey(this.server.id) + accountId,
        nextWorkspaces,
      );
    }
    return updateWorkspace.name;
  }

  async createWorkspace(
    initial: (
      docCollection: WorkspaceImpl,
      blobStorage: BlobStorage,
      docStorage: DocStorage,
    ) => Promise<void>,
    empty?: EmptyWorkspaceCreation,
  ): Promise<WorkspaceMetadata> {
    if (empty) {
      if (empty.kind !== "cloud-empty")
        throw new Error("Invalid cloud creation target");
      const account = this.authService.session.account$.value;
      if (!account) throw new Error("Workspace creation requires an account");
      let ownerValid = true;
      const ownerSubscription = this.authService.session.account$.subscribe(
        (current) => {
          if (current?.id !== account.id) ownerValid = false;
        },
      );
      try {
        const { createWorkspace: created } = await this.graphqlService.gql({
          query: createWorkspaceMutation,
          variables: { input: empty.input },
        });
        if (!ownerValid) throw new Error("Workspace creation owner changed");
        // Empty already has its canonical root. Never upload a local root or run
        // a legacy initializer while resuming the native creation receipt.
        this.revalidate();
        await this.waitForLoaded();
        if (!ownerValid) throw new Error("Workspace creation owner changed");
        return {
          id: created.id,
          flavour: this.flavour,
          name: created.name,
          initialContentPolicy: created.initialContentPolicy,
          creation: created.creation,
          initialized: created.initialized,
          role: created.role,
          workspaceType: isWorkspaceType(created.workspaceType)
            ? created.workspaceType
            : undefined,
          isOwner:
            created.role === Permission.Owner ||
            created.owner?.id === account.id,
          isAdmin: created.role === Permission.Admin,
        };
      } finally {
        ownerSubscription.unsubscribe();
      }
    }
    // create workspace on cloud, get workspace id
    const {
      createWorkspace: { id: workspaceId },
    } = await this.graphqlService.gql({
      query: createWorkspaceMutation,
      variables: {},
    });

    // save the initial state to local storage, then sync to cloud
    const blobStorage = new this.BlobStorageType({
      id: workspaceId,
      flavour: this.flavour,
      type: "workspace",
    });
    blobStorage.connection.connect();
    await blobStorage.connection.waitForConnected();
    const docStorage = new this.DocStorageType({
      id: workspaceId,
      flavour: this.flavour,
      type: "workspace",
    });
    docStorage.connection.connect();
    await docStorage.connection.waitForConnected();

    const docList = new Set<YDoc>();

    const docCollection = new WorkspaceImpl({
      id: workspaceId,
      rootDoc: new YDoc({ guid: workspaceId }),
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
      onLoadDoc: (doc) => {
        docList.add(doc);
      },
    });

    try {
      // apply initial state
      await initial(docCollection, blobStorage, docStorage);

      // save workspace to local storage, should be vary fast
      for (const subdocs of docList) {
        await docStorage.pushDocUpdate({
          docId: subdocs.guid,
          bin: encodeStateAsUpdate(subdocs),
        });
      }

      docStorage.connection.disconnect();
      blobStorage.connection.disconnect();

      this.revalidate();
      await this.waitForLoaded();
    } finally {
      docCollection.dispose();
    }

    return {
      id: workspaceId,
      flavour: this.server.id,
    };
  }
  revalidate = effect(
    map(() => {
      return { accountId: this.authService.session.account$.value?.id };
    }),
    exhaustMapSwitchUntilChanged(
      (a, b) => a.accountId === b.accountId,
      ({ accountId }) => {
        return fromPromise(async (signal) => {
          if (!accountId) {
            if (BUILD_CONFIG.isWeb) {
              await registerCloudWorkspaceDatabases(this.server.baseUrl, []);
            }
            return null; // no cloud workspace if no account
          }

          const { workspaces } = await this.graphqlService.gql({
            query: getWorkspacesQuery,
            context: {
              signal,
            },
          });
          if (BUILD_CONFIG.isWeb) {
            await registerCloudWorkspaceDatabases(
              this.server.baseUrl,
              workspaces.map((workspace) =>
                cloudWorkspaceDatabaseRegistration(
                  this.server.id,
                  workspace.id,
                ),
              ),
            );
          }

          return {
            accountId,
            workspaces: workspaces.map((workspace) => ({
              id: workspace.id,
              flavour: this.server.id,
              initialized: workspace.initialized,
              initialContentPolicy: workspace.initialContentPolicy,
              isAdmin: workspace.role === Permission.Admin,
              isOwner:
                workspace.role === Permission.Owner ||
                workspace.owner?.id === accountId,
              name: workspace.name,
              role: workspace.role,
              workspaceType: isWorkspaceType(workspace.workspaceType)
                ? workspace.workspaceType
                : undefined,
            })),
          };
        }).pipe(
          tap((data) => {
            if (data) {
              const { accountId, workspaces } = data;
              const sorted = workspaces.sort((a, b) => {
                return a.id.localeCompare(b.id);
              });
              this.globalState.set(
                getCloudWorkspaceCacheKey(this.server.id) + accountId,
                sorted,
              );
              if (!isEqual(this.workspaces$.value, sorted)) {
                this.workspaces$.next(sorted);
              }
            } else {
              this.workspaces$.next([]);
            }
          }),
          catchErrorInto(this.error$, (err) => {
            logger.error("error to revalidate cloud workspaces", err);
          }),
          onStart(() => this.isRevalidating$.next(true)),
          onComplete(() => this.isRevalidating$.next(false)),
        );
      },
      ({ accountId }) => {
        if (accountId) {
          this.workspaces$.next(
            this.globalState.get(
              getCloudWorkspaceCacheKey(this.server.id) + accountId,
            ) ?? [],
          );
        } else {
          this.workspaces$.next([]);
        }
      },
    ),
  );

  error$ = new LiveData<any>(null);
  isRevalidating$ = new LiveData(false);
  workspaces$ = new LiveData<WorkspaceMetadata[]>([]);

  async getWorkspaceProfile(
    metadata: WorkspaceMetadata,
    signal?: AbortSignal,
  ): Promise<WorkspaceProfileInfo | undefined> {
    const { id } = metadata;
    let preview = profileFromMetadata(metadata);
    if (
      metadata.name === undefined ||
      metadata.role === undefined ||
      metadata.workspaceType === undefined
    ) {
      const workspaceInfo = await this.getWorkspaceInfo(id, signal);
      preview = {
        ...preview,
        name: workspaceInfo.name,
        isOwner: workspaceInfo.role === Permission.Owner,
        isAdmin: workspaceInfo.role === Permission.Admin,
        workspaceType: isWorkspaceType(workspaceInfo.workspaceType)
          ? workspaceInfo.workspaceType
          : preview.workspaceType,
      };
    }

    if (metadata.initialized === false) {
      // The server can list a workspace before its root doc has been created.
      // Profile previews should use membership metadata in that state instead
      // of probing `/docs/{workspaceId}`, which creates noisy 5xx console output
      // behind local reverse proxies and still yields no profile name/avatar.
      return {
        ...preview,
        isEmpty: true,
      };
    }

    // Workspace switcher previews must not synchronously probe the remote root
    // doc. The list GraphQL payload already carries authoritative name/type
    // metadata; local readonly storage can opportunistically enrich avatar data
    // when the sync engine has cached the root doc.
    const docStorage = new this.DocStorageType({
      id,
      flavour: this.flavour,
      type: "workspace",
      readonlyMode: true,
    });
    let localData: Uint8Array | undefined;
    try {
      docStorage.connection.connect();
      await docStorage.connection.waitForConnected();
      localData = (await docStorage.getDoc(id))?.bin;
    } finally {
      docStorage.connection.disconnect();
    }
    const isEmpty = isEmptyUpdate(localData);

    if (!localData) {
      return {
        ...preview,
        isEmpty,
      };
    }

    const client = getWorkspaceProfileWorker();

    const result = await client.call(
      "renderWorkspaceProfile",
      [localData].filter(Boolean) as Uint8Array[],
    );

    return {
      ...preview,
      avatar: result.avatar,
      isEmpty,
    };
  }

  async getWorkspaceBlob(id: string, blob: string): Promise<Blob | null> {
    const storage = new this.BlobStorageType({
      id: id,
      flavour: this.flavour,
      type: "workspace",
    });
    storage.connection.connect();
    await storage.connection.waitForConnected();
    const localBlob = await storage.get(blob);

    storage.connection.disconnect();

    if (localBlob) {
      return new Blob([toArrayBuffer(localBlob.data)], {
        type: localBlob.mime,
      });
    }

    const cloudBlob = await new CloudBlobStorage({
      id,
      serverId: this.server.id,
      serverBaseUrl: this.server.serverMetadata.baseUrl,
    }).get(blob);
    if (!cloudBlob) {
      return null;
    }
    return new Blob([toArrayBuffer(cloudBlob.data)], { type: cloudBlob.mime });
  }

  async listBlobs(id: string): Promise<ListedBlobRecord[]> {
    const cloudStorage = new CloudBlobStorage({
      id,
      serverId: this.server.id,
      serverBaseUrl: this.server.serverMetadata.baseUrl,
    });
    return cloudStorage.list();
  }

  async deleteBlob(
    id: string,
    blob: string,
    permanent: boolean,
  ): Promise<void> {
    const cloudStorage = new CloudBlobStorage({
      id,
      serverId: this.server.id,
      serverBaseUrl: this.server.serverMetadata.baseUrl,
    });
    await cloudStorage.delete(blob, permanent);

    // should also delete from local storage
    const storage = new this.BlobStorageType({
      id: id,
      flavour: this.flavour,
      type: "workspace",
    });
    storage.connection.connect();
    await storage.connection.waitForConnected();
    await storage.delete(blob, permanent);
    storage.connection.disconnect();
  }

  onWorkspaceInitialized(workspace: Workspace): void {
    // bind the workspace to the affine cloud server
    workspace.scope.get(WorkspaceServerService).bindServer(this.server);
  }

  private async getWorkspaceInfo(workspaceId: string, signal?: AbortSignal) {
    const result = await this.graphqlService.gql({
      query: getWorkspaceInfoQuery,
      variables: {
        workspaceId,
      },
      context: { signal },
    });
    if (!result.workspace) {
      throw new Error("Workspace info not found");
    }
    return result.workspace;
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
        docSync: {
          name: this.DocSyncStorageType.identifier,
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
        awareness: {
          name: "BroadcastChannelAwarenessStorage",
          opts: {
            id: `${this.flavour}:${workspaceId}`,
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
      remotes: {
        [`cloud:${this.flavour}`]: {
          doc: {
            name: "CloudDocStorage",
            opts: {
              type: "workspace",
              id: workspaceId,
              serverId: this.server.id,
              serverBaseUrl: this.server.serverMetadata.baseUrl,
              isSelfHosted:
                this.server.config$.value.type ===
                ServerDeploymentType.Standalone,
            },
          },
          blob: {
            name: "CloudBlobStorage",
            opts: {
              id: workspaceId,
              serverId: this.server.id,
              serverBaseUrl: this.server.serverMetadata.baseUrl,
            },
          },
          awareness: {
            name: "CloudAwarenessStorage",
            opts: {
              type: "workspace",
              id: workspaceId,
              serverId: this.server.id,
              serverBaseUrl: this.server.serverMetadata.baseUrl,
              isSelfHosted:
                this.server.config$.value.type ===
                ServerDeploymentType.Standalone,
            },
          },
          indexer: this.server.config$.value.features.includes(
            ServerFeature.Indexer,
          )
            ? {
                name: "CloudIndexerStorage",
                opts: {
                  id: workspaceId,
                  serverId: this.server.id,
                  serverBaseUrl: this.server.serverMetadata.baseUrl,
                },
              }
            : undefined,
        },
      },
    };
  }

  private waitForLoaded() {
    return this.isRevalidating$.waitFor((loading) => !loading);
  }

  dispose() {
    this.revalidate.unsubscribe();
    this.unsubscribeAccountChanged();
  }
}

export class CloudWorkspaceFlavoursProvider
  extends Service
  implements WorkspaceFlavoursProvider
{
  constructor(
    private readonly globalState: GlobalState,
    private readonly serversService: ServersService,
  ) {
    super();
  }

  workspaceFlavours$ = LiveData.from<WorkspaceFlavourProvider[]>(
    this.serversService.servers$.pipe(
      switchMap((servers) => {
        const refs = servers.map((server) => {
          const exists = this.pool.get(server.id);
          if (exists) {
            return exists;
          }
          const provider = new CloudWorkspaceFlavourProvider(
            this.globalState,
            server,
          );
          provider.revalidate();
          const ref = this.pool.put(server.id, provider);
          return ref;
        });

        return new Observable<WorkspaceFlavourProvider[]>((subscribe) => {
          subscribe.next(refs.map((ref) => ref.obj));
          return () => {
            refs.forEach((ref) => {
              ref.release();
            });
          };
        });
      }),
    ),
    [] as any,
  );

  private readonly pool = new ObjectPool<string, CloudWorkspaceFlavourProvider>(
    {
      onDelete(obj) {
        obj.dispose();
      },
    },
  );
}

export function isEmptyUpdate(binary: Uint8Array | undefined) {
  if (!binary) {
    return true;
  }
  return (
    binary.byteLength === 0 ||
    (binary.byteLength === 2 && binary[0] === 0 && binary[1] === 0)
  );
}
