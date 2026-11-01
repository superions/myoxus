import { useWorkspaceInfo } from "@myoxus/core/components/hooks/use-workspace-info";
import { WorkspaceAvatar } from "@myoxus/core/components/workspace-avatar";
import { WorkspaceService } from "@myoxus/core/modules/workspace";
import { UNTITLED_WORKSPACE_NAME } from "@myoxus/env/constant";
import { ArrowDownSmallIcon } from "@myoxus/icons/react";
import { useServiceOptional } from "@myoxus/infra";
import {
  Avatar,
  MyoxusText,
  SidebarIdentitySummary,
  SidebarIdentityText,
  SidebarNavItem,
} from "@myoxus/ui-facade";
import { forwardRef, type HTMLAttributes } from "react";

export interface CurrentWorkspaceCardProps extends HTMLAttributes<HTMLElement> {}

export const CurrentWorkspaceCard = forwardRef<
  HTMLElement,
  CurrentWorkspaceCardProps
>(function CurrentWorkspaceCard({ onClick, className, ...attrs }, ref) {
  const currentWorkspace = useServiceOptional(WorkspaceService)?.workspace;
  const info = useWorkspaceInfo(currentWorkspace?.meta);
  const name = info?.name?.trim() || UNTITLED_WORKSPACE_NAME;
  const leading = currentWorkspace ? (
    <WorkspaceAvatar
      key={currentWorkspace.id}
      meta={currentWorkspace.meta}
      data-testid="workspace-avatar"
      name={name}
      size="sm"
      colorfulFallback
    />
  ) : (
    <Avatar kind="workspace" name={name} size="sm" colorfulFallback />
  );

  return (
    <SidebarNavItem
      {...attrs}
      ref={ref}
      className={className}
      leading={leading}
      actions={
        <ArrowDownSmallIcon
          aria-hidden="true"
          data-myoxus-ui-role="mobile-workspace-trigger-disclosure"
        />
      }
      onClick={onClick}
      type="button"
      data-myoxus-ui-role="mobile-workspace-trigger"
    >
      <SidebarIdentityText data-myoxus-ui-role="mobile-workspace-trigger-text">
        <SidebarIdentitySummary data-myoxus-ui-role="mobile-workspace-trigger-title-row">
          <MyoxusText
            component="span"
            typographySlot="nav"
            truncate
            data-myoxus-ui-role="mobile-workspace-trigger-title"
          >
            {name}
          </MyoxusText>
        </SidebarIdentitySummary>
      </SidebarIdentityText>
    </SidebarNavItem>
  );
});
