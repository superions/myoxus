// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors

import { useGuard } from "@myoxus/core/components/guard/use-guard";
import type { FilterParams } from "@myoxus/core/modules/collection-rules";
import { type DocRecord, DocService } from "@myoxus/core/modules/doc";
import { type Tag, TagService } from "@myoxus/core/modules/tag";
import { WorkbenchService } from "@myoxus/core/modules/workbench";
import { WorkspaceService } from "@myoxus/core/modules/workspace";
import { useI18n } from "@myoxus/i18n";
import { ArchiveIcon, MoreHorizontalIcon, TagsIcon } from "@myoxus/icons/react";
import { useLiveData, useService } from "@myoxus/infra";
import {
  Badge,
  ColorSwatch,
  IconButton,
  type MenuRef,
  PlaceholderText,
} from "@myoxus/ui-facade";
import { useCallback, useEffect, useMemo, useRef } from "react";

import type { GroupHeaderProps } from "../explorer/types";
import { useNavigateHelper } from "../hooks/use-navigate-helper";
import type { PropertyValueProps } from "../properties/types";
import { WorkspaceTagsInlineEditor } from "../tags";
import { useWorkspaceTagColorOptions } from "../tags/color-options";
import { TagEditMenu } from "../tags/tag-edit-menu";
import { useWorkspaceTagCommands } from "../tags/use-workspace-tag-commands";
import {
  PropertyFieldCell,
  PropertyGroupHeader,
  PropertyListBadge,
} from "./property-kit";

const MAX_LIST_TAGS = 3;

const TagLabel = ({ tag }: { tag: Tag }) => useLiveData(tag.value$);

const TagColorDot = ({ tag }: { tag: Tag }) => {
  const color = useLiveData(tag.color$);
  return <ColorSwatch tagColorRole={color} />;
};

export const TagsValue = ({
  readonly,
  hideEmpty = false,
}: Pick<PropertyValueProps, "readonly"> & { hideEmpty?: boolean }) => {
  const t = useI18n();
  const doc = useService(DocService).doc;
  const workspace = useService(WorkspaceService);
  const tagList = useService(TagService).tagList;
  const navigator = useNavigateHelper();

  const tagIds = useLiveData(tagList.tagIdsByPageId$(doc.id));
  const assignmentState = useLiveData(tagList.assignmentState$(doc.id));
  const empty = !tagIds || tagIds.length === 0;

  const commit = useCallback(
    async (nextIds: string[]) => tagList.setPageTags(doc.id, nextIds),
    [doc.id, tagList],
  );

  const jumpToTag = useCallback(
    (tagId: string) => navigator.jumpToTag(workspace.workspace.id, tagId),
    [navigator, workspace.workspace.id],
  );

  if (hideEmpty && empty) {
    return null;
  }

  return (
    <PropertyFieldCell
      isEmpty={empty}
      data-testid="property-tags-value"
      readonly={readonly}
    >
      <WorkspaceTagsInlineEditor
        tagMode="inline-tag"
        block
        placeholder={t[
          "com.myoxus.page-properties.property-value-placeholder"
        ]()}
        readonly={readonly}
        selectedTags={tagIds}
        assignmentState={assignmentState}
        commit={commit}
        jumpToTag={jumpToTag}
        title={
          <>
            <TagsIcon />
            {t["Tags"]()}
          </>
        }
      />
    </PropertyFieldCell>
  );
};

export const TagsFilterValue = ({
  filter,
  isDraft,
  onDraftCompleted,
  onChange,
}: {
  filter: FilterParams;
  isDraft?: boolean;
  onDraftCompleted?: () => void;
  onChange: (filter: FilterParams) => void;
}) => {
  const t = useI18n();
  const menuRef = useRef<MenuRef>(null);

  useEffect(() => {
    if (isDraft) menuRef.current?.changeOpen(true);
  }, [isDraft]);

  useEffect(() => {
    if (
      isDraft &&
      (filter.method === "is-not-empty" || filter.method === "is-empty")
    ) {
      onDraftCompleted?.();
    }
  }, [filter.method, isDraft, onDraftCompleted]);

  const selectedTags = useMemo(
    () => filter.value?.split(",").filter(Boolean) ?? [],
    [filter.value],
  );

  const commit = useCallback(
    (tagIds: string[]) => {
      onChange({ ...filter, value: tagIds.join(",") });
    },
    [filter, onChange],
  );

  if (filter.method === "is-not-empty" || filter.method === "is-empty") {
    return undefined;
  }

  return (
    <WorkspaceTagsInlineEditor
      placeholder={
        <PlaceholderText>{t["com.myoxus.filter.empty"]()}</PlaceholderText>
      }
      selectedTags={selectedTags}
      commit={commit}
      tagMode="inline-tag"
      ref={menuRef}
      onEditorClose={onDraftCompleted}
    />
  );
};

