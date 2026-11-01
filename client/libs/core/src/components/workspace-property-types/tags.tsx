import type { FilterParams } from "@myoxus/core/modules/collection-rules";
import { useGuard } from "@myoxus/core/components/guard/use-guard";
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
  PropertyValue,
} from "@myoxus/ui-facade";
import { useCallback, useEffect, useMemo, useRef } from "react";

import { PlainTextDocGroupHeader } from "../explorer/docs-view/group-header";
import { StackProperty } from "../explorer/docs-view/stack-property";
import type { GroupHeaderProps } from "../explorer/types";
import { useNavigateHelper } from "../hooks/use-navigate-helper";
import type { PropertyValueProps } from "../properties/types";
import {
  WorkspaceTagsInlineEditor as TagsInlineEditorComponent,
  WorkspaceTagsInlineEditor,
} from "../tags";
import { useWorkspaceTagColorOptions } from "../tags/color-options";
import { TagEditMenu } from "../tags/tag-edit-menu";
import { useWorkspaceTagCommands } from "../tags/use-workspace-tag-commands";

export const TagsValue = ({
  readonly,
  hideEmpty = false,
}: Pick<PropertyValueProps, "readonly"> & { hideEmpty?: boolean }) => {
  const t = useI18n();

  const doc = useService(DocService).doc;

  const tagList = useService(TagService).tagList;
  const tagIds = useLiveData(tagList.tagIdsByPageId$(doc.id));
  const empty = !tagIds || tagIds.length === 0;

  if (hideEmpty && empty) return null;

  return (
    <PropertyValue
      isEmpty={empty}
      data-testid="property-tags-value"
      readonly={readonly}
    >
      <TagsInlineEditor
        block
        placeholder={t[
          "com.myoxus.page-properties.property-value-placeholder"
        ]()}
        pageId={doc.id}
        onChange={() => {}}
        readonly={readonly}
      />
    </PropertyValue>
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
    if (isDraft) {
      menuRef.current?.changeOpen(true);
    }
  }, [isDraft]);

  const selectedTags = useMemo(
    () => filter.value?.split(",").filter(Boolean) ?? [],
    [filter.value],
  );

  const commit = useCallback(
    (tagIds: string[]) => {
      onChange({
        ...filter,
        value: tagIds.join(","),
      });
    },
    [filter, onChange],
  );

  useEffect(() => {
    if (
      isDraft &&
      (filter.method === "is-not-empty" || filter.method === "is-empty")
    ) {
      onDraftCompleted?.();
    }
  }, [isDraft, filter.method, onDraftCompleted]);

  return filter.method !== "is-not-empty" && filter.method !== "is-empty" ? (
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
  ) : undefined;
};

const TagsInlineEditor = ({
  pageId,
  readonly,
  placeholder,
  className,
  block,
  onChange,
}: {
  placeholder?: string;
  className?: string;
  block?: boolean;
  onChange?: (value: unknown) => void;
  pageId: string;
  readonly?: boolean;
  focusedIndex?: number;
}) => {
  const t = useI18n();
  const workspace = useService(WorkspaceService);
  const tagService = useService(TagService);
  const tagIds = useLiveData(tagService.tagList.tagIdsByPageId$(pageId));
  const assignmentState = useLiveData(
    tagService.tagList.assignmentState$(pageId),
  );
  const commit = useCallback(
    async (nextIds: string[]) => {
      const confirmed = await tagService.tagList.setPageTags(pageId, nextIds);
      onChange?.(confirmed);
      return confirmed;
    },
    [onChange, pageId, tagService.tagList],
  );

  const navigator = useNavigateHelper();

  const jumpToTag = useCallback(
    (id: string) => {
      navigator.jumpToTag(workspace.workspace.id, id);
    },
    [navigator, workspace.workspace.id],
  );

  return (
    <TagsInlineEditorComponent
      tagMode="inline-tag"
      jumpToTag={jumpToTag}
      readonly={readonly}
      placeholder={placeholder}
      className={className}
      block={block}
      selectedTags={tagIds}
      assignmentState={assignmentState}
      commit={commit}
      title={
        <>
          <TagsIcon />
          {t["Tags"]()}
        </>
      }
    />
  );
};

