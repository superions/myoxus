import { useEnableServer } from "@myoxus/core/components/hooks/myoxus/use-enable-server";
import { useSignOut } from "@myoxus/core/components/hooks/myoxus/use-sign-out";
import { useAsyncCallback } from "@myoxus/core/components/hooks/myoxus-async-hooks";
import { useNavigateHelper } from "@myoxus/core/components/hooks/use-navigate-helper";
import { GlobalDialogService } from "@myoxus/core/modules/dialogs";
import { GlobalContextService } from "@myoxus/core/modules/global-context";
import {
  type AuthAccountInfo,
  AuthService,
  type Server,
  ServersService,
} from "@myoxus/core/modules/server";
import {
  type WorkspaceMetadata,
  WorkspaceService,
  WorkspacesService,
} from "@myoxus/core/modules/workspace";
import { canUseLocalWorkspaces } from "@myoxus/core/modules/workspace/local-workspace-capability";
import { useI18n } from "@myoxus/i18n";
import {
  AccountIcon,
  CloudWorkspaceIcon,
  DeleteIcon,
  LocalWorkspaceIcon,
  MoreHorizontalIcon,
  SelfhostIcon as StandaloneIcon,
  SignOutIcon,
} from "@myoxus/icons/react";
import {
  FrameworkScope,
  useLiveData,
  useService,
  useServiceOptional,
} from "@myoxus/infra";
import {
  IconButton,
  Menu,
  MenuDetailRow,
  MenuInlineText,
  MenuItem,
  MenuSeparator,
} from "@myoxus/ui-facade";
import { useCallback, useMemo } from "react";

import { PureWorkspaceCard, WorkspaceCard } from "../../workspace-card";
import { AddServer } from "../add-server";

interface WorkspaceModalProps {
  workspaces: WorkspaceMetadata[];
  onClickWorkspace: (workspaceMetadata: WorkspaceMetadata) => void;
  onClickWorkspaceSetting?: (workspaceMetadata: WorkspaceMetadata) => void;
  onClickEnableCloud?: (meta: WorkspaceMetadata) => void;
  onNewWorkspace: () => void;
  onAddWorkspace: () => void;
}

const WorkspaceServerInfo = ({
  server,
  name,
  account,
  accountStatus,
  onDeleteServer,
  onSignOut,
}: {
  server: string;
  name: string;
  account?: AuthAccountInfo | null;
  accountStatus?: "authenticated" | "unauthenticated";
  onDeleteServer?: () => void;
  onSignOut?: () => void;
}) => {
  const t = useI18n();
  const isCloud = server !== "local";
  const isPrimaryServer = server === "myoxus-cloud";
  const Icon = isPrimaryServer
    ? CloudWorkspaceIcon
    : isCloud
      ? StandaloneIcon
      : LocalWorkspaceIcon;

  const menuItems = useMemo(
    () =>
      [
        server !== "myoxus-cloud" && server !== "local" && (
          <MenuItem
            prefixIcon={<DeleteIcon />}
            type="danger"
            key="delete-server"
            onClick={onDeleteServer}
          >
            {t["com.myoxus.server.delete"]()}
          </MenuItem>
        ),
        accountStatus === "authenticated" && (
          <MenuItem
            prefixIcon={<SignOutIcon />}
            key="sign-out"
            onClick={onSignOut}
            type="danger"
          >
            {t["Sign out"]()}
          </MenuItem>
        ),
      ].filter(Boolean),
    [accountStatus, onDeleteServer, onSignOut, server, t],
  );

  const actionMenu = menuItems.length ? (
    <Menu items={menuItems}>
      <IconButton icon={<MoreHorizontalIcon />} />
    </Menu>
  ) : null;

  return (
    <MenuDetailRow
      justify="start"
      right={actionMenu}
      data-myoxus-ui-role="workspace-server-row"
    >
      <MenuInlineText prefixIcon={<Icon />}>{name}</MenuInlineText>
      {isCloud ? (
        <MenuInlineText tone="secondary">
          {account ? account.email : "Not signed in"}
        </MenuInlineText>
      ) : null}
    </MenuDetailRow>
  );
};

