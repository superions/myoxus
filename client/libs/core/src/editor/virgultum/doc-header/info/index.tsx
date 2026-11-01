import { WorkspaceDialogService } from "@myoxus/core/modules/dialogs";
import { useI18n } from "@myoxus/i18n";
import { InformationIcon } from "@myoxus/icons/react";
import { useService } from "@myoxus/infra";
import { track } from "@myoxus/track";
import { IconButton } from "@myoxus/ui-facade";
import { useCallback } from "react";

export const InfoButton = ({ docId }: { docId: string }) => {
  const workspaceDialogService = useService(WorkspaceDialogService);
  const t = useI18n();

  const onOpenInfoModal = useCallback(() => {
    track.$.header.actions.openDocInfo();
    workspaceDialogService.open("doc-info", { docId });
  }, [docId, workspaceDialogService]);

  return (
    <IconButton
      tooltip={t["com.myoxus.page-properties.page-info.view"]()}
      data-testid="header-info-button"
      onClick={onOpenInfoModal}
    >
      <InformationIcon size="calc(var(--mantine-spacing-lg) + var(--mantine-spacing-xs))" />
    </IconButton>
  );
};
