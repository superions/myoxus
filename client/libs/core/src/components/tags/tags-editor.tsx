import type { TagAssignmentState } from "@myoxus/core/modules/tag/stores/tag";
import {
  TagService,
  type WorkspaceTagAssignmentCommit,
  WorkspaceTagAssignmentController,
} from "@myoxus/core/modules/tag";
import { useI18n } from "@myoxus/i18n";
import { DoneIcon, MoreHorizontalIcon, PlusIcon } from "@myoxus/icons/react";
import { useLiveData, useService } from "@myoxus/infra";
import {
  Alert,
  Box,
  Button,
  Divider,
  Group,
  IconButton,
  InlineContentTrigger,
  Loading,
  Menu,
  type MenuContentOptions,
  MenuDetailRow,
  MenuItem,
  MenuPanel,
  type MenuRef,
  MenuScrollableSection,
  MenuSection,
  MenuSectionLabel,
  MenuSeparator,
  MyoxusText,
  RowInput,
  Stack,
  type TagColorRole,
} from "@myoxus/ui-facade";
import { clamp } from "lodash-es";
import {
  type KeyboardEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useReducer,
  useRef,
  useState,
} from "react";

import { ConfigModal } from "../mobile";
import { useWorkspaceTagColorOptions } from "./color-options";
import { InlineTagList } from "./inline-tag-list";
import { TagItem } from "./tag";
import { TagEditMenu } from "./tag-edit-menu";
import type { TagMetadataUpdate } from "./tag-edit-menu";
import type { TagColor, TagLike } from "./types";
import { useWorkspaceTagCommands } from "./use-workspace-tag-commands";

export interface TagsEditorProps {
  tags: TagLike[]; // candidates to show in the tag dropdown
  selectedTags: string[];
  onCreateTag: (name: string, color: TagColorRole) => Promise<TagLike>;
  onSelectTag: (tagId: string) => void | Promise<void>; // activate tag
  onDeselectTag: (tagId: string) => void | Promise<void>; // deactivate tag
  tagColors: TagColor[];
  onTagUpdate: (id: string, metadata: TagMetadataUpdate) => Promise<boolean>;
  onTagArchive: (id: string) => void | Promise<void>;
  onRestoreTag?: (id: string) => void | Promise<void>;
  lifecycleDisabled?: boolean;
  feedback?: ReactNode;
  jumpToTag?: (id: string) => void;
  tagMode: "inline-tag" | "db-label";
  style?: React.CSSProperties;
}

export interface TagsInlineEditorProps extends TagsEditorProps {
  placeholder?: ReactNode;
  className?: string;
  block?: boolean;
  readonly?: boolean;
  title?: ReactNode; // only used for mobile
  modalMenu?: boolean;
  menuClassName?: string;
  menuPanelWidth?: MenuContentOptions["panelWidth"];
  style?: React.CSSProperties;
  ref?: React.Ref<MenuRef>;
  onEditorClose?: () => void;
}

type TagOption = TagLike | { readonly create: true; readonly value: string };

const TAG_SELECTOR_ITEM_ROLE = "tag-selector-item";

const isCreateNewTag = (
  tagOption: TagOption,
): tagOption is { readonly create: true; readonly value: string } => {
  return "create" in tagOption;
};

