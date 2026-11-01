import { DefaultServerService } from "@myoxus/core/modules/server";
import { canUseLocalWorkspaces } from "@myoxus/core/modules/workspace/local-workspace-capability";
import { ServerFeature } from "@myoxus/graphql";
import { useI18n } from "@myoxus/i18n";
import { ImportIcon, PlusIcon } from "@myoxus/icons/react";
import { useLiveData, useService } from "@myoxus/infra";
import { MenuItem } from "@myoxus/ui-facade";
import type { ReactNode } from "react";

export const WorkspaceMenuAction = ({
  children,
  icon,
  onClick,
  testId,
}: {
  children: ReactNode;
  icon: ReactNode;
  onClick?: () => void;
  testId?: string;
}) => (
  <MenuItem block prefixIcon={icon} onClick={onClick} data-testid={testId}>
    {children}
  </MenuItem>
);

export const AddWorkspace = ({
  onAddWorkspace,
  onNewWorkspace,
}: {
  onAddWorkspace?: () => void;
  onNewWorkspace?: () => void;
}) => {
  const t = useI18n();
  const defaultServerService = useService(DefaultServerService);
  const enableLocalWorkspace = useLiveData(
    defaultServerService.server.config$.selector(
      (c) =>
        canUseLocalWorkspaces() &&
        (c.features.includes(ServerFeature.LocalWorkspace) ||
          BUILD_CONFIG.isNative),
    ),
  );

  return (
    <>
      <WorkspaceMenuAction
        icon={<ImportIcon />}
        onClick={onAddWorkspace}
        testId="add-workspace"
      >
        {t["com.myoxus.cmdk.import-workspace"]()}
      </WorkspaceMenuAction>
      <WorkspaceMenuAction
        icon={<PlusIcon />}
        onClick={onNewWorkspace}
        testId="new-workspace"
      >
        {enableLocalWorkspace
          ? t["com.myoxus.workspaceList.addWorkspace.create"]()
          : t["com.myoxus.workspaceList.addWorkspace.create-cloud"]()}
      </WorkspaceMenuAction>
    </>
  );
};
