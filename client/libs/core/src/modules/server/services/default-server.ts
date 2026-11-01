import { ServerDeploymentType } from "@myoxus/graphql";
import { LiveData, Service } from "@myoxus/infra";

import type { Server } from "../entities/server";
import type { ServersService } from "./servers";

export class DefaultServerService extends Service {
  readonly server$ = this.serversService.selectedServerId$
    .map((id) =>
      id
        ? this.serversService.server$(id)
        : new LiveData<Server | undefined>(undefined),
    )
    .flat();

  /** Server-dependent consumers run below the root's configured-server gate.
   * Fail closed outside that scope; never synthesize a server for first start. */
  get server(): Server {
    const server = this.server$.value;
    if (!server) throw new Error("No configured server selected");
    return server;
  }

  constructor(private readonly serversService: ServersService) {
    super();
  }

  async waitForSelfhostedServerConfig() {
    if (
      BUILD_CONFIG.isElectron ||
      this.server.config$.value.type === ServerDeploymentType.Standalone
    ) {
      await this.server.waitForConfigRevalidation();
    }
  }
}