export const TagsEditor = ({
  tags,
  selectedTags,
  onSelectTag,
  onDeselectTag,
  onCreateTag,
  tagColors,
  onTagArchive,
  onRestoreTag,
  lifecycleDisabled = false,
  feedback,
  onTagUpdate,
  jumpToTag,
  tagMode,
  style,
}: TagsEditorProps) => {
  const t = useI18n();
  const [inputValue, setInputValue] = useState("");

  const trimmedInputValue = inputValue.trim();

  const filteredTags = tags.filter(
    (tag) =>
      !tag.archived &&
      tag.name.toLowerCase().includes(trimmedInputValue.toLowerCase()),
  );
  const inputRef = useRef<HTMLInputElement>(null);

  const showCreateTag = !lifecycleDisabled && Boolean(trimmedInputValue);

  // tag option candidates to show in the tag dropdown
  const tagOptions: TagOption[] = useMemo(() => {
    if (showCreateTag) {
      return [
        ...filteredTags,
        { create: true, value: trimmedInputValue } as const,
      ];
    } else {
      return filteredTags;
    }
  }, [filteredTags, showCreateTag, trimmedInputValue]);

  const [focusedIndex, setFocusedIndex] = useState<number>(-1);
  const [focusedInlineIndex, setFocusedInlineIndex] = useState<number>(
    selectedTags.length,
  );

  // -1: no focus
  const safeFocusedIndex = clamp(focusedIndex, -1, tagOptions.length - 1);
  // inline tags focus index can go beyond the length of tagIds
  // using -1 and tagIds.length to make keyboard navigation easier
  const safeInlineFocusedIndex = clamp(
    focusedInlineIndex,
    -1,
    selectedTags.length,
  );

  const scrollContainerRef = useRef<HTMLDivElement>(null);

  const onInputChange = useCallback(
    (value: string) => {
      setInputValue(value);
      if (value.length > 0) {
        setFocusedInlineIndex(selectedTags.length);
      }
    },
    [selectedTags.length],
  );

  const onToggleTag = useCallback(
    (id: string) => {
      if (!selectedTags.includes(id)) {
        return onSelectTag(id);
      }
      return onDeselectTag(id);
    },
    [selectedTags, onSelectTag, onDeselectTag],
  );

  const focusInput = useCallback(() => {
    inputRef.current?.focus();
  }, []);

  const [nextColor, rotateNextColor] = useReducer(
    (color) => {
      const idx = tagColors.findIndex((c) => c.value === color);
      return tagColors[(idx + 1) % tagColors.length].value;
    },

    tagColors[tags.length % tagColors.length].value,
  );

  const handleCreateTag = useCallback(
    async (name: string) => {
      rotateNextColor();
      const newTag = await onCreateTag(name.trim(), nextColor);
      return newTag.id;
    },
    [onCreateTag, nextColor],
  );

  const handleArchiveTag = useCallback(
    (tagId: string) => {
      return onTagArchive(tagId);
    },
    [onTagArchive],
  );

  const onSelectTagOption = useCallback(
    async (tagOption: TagOption) => {
      try {
        const id = isCreateNewTag(tagOption)
          ? await handleCreateTag(tagOption.value)
          : tagOption.id;
        await onToggleTag(id);
        setInputValue("");
        focusInput();
        setFocusedIndex(-1);
        setFocusedInlineIndex(selectedTags.length + 1);
      } catch {
        // The serviceless callback owner reports the domain-specific failure.
      }
    },
    [handleCreateTag, onToggleTag, focusInput, selectedTags.length],
  );
  const onEnter = useCallback(() => {
    if (safeFocusedIndex >= 0) {
      void onSelectTagOption(tagOptions[safeFocusedIndex]);
    }
  }, [onSelectTagOption, safeFocusedIndex, tagOptions]);

  const handleUntag = useCallback(
    (id: string) => {
      onToggleTag(id);
      focusInput();
    },
    [onToggleTag, focusInput],
  );

  const onInputKeyDown = useCallback(
    (e: KeyboardEvent<HTMLInputElement>) => {
      if (e.key === "Backspace") {
        if (inputValue.length > 0 || selectedTags.length === 0) {
          return;
        }
        e.preventDefault();
        const index =
          safeInlineFocusedIndex < 0 ||
          safeInlineFocusedIndex >= selectedTags.length
            ? selectedTags.length - 1
            : safeInlineFocusedIndex;
        const tagToRemove = selectedTags.at(index);
        if (tagToRemove) {
          onDeselectTag(tagToRemove);
        }
      } else if (e.key === "ArrowUp" || e.key === "ArrowDown") {
        e.preventDefault();
        const newFocusedIndex = clamp(
          safeFocusedIndex + (e.key === "ArrowUp" ? -1 : 1),
          0,
          tagOptions.length - 1,
        );
        scrollContainerRef.current
          ?.querySelector<HTMLElement>(
            `[data-tag-option-index="${newFocusedIndex}"]`,
          )
          ?.scrollIntoView({ block: "nearest" });
        setFocusedIndex(newFocusedIndex);
        // reset inline focus
        setFocusedInlineIndex(selectedTags.length + 1);
      } else if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
        if (inputValue.length > 0 || selectedTags.length === 0) {
          return;
        }
        const newItemToFocus =
          e.key === "ArrowLeft"
            ? safeInlineFocusedIndex - 1
            : safeInlineFocusedIndex + 1;

        e.preventDefault();
        setFocusedInlineIndex(newItemToFocus);
        // reset tag list focus
        setFocusedIndex(-1);
      }
    },
    [
      inputValue,
      safeInlineFocusedIndex,
      selectedTags,
      onDeselectTag,
      safeFocusedIndex,
      tagOptions.length,
    ],
  );

  return (
    <MenuPanel
      style={style}
      data-testid="tags-editor-popup"
      data-myoxus-ui-role="tags-editor-panel"
    >
      <Group
        component="header"
        gap={0}
        wrap="nowrap"
        data-myoxus-ui-role="tags-editor-selected-tags"
      >
        <InlineTagList
          tagMode={tagMode}
          tags={selectedTags.flatMap((id) => {
            const tag = tags.find((tag) => tag.id === id);
            return tag ? [tag] : [];
          })}
          focusedIndex={safeInlineFocusedIndex}
          onRemoved={handleUntag}
        >
          <RowInput
            ref={inputRef}
            value={inputValue}
            onChange={onInputChange}
            onKeyDown={onInputKeyDown}
            onEnter={onEnter}
            autoFocus
            block
            noBorder
            placeholder={t["com.myoxus.search-tags.placeholder"]()}
          />
        </InlineTagList>

        {BUILD_CONFIG.isMobileEdition ? null : (
          <MenuItem
            aria-label={t["com.myoxus.m.explorer.tag.rename-confirm"]()}
            prefixIcon={<DoneIcon />}
          >
            {t["com.myoxus.m.explorer.tag.rename-confirm"]()}
          </MenuItem>
        )}
      </Group>
      {BUILD_CONFIG.isMobileEdition ? null : <Divider size="thinner" />}
      <MenuSection data-myoxus-ui-role="tags-editor-selector">
        <MenuSectionLabel>{t["Tags"]()}</MenuSectionLabel>
        <MenuScrollableSection
          ref={scrollContainerRef}
          maxHeight={BUILD_CONFIG.isMobileEdition ? "default" : "compact"}
        >
          {filteredTags.length === 0 && (
            <MenuSectionLabel data-myoxus-ui-role="tag-selector-empty">
              {t["com.myoxus.rootAppSidebar.tags.empty"]()}
            </MenuSectionLabel>
          )}

          {filteredTags.map((tag, idx) => {
            const active = safeFocusedIndex === idx;
            const commonProps = {
              onClick: () => void onSelectTagOption(tag),
              onMouseEnter: () => setFocusedIndex(idx),
              ["data-tag-option-index"]: idx,
              ["data-testid"]: "tag-selector-item",
              ["data-focused"]: active,
              ["data-myoxus-ui-role"]: TAG_SELECTOR_ITEM_ROLE,
            } as const;
            return (
              <MenuDetailRow
                key={tag.id}
                right={
                  lifecycleDisabled ? undefined : (
                    <TagEditMenu
                      tag={tag}
                      onTagArchive={handleArchiveTag}
                      onTagRestore={onRestoreTag}
                      onTagUpdate={onTagUpdate}
                      jumpToTag={jumpToTag}
                      colors={tagColors}
                    >
                      <IconButton
                        aria-label={t["Edit"]()}
                        icon={<MoreHorizontalIcon />}
                      />
                    </TagEditMenu>
                  )
                }
                data-myoxus-ui-role="tag-selector-row"
              >
                <MenuItem
                  active={active}
                  block
                  closeMenuOnClick={false}
                  selected={selectedTags.includes(tag.id)}
                  {...commonProps}
                  data-tag-id={tag.id}
                  data-tag-value={tag.name}
                >
                  <TagItem tag={tag} mode={tagMode} />
                </MenuItem>
              </MenuDetailRow>
            );
          })}
          {showCreateTag ? (
            <>
              <MenuSeparator />
              <MenuSection data-myoxus-ui-role="tag-create-section">
                <MenuSectionLabel>
                  {t["com.myoxus.tags.empty.new-tag-button"]()}
                </MenuSectionLabel>
                <MenuItem
                  active={safeFocusedIndex === filteredTags.length}
                  closeMenuOnClick={false}
                  data-focused={
                    safeFocusedIndex === filteredTags.length || undefined
                  }
                  data-myoxus-ui-role={TAG_SELECTOR_ITEM_ROLE}
                  data-tag-option-index={filteredTags.length}
                  data-testid="tag-selector-item"
                  onClick={() =>
                    void onSelectTagOption({
                      create: true,
                      value: trimmedInputValue,
                    })
                  }
                  onMouseEnter={() => setFocusedIndex(filteredTags.length)}
                  prefixIcon={<PlusIcon />}
                >
                  <Group
                    gap={0}
                    miw={0}
                    wrap="nowrap"
                    data-myoxus-ui-role="tag-create-option"
                  >
                    <MyoxusText component="span" typographySlot="nav">
                      {t["Create"]()}
                    </MyoxusText>
                    <TagItem
                      mode={tagMode}
                      tag={{
                        id: "create-new-tag",
                        name: inputValue,
                        color: nextColor,
                      }}
                    />
                  </Group>
                </MenuItem>
              </MenuSection>
            </>
          ) : null}
        </MenuScrollableSection>
      </MenuSection>
      {feedback}
    </MenuPanel>
  );
};