const CloudWorkSpaceList = ({
  server,
  workspaces,
  onClickWorkspace,
  onClickEnableCloud,
}: {
  server: Server;
  workspaces: WorkspaceMetadata[];
  onClickWorkspace: (workspaceMetadata: WorkspaceMetadata) => void;
  onClickEnableCloud?: (meta: WorkspaceMetadata) => void;
}) => {
  const t = useI18n();
  const globalContextService = useService(GlobalContextService);
  const globalDialogService = useService(GlobalDialogService);
  const serverName = useLiveData(server.config$.selector((c) => c.serverName));
  const authService = useService(AuthService);
  const serversService = useService(ServersService);
  const workspacesService = useService(WorkspacesService);
  const account = useLiveData(authService.session.account$);
  const accountStatus = useLiveData(authService.session.status$);
  const navigateHelper = useNavigateHelper();

  const currentWorkspaceFlavour = useLiveData(
    globalContextService.globalContext.workspaceFlavour.$,
  );

  const handleDeleteServer = useCallback(() => {
    // The section's `workspaces` contains only this server. Resolve the next
    // workspace from the shared list before removing the current authority.
    const otherWorkspace = workspacesService.list.workspaces$.value.find(
      (workspace) => workspace.flavour !== server.id,
    );
    serversService.removeServer(server.id);

    if (currentWorkspaceFlavour === server.id) {
      if (otherWorkspace) {
        navigateHelper.openPage(otherWorkspace.id, "home");
      } else {
        navigateHelper.jumpToIndex();
      }
    }
  }, [
    currentWorkspaceFlavour,
    navigateHelper,
    server.id,
    serversService,
    workspacesService,
  ]);

  const handleSignOut = useSignOut();

  const handleSignIn = useAsyncCallback(async () => {
    globalDialogService.open("sign-in", {
      server: server.baseUrl,
    });
  }, [globalDialogService, server.baseUrl]);

  return (
    <>
      <WorkspaceServerInfo
        server={server.id}
        name={serverName}
        account={account}
        accountStatus={accountStatus}
        onDeleteServer={handleDeleteServer}
        onSignOut={handleSignOut}
      />
      {accountStatus === "unauthenticated" ? (
        <MenuItem
          key="sign-in"
          prefixIcon={<AccountIcon />}
          onClick={handleSignIn}
        >
          {t["Sign in"]()}
        </MenuItem>
      ) : null}
      <WorkspaceList
        items={workspaces}
        onClick={onClickWorkspace}
        onEnableCloudClick={onClickEnableCloud}
      />
    </>
  );
};

const LocalWorkspaces = ({
  workspaces,
  onClickWorkspace,
  onClickWorkspaceSetting,
  onClickEnableCloud,
}: Omit<WorkspaceModalProps, "onNewWorkspace" | "onAddWorkspace">) => {
  const t = useI18n();
  if (workspaces.length === 0) {
    return null;
  }
  return (
    <>
      <WorkspaceServerInfo
        server="local"
        name={t["com.myoxus.workspaceList.workspaceListType.local"]()}
      />
      <WorkspaceList
        items={workspaces}
        onClick={onClickWorkspace}
        onSettingClick={onClickWorkspaceSetting}
        onEnableCloudClick={onClickEnableCloud}
      />
    </>
  );
};

