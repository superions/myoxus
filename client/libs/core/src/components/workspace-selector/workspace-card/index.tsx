import { useSystemOnline } from "@myoxus/core/components/hooks/use-system-online";
import { useWorkspace } from "@myoxus/core/components/hooks/use-workspace";
import { useWorkspaceInfo } from "@myoxus/core/components/hooks/use-workspace-info";
import {
  type WorkspaceMetadata,
  type WorkspaceProfileInfo,
  WorkspacesService,
} from "@myoxus/core/modules/workspace";
import { UNTITLED_WORKSPACE_NAME } from "@myoxus/env/constant";
import { useI18n } from "@myoxus/i18n";
import {
  ArrowDownSmallIcon,
  CloudWorkspaceIcon,
  CollaborationIcon,
  DeleteIcon,
  DoneIcon,
  InformationFillDuotoneIcon,
  LocalWorkspaceIcon,
  NoNetworkIcon,
  SettingsIcon,
  UnsyncIcon,
} from "@myoxus/icons/react";
import { LiveData, useLiveData, useService } from "@myoxus/infra";
import {
  type AvatarProps,
  Badge,
  Group,
  IconButton,
  Loading,
  MenuInlineText,
  MyoxusText,
  notify,
  SidebarIdentitySummary,
  SidebarIdentityText,
  SidebarNavItem,
  Skeleton,
  Tooltip,
} from "@myoxus/ui-facade";
import {
  forwardRef,
  type HTMLAttributes,
  type ReactNode,
  useMemo,
} from "react";

import { useCatchEventCallback } from "../../hooks/use-catch-event-hook";
import { useNavigateHelper } from "../../hooks/use-navigate-helper";
import { WorkspaceAvatar } from "../../workspace-avatar";
export { PureWorkspaceCard } from "./pure-workspace-card";

const getWorkspaceDisplayName = (name: string | null | undefined) => {
  const trimmedName = name?.trim();
  return trimmedName ? trimmedName : UNTITLED_WORKSPACE_NAME;
};

/** Server-owned workspace classification, hidden only for Personal userspaces. */
const WorkspaceTypeBadge = ({
  type,
}: {
  type: "Personal" | "UserOwned" | "Shared" | undefined;
}) => {
  const t = useI18n();
  if (!type || type === "Personal") return null;
  const label =
    type === "UserOwned"
      ? t["com.myoxus.workspace.type.user-owned"]()
      : t["com.myoxus.workspace.type.shared"]();
  return (
    <Badge
      tone={type === "Shared" ? "info" : "neutral"}
      data-workspace-type={type}
      data-myoxus-ui-role="workspace-card-type-badge"
    >
      {label}
    </Badge>
  );
};

const WorkspaceStatusLine = ({
  icon,
  children,
  tone = "secondary",
}: {
  icon: ReactNode;
  children: ReactNode;
  tone?: "primary" | "secondary" | "disabled";
}) => {
  return (
    <MenuInlineText
      prefixIcon={icon}
      tone={tone}
      data-myoxus-ui-role="workspace-card-status"
    >
      {children}
    </MenuInlineText>
  );
};

const CloudWorkspaceStatus = () => {
  return (
    <WorkspaceStatusLine icon={<CloudWorkspaceIcon />}>
      Cloud
    </WorkspaceStatusLine>
  );
};

const SyncingWorkspaceStatus = () => {
  const t = useI18n();

  return (
    <WorkspaceStatusLine icon={<Loading />}>
      {t["com.myoxus.syncing"]()}
    </WorkspaceStatusLine>
  );
};

const UnSyncWorkspaceStatus = () => {
  return (
    <WorkspaceStatusLine icon={<UnsyncIcon />}>
      Wait for upload
    </WorkspaceStatusLine>
  );
};

const LocalWorkspaceStatus = () => {
  return (
    <WorkspaceStatusLine
      icon={
        !BUILD_CONFIG.isElectron ? (
          <InformationFillDuotoneIcon />
        ) : (
          <LocalWorkspaceIcon />
        )
      }
    >
      Local
    </WorkspaceStatusLine>
  );
};

const OfflineStatus = () => {
  return (
    <WorkspaceStatusLine icon={<NoNetworkIcon />}>Offline</WorkspaceStatusLine>
  );
};

