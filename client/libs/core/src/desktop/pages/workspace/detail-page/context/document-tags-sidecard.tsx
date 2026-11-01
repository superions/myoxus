// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useNavigateHelper } from "@myoxus/core/components/hooks/use-navigate-helper";
import { WorkspaceTagsInlineEditor } from "@myoxus/core/components/tags";
import { TagService } from "@myoxus/core/modules/tag";
import { WorkspaceService } from "@myoxus/core/modules/workspace";
import { useI18n } from "@myoxus/i18n";
import { PlusIcon } from "@myoxus/icons/react";
import { useLiveData, useService } from "@myoxus/infra";
import {
  Button,
  Divider,
  EmptyState,
  Group,
  type MenuRef,
  Stack,
} from "@myoxus/ui-facade";
import { useCallback, useRef } from "react";

export function DocumentTagsSidecard({
  docId,
  readonly,
}: {
  docId: string;
  readonly: boolean;
}) {
  const t = useI18n();
  const tagService = useService(TagService);
  const workspace = useService(WorkspaceService).workspace;
  const navigator = useNavigateHelper();
  const editorRef = useRef<MenuRef>(null);
  const catalogState = useLiveData(tagService.tagList.catalogState$);
  const assignmentState = useLiveData(
    tagService.tagList.assignmentState$(docId),
  );
  const selectedTags = useLiveData(tagService.tagList.tagIdsByPageId$(docId));

  const commit = useCallback(
    (nextIds: string[]) => tagService.tagList.setPageTags(docId, nextIds),
    [docId, tagService.tagList],
  );
  const jumpToTag = useCallback(
    (tagId: string) => {
      navigator.jumpToTag(workspace.id, tagId);
    },
    [navigator, workspace.id],
  );
  const openSelector = useCallback(() => {
    editorRef.current?.changeOpen(true);
  }, []);

  const addButton =
    !readonly &&
    catalogState.status === "ready" &&
    assignmentState.status === "ready" ? (
      <Button
        aria-haspopup="menu"
        data-myoxus-ui-role="document-tags-add-action"
        data-testid="document-tags-add"
        onClick={openSelector}
        prefix={<PlusIcon />}
        variant="primary"
      >
        {t["com.myoxus.tags.assignment.add"]()}
      </Button>
    ) : null;

  return (
    <Stack
      data-myoxus-ui-role="document-tags-sidecard"
      data-testid="document-tags-sidecard"
      pt="sm"
    >
      <WorkspaceTagsInlineEditor
        commit={commit}
        assignmentState={assignmentState}
        jumpToTag={jumpToTag}
        placeholder={
          <EmptyState
            title={
              readonly
                ? t["com.myoxus.tags.assignment.readonly-empty"]()
                : t["com.myoxus.tags.assignment.empty"]()
            }
            cta={readonly ? null : addButton}
            data-testid="document-tags-empty"
          />
        }
        readonly={readonly}
        ref={editorRef}
        menuPanelWidth="display"
        selectedTags={selectedTags}
        tagMode="inline-tag"
      />
      {selectedTags.length > 0 ? (
        <>
          <Divider />
          <Group justify="flex-end" data-myoxus-ui-role="document-tags-actions">
            {addButton}
          </Group>
        </>
      ) : null}
    </Stack>
  );
}
