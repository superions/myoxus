import { useI18n } from "@myoxus/i18n";
import { CloseIcon, WarningIcon } from "@myoxus/icons/react";
import {
  IconButton,
  Loading,
  Pagination,
  Stack,
  SurfaceList,
  SurfaceListItem,
  SurfaceListItemIcon,
  SurfaceListText,
  Tooltip,
  useConfirmModal,
} from "@myoxus/ui-facade";
import { getAttachmentFileIconRC } from "@virgultum/editor/components/icons";
import { useCallback } from "react";

import { COUNT_PER_PAGE } from "../constants";
import type {
  AttachmentFile,
  ErrorAttachmentFile,
  PersistedAttachmentFile,
  UploadingAttachmentFile,
} from "../types";
import {
  getAttachmentId,
  isErrorAttachment,
  isPersistedAttachment,
  isUploadingAttachment,
} from "../utils";

interface AttachmentsProps {
  attachments: AttachmentFile[];
  totalCount: number;
  onPageChange: (offset: number) => void;
  onDelete: (id: string) => void;
  disabled: boolean;
}

interface AttachmentItemProps {
  attachment: AttachmentFile;
  onDelete: (id: string) => void;
  disabled: boolean;
}

const UploadingItem: React.FC<{ attachment: UploadingAttachmentFile }> = ({
  attachment,
}) => {
  return (
    <>
      <SurfaceListItemIcon
        size="sm"
        tone="secondary"
        data-myoxus-ui-role="workspace-embedding-attachment-uploading-icon"
      >
        <Loading />
      </SurfaceListItemIcon>
      <SurfaceListText
        kind="title"
        data-testid="workspace-embedding-setting-attachment-uploading-item"
      >
        {attachment.fileName}
      </SurfaceListText>
    </>
  );
};

const ErrorItem: React.FC<{ attachment: ErrorAttachmentFile }> = ({
  attachment,
}) => {
  return (
    <>
      <SurfaceListItemIcon
        size="sm"
        tone="danger"
        data-myoxus-ui-role="workspace-embedding-attachment-error-icon"
      >
        <WarningIcon />
      </SurfaceListItemIcon>
      <Tooltip content={attachment.errorMessage}>
        <SurfaceListText
          kind="title"
          tone="danger"
          data-testid="workspace-embedding-setting-attachment-error-item"
        >
          {attachment.fileName}
        </SurfaceListText>
      </Tooltip>
    </>
  );
};

const PersistedItem: React.FC<{ attachment: PersistedAttachmentFile }> = ({
  attachment,
}) => {
  const Icon = getAttachmentFileIconRC(attachment.mimeType);
  return (
    <>
      <SurfaceListItemIcon
        size="sm"
        data-myoxus-ui-role="workspace-embedding-attachment-file-icon"
      >
        <Icon />
      </SurfaceListItemIcon>
      <SurfaceListText
        kind="title"
        data-testid="workspace-embedding-setting-attachment-persisted-item"
      >
        {attachment.fileName}
      </SurfaceListText>
    </>
  );
};

const AttachmentItem: React.FC<AttachmentItemProps> = ({
  attachment,
  onDelete,
  disabled,
}) => {
  const t = useI18n();
  const { openConfirmModal } = useConfirmModal();

  const handleDelete = useCallback(() => {
    if (isErrorAttachment(attachment)) {
      onDelete(getAttachmentId(attachment));
      return;
    }

    openConfirmModal({
      title:
        t[
          "com.myoxus.settings.workspace.indexer-embedding.embedding.additional-attachments.remove-attachment.title"
        ](),
      description:
        t[
          "com.myoxus.settings.workspace.indexer-embedding.embedding.additional-attachments.remove-attachment.description"
        ](),
      confirmText: t["Confirm"](),
      confirmButtonOptions: {
        variant: "error",
      },
      onConfirm: () => {
        onDelete(getAttachmentId(attachment));
      },
    });
  }, [onDelete, attachment, openConfirmModal, t]);

  return (
    <SurfaceListItem
      alignItems="center"
      data-state={isErrorAttachment(attachment) ? "error" : undefined}
      data-testid="workspace-embedding-setting-attachment-item"
      density="compact"
      fullWidth
      layout="row"
      tone={isErrorAttachment(attachment) ? "danger" : "default"}
    >
      {isUploadingAttachment(attachment) ? (
        <UploadingItem attachment={attachment} />
      ) : isErrorAttachment(attachment) ? (
        <ErrorItem attachment={attachment} />
      ) : isPersistedAttachment(attachment) ? (
        <PersistedItem attachment={attachment} />
      ) : null}
      {!disabled && (
        <IconButton
          data-testid="workspace-embedding-setting-attachment-delete-button"
          icon={<CloseIcon />}
          onClick={handleDelete}
          tooltip={t[
            "com.myoxus.settings.workspace.indexer-embedding.embedding.additional-attachments.remove-attachment.tooltip"
          ]()}
          variant={isErrorAttachment(attachment) ? "danger" : "plain"}
        />
      )}
    </SurfaceListItem>
  );
};

export const Attachments: React.FC<AttachmentsProps> = ({
  attachments,
  totalCount,
  onDelete,
  onPageChange,
  disabled,
}) => {
  const t = useI18n();

  const handlePageChange = useCallback(
    (offset: number) => {
      onPageChange(offset);
    },
    [onPageChange],
  );

  return (
    <Stack
      data-testid="workspace-embedding-setting-attachment-list"
      data-myoxus-ui-role="workspace-embedding-attachment-list"
      gap="sm"
    >
      <SurfaceList
        data-testid="workspace-embedding-setting-attachment-surface-list"
        label={t[
          "com.myoxus.settings.workspace.indexer-embedding.embedding.additional-attachments.title"
        ]()}
      >
        {attachments.map((attachment) => (
          <AttachmentItem
            key={getAttachmentId(attachment)}
            attachment={attachment}
            onDelete={onDelete}
            disabled={disabled}
          />
        ))}
      </SurfaceList>
      <Pagination
        totalCount={totalCount}
        countPerPage={COUNT_PER_PAGE}
        onPageChange={handlePageChange}
      />
    </Stack>
  );
};
