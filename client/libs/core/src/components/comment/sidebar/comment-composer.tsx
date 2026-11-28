// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors

import { useGuard } from "@myoxus/core/components/guard";
import type { DocCommentEntity } from "@myoxus/core/modules/comment/entities/doc-comment";
import type { CommentAttachment } from "@myoxus/core/modules/comment/types";
import { AuthService } from "@myoxus/core/modules/server/services/auth";
import { i18nTime, useI18n } from "@myoxus/i18n";
import {
  AddCommentIcon,
  DeleteIcon,
  EditIcon,
  LinkIcon,
  MoreHorizontalIcon,
} from "@myoxus/icons/react";
import { useLiveData, useService } from "@myoxus/infra";
import {
  Avatar,
  Group,
  IconButton,
  Menu,
  MenuItem,
  MyoxusText,
  Stack,
  SurfaceListItem,
} from "@myoxus/ui-facade";
import type { DocSnapshot, Store } from "@virgultum/editor/store";
import { type ReactNode, useCallback, useState } from "react";

import { useAsyncCallback } from "../../hooks/myoxus-async-hooks";
import { CommentEditor, type CommentEditorRef } from "../comment-editor";

export interface CommentActionMenuProps {
  open: boolean;
  onOpenChange: (open: boolean | ((prev: boolean) => boolean)) => void;
  canReply?: boolean;
  canEdit?: boolean;
  canDelete?: boolean;
  canCopyLink?: boolean;
  disabled?: boolean;
  resolved?: boolean;
  onReply?: (event: React.MouseEvent) => void;
  onEdit?: (event: React.MouseEvent) => void;
  onDelete?: (event: React.MouseEvent) => void;
  onCopyLink?: (event: React.MouseEvent) => void;
}

export const CommentActionMenu = ({
  open,
  onOpenChange,
  canReply,
  canEdit,
  canDelete,
  canCopyLink,
  disabled,
  resolved,
  onReply,
  onEdit,
  onDelete,
  onCopyLink,
}: CommentActionMenuProps) => {
  const t = useI18n();

  return (
    <Menu
      noPortal
      rootOptions={{ open, onOpenChange }}
      items={
        <>
          {canReply ? (
            <MenuItem
              onClick={onReply}
              disabled={Boolean(disabled || resolved)}
              prefixIcon={<AddCommentIcon />}
            >
              {t["com.myoxus.comment.reply"]()}
            </MenuItem>
          ) : null}
          {canCopyLink ? (
            <MenuItem
              onClick={onCopyLink}
              disabled={disabled}
              prefixIcon={<LinkIcon />}
            >
              {t["com.myoxus.comment.copy-link"]()}
            </MenuItem>
          ) : null}
          {canEdit ? (
            <MenuItem
              onClick={onEdit}
              disabled={Boolean(disabled || resolved)}
              prefixIcon={<EditIcon />}
            >
              {t["Edit"]()}
            </MenuItem>
          ) : null}
          {canDelete ? (
            <MenuItem
              onClick={onDelete}
              type="danger"
              disabled={disabled}
              prefixIcon={<DeleteIcon />}
            >
              {t["Delete"]()}
            </MenuItem>
          ) : null}
        </>
      }
    >
      <IconButton
        icon={<MoreHorizontalIcon />}
        disabled={disabled}
        tooltip={t["com.myoxus.actions"]()}
        tooltipOptions={{ opened: open ? false : undefined }}
      />
    </Menu>
  );
};

export interface CommentEntryRowProps {
  user: { avatarUrl: string | null; name: string };
  snapshot?: DocSnapshot;
  time?: number;
  actions?: ReactNode;
  context?: ReactNode;
  doc?: Store;
  autoFocus?: boolean;
  onCommit?: () => void;
  onCancel?: () => void;
  attachments?: CommentAttachment[];
  onAttachmentsChange?: (attachments: CommentAttachment[]) => void;
  uploadCommentAttachment?: (id: string, file: File) => Promise<string>;
  editorRefSetter?: (ref: CommentEditorRef | null) => void;
}