export const TagsDocListProperty = ({ doc }: { doc: DocRecord }) => {
  const t = useI18n();
  const tags = useLiveData(
    useService(TagService).tagList.tagsByPageId$(doc.id),
  );

  const hasOverflow = tags.length > MAX_LIST_TAGS + 1;
  const visibleCount =
    tags.length === MAX_LIST_TAGS + 1 ? MAX_LIST_TAGS + 1 : MAX_LIST_TAGS;

  return (
    <>
      {tags.slice(0, visibleCount).map((tag) => (
        <PropertyListBadge icon={<TagColorDot tag={tag} />} key={tag.id}>
          <TagLabel tag={tag} />
        </PropertyListBadge>
      ))}
      {hasOverflow ? (
        <PropertyListBadge icon={null}>
          <span>+{tags.length - MAX_LIST_TAGS}</span>
          <span> {t["Tags"]()}</span>
        </PropertyListBadge>
      ) : null}
    </>
  );
};

export const TagsGroupActions = ({ groupId }: { groupId: string }) => {
  const t = useI18n();
  const tagList = useService(TagService).tagList;
  const workbench = useService(WorkbenchService).workbench;
  const commands = useWorkspaceTagCommands();
  const colors = useWorkspaceTagColorOptions();
  const canChangeTag = useGuard("Workspace_CreateDoc");
  const canDeleteTag = useGuard("Workspace_Properties_Delete");

  const tag = useLiveData(tagList.tagByTagId$(groupId));
  const catalogState = useLiveData(tagList.catalogState$);
  const name = useLiveData(tag?.value$);
  const color = useLiveData(tag?.color$);
  const description = useLiveData(tag?.description$);
  const archived = useLiveData(tag?.archived$);

  const openTag = useCallback(
    (tagId = tag?.id) => {
      if (tagId) workbench.openTag(tagId);
    },
    [tag?.id, workbench],
  );

  if (!tag || catalogState.status !== "ready") {
    return null;
  }

  return (
    <TagEditMenu
      colors={colors}
      canEdit={canChangeTag}
      canDeletePermanently={canDeleteTag}
      jumpToTag={openTag}
      onTagUpdate={(_tagId, metadata) => commands.updateTag(tag.id, metadata)}
      onTagArchive={(tagId) => {
        void commands.archiveTags([tagId]);
      }}
      onTagDeletePermanently={(tagId) => commands.deleteTagPermanently(tagId)}
      onTagRestore={(tagId) => {
        void commands.restoreTag(tagId);
      }}
      tag={{
        id: tag.id,
        name: name ?? "",
        color: color ?? "tag.grey",
        description: description ?? "",
        archived: archived ?? false,
      }}
    >
      <IconButton
        aria-label={`${name || t["Untitled"]()}: ${t["com.myoxus.common.open-menu"]()}`}
        icon={<MoreHorizontalIcon />}
        size="small"
      />
    </TagEditMenu>
  );
};

export const TagsGroupHeader = ({
  groupId,
  docCount,
  interactive = true,
}: GroupHeaderProps) => {
  const t = useI18n();
  const tag = useLiveData(useService(TagService).tagList.tagByTagId$(groupId));
  const name = useLiveData(tag?.value$);
  const archived = useLiveData(tag?.archived$);

  if (!tag) {
    return (
      <PropertyGroupHeader
        groupId={groupId}
        docCount={docCount}
        icon={<ColorSwatch tagColorRole="tag.grey" />}
      >
        {t["com.myoxus.page.display.grouping.group-by-tag.untagged"]()}
      </PropertyGroupHeader>
    );
  }

  return (
    <PropertyGroupHeader
      actions={interactive ? <TagsGroupActions groupId={groupId} /> : undefined}
      groupId={groupId}
      docCount={docCount}
      icon={<TagColorDot tag={tag} />}
      status={
        archived ? (
          <Badge prefix={<ArchiveIcon />}>
            {t["com.myoxus.tags.status.archived"]()}
          </Badge>
        ) : undefined
      }
    >
      {name}
    </PropertyGroupHeader>
  );
};