const useSyncEngineSyncProgress = (meta: WorkspaceMetadata) => {
  const isOnline = useSystemOnline();
  const workspace = useWorkspace(meta);

  const engineState = useLiveData(
    useMemo(() => {
      return workspace
        ? LiveData.from(workspace.engine.doc.state$, null)
        : null;
    }, [workspace]),
  );

  if (!engineState || !workspace) {
    return null;
  }

  const progress =
    (engineState.total - engineState.syncing) / engineState.total;
  const syncing = engineState.syncing > 0 || engineState.syncRetrying;

  let content;
  // TODO(@eyhn): add i18n
  if (workspace.flavour === "local") {
    if (!BUILD_CONFIG.isElectron) {
      content = "This is a local demo workspace.";
    } else {
      content = "Saved locally";
    }
  } else if (!isOnline) {
    content = "Disconnected, please check your network connection";
  } else if (engineState.syncRetrying && engineState.syncErrorMessage) {
    content = `${engineState.syncErrorMessage}, reconnecting.`;
  } else if (engineState.syncRetrying) {
    content = "Sync disconnected due to unexpected issues, reconnecting.";
  } else if (syncing) {
    content =
      `Syncing with Myoxus Cloud` +
      (progress ? ` (${Math.floor(progress * 100)}%)` : "");
  } else {
    content = "Synced with Myoxus Cloud";
  }

  const CloudWorkspaceSyncStatus = () => {
    if (syncing) {
      return SyncingWorkspaceStatus();
    } else if (engineState.syncRetrying) {
      return UnSyncWorkspaceStatus();
    } else {
      return CloudWorkspaceStatus();
    }
  };

  return {
    message: content,
    icon:
      workspace.flavour !== "local" ? (
        !isOnline ? (
          <OfflineStatus />
        ) : (
          <CloudWorkspaceSyncStatus />
        )
      ) : (
        <LocalWorkspaceStatus />
      ),
    progress,
    active:
      workspace.flavour !== "local" &&
      ((syncing && progress !== undefined) || engineState.syncRetrying), // active if syncing or retrying,
  };
};

const WorkspaceSyncInfo = ({
  workspaceMetadata,
  workspaceProfile,
  dense,
}: {
  workspaceMetadata: WorkspaceMetadata;
  workspaceProfile: WorkspaceProfileInfo;
  dense?: boolean;
}) => {
  const syncStatus = useSyncEngineSyncProgress(workspaceMetadata);
  const isCloud = workspaceMetadata.flavour !== "local";

  if (!workspaceProfile) {
    return null;
  }

  const steadyStatus = isCloud ? (
    <CloudWorkspaceStatus />
  ) : (
    <LocalWorkspaceStatus />
  );
  const status = syncStatus?.active ? (
    <Tooltip content={syncStatus.message}>{syncStatus.icon}</Tooltip>
  ) : (
    steadyStatus
  );

  return (
    <WorkspaceCardText
      name={getWorkspaceDisplayName(workspaceProfile.name)}
      status={dense ? null : status}
    />
  );
};

const WorkspaceCardText = ({
  name,
  badge,
  status,
}: {
  name: ReactNode;
  badge?: ReactNode;
  status?: ReactNode;
}) => {
  return (
    <SidebarIdentityText data-myoxus-ui-role="workspace-card-text">
      <SidebarIdentitySummary data-myoxus-ui-role="workspace-card-title-row">
        <MyoxusText
          component="span"
          typographySlot="nav"
          truncate
          data-testid="workspace-name"
          data-myoxus-ui-role="workspace-card-title"
        >
          {name}
        </MyoxusText>
        {badge}
      </SidebarIdentitySummary>
      {status}
    </SidebarIdentityText>
  );
};

export const WorkspaceCard = forwardRef<
  HTMLElement,
  HTMLAttributes<HTMLElement> & {
    workspaceMetadata: WorkspaceMetadata;
    showSyncStatus?: boolean;
    showArrowDownIcon?: boolean;
    avatarSize?: AvatarProps["size"];
    disable?: boolean;
    hideCollaborationIcon?: boolean;
    active?: boolean;
    infoClassName?: string;
    dense?: boolean;
    onClickOpenSettings?: (workspaceMetadata: WorkspaceMetadata) => void;
    onClickEnableCloud?: (workspaceMetadata: WorkspaceMetadata) => void;
  }