const MobileInlineEditor = ({
  readonly,
  placeholder,
  className,
  block,
  title,
  style,
  onEditorClose,
  ref,
  ...props
}: TagsInlineEditorProps) => {
  const [editing, setEditing] = useState(false);

  useImperativeHandle(
    ref,
    () => ({
      changeOpen: (open: boolean) => {
        setEditing(readonly ? false : open);
        if (!open) {
          onEditorClose?.();
        }
      },
    }),
    [onEditorClose, readonly],
  );

  const empty = !props.selectedTags || props.selectedTags.length === 0;
  const selectedTags = useMemo(() => {
    return props.selectedTags
      .map((id) => props.tags.find((tag) => tag.id === id))
      .filter((tag) => tag !== undefined);
  }, [props.selectedTags, props.tags]);
  return (
    <>
      <ConfigModal
        title={title}
        open={editing}
        onOpenChange={setEditing}
        onBack={() => {
          setEditing(false);
          onEditorClose?.();
        }}
      >
        <TagsEditor {...props} />
      </ConfigModal>
      <Box
        className={className}
        data-empty={empty}
        data-readonly={readonly}
        display="flex"
        onClick={readonly ? undefined : () => setEditing(true)}
        style={style}
        w={block ? "100%" : undefined}
        data-myoxus-ui-role="tags-inline-editor"
      >
        {empty ? (
          placeholder
        ) : (
          <InlineTagList {...props} tags={selectedTags} onRemoved={undefined} />
        )}
      </Box>
    </>
  );
};

