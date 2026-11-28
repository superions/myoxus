// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors

import { useGuard } from "@myoxus/core/components/guard";
import type { DocCommentEntity } from "@myoxus/core/modules/comment/entities/doc-comment";
import type { DocComment } from "@myoxus/core/modules/comment/types";
import { toDocSearchParams } from "@myoxus/core/modules/navigation";
import { ServerService } from "@myoxus/core/modules/server";
import { AuthService } from "@myoxus/core/modules/server/services/auth";
import { WorkbenchService } from "@myoxus/core/modules/workbench";
import { copyTextToClipboard } from "@myoxus/core/utils/clipboard";
import { useI18n } from "@myoxus/i18n";
import { DoneIcon } from "@myoxus/icons/react";
import { useLiveData, useService } from "@myoxus/infra";
import {
  Group,
  IconButton,
  MyoxusText,
  notify,
  Stack,
  SurfaceListItem,
  useConfirmModal,
} from "@myoxus/ui-facade";
import { useCallback, useEffect, useRef, useState } from "react";
import { debounceTime, distinctUntilChanged } from "rxjs/operators";

import { useAsyncCallback } from "../../hooks/myoxus-async-hooks";
import type { CommentEditorRef } from "../comment-editor";
import { CommentActionMenu, CommentEntryRow } from "./comment-composer";
import { CommentReplyList } from "./comment-reply-row";