export const CommentEntryRow = ({
  user,
  snapshot,
  time,
  actions,
  context,
  doc,
  autoFocus,
  onCommit,
  onCancel,
  attachments,
  onAttachmentsChange,
  uploadCommentAttachment,
  editorRefSetter,
}: CommentEntryRowProps) => {
  if (snapshot) {
    const absoluteTimestamp = time
      ? i18nTime(time, { absolute: { accuracy: "minute" } })
      : undefined;

    return (
      <Stack data-time={time} data-myoxus-ui-role="comment-readonly-row">
        <Group align="center" justify="space-between" wrap="nowrap">
          <Group align="center" miw={0} wrap="nowrap">
            <Avatar url={user.avatarUrl ?? null} name={user.name} size="sm" />
            <MyoxusText truncate typographySlot="nav">
              {user.name}
            </MyoxusText>
            {time ? (
              <MyoxusText
                flexShrink={0}
                title={absoluteTimestamp}
                tone="secondary"
                typographySlot="caption"
              >
                {i18nTime(time, { relative: true })}
              </MyoxusText>
            ) : null}
          </Group>
          {actions}
        </Group>
        {context}
        <CommentEditor
          readonly
          defaultSnapshot={snapshot}
          attachments={attachments}
        />
      </Stack>
    );
  }

  if (!doc) {
    return null;
  }

  return (
    <Group align="flex-start" miw={0} w="100%">
      <Avatar url={user.avatarUrl ?? null} name={user.name} size="sm" />
      <CommentEditor
        ref={editorRefSetter}
        attachments={attachments}
        onAttachmentsChange={onAttachmentsChange}
        doc={doc}
        autoFocus={autoFocus}
        onCommit={onCommit}
        onCancel={onCancel}
        uploadCommentAttachment={uploadCommentAttachment}
      />
    </Group>
  );
};

export const CommentComposer = ({ entity }: { entity: DocCommentEntity }) => {
  const pendingComment = useLiveData(entity.pendingComment$);
  const account = useLiveData(useService(AuthService).session.account$);
  const canCreateComment = useGuard("Doc_Comments_Create", entity.props.docId);
  const [submitting, setSubmitting] = useState(false);

  const handleCommit = useAsyncCallback(async () => {
    if (!pendingComment?.id) return;
    setSubmitting(true);
    try {
      await entity.commitComment(pendingComment.id);
    } finally {
      setSubmitting(false);
    }
  }, [entity, pendingComment]);

  const handleCancel = useCallback(() => {
    if (!pendingComment?.id) return;
    entity.dismissDraftComment();
  }, [entity, pendingComment]);

  if (!pendingComment || !account || !canCreateComment) {
    return null;
  }

  return (
    <SurfaceListItem
      data-pending-comment
      selected
      component="section"
      density="default"
      fullWidth
      layout="column"
      data-myoxus-ui-role="comment-pending-thread-item"
    >
      {pendingComment.preview ? (
        <MyoxusText
          tone="secondary"
          truncate
          typographySlot="body-small"
          data-myoxus-ui-role="comment-pending-preview"
        >
          {pendingComment.preview}
        </MyoxusText>
      ) : null}
      <CommentEntryRow
        user={{ avatarUrl: account.avatar ?? null, name: "" }}
        doc={pendingComment.doc}
        autoFocus
        onCommit={submitting ? undefined : handleCommit}
        onCancel={submitting ? undefined : handleCancel}
        attachments={pendingComment.attachments}
        onAttachmentsChange={(attachments) =>
          entity.updatePendingComment(pendingComment.id, { attachments })
        }
        uploadCommentAttachment={(id, file) =>
          entity.uploadCommentAttachment(id, file, pendingComment)
        }
      />
    </SurfaceListItem>
  );
};