const DesktopTagsInlineEditor = ({
  readonly,
  placeholder,
  className,
  block,
  modalMenu,
  menuClassName,
  menuPanelWidth,
  style,
  ref,
  onEditorClose,
  ...props
}: TagsInlineEditorProps) => {
  const empty = !props.selectedTags || props.selectedTags.length === 0;
  const selectedTags = useMemo(() => {
    return props.selectedTags
      .map((id) => props.tags.find((tag) => tag.id === id))
      .filter((tag) => tag !== undefined);
  }, [props.selectedTags, props.tags]);

  // Read-only chips are display-only; keep that as behavior now that the
  // previous pointer-events CSS system has been removed.
  const triggerContent = empty ? (
    placeholder
  ) : (
    <InlineTagList
      {...props}
      title=""
      tags={selectedTags}
      onRemoved={undefined}
    />
  );
  const displayTrigger = (
    <Box
      className={className}
      data-empty={empty}
      data-readonly={readonly}
      display="flex"
      style={style}
      w={block ? "100%" : undefined}
      data-myoxus-ui-role="tags-inline-editor"
    >
      {triggerContent}
    </Box>
  );

  if (readonly) {
    return displayTrigger;
  }

  // Keep the Database cell's native trigger mounted when its first/last tag
  // changes, so Mantine can return focus to the same button after dismissal.
  const menuTrigger = block ? (
    <InlineContentTrigger
      className={className}
      data-empty={empty}
      data-readonly="false"
      style={style}
      data-myoxus-ui-role="tags-inline-editor"
    >
      {triggerContent}
    </InlineContentTrigger>
  ) : (
    displayTrigger
  );

  return (
    <Menu
      ref={ref}
      contentOptions={{
        side: "bottom",
        align: "start",
        panelWidth: menuPanelWidth ?? "large",
        className: menuClassName,
        onClick(e) {
          e.stopPropagation();
        },
      }}
      rootOptions={{
        modal: modalMenu,
        onClose: onEditorClose,
      }}
      items={<TagsEditor {...props} />}
    >
      {menuTrigger}
    </Menu>
  );
};

