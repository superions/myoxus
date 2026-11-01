import { useWorkspaceInfo } from "@myoxus/core/components/hooks/use-workspace-info";
import type { WorkspaceMetadata } from "@myoxus/core/modules/workspace";
import { UNTITLED_WORKSPACE_NAME } from "@myoxus/env/constant";
import { DoneIcon } from "@myoxus/icons/react";
import {
  type AvatarProps,
  MyoxusText,
  SidebarIdentitySummary,
  SidebarIdentityText,
  SidebarNavItem,
  Skeleton,
} from "@myoxus/ui-facade";
import { forwardRef, type HTMLAttributes } from "react";

import { WorkspaceAvatar } from "../../workspace-avatar";

const getWorkspaceDisplayName = (name: string | null | undefined) => {
  const trimmedName = name?.trim();
  return trimmedName ? trimmedName : UNTITLED_WORKSPACE_NAME;
};

export const PureWorkspaceCard = forwardRef<
  HTMLElement,
  HTMLAttributes<HTMLElement> & {
    workspaceMetadata: WorkspaceMetadata;
    avatarSize?: AvatarProps["size"];
    disable?: boolean;
    active?: boolean;
  }
>(
  (
    { workspaceMetadata, avatarSize, className, disable, active, ...props },
    ref,
  ) => {
    const dataTestId = props["data-testid" as keyof typeof props];
    const uiRole = props["data-myoxus-ui-role" as keyof typeof props];
    const information = useWorkspaceInfo(workspaceMetadata);

    const workspaceName = getWorkspaceDisplayName(information?.name);

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

    return (
      <SidebarNavItem
        {...props}
        className={className}
        disabled={disable}
        leading={leading}
        actions={
          active ? (
            <DoneIcon
              aria-hidden="true"
              data-myoxus-ui-role="workspace-card-active-icon"
            />
          ) : undefined
        }
        active={active}
        ref={ref}
        type="button"
        data-testid={dataTestId ?? "workspace-card"}
        data-myoxus-ui-role={uiRole ?? "workspace-card"}
      >
        {information ? (
          <SidebarIdentityText data-myoxus-ui-role="workspace-card-text">
            <SidebarIdentitySummary data-myoxus-ui-role="workspace-card-title-row">
              <MyoxusText
                component="span"
                typographySlot="nav"
                truncate
                data-testid="workspace-name"
                data-myoxus-ui-role="workspace-card-title"
              >
                {workspaceName}
              </MyoxusText>
            </SidebarIdentitySummary>
          </SidebarIdentityText>
        ) : (
          <Skeleton width="100%" />
        )}
      </SidebarNavItem>
    );
  },
);

PureWorkspaceCard.displayName = "PureWorkspaceCard";
