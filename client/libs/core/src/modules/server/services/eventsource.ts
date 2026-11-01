import { Service } from "@myoxus/infra";
import { desktopServerRequestUrl } from "@myoxus/desktop-api-contract";

import type { ServerService } from "./server";

export class EventSourceService extends Service {
  constructor(private readonly serverService: ServerService) {
    super();
  }

  eventSource = (url: string, eventSourceInitDict?: EventSourceInit) => {
    const server = this.serverService.server;
    const target = new URL(url, server.baseUrl);
    if (
      BUILD_CONFIG.isElectron &&
      target.origin !== new URL(server.baseUrl).origin
    )
      throw new Error("Cross-server event stream");
    return new EventSource(
      BUILD_CONFIG.isElectron
        ? desktopServerRequestUrl(server.id, target.pathname + target.search)
        : target,
      eventSourceInitDict,
    );
  };
}
