// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors

import type { DocCommentEntity } from "@myoxus/core/modules/comment/entities/doc-comment";
import { CommentPanelService } from "@myoxus/core/modules/comment/services/comment-panel-service";
import { DocCommentManagerService } from "@myoxus/core/modules/comment/services/doc-comment-manager";
import { DocService } from "@myoxus/core/modules/doc";
import { AuthService } from "@myoxus/core/modules/server/services/auth";
import { useI18n } from "@myoxus/i18n";
import { useLiveData, useService, useServiceOptional } from "@myoxus/infra";
import {
  EmptyState,
  Group,
  Loading,
  MyoxusTitle,
  Stack,
  useHotkeys,
} from "@myoxus/ui-facade";
import { useCallback, useEffect, useMemo, useState } from "react";

import { CommentComposer } from "./comment-composer";
import {
  CommentFilterMenu,
  type CommentFilterState,
} from "./comment-filter-menu";
import { CommentThreadCard } from "./comment-thread-card";

const useActiveCommentEntity = (
  store: DocService["doc"]["virgultumDoc"] | undefined,
) => {
  const manager = useService(DocCommentManagerService);
  const panelService = useService(CommentPanelService);
  const [entity, setEntity] = useState<DocCommentEntity | null>(null);

  useEffect(() => {
    if (!store) return;
    const ref = manager.get(store);
    setEntity(ref.obj);
    ref.obj.start();
    const unwatch = panelService.watchForPendingComments(ref.obj);

    return () => {
      unwatch();
      ref.obj.stop();
      ref.release();
    };
  }, [manager, panelService, store]);

  return entity;
};

const CommentSidebarContent = ({ entity }: { entity: DocCommentEntity }) => {
  const t = useI18n();
  const comments = useLiveData(entity.comments$);
  const pendingComment = useLiveData(entity.pendingComment$);
  const loading = useLiveData(entity.loading$);
  const docMode = useLiveData(entity.docMode$);
  const account = useLiveData(useService(AuthService).session.account$);

  const [filterState, setFilterState] = useState<CommentFilterState>({
    showResolvedComments: false,
    onlyMyReplies: false,
    onlyCurrentMode: false,
  });

  const handleFilterChange = useCallback(
    (key: keyof CommentFilterState, value: boolean) => {
      setFilterState((prev) => ({ ...prev, [key]: value }));
    },
    [],
  );

  const visibleThreads = useMemo(() => {
    let result = comments;

    if (!filterState.showResolvedComments) {
      result = result.filter((comment) => !comment.resolved);
    }

    if (filterState.onlyMyReplies && account) {
      const involvesAccount = (userId: string, mentions: readonly string[]) =>
        userId === account.id || mentions.includes(account.id);

      result = result
        .filter(
          (comment) =>
            involvesAccount(comment.user.id, comment.mentions) ||
            comment.replies?.some((reply) =>
              involvesAccount(reply.user.id, reply.mentions),
            ),
        )
        .map((comment) => ({
          ...comment,
          replies: comment.replies?.filter((reply) =>
            involvesAccount(reply.user.id, reply.mentions),
          ),
        }));
    }

    if (filterState.onlyCurrentMode) {
      result = result.filter(
        (comment) =>
          !comment.content?.mode ||
          !docMode ||
          comment.content.mode === docMode,
      );
    }

    return result.toSorted((a, b) => b.createdAt - a.createdAt);
  }, [account, comments, docMode, filterState]);

  const showEmpty = visibleThreads.length === 0 && !pendingComment && !loading;
  const showLoading = loading && visibleThreads.length === 0 && !pendingComment;

  return (
    <Stack data-myoxus-ui-role="comment-sidebar-content">
      <Group component="header" justify="space-between" wrap="nowrap">
        <MyoxusTitle order={3} data-myoxus-ui-role="comment-sidebar-title">
          {t["com.myoxus.comment.comments"]()}
        </MyoxusTitle>
        {comments.length > 0 ? (
          <CommentFilterMenu
            filterState={filterState}
            onFilterChange={handleFilterChange}
          />
        ) : null}
      </Group>

      <CommentComposer entity={entity} />

      {showEmpty ? (
        <EmptyState
          title={t["com.myoxus.comment.no-comments"]()}
          data-myoxus-ui-role="comment-sidebar-empty"
        />
      ) : null}

      {showLoading ? (
        <EmptyState
          title={<Loading />}
          data-myoxus-ui-role="comment-sidebar-loading"
        />
      ) : null}

      <Stack
        aria-label={t["com.myoxus.comment.comments"]()}
        data-myoxus-ui-role="comment-thread-list"
        role="list"
      >
        {visibleThreads.map((comment) => (
          <CommentThreadCard
            key={comment.id}
            comment={comment}
            entity={entity}
          />
        ))}
      </Stack>
    </Stack>
  );
};

export const CommentSidebar = () => {
  const doc = useServiceOptional(DocService)?.doc;
  const entity = useActiveCommentEntity(doc?.virgultumDoc);

  useHotkeys(
    [
      [
        "Escape",
        () => {
          entity?.highlightComment(null);
          entity?.dismissDraftEditing();
        },
        { preventDefault: false },
      ],
    ],
    [],
    true,
  );

  useEffect(
    () => () => {
      entity?.highlightComment(null);
    },
    [entity],
  );

  const handleBackdropClick = useCallback(
    (event: React.MouseEvent<HTMLDivElement>) => {
      const target = event.target as HTMLElement;
      if (!target.closest("[data-comment-id]")) {
        entity?.highlightComment(null);
        entity?.dismissDraftEditing();
      }
      if (
        entity?.pendingComment$.value &&
        !target.closest("[data-pending-comment]")
      ) {
        entity.dismissDraftComment();
      }
    },
    [entity],
  );

  if (!entity) {
    return null;
  }

  return (
    <Stack
      p="sm"
      onClick={handleBackdropClick}
      data-myoxus-ui-role="comment-sidebar-root"
    >
      <CommentSidebarContent entity={entity} />
    </Stack>
  );
};

export { CommentComposer } from "./comment-composer";
export { CommentFilterMenu } from "./comment-filter-menu";
export { CommentReplyRow } from "./comment-reply-row";
export { CommentThreadCard } from "./comment-thread-card";
