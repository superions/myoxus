import { useSharingUrl } from "@myoxus/core/components/hooks/myoxus/use-share-url";
import { WorkspaceDialogService } from "@myoxus/core/modules/dialogs";
import { WorkspaceService } from "@myoxus/core/modules/workspace";
import { useI18n } from "@myoxus/i18n";
import { InformationIcon, LinkIcon } from "@myoxus/icons/react";
import { useService } from "@myoxus/infra";
import { IconButton } from "@myoxus/ui-facade";
import { type DocMode } from "@virgultum/editor/model";
import { useCallback } from "react";

export const DocInfoButton = ({
  docId,
  trackFn,
  "data-testid": dataTestId,
}: {
  docId: string;
  trackFn?: () => void;
  "data-testid"?: string;
}) => {
  const t = useI18n();
  const workspaceDialogService = useService(WorkspaceDialogService);

  const onClick = useCallback(() => {
    trackFn?.();
    workspaceDialogService.open("doc-info", { docId });
  }, [docId, trackFn, workspaceDialogService]);

  return (
    <IconButton
      tooltip={t["com.myoxus.page-properties.page-info.view"]()}
      data-testid={dataTestId}
      onClick={onClick}
    >
      <InformationIcon />
    </IconButton>
  );
};

export const CopyLinkButton = ({
  pageId,
  blockId,
  mode,
  trackFn,
  "data-testid": dataTestId,
}: {
  pageId: string;
  blockId?: string;
  mode?: DocMode;
  trackFn?: () => void;
  "data-testid"?: string;
}) => {
  const t = useI18n();
  const workspace = useService(WorkspaceService).workspace;

  const { onClickCopyLink } = useSharingUrl({
    workspaceId: workspace.id,
    pageId,
  });

  const copyLink = useCallback(() => {
    trackFn?.();
    onClickCopyLink(mode, blockId ? [blockId] : undefined);
  }, [blockId, mode, onClickCopyLink, trackFn]);

  return (
    <IconButton
      tooltip={t["com.myoxus.share-menu.copy"]()}
      data-testid={dataTestId}
      onClick={copyLink}
    >
      <LinkIcon />
    </IconButton>
  );
};
