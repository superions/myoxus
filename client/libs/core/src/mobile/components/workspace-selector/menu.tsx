import { useNavigateHelper } from "@myoxus/core/components/hooks/use-navigate-helper";
import { MyoxusWorkspaceList } from "@myoxus/core/components/workspace-selector/user-with-workspace-list/workspace-list";
import {
  type WorkspaceMetadata,
  WorkspaceService,
} from "@myoxus/core/modules/workspace";
import { CloseIcon } from "@myoxus/icons/react";
import { useServiceOptional } from "@myoxus/infra";
import {
  Group,
  IconButton,
  MenuPanel,
  MenuScrollableSection,
  MenuSection,
  MenuSeparator,
  MyoxusText,
} from "@myoxus/ui-facade";
import { useCallback } from "react";

export const SelectorMenu = ({ onClose }: { onClose?: () => void }) => {
  const currentWorkspace = useServiceOptional(WorkspaceService)?.workspace;
  const { jumpToPage } = useNavigateHelper();

  const handleClickWorkspace = useCallback(
    (workspaceMetadata: WorkspaceMetadata) => {
      if (workspaceMetadata.id !== currentWorkspace?.id) {
        jumpToPage(workspaceMetadata.id, "home");
      }
    },
    [currentWorkspace?.id, jumpToPage],
  );

  return (
    <MenuPanel
      panelPadding="comfortable"
      panelWidth="comfortable"
      data-myoxus-ui-role="mobile-workspace-selector-menu"
    >
      <MenuSection data-myoxus-ui-role="mobile-workspace-selector-header-section">
        <Group
          component="header"
          justify="space-between"
          wrap="nowrap"
          data-myoxus-ui-role="mobile-workspace-selector-header"
        >
          <MyoxusText
            component="span"
            typographySlot="nav"
            data-myoxus-ui-role="mobile-workspace-selector-title"
          >
            Workspace
          </MyoxusText>
          <IconButton
            aria-label="Close workspace selector"
            icon={<CloseIcon />}
            onClick={onClose}
            size="default"
            variant="plain"
            data-myoxus-ui-role="button:mobile-workspace-selector-close"
          />
        </Group>
      </MenuSection>
      <MenuSeparator />
      <MenuScrollableSection
        maxHeight="default"
        data-myoxus-ui-role="mobile-workspace-selector-scroll"
      >
        <MyoxusWorkspaceList
          onClickWorkspace={handleClickWorkspace}
          onEventEnd={onClose}
        />
      </MenuScrollableSection>
    </MenuPanel>
  );
};