export const MyoxusWorkspaceList = ({
  onEventEnd,
  onClickWorkspace,
  showEnableCloudButton,
}: {
  onClickWorkspace?: (workspaceMetadata: WorkspaceMetadata) => void;
  onEventEnd?: () => void;
  showEnableCloudButton?: boolean;
}) => {
  const workspacesService = useService(WorkspacesService);
  const workspaces = useLiveData(workspacesService.list.workspaces$);
  const localWorkspacesEnabled = canUseLocalWorkspaces();

  const migrateWorkspaceToServer = useEnableServer();

  const serversService = useService(ServersService);
  const servers = useLiveData(serversService.servers$);
  const primaryServer = useMemo(
    () => servers.find((s) => s.id === "myoxus-cloud"),
    [servers],
  );
  const selfhostServers = useMemo(
    () => servers.filter((s) => s.id !== "myoxus-cloud"),
    [servers],
  );

  const cloudWorkspaces = useMemo(
    () =>
      workspaces.filter(
        ({ flavour }) => flavour !== "local",
      ) as WorkspaceMetadata[],
    [workspaces],
  );

  const localWorkspaces = useMemo(
    () =>
      localWorkspacesEnabled
        ? (workspaces.filter(
            ({ flavour }) => flavour === "local",
          ) as WorkspaceMetadata[])
        : [],
    [localWorkspacesEnabled, workspaces],
  );

  const onClickEnableCloud = useCallback(
    (meta: WorkspaceMetadata) => {
      const { workspace, dispose } = workspacesService.open({ metadata: meta });
      migrateWorkspaceToServer(workspace, {
        onFinished: () => {
          dispose();
        },
      });
    },
    [migrateWorkspaceToServer, workspacesService],
  );

  const handleClickWorkspace = useCallback(
    (workspaceMetadata: WorkspaceMetadata) => {
      onClickWorkspace?.(workspaceMetadata);
      onEventEnd?.();
    },
    [onClickWorkspace, onEventEnd],
  );

  return (
    <>
      {/* Only Browser Web has a built-in location.origin server. Native has
          registered servers only; never dereference a synthetic primary. */}
      {primaryServer ? (
        <FrameworkScope key={primaryServer.id} scope={primaryServer.scope}>
          <CloudWorkSpaceList
            server={primaryServer}
            workspaces={cloudWorkspaces.filter(
              ({ flavour }) => flavour === primaryServer.id,
            )}
            onClickWorkspace={handleClickWorkspace}
          />
        </FrameworkScope>
      ) : null}
      {primaryServer &&
        ((localWorkspacesEnabled && localWorkspaces.length > 0) ||
          selfhostServers.length > 0) && <MenuSeparator />}

      {/* 2. local */}
      {localWorkspacesEnabled ? (
        <LocalWorkspaces
          workspaces={localWorkspaces}
          onClickWorkspace={handleClickWorkspace}
          onClickEnableCloud={
            showEnableCloudButton ? onClickEnableCloud : undefined
          }
        />
      ) : null}
      {localWorkspaces.length > 0 && selfhostServers.length > 0 && (
        <MenuSeparator />
      )}

      {/* 3. selfhost */}
      {selfhostServers.map((server, index) => (
        <FrameworkScope key={server.id} scope={server.scope}>
          <CloudWorkSpaceList
            server={server}
            workspaces={cloudWorkspaces.filter(
              ({ flavour }) => flavour === server.id,
            )}
            onClickWorkspace={handleClickWorkspace}
          />
          {index !== selfhostServers.length - 1 && <MenuSeparator />}
        </FrameworkScope>
      ))}
      <AddServer onEventEnd={onEventEnd} />
      <MenuSeparator />
    </>
  );
};

interface WorkspaceListProps {
  items: WorkspaceMetadata[];
  onClick: (workspace: WorkspaceMetadata) => void;
  onSettingClick?: (workspace: WorkspaceMetadata) => void;
  onEnableCloudClick?: (meta: WorkspaceMetadata) => void;
}

interface SortableWorkspaceItemProps extends Omit<WorkspaceListProps, "items"> {
  workspaceMetadata: WorkspaceMetadata;
}

const SortableWorkspaceItem = ({
  workspaceMetadata,
  onClick,
  onSettingClick,
  onEnableCloudClick,
}: SortableWorkspaceItemProps) => {
  const handleClick = useCallback(() => {
    onClick(workspaceMetadata);
  }, [onClick, workspaceMetadata]);

  const currentWorkspace = useServiceOptional(WorkspaceService)?.workspace;

  // Native navigation keeps the existing pure sidebar card. Registering a
  // server must not also restore the older selector's inline workspace-delete
  // control; lifecycle actions remain in the existing workspace settings.
  if (BUILD_CONFIG.isNative) {
    return (
      <PureWorkspaceCard
        workspaceMetadata={workspaceMetadata}
        onClick={handleClick}
        active={currentWorkspace?.id === workspaceMetadata.id}
        data-testid="workspace-card"
      />
    );
  }

  return (
    <WorkspaceCard
      workspaceMetadata={workspaceMetadata}
      onClick={handleClick}
      avatarSize="xs"
      active={currentWorkspace?.id === workspaceMetadata.id}
      onClickOpenSettings={onSettingClick}
      onClickEnableCloud={onEnableCloudClick}
    />
  );
};

export const WorkspaceList = (props: WorkspaceListProps) => {
  const workspaceList = props.items;

  return workspaceList.map((item) => (
    <SortableWorkspaceItem key={item.id} {...props} workspaceMetadata={item} />
  ));
};
