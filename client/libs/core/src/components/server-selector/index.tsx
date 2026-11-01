import type { Server } from "@myoxus/core/modules/server";
import { FormSelect } from "@myoxus/ui-facade";
import { useMemo } from "react";

export const ServerSelector = ({
  servers,
  selectedServerId,
  onSelect,
  label,
}: {
  servers: Server[];
  selectedServerId: string;
  onSelect: (server: Server) => void;
  label: string;
}) => {
  const data = useMemo(
    () =>
      servers.map((server) => ({
        value: server.id,
        label: `${server.config$.value.serverName} (${server.baseUrl})`,
      })),
    [servers],
  );

  return (
    <FormSelect
      data={data}
      label={label}
      value={selectedServerId}
      onChange={(serverId) => {
        const server = servers.find(({ id }) => id === serverId);
        if (server) onSelect(server);
      }}
    />
  );
};
