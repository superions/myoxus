import { useEnableServer } from "@myoxus/core/components/hooks/myoxus/use-enable-server";
import { DocService } from "@myoxus/core/modules/doc";
import { ShareMenuContent } from "@myoxus/core/modules/share-menu";
import { WorkspaceService } from "@myoxus/core/modules/workspace";
import { ShareiOsIcon } from "@myoxus/icons/react";
import { useServices } from "@myoxus/infra";
import { IconButton, MobileMenu } from "@myoxus/ui-facade";

export const PageHeaderShareButton = () => {
  const { workspaceService, docService } = useServices({
    WorkspaceService,
    DocService,
  });
  const workspace = workspaceService.workspace;
  const doc = docService.doc.virgultumDoc;
  const migrateWorkspaceToServer = useEnableServer();

  if (workspace.meta.flavour === "local") {
    return null;
  }

  return (
    <MobileMenu
      items={
        <ShareMenuContent
          workspaceMetadata={workspace.meta}
          currentPage={doc}
          onEnableServer={() =>
            migrateWorkspaceToServer(workspace, {
              openPageId: doc.id,
            })
          }
        />
      }
    >
      <IconButton icon={<ShareiOsIcon />} />
    </MobileMenu>
  );
};