export const TagsInlineEditor = BUILD_CONFIG.isMobileEdition
  ? MobileInlineEditor
  : DesktopTagsInlineEditor;

export type WorkspaceTagsInlineEditorProps = Omit<
  TagsInlineEditorProps,
  | "tags"
  | "onCreateTag"
  | "onTagArchive"
  | "onRestoreTag"
  | "tagColors"
  | "onTagUpdate"
  | "onSelectTag"
  | "onDeselectTag"
> & {
  commit: WorkspaceTagAssignmentCommit;
  assignmentState?: TagAssignmentState;
};

const useWorkspaceTagsEditorBinding = ({
  selectedTags,
  commit,
  assignmentState: readState,
}: Pick<
  WorkspaceTagsInlineEditorProps,
  "selectedTags" | "commit" | "assignmentState"
>) => {
  const t = useI18n();
  const tagService = useService(TagService);
  const catalog = useLiveData(tagService.tagList.catalogState$);
  const catalogState =
    readState && readState.status !== "ready"
      ? { ...catalog, status: readState.status, error: readState.error }
      : catalog;
  const tags = useLiveData(tagService.tagList.tagMetas$);
  const commands = useWorkspaceTagCommands();
  const tagColors = useWorkspaceTagColorOptions();
  const commitRef = useRef(commit);
  commitRef.current = commit;
  const [assignmentController] = useState(
    () =>
      new WorkspaceTagAssignmentController(selectedTags, (nextIds) =>
        commitRef.current(nextIds),
      ),
  );
  const assignmentState = useLiveData(assignmentController.state$);
  const catalogError =
    catalogState.status === "error" ? catalogState.error : null;
  const assignmentError =
    assignmentState.status === "error" ? assignmentState.error : null;

  useEffect(() => {
    assignmentController.setConfirmedIds(selectedTags);
  }, [assignmentController, selectedTags]);

  const onSelectTag = useCallback(
    (tagId: string) => {
      assignmentController.select(tagId);
    },
    [assignmentController],
  );
  const onDeselectTag = useCallback(
    (tagId: string) => {
      assignmentController.deselect(tagId);
    },
    [assignmentController],
  );
  const onTagArchive = useCallback(
    async (tagId: string) => {
      await commands.archiveTags([tagId]);
    },
    [commands],
  );
  const onRestoreTag = useCallback(
    async (tagId: string) => {
      await commands.restoreTag(tagId);
    },
    [commands],
  );
  const onTagUpdate = useCallback(
    (id: string, metadata: TagMetadataUpdate) =>
      commands.updateTag(id, metadata),
    [commands],
  );
  const assignmentFeedback =
    assignmentState.status === "saving" ? (
      <Stack data-testid="workspace-tags-loading">
        <Loading />
      </Stack>
    ) : assignmentError ? (
      <Alert
        data-testid="workspace-tags-assignment-error"
        title={commands.errorMessage(assignmentError)}
      >
        <Button
          variant="secondary"
          onClick={() => assignmentController.retry()}
        >
          {t["Retry"]()}
        </Button>
      </Alert>
    ) : null;

  const showEditor =
    catalogState.status === "ready" ||
    catalogState.tags.length > 0 ||
    assignmentState.projectedIds.length > 0;
  const retryCatalog = useCallback(() => {
    void tagService.tagList.retryCatalog().catch(() => undefined);
  }, [tagService.tagList]);

  return {
    catalogError,
    catalogState,
    editorProps: {
      feedback: assignmentFeedback,
      lifecycleDisabled:
        assignmentState.status !== "idle" || catalogState.status !== "ready",
      onCreateTag: commands.createTag,
      onTagArchive,
      onDeselectTag,
      onRestoreTag,
      onSelectTag,
      onTagUpdate,
      selectedTags: assignmentState.projectedIds,
      tagColors,
      tags,
    },
    retryCatalog,
    showEditor,
  };
};

