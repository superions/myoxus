// SPDX-License-Identifier: AGPL-3.0-or-later

import { WorkspaceServerService } from "@myoxus/core/modules/server/services/workspace-server";
import { ServerDeploymentType } from "@myoxus/graphql";
import { useService } from "@myoxus/infra";
import { SocketConnection } from "@myoxus/storage/cloud";
import { useEffect, useState } from "react";
import type { Socket } from "socket.io-client";

/**
 * Acquire the existing shared Socket.IO transport for a server workspace.
 * `SocketConnection` delegates to Storage's endpoint cache, so Database
 * collaboration shares authentication, reconnect and reference counting with
 * the rest of the client instead of opening an ad-hoc socket implementation.
 */
export function useDatabaseSocket(): Socket | null {
  const server = useService(WorkspaceServerService).server;
  const [socket, setSocket] = useState<Socket | null>(null);

  useEffect(() => {
    if (!server) {
      setSocket(null);
      return;
    }
    const connection = new SocketConnection(
      server.baseUrl,
      server.config$.value.type === ServerDeploymentType.Standalone,
      server.id,
    );
    const unsubscribe = connection.onStatusChanged((status) => {
      setSocket(
        status === "connected"
          ? (connection.maybeConnection?.socket ?? null)
          : null,
      );
    });
    connection.connect();
    if (connection.status === "connected") {
      setSocket(connection.maybeConnection?.socket ?? null);
    }

    return () => {
      unsubscribe();
      connection.disconnect();
      setSocket(null);
    };
  }, [server]);

  return socket;
}
