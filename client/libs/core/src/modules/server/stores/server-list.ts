import { Store } from "@myoxus/infra";
import { getDesktopBridge } from "@myoxus/desktop-api-contract/bridge";
import type {
  DesktopServerRegistryMutation,
  SharedStoragePersistedValue,
} from "@myoxus/desktop-api-contract";
import { ServerDeploymentType } from "@myoxus/graphql";
import { combineLatest, map } from "rxjs";

import type { GlobalStateService } from "../../storage";
import { BUILD_IN_SERVERS, normalizeServerBaseUrl } from "../constant";
import type { ServerConfig, ServerMetadata } from "../types";

export class ServerListStore extends Store {
  constructor(private readonly globalStateService: GlobalStateService) {
    super();
  }

  watchServerList() {
    return this.globalStateService.globalState
      .watch<ServerMetadata[]>("serverList")
      .pipe(
        map((servers) => [
          ...BUILD_IN_SERVERS,
          ...this.registeredServers(servers),
        ]),
      );
  }

  /** Selection is shared with other Electron windows, but always resolved
   * against the current list. Removing a server cannot leave a stale owner. */
  watchSelectedServerId() {
    return combineLatest([
      this.watchServerList(),
      this.globalStateService.globalState.watch<string>("selectedServerId"),
    ]).pipe(
      map(
        ([servers, selected]) =>
          BUILD_IN_SERVERS[0]?.id ??
          servers.find((server) => server.id === selected)?.id ??
          servers[0]?.id,
      ),
    );
  }

  selectServer(id: string) {
    if (!this.getServerList().some((server) => server.id === id)) {
      throw new Error("Cannot select an unregistered server");
    }
    if (this.globalStateService.globalState.get("selectedServerId") !== id) {
      this.globalStateService.globalState.set("selectedServerId", id);
    }
  }

  getServerList() {
    return [
      ...BUILD_IN_SERVERS,
      ...this.registeredServers(
        this.globalStateService.globalState.get<ServerMetadata[]>("serverList"),
      ),
    ];
  }

  private registeredServers(value: unknown): ServerMetadata[] {
    if (!Array.isArray(value)) return [];
    return value.filter((server): server is ServerMetadata => {
      if (
        !server ||
        typeof server.id !== "string" ||
        !server.id ||
        typeof server.baseUrl !== "string"
      )
        return false;
      try {
        const config = this.getServerConfig(server.id);
        return (
          normalizeServerBaseUrl(server.baseUrl) === server.baseUrl &&
          (config?.type === ServerDeploymentType.Cloud ||
            config?.type === ServerDeploymentType.Standalone)
        );
      } catch {
        // Unvalidated persisted entries are not runtime authorities. Leave the
        // record untouched so that rejecting it never destroys user data.
        return false;
      }
    });
  }

  private async mutateNativeRegistry(mutation: DesktopServerRegistryMutation) {
    await this.globalStateService.globalState.ready;
    const api = getDesktopBridge()?.apis.sharedStorage;
    if (!api) throw new Error("Native server registry is unavailable");
    await api.mutateServerRegistry(mutation);
  }

  async addServer(server: ServerMetadata, serverConfig: ServerConfig) {
    server = { ...server, baseUrl: normalizeServerBaseUrl(server.baseUrl) };
    if (
      !server.id ||
      ![ServerDeploymentType.Cloud, ServerDeploymentType.Standalone].includes(
        serverConfig.type,
      )
    ) {
      throw new Error("Invalid configured server");
    }
    if (BUILD_CONFIG.isElectron) {
      await this.mutateNativeRegistry({
        type: "add",
        server,
        config: structuredClone(
          serverConfig,
        ) as unknown as SharedStoragePersistedValue,
      });
      return;
    }
    const oldServers =
      this.globalStateService.globalState.get<ServerMetadata[]>("serverList") ??
      [];

    if (
      this.getServerList().some(
        (s) => s.id === server.id || s.baseUrl === server.baseUrl,
      )
    ) {
      throw new Error(
        "Server with same base url already exists, " + server.baseUrl,
      );
    }

    this.updateServerConfig(server.id, serverConfig);
    this.globalStateService.globalState.set<ServerMetadata[]>("serverList", [
      ...oldServers,
      server,
    ]);
    this.selectServer(server.id);
  }

  async removeServer(serverId: string) {
    if (BUILD_CONFIG.isElectron) {
      await this.mutateNativeRegistry({ type: "remove", id: serverId });
      return;
    }
    const oldServers =
      this.globalStateService.globalState.get<ServerMetadata[]>("serverList") ??
      [];

    this.globalStateService.globalState.set<ServerMetadata[]>(
      "serverList",
      oldServers.filter((server) => server.id !== serverId),
    );
  }

  watchServerConfig(serverId: string) {
    return this.globalStateService.globalState
      .watch<ServerConfig>(`serverConfig:${serverId}`)
      .pipe(
        map((config) => {
          if (!config) {
            return BUILD_IN_SERVERS.find((server) => server.id === serverId)
              ?.config;
          } else {
            return config;
          }
        }),
      );
  }

  getServerConfig(serverId: string) {
    return (
      this.globalStateService.globalState.get<ServerConfig>(
        `serverConfig:${serverId}`,
      ) ?? BUILD_IN_SERVERS.find((server) => server.id === serverId)?.config
    );
  }

  updateServerConfig(serverId: string, config: ServerConfig) {
    this.globalStateService.globalState.set<ServerConfig>(
      `serverConfig:${serverId}`,
      config,
    );
  }
}