>(
  (
    {
      workspaceMetadata,
      showSyncStatus,
      showArrowDownIcon,
      onClickOpenSettings,
      onClickEnableCloud,
      className,
      infoClassName: _infoClassName,
      disable,
      hideCollaborationIcon,
      active,
      dense,
      avatarSize = dense ? "xs" : "sm",
      ...props
    },
    ref,
  ) => {
    const dataTestId = props["data-testid" as keyof typeof props];
    const uiRole = props["data-myoxus-ui-role" as keyof typeof props];
    const t = useI18n();
    const information = useWorkspaceInfo(workspaceMetadata);
    const workspacesService = useService(WorkspacesService);
    const navigate = useNavigateHelper();

    const workspaceName = getWorkspaceDisplayName(information?.name);

    const onEnableCloud = useCatchEventCallback(() => {
      onClickEnableCloud?.(workspaceMetadata);
    }, [onClickEnableCloud, workspaceMetadata]);

    const onRemoveWorkspace = useCatchEventCallback(async () => {
      await workspacesService
        .deleteWorkspace(workspaceMetadata)
        .then(() => {
          notify.success({ title: t["Successfully removed workspace"]() });
          navigate.jumpToIndex();
        })
        .catch(() => {
          notify.error({ title: t["Failed to remove workspace"]() });
        });
    }, [workspacesService, workspaceMetadata, t, navigate]);

    const onOpenSettings = useCatchEventCallback(() => {
      onClickOpenSettings?.(workspaceMetadata);
    }, [onClickOpenSettings, workspaceMetadata]);

    const leading = information ? (
      <WorkspaceAvatar
        meta={workspaceMetadata}
        data-testid="workspace-avatar"
        size={avatarSize}
        name={workspaceName}
        colorfulFallback
      />
    ) : (
      <Skeleton width={avatarSize} height={avatarSize} />
    );

    const label = information ? (
      showSyncStatus ? (
        <WorkspaceSyncInfo
          workspaceProfile={information}
          workspaceMetadata={workspaceMetadata}
          dense={dense}
        />
      ) : (
        <WorkspaceCardText
          name={workspaceName}
          badge={<WorkspaceTypeBadge type={information.workspaceType} />}
        />
      )
    ) : (
      <Skeleton width="100%" />
    );

    const hasInteractiveActions = Boolean(
      (information?.isEmpty && information.isOwner) ||
      (onClickEnableCloud && workspaceMetadata.flavour === "local") ||
      onClickOpenSettings,
    );
    const hasPassiveActions = Boolean(
      (!hideCollaborationIcon && !information?.isOwner) ||
      active ||
      showArrowDownIcon,
    );
    const actions =
      hasInteractiveActions || hasPassiveActions ? (
        <Group gap="sm" justify="flex-end">
          {information?.isEmpty && information.isOwner ? (
            <IconButton
              icon={<DeleteIcon />}
              onClick={onRemoveWorkspace}
              tooltip="Remove"
              variant="danger"
              data-myoxus-ui-role="button:workspace-remove"
            />
          ) : null}
          {onClickEnableCloud && workspaceMetadata.flavour === "local" ? (
            <IconButton
              icon={<CloudWorkspaceIcon />}
              onClick={onEnableCloud}
              tooltip="Enable Cloud"
              data-myoxus-ui-role="button:workspace-enable-cloud"
            />
          ) : null}
          {onClickOpenSettings ? (
            <IconButton
              icon={<SettingsIcon />}
              onClick={onOpenSettings}
              tooltip={t["com.myoxus.settings.workspace"]()}
              data-myoxus-ui-role="button:workspace-settings"
            />
          ) : null}
          {hideCollaborationIcon || information?.isOwner ? null : (
            <Tooltip
              content={t["com.myoxus.settings.workspace.state.joined"]()}
            >
              <CollaborationIcon aria-hidden="true" />
            </Tooltip>
          )}
          {active ? (
            <DoneIcon
              aria-hidden="true"
              data-myoxus-ui-role="workspace-card-active-icon"
            />
          ) : null}
          {showArrowDownIcon ? <ArrowDownSmallIcon aria-hidden="true" /> : null}
        </Group>
      ) : undefined;

    return (
      <SidebarNavItem
        {...props}
        ref={ref}
        type="button"
        className={className}
        disabled={disable}
        active={active}
        leading={leading}
        actions={actions}
        actionsInteractive={hasInteractiveActions}
        data-testid={dataTestId ?? "workspace-card"}
        data-myoxus-ui-role={uiRole ?? "workspace-card"}
      >
        {label}
      </SidebarNavItem>
    );
  },
);

WorkspaceCard.displayName = "WorkspaceCard";