const WorkspaceTagsCatalogFeedback = ({
  catalogError,
  catalogState,
  retry,
}: {
  catalogError: unknown;
  catalogState: ReturnType<
    typeof useWorkspaceTagsEditorBinding
  >["catalogState"];
  retry: () => void;
}) => {
  const t = useI18n();

  if (catalogState.status === "ready") return null;

  return (
    <Stack data-myoxus-ui-role="workspace-tags-state">
      {catalogState.status === "loading" ? (
        <Stack data-testid="workspace-tags-loading">
          <Loading />
        </Stack>
      ) : null}
      {catalogError ? (
        <Alert
          data-testid="workspace-tags-catalog-error"
          title={t["com.myoxus.tags.catalog.load-failed"]()}
        >
          <Button variant="secondary" onClick={retry}>
            {t["Retry"]()}
          </Button>
        </Alert>
      ) : null}
    </Stack>
  );
};

export type WorkspaceTagsMenuEditorProps = Pick<
  WorkspaceTagsInlineEditorProps,
  "commit" | "jumpToTag" | "selectedTags" | "tagMode" | "assignmentState"
>;

/**
 * Server-bound tag assignment editor for an existing Facade menu/submenu.
 * The surrounding menu owns the trigger and panel placement; this component
 * retains the same catalog, lifecycle and serialized assignment authority as
 * WorkspaceTagsInlineEditor.
 */
export const WorkspaceTagsMenuEditor = ({
  commit,
  jumpToTag,
  selectedTags,
  tagMode,
  assignmentState,
}: WorkspaceTagsMenuEditorProps) => {
  const binding = useWorkspaceTagsEditorBinding({
    selectedTags,
    commit,
    assignmentState,
  });

  return (
    <>
      {binding.showEditor && binding.catalogState.status === "ready" ? (
        <TagsEditor
          {...binding.editorProps}
          jumpToTag={jumpToTag}
          tagMode={tagMode}
        />
      ) : null}
      <WorkspaceTagsCatalogFeedback
        catalogError={binding.catalogError}
        catalogState={binding.catalogState}
        retry={binding.retryCatalog}
      />
    </>
  );
};

export const WorkspaceTagsInlineEditor = ({
  selectedTags,
  commit,
  ref,
  onEditorClose,
  assignmentState,
  ...otherProps
}: WorkspaceTagsInlineEditorProps) => {
  const binding = useWorkspaceTagsEditorBinding({
    selectedTags,
    commit,
    assignmentState,
  });

  return (
    <>
      {binding.showEditor ? (
        <TagsInlineEditor
          {...binding.editorProps}
          {...otherProps}
          readonly={
            otherProps.readonly || binding.catalogState.status !== "ready"
          }
          ref={ref}
          onEditorClose={onEditorClose}
        />
      ) : null}
      <WorkspaceTagsCatalogFeedback
        catalogError={binding.catalogError}
        catalogState={binding.catalogState}
        retry={binding.retryCatalog}
      />
    </>
  );
};