const TagName = ({ tag }: { tag: Tag }) => {
  const name = useLiveData(tag.value$);
  return name;
};
const TagIcon = ({ tag }: { tag: Tag }) => {
  const color = useLiveData(tag.color$);
  return <ColorSwatch tagColorRole={color} />;
};

export const TagsDocListProperty = ({ doc }: { doc: DocRecord }) => {
  const max = 3;
  const t = useI18n();
  const tagList = useService(TagService).tagList;
  const tags = useLiveData(tagList.tagsByPageId$(doc.id));

  const showRest = tags.length > max + 1;
  const visibleTags = tags.length === max + 1 ? max + 1 : max;

  return (
    <>
      {tags.slice(0, visibleTags).map((tag) => {
        return (
          <StackProperty icon={<TagIcon tag={tag} />} key={tag.id}>
            <TagName tag={tag} />
          </StackProperty>
        );
      })}
      {showRest ? (
        <StackProperty icon={null}>
          <span>+{tags.length - max}</span>
          <span> {t["Tags"]()}</span>
        </StackProperty>
      ) : null}
    </>
  );
};

export const TagsGroupActions = ({ groupId }: { groupId: string }) => {
  const t = useI18n();
  const tagService = useService(TagService);
  const workbench = useService(WorkbenchService).workbench;
  const commands = useWorkspaceTagCommands();
  const colors = useWorkspaceTagColorOptions();
  const canChangeTag = useGuard("Workspace_CreateDoc");
  const canDeleteTag = useGuard("Workspace_Properties_Delete");
  const tag = useLiveData(tagService.tagList.tagByTagId$(groupId));
  const catalogState = useLiveData(tagService.tagList.catalogState$);
  const name = useLiveData(tag?.value$);
  const color = useLiveData(tag?.color$);
  const description = useLiveData(tag?.description$);
  const archived = useLiveData(tag?.archived$);
  const openTag = useCallback(
    (tagId = tag?.id) => {
      if (tagId) {
        workbench.openTag(tagId);
      }
    },
    [tag?.id, workbench],
  );

  if (!tag || catalogState.status !== "ready") return null;

  const tagLike = {
    id: tag.id,
    name: name ?? "",
    color: color ?? "tag.grey",
    description: description ?? "",
    archived: archived ?? false,
  } as const;

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
      onTagDeletePermanently={(tagId) => {
        return commands.deleteTagPermanently(tagId);
      }}
      onTagRestore={(tagId) => {
        void commands.restoreTag(tagId);
      }}
      tag={tagLike}
    >
      <IconButton
        aria-label={`${name || t["Untitled"]()}: ${t[
          "com.myoxus.common.open-menu"
        ]()}`}
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
  const tagService = useService(TagService);
  const tag = useLiveData(tagService.tagList.tagByTagId$(groupId));
  const name = useLiveData(tag?.value$);
  const archived = useLiveData(tag?.archived$);

  if (!tag) {
    return (
      <PlainTextDocGroupHeader
        groupId={groupId}
        docCount={docCount}
        icon={<ColorSwatch tagColorRole="tag.grey" />}
      >
        {t["com.myoxus.page.display.grouping.group-by-tag.untagged"]()}
      </PlainTextDocGroupHeader>
    );
  }

  return (
    <PlainTextDocGroupHeader
      actions={interactive ? <TagsGroupActions groupId={groupId} /> : undefined}
      groupId={groupId}
      docCount={docCount}
      icon={<TagIcon tag={tag} />}
      status={
        archived ? (
          <Badge prefix={<ArchiveIcon />}>
            {t["com.myoxus.tags.status.archived"]()}
          </Badge>
        ) : undefined
      }
    >
      {name}
    </PlainTextDocGroupHeader>
  );
};