export const CommentThreadCard = ({
  comment,
  entity,
}: {
  comment: DocComment;
  entity: DocCommentEntity;
}) => {
  const t = useI18n();
  const workbench = useService(WorkbenchService);
  const serverService = useService(ServerService);
  const account = useLiveData(useService(AuthService).session.account$);
  const { openConfirmModal } = useConfirmModal();

  const highlighting = useLiveData(entity.commentHighlighted$) === comment.id;
  const pendingReply = useLiveData(entity.pendingReply$);
  const isReplyingHere = pendingReply?.commentId === comment.id;
  const editingDraft = useLiveData(entity.editingDraft$);
  const isEditing =
    editingDraft?.type === "comment" && editingDraft.id === comment.id;
  const editingDoc = isEditing ? editingDraft.doc : undefined;

  const docId = entity.props.docId;
  const canCreateComment = useGuard("Doc_Comments_Create", docId);
  const canDeleteComment = useGuard("Doc_Comments_Delete", docId);
  const canResolveComment = useGuard("Doc_Comments_Resolve", docId);

  const cardRef = useRef<HTMLDivElement>(null);
  const [mutating, setMutating] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [replyEditor, setReplyEditor] = useState<CommentEditorRef | null>(null);

  useEffect(() => {
    const subscription = entity.commentHighlighted$
      .pipe(debounceTime(0), distinctUntilChanged())
      .subscribe((activeId) => {
        if (activeId === comment.id && cardRef.current) {
          if (!isReplyingHere && !comment.resolved) {
            entity.addReply(comment.id).catch((error) => {
              console.error("Failed to open reply draft:", comment.id, error);
            });
          }
        } else if (activeId !== comment.id && isReplyingHere && pendingReply) {
          entity.dismissDraftReply();
        }
      });

    return () => subscription.unsubscribe();
  }, [comment.id, comment.resolved, entity, isReplyingHere, pendingReply]);

  useEffect(() => {
    if (comment.resolved && isReplyingHere && pendingReply) {
      entity.dismissDraftReply();
    }
  }, [comment.resolved, entity, isReplyingHere, pendingReply]);

  const handleSelectThread = useCallback(() => {
    workbench.workbench.openDoc(
      {
        docId: entity.props.docId,
        mode: comment.content?.mode,
        commentId: comment.id,
        refreshKey: `comment-${Date.now()}`,
      },
      { replaceHistory: true },
    );
    entity.highlightComment(comment.id);
  }, [comment.content?.mode, comment.id, entity, workbench.workbench]);

  const handleResolveToggle = useAsyncCallback(
    async (event: React.MouseEvent) => {
      event.stopPropagation();
      setMutating(true);
      try {
        await entity.resolveComment(comment.id, !comment.resolved);
      } finally {
        setMutating(false);
      }
    },
    [comment.id, comment.resolved, entity],
  );

  const handleReply = useAsyncCallback(async () => {
    if (comment.resolved) return;
    await entity.addReply(comment.id);
    entity.highlightComment(comment.id);
    if (replyEditor) {
      setTimeout(() => replyEditor.focus(), 100);
    }
  }, [comment.id, comment.resolved, entity, replyEditor]);

  const handleCopyLink = useAsyncCallback(
    async (event: React.MouseEvent) => {
      event.stopPropagation();
      if (!comment.content) return;

      const search = toDocSearchParams({
        mode: comment.content.mode,
        commentId: comment.id,
      });
      const url = new URL(
        `${workbench.workbench.basename$.value}/${entity.props.docId}`,
        serverService.server.baseUrl,
      );
      if (search?.size) {
        url.search = search.toString();
      }
      await copyTextToClipboard(url.toString());
      notify.success({ title: t["Copied link to clipboard"]() });
    },
    [
      comment.content,
      comment.id,
      entity.props.docId,
      serverService.server.baseUrl,
      t,
      workbench.workbench.basename$.value,
    ],
  );

  const handleStartEdit = useAsyncCallback(
    async (event: React.MouseEvent) => {
      event.stopPropagation();
      if (comment.resolved || !comment.content) return;
      await entity.startEdit(
        comment.id,
        "comment",
        comment.content.snapshot,
        comment.content.attachments ?? [],
      );
    },
    [comment.content, comment.id, comment.resolved, entity],
  );

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

  const handleDelete = useAsyncCallback(
    async (event: React.MouseEvent) => {
      event.stopPropagation();
      openConfirmModal({
        title: t["com.myoxus.comment.delete.confirm.title"](),
        description: t["com.myoxus.comment.delete.confirm.description"](),
        confirmText: t["Delete"](),
        cancelText: t["Cancel"](),
        confirmButtonOptions: { variant: "error" },
        onConfirm: async () => {
          setMutating(true);
          try {
            await entity.deleteComment(comment.id);
          } finally {
            setMutating(false);
          }
        },
      });
    },
    [comment.id, entity, openConfirmModal, t],
  );

  const handleCommitReply = useAsyncCallback(async () => {
    if (!pendingReply?.id) return;
    setMutating(true);
    try {
      await entity.commitReply(pendingReply.id);
    } finally {
      setMutating(false);
    }
  }, [entity, pendingReply]);

  const handleCancelReply = useCallback(() => {
    if (!pendingReply?.id) return;
    entity.dismissDraftReply();
  }, [entity, pendingReply]);

  if (!comment.content) {
    return null;
  }

  const isOwnComment = Boolean(account && account.id === comment.user.id);
  const canEdit = isOwnComment && canCreateComment;
  const canDelete =
    (isOwnComment && canCreateComment) || (!isOwnComment && canDeleteComment);
  const resolveTooltip = comment.resolved
    ? t["com.myoxus.documentGraph.state.unresolved"]()
    : t["Complete"]();

  const quotePreview = comment.content.preview ? (
    <MyoxusText
      tone="secondary"
      truncate
      typographySlot="body-small"
      data-myoxus-ui-role="comment-thread-preview"
    >
      {comment.content.preview}
    </MyoxusText>
  ) : null;

  const actions = (
    <Group
      data-menu-open={menuOpen}
      data-editing={isEditing}
      onClick={(event) => event.stopPropagation()}
      data-myoxus-ui-role="comment-thread-item-actions"
      wrap="nowrap"
    >
      {canResolveComment ? (
        <IconButton
          onClick={handleResolveToggle}
          icon={<DoneIcon />}
          disabled={mutating}
          tooltip={resolveTooltip}
        />
      ) : null}
      <CommentActionMenu
        open={menuOpen}
        onOpenChange={setMenuOpen}
        canReply={canCreateComment}
        canCopyLink
        canEdit={canEdit}
        canDelete={canDelete}
        disabled={mutating}
        resolved={comment.resolved}
        onReply={handleReply}
        onCopyLink={handleCopyLink}
        onEdit={handleStartEdit}
        onDelete={handleDelete}
      />
    </Group>
  );

  const showReplyComposer =
    !editingDraft &&
    highlighting &&
    isReplyingHere &&
    Boolean(pendingReply) &&
    Boolean(account) &&
    !comment.resolved &&
    canCreateComment;

  return (
    <SurfaceListItem
      ref={cardRef}
      onClick={handleSelectThread}
      data-comment-id={comment.id}
      data-resolved={comment.resolved}
      data-highlighting={highlighting || menuOpen}
      component="article"
      density="default"
      fullWidth
      interactive
      layout="column"
      muted={comment.resolved}
      role="listitem"
      selected={highlighting || menuOpen}
      // Keep the non-portalled action menu inside the right-drawer stacking context
      // while allowing menu items to extend past the compact card bounds.
      style={{ overflow: "visible" }}
      data-myoxus-ui-role="comment-thread-item"
    >
      <Stack data-myoxus-ui-role="comment-thread-replies">
        {isEditing && editingDoc ? (
          <Stack>
            {quotePreview}
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
          </Stack>
        ) : (
          <CommentEntryRow
            user={{
              avatarUrl: comment.user.avatarUrl,
              name: comment.user.name,
            }}
            time={comment.createdAt}
            snapshot={comment.content.snapshot}
            attachments={comment.content.attachments}
            actions={actions}
            context={quotePreview}
          />
        )}

        {comment.replies && comment.replies.length > 0 ? (
          <CommentReplyList
            replies={comment.replies}
            parentComment={comment}
            entity={entity}
            replyEditor={replyEditor}
          />
        ) : null}
      </Stack>

      {showReplyComposer && pendingReply && account ? (
        <CommentEntryRow
          user={{ avatarUrl: account.avatar ?? null, name: "" }}
          doc={pendingReply.doc}
          autoFocus
          editorRefSetter={setReplyEditor}
          onCommit={mutating ? undefined : handleCommitReply}
          onCancel={mutating ? undefined : handleCancelReply}
          attachments={pendingReply.attachments}
          onAttachmentsChange={(attachments) =>
            entity.updatePendingReply(pendingReply.id, { attachments })
          }
          uploadCommentAttachment={(id, file) =>
            entity.uploadCommentAttachment(id, file, pendingReply)
          }
        />
      ) : null}
    </SurfaceListItem>
  );
};
