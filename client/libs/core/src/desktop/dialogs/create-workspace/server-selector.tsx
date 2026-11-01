import { type Server, ServersService } from "@myoxus/core/modules/server";
import { canUseLocalWorkspaces } from "@myoxus/core/modules/workspace/local-workspace-capability";
import { useI18n } from "@myoxus/i18n";
import { useLiveData, useService } from "@myoxus/infra";
import { FormSelect, type FormSelectProps } from "@myoxus/ui-facade";
import { useMemo } from "react";

export type WorkspaceTargetOption = {
  value: Server["id"];
  label: string;
};

export function buildWorkspaceTargetOptions({
  servers,
  includeLocal,
  localLabel,
}: {
  servers: Server[];
  includeLocal: boolean;
  localLabel: string;
}): WorkspaceTargetOption[] {
  const remoteTargets = servers.map((server) => ({
    value: server.id,
    label: server.config$.value.serverName,
  }));

  return includeLocal
    ? [{ value: "local", label: localLabel }, ...remoteTargets]
    : remoteTargets;
}

export interface ServerSelectorProps extends Omit<
  FormSelectProps,
  "data" | "onChange" | "value"
> {
  selectedId: Server["id"];
  onChange: (id: Server["id"]) => void;
}

export const ServerSelector = ({
  selectedId,
  onChange,
  ...props
}: ServerSelectorProps) => {
  const t = useI18n();

  const serversService = useService(ServersService);
  const servers = useLiveData(serversService.servers$);

  const data = useMemo(
    () =>
      buildWorkspaceTargetOptions({
        servers,
        includeLocal: canUseLocalWorkspaces(),
        localLabel: t["com.myoxus.workspaceList.workspaceListType.local"](),
      }),
    [servers, t],
  );

  return (
    <FormSelect
      data={data}
      data-testid="server-selector-trigger"
      value={selectedId}
      onChange={onChange}
      {...props}
    />
  );
};
