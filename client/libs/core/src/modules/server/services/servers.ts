import { Unreachable } from "@myoxus/env/constant";
import { isAllowedDesktopServerOrigin } from "@myoxus/desktop-api-contract";
import { LiveData, ObjectPool, Service } from "@myoxus/infra";
import { nanoid } from "nanoid";
import { Observable, switchMap } from "rxjs";

import { Server } from "../entities/server";
import { normalizeServerBaseUrl } from "../constant";
import { ServerStarted } from "../events/server-started";
import type { ServerConfigStore } from "../stores/server-config";
import type { ServerListStore } from "../stores/server-list";
import type { ServerConfig, ServerMetadata } from "../types";

export class ServersService extends Service {
  constructor(
    private readonly serverListStore: ServerListStore,
    private readonly serverConfigStore: ServerConfigStore,
  ) {
    super();
  }

  servers$ = LiveData.from<Server[]>(
    this.serverListStore.watchServerList().pipe(
      switchMap((metadatas) => {
        const refs = metadatas.map((metadata) => {
          const exists = this.serverPool.get(metadata.id);
          if (exists) {
            return exists;
          }
          const server = this.framework.createEntity(Server, {
            serverMetadata: metadata,
          });
          server.revalidateConfig();
          server.scope.eventBus.emit(ServerStarted, server);
          const ref = this.serverPool.put(metadata.id, server);
          return ref;
        });

        return new Observable<Server[]>((subscribe) => {
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

  serversWithAccount$ = this.servers$
    .map((servers) =>
      servers.map((server) =>
        server.account$.map((account) => ({
          server,
          account,
        })),
      ),
    )
    .flat();

  server$(id: string) {
    return this.servers$.map((servers) =>
      servers.find((server) => server.id === id),
    );
  }

  serverByBaseUrl$(url: string) {
    return this.servers$.map((servers) =>
      servers.find((server) => server.baseUrl === url),
    );
  }

  private readonly serverPool = new ObjectPool<string, Server>({
    onDelete(obj) {
      obj.dispose();
    },
  });

  addServer(metadata: ServerMetadata, config: ServerConfig) {
    this.serverListStore.addServer(metadata, config);
  }

  removeServer(id: string) {
    this.serverListStore.removeServer(id);
  }

  readonly selectedServerId$ = LiveData.from(
    this.serverListStore.watchSelectedServerId(),
    undefined,
  );

  selectServer(id: string) {
    this.serverListStore.selectServer(id);
  }

  async addServerByBaseUrl(baseUrl: string) {
    baseUrl = normalizeServerBaseUrl(baseUrl);
    if (BUILD_CONFIG.isElectron && !isAllowedDesktopServerOrigin(baseUrl)) {
      throw new Error("Remote servers require HTTPS");
    }
    const config = await this.serverConfigStore.fetchServerConfig(baseUrl);
    const id = nanoid();
    this.serverListStore.addServer(
      { id, baseUrl },
      {
        credentialsRequirement: config.credentialsRequirement,
        features: config.features,
        oauthProviders: config.oauthProviders,
        serverName: config.name,
        type: config.deploymentType,
        initialized: config.initialized,
        preview: config.preview,
        version: config.version,
      },
    );
  }

  getServerByBaseUrl(baseUrl: string) {
    try {
      baseUrl = normalizeServerBaseUrl(baseUrl);
    } catch {
      return undefined;
    }
    return this.servers$.value.find((s) => s.baseUrl === baseUrl);
  }

  async addOrGetServerByBaseUrl(baseUrl: string) {
    baseUrl = normalizeServerBaseUrl(baseUrl);
    const server = this.getServerByBaseUrl(baseUrl);
    if (server) {
      this.selectServer(server.id);
      return server;
    } else {
      await this.addServerByBaseUrl(baseUrl);
      const server = this.getServerByBaseUrl(baseUrl);
      if (!server) {
        throw new Unreachable();
      }
      return server;
    }
  }
}
