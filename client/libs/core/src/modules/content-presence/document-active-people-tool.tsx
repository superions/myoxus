// SPDX-License-Identifier: AGPL-3.0-or-later

import { WorkspaceServerService } from "@myoxus/core/modules/server/services/workspace-server";
import { ServerDeploymentType } from "@myoxus/graphql";
import { useService } from "@myoxus/infra";
import { SocketConnection } from "@myoxus/storage/cloud";
import { useEffect, useState } from "react";
import type { Awareness } from "y-protocols/awareness";
import { ActivePeopleTool, type ActivePerson } from "./active-people-tool";

export function DocumentActivePeopleTool({
  awareness,
}: {
  awareness: Awareness;
}) {
  const server = useService(WorkspaceServerService).server;
  const [people, setPeople] = useState<ActivePerson[] | null>(null);
  const [connected, setConnected] = useState<boolean | null>(null);

  useEffect(() => {
    const update = () =>
      setPeople(
        [...awareness.getStates()].flatMap(([id, state]) =>
          typeof state.user?.name === "string"
            ? [
                {
                  key: String(id),
                  name: state.user.name,
                  local: id === awareness.clientID,
                  color:
                    typeof state.color === "string" &&
                    !state.color.includes("grey") &&
                    !state.color.includes("gray")
                      ? state.color
                      : undefined,
                },
              ]
            : [],
        ),
      );
    awareness.on("change", update);
    update();
    return () => awareness.off("change", update);
  }, [awareness]);

  useEffect(() => {
    if (!server) {
      setConnected(false);
      return;
    }
    // Observe the cached workspace transport; this tool never joins or leaves
    // document awareness rooms, which remain owned by the editor lifecycle.
    const connection = new SocketConnection(
      server.baseUrl,
      server.config$.value.type === ServerDeploymentType.Standalone,
      server.id,
    );
    const unsubscribe = connection.onStatusChanged((status) =>
      setConnected(
        status === "idle" || status === "connecting"
          ? null
          : status === "connected",
      ),
    );
    connection.connect();
    setConnected(
      connection.status === "idle" || connection.status === "connecting"
        ? null
        : connection.status === "connected",
    );
    return () => {
      unsubscribe();
      connection.disconnect();
    };
  }, [server]);

  return <ActivePeopleTool people={people} connected={connected} />;
}
