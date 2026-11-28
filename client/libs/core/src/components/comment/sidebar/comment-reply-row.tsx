// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors

import { useGuard } from "@myoxus/core/components/guard";
import type { DocCommentEntity } from "@myoxus/core/modules/comment/entities/doc-comment";
import type {
  DocComment,
  DocCommentReply,
} from "@myoxus/core/modules/comment/types";
import { AuthService } from "@myoxus/core/modules/server/services/auth";
import { useI18n } from "@myoxus/i18n";
import { useLiveData, useService } from "@myoxus/infra";
import {
  Group,
  MyoxusText,
  Stack,
  SurfaceListAction,
  useConfirmModal,
} from "@myoxus/ui-facade";
import { useCallback, useMemo, useState } from "react";

import { useAsyncCallback } from "../../hooks/myoxus-async-hooks";
import type { CommentEditorRef } from "../comment-editor";
import { CommentActionMenu, CommentEntryRow } from "./comment-composer";

const COLLAPSE_REPLY_THRESHOLD = 4;

export interface CommentReplyRowProps {
  reply: DocCommentReply;
  parentComment: DocComment;
  entity: DocCommentEntity;
  replyEditor: CommentEditorRef | null;
}

export const CommentReplyRow = ({
  reply,
  parentComment,
  entity,
  replyEditor,
}: CommentReplyRowProps) => {
  const t = useI18n();
  const account = useLiveData(useService(AuthService).session.account$);
  const { openConfirmModal } = useConfirmModal();
  const [mutating, setMutating] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);

  const editingDraft = useLiveData(entity.editingDraft$);
  const isEditing =
    editingDraft?.type === "reply" && editingDraft.id === reply.id;
  const editingDoc = isEditing ? editingDraft.doc : undefined;

  const docId = entity.props.docId;
  const canCreateComment = useGuard("Doc_Comments_Create", docId);
  const canDeleteComment = useGuard("Doc_Comments_Delete", docId);

  const handleStartEdit = useAsyncCallback(async () => {
    if (parentComment.resolved || !reply.content) return;
    await entity.startEdit(
      reply.id,
      "reply",
      reply.content.snapshot,
      reply.content.attachments ?? [],
    );
  }, [entity, parentComment.resolved, reply.content, reply.id]);

  const handleCommitEdit = useAsyncCallback(async () => {
    setMutating(true);
    try {
      await entity.commitEditing();
    } finally {
      setMutating(false);
    }
  }, [entity]);

  const handleCancelEdit = useCallback(
    () => entity.dismissDraftEditing(),
    [entity],
  );

  const handleDelete = useAsyncCallback(async () => {
    openConfirmModal({
      title: t["com.myoxus.comment.reply.delete.confirm.title"](),
      description: t["com.myoxus.comment.reply.delete.confirm.description"](),
      confirmText: t["Delete"](),
      cancelText: t["Cancel"](),
      confirmButtonOptions: { variant: "error" },
      onConfirm: async () => {
        setMutating(true);
        try {
          await entity.deleteReply(reply.id);
        } finally {
          setMutating(false);
        }
      },
    });
  }, [entity, openConfirmModal, reply.id, t]);

  const handleReply = useAsyncCallback(async () => {
    if (parentComment.resolved) return;
    await entity.addReply(parentComment.id, reply);
    entity.highlightComment(parentComment.id);
    if (replyEditor) {
      setTimeout(() => replyEditor.focus(), 100);
    }
  }, [entity, parentComment.id, parentComment.resolved, reply, replyEditor]);

  if (!reply.content) {
    return null;
  }

  const isOwnReply = Boolean(account && account.id === reply.user.id);
  const canEdit = isOwnReply && canCreateComment;
  const canDelete =
    (isOwnReply && canCreateComment) || (!isOwnReply && canDeleteComment);

  const actions = (
    <Group
      data-menu-open={menuOpen}
      data-editing={isEditing}
      onClick={(event) => event.stopPropagation()}
      data-myoxus-ui-role="comment-reply-actions"
      wrap="nowrap"
    >
      <CommentActionMenu
        open={menuOpen}
        onOpenChange={setMenuOpen}
        canReply={canCreateComment}
        canEdit={canEdit}
        canDelete={canDelete}
        disabled={mutating}
        resolved={parentComment.resolved}
        onReply={handleReply}
        onEdit={handleStartEdit}
        onDelete={handleDelete}
      />
    </Group>
  );

  return (
    <Stack
      data-reply-id={reply.id}
      component="article"
      data-myoxus-ui-role="comment-reply-item"
    >
      {isEditing && editingDoc ? (
        <CommentEntryRow
          user={{ avatarUrl: account?.avatar ?? null, name: "" }}
          doc={editingDoc}
          autoFocus
          onCommit={mutating ? undefined : handleCommitEdit}
          onCancel={mutating ? undefined : handleCancelEdit}
          attachments={editingDraft.attachments}
          onAttachmentsChange={(attachments) =>
            entity.updateEditingDraft(editingDraft.id, { attachments })
          }
          uploadCommentAttachment={(id, file) =>
            entity.uploadCommentAttachment(id, file, editingDraft)
          }
        />
      ) : (
        <CommentEntryRow
          user={{
            avatarUrl: reply.user.avatarUrl ?? null,
            name: reply.user.name,
          }}
          time={reply.createdAt}
          snapshot={reply.content.snapshot}
          attachments={reply.content.attachments}
          actions={actions}
        />
      )}
    </Stack>
  );
};

export const CommentReplyList = ({
  replies,
  parentComment,
  entity,
  replyEditor,
}: {
  replies: DocCommentReply[];
  parentComment: DocComment;
  entity: DocCommentEntity;
  replyEditor: CommentEditorRef | null;
}) => {
  const t = useI18n();
  const [collapsed, setCollapsed] = useState(
    replies.length > COLLAPSE_REPLY_THRESHOLD,
  );

  const content = useMemo(() => {
    const ordered = replies.toSorted((a, b) => a.createdAt - b.createdAt);
    if (ordered.length === 0) return null;

    if (!collapsed || ordered.length <= COLLAPSE_REPLY_THRESHOLD) {
      return ordered.map((reply) => (
        <CommentReplyRow
          key={reply.id}
          reply={reply}
          parentComment={parentComment}
          entity={entity}
          replyEditor={replyEditor}
        />
      ));
    }

    const firstReply = ordered[0];
    const recentReplies = ordered.slice(-2);

    return (
      <>
        <CommentEntryRow
          user={{
            avatarUrl: firstReply.user.avatarUrl ?? null,
            name: firstReply.user.name,
          }}
          time={firstReply.createdAt}
          snapshot={firstReply.content?.snapshot}
          attachments={firstReply.content?.attachments}
        />
        <SurfaceListAction
          onClick={(event) => {
            event.stopPropagation();
            setCollapsed(false);
          }}
          data-myoxus-ui-role="comment-replies-expand"
        >
          <MyoxusText tone="accent" typographySlot="body-small">
            {t["com.myoxus.comment.reply.show-more"]({
              count: String(ordered.length - COLLAPSE_REPLY_THRESHOLD),
            })}
          </MyoxusText>
        </SurfaceListAction>
        {recentReplies.map((reply) => (
          <CommentReplyRow
            key={reply.id}
            reply={reply}
            parentComment={parentComment}
            entity={entity}
            replyEditor={replyEditor}
          />
        ))}
      </>
    );
  }, [collapsed, entity, parentComment, replies, replyEditor, t]);

  return <Stack data-myoxus-ui-role="comment-reply-list">{content}</Stack>;
};
