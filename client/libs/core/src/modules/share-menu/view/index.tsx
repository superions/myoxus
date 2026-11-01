import { useEnableServer } from "@myoxus/core/components/hooks/myoxus/use-enable-server";
import type { Workspace } from "@myoxus/core/modules/workspace";
import { track } from "@myoxus/track";
import type { Store } from "@virgultum/editor/store";
import { useCallback } from "react";

import { ShareMenu } from "./share-menu";
export { CloudSvg } from "./cloud-svg";
export { ShareMenuContent } from "./share-menu";

type SharePageModalProps = {
  workspace: Workspace;
  page: Store;
};

export const SharePageButton = ({ workspace, page }: SharePageModalProps) => {
  const migrateWorkspaceToServer = useEnableServer();
  const handleOpenShareModal = useCallback((open: boolean) => {
    if (open) {
      track.$.sharePanel.$.open();
    }
  }, []);

  return (
    <ShareMenu
      workspaceMetadata={workspace.meta}
      currentPage={page}
      onEnableServer={() =>
        migrateWorkspaceToServer(workspace, {
          openPageId: page.id,
        })
      }
      onOpenShareModal={handleOpenShareModal}
    />
  );
};
