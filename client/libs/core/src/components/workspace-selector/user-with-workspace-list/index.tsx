import { GlobalDialogService } from "@myoxus/core/modules/dialogs";
import { AuthService, DefaultServerService } from "@myoxus/core/modules/server";
import { type WorkspaceMetadata } from "@myoxus/core/modules/workspace";
import { canUseLocalWorkspaces } from "@myoxus/core/modules/workspace/local-workspace-capability";
import { ServerFeature } from "@myoxus/graphql";
import { useI18n } from "@myoxus/i18n";
import { useLiveData, useService } from "@myoxus/infra";
import { track } from "@myoxus/track";
import {
  BrandAssetImage,
  MenuItem,
  MenuPanel,
  MenuScrollableSection,
  MenuSection,
  MyoxusText,
  SidebarIdentityText,
} from "@myoxus/ui-facade";
import { type RefObject, useCallback } from "react";

import { AddWorkspace } from "./add-workspace";
import { MyoxusWorkspaceList } from "./workspace-list";

export const SignInItem = () => {
  const globalDialogService = useService(GlobalDialogService);

  const t = useI18n();

  const onClickSignIn = useCallback(() => {
    track.$.navigationPanel.workspaceList.requestSignIn();
    globalDialogService.open("sign-in", {});
  }, [globalDialogService]);

  return (
    <MenuItem
      block
      onClick={onClickSignIn}
      prefixIcon={
        <BrandAssetImage slot="productMark" alt="Myoxus Product Mark" />
      }
      data-testid="cloud-signin-button"
    >
      <SidebarIdentityText data-myoxus-ui-role="workspace-sign-in-text">
        <MyoxusText component="span" typographySlot="nav" truncate>
          {t["com.myoxus.workspace.cloud.auth"]()}
        </MyoxusText>
        <MyoxusText
          component="span"
          typographySlot="body-small"
          tone="secondary"
          truncate
        >
          {t["com.myoxus.workspace.cloud.description"]()}
        </MyoxusText>
      </SidebarIdentityText>
    </MenuItem>
  );
};

interface UserWithWorkspaceListProps {
  returnFocusRef?: RefObject<HTMLElement | null>;
  onEventEnd?: () => void;
  onClickWorkspace?: (workspace: WorkspaceMetadata) => void;
  onCreatedWorkspace?: (payload: {
    metadata: WorkspaceMetadata;
    defaultDocId?: string;
  }) => void;
  showEnableCloudButton?: boolean;
}

export const UserWithWorkspaceList = ({
  returnFocusRef,
  onEventEnd,
  onClickWorkspace,
  onCreatedWorkspace,
  showEnableCloudButton,
}: UserWithWorkspaceListProps) => {
  const globalDialogService = useService(GlobalDialogService);
  const session = useLiveData(useService(AuthService).session.session$);
  const defaultServerService = useService(DefaultServerService);

  const isAuthenticated = session.status === "authenticated";

  const openSignInModal = useCallback(() => {
    globalDialogService.open("sign-in", {});
  }, [globalDialogService]);

  const onNewWorkspace = useCallback(() => {
    const enableLocalWorkspace =
      canUseLocalWorkspaces() &&
      (BUILD_CONFIG.isNative ||
        defaultServerService.server.config$.value.features.includes(
          ServerFeature.LocalWorkspace,
        ));
    if (!isAuthenticated && !enableLocalWorkspace) {
      return openSignInModal();
    }
    track.$.navigationPanel.workspaceList.createWorkspace();
    globalDialogService.open(
      "create-workspace",
      { returnFocusRef },
      (payload) => {
        if (payload) {
          onCreatedWorkspace?.(payload);
        }
      },
    );
    onEventEnd?.();
  }, [
    globalDialogService,
    defaultServerService,
    isAuthenticated,
    onCreatedWorkspace,
    onEventEnd,
    openSignInModal,
    returnFocusRef,
  ]);

  const onAddWorkspace = useCallback(() => {
    track.$.navigationPanel.workspaceList.createWorkspace({
      control: "import",
    });
    globalDialogService.open("import-workspace", undefined, (payload) => {
      if (payload) {
        onCreatedWorkspace?.({ metadata: payload.workspace });
      }
    });
    onEventEnd?.();
  }, [globalDialogService, onCreatedWorkspace, onEventEnd]);

  return (
    <MenuPanel
      panelWidth="comfortable"
      data-myoxus-ui-role="workspace-menu-panel"
    >
      <MenuScrollableSection
        maxHeight="default"
        data-myoxus-ui-role="workspace-menu-scroll"
      >
        <MyoxusWorkspaceList
          onEventEnd={onEventEnd}
          onClickWorkspace={onClickWorkspace}
          showEnableCloudButton={showEnableCloudButton}
        />
      </MenuScrollableSection>
      <MenuSection data-myoxus-ui-role="workspace-menu-footer">
        <AddWorkspace
          onAddWorkspace={onAddWorkspace}
          onNewWorkspace={onNewWorkspace}
        />
      </MenuSection>
    </MenuPanel>
  );
};
