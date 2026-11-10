/**
 * Saved-filter bar — the horizontal list of saved filter shortcuts at the top
 * of the all-docs view.
 *
 * Saved filters are user-specific workspace preferences backed by
 * `WorkspaceLocalState`, not collections. Collections remain their own
 * workspace-level concept and must not be created by this all-docs filter bar.
 *
 * Exports:
 * - `SavedFilterItem` — one saved-filter pill backed by local user state.
 * - `AllDocsSavedFilters` — the full all-docs saved-filter bar.
 */
import { AddFilterMenu } from "@myoxus/core/components/filter/add-filter";
import type { ExplorerPreviewSize } from "@myoxus/core/components/explorer/types";
import { useWorkspaceTagCommands } from "@myoxus/core/components/tags";
import type { AllDocsSavedFilter } from "@myoxus/core/modules/all-docs";
import type { FilterParams } from "@myoxus/core/modules/collection-rules";
import { TagService } from "@myoxus/core/modules/tag";
import { useI18n } from "@myoxus/i18n";
import {
  AddTagIcon,
  CloseIcon,
  EditIcon,
  FilterIcon,
  TagsIcon,
} from "@myoxus/icons/react";
import { useLiveData, useService } from "@myoxus/infra";
import {
  FilterBar,
  FilterBarSpacer,
  FilterChip,
  FilterChipTrigger,
  Group,
  IconButton,
  Menu,
  MyoxusSegmentedControl,
  Text,
  Tooltip,
  usePromptModal,
} from "@myoxus/ui-facade";
import { type ReactNode, useCallback, useState } from "react";

/**
 * A single saved-filter pill in the all-docs filter bar.
 *
 * Shows the saved filter name. When active, also shows a close button that
 * removes the local saved filter and selects the previous saved filter (or all
 * documents if none exists).
 *
 * @param isActive - Whether this pill is the currently selected filter.
 * @param onClick - Called when the pill is clicked to activate the saved filter.
 * @param onClickRemove - Called when the close button is clicked.
 */
export const SavedFilterItem = ({
  savedFilter,
  isActive,
  onClick,
  onClickRemove,
}: {
  savedFilter: AllDocsSavedFilter;
  onClickRemove: () => void;
  isActive: boolean;
  onClick: () => void;
}) => {
  const t = useI18n();
  return (
    <FilterChip active={isActive} data-myoxus-ui-role="saved-filter-chip">
      <FilterChipTrigger
        tone={isActive ? "primary" : "secondary"}
        onClick={onClick}
      >
        {savedFilter.name || t["Untitled"]()}
      </FilterChipTrigger>
      {isActive && (
        <IconButton
          aria-label={t["com.myoxus.common.remove"]()}
          onClick={(e) => {
            e.stopPropagation();
            onClickRemove();
          }}
        >
          <CloseIcon />
        </IconButton>
      )}
    </FilterChip>
  );
};

/**
 * Horizontal all-docs filter bar.
 *
 * Renders the all-documents scope, explicit ad-hoc filter control, saved filter
 * shortcuts, and saved-filter editing. Do not route saved filters through
 * collection dialogs or collection persistence; that makes personal filters
 * look like shared workspace objects.
 *
 * @param activeSavedFilterId - ID of the currently selected saved filter, or
 *   `null` when no personal saved filter is active.
 * @param allActive - Whether the "All" quick-filter is active.
 * @param onActiveAll - Called when the "All" pill is clicked.
 * @param onAddFilter - Called with initial filter params when the user selects
 *   a property from the filter menu.
 * @param hiddenAdd - When `true` the filter and saved-filter controls are
 *   hidden while a temporary filter is being edited.
 */
export const AllDocsSavedFilters = ({
  activeSavedFilterId,
  allActive,
  tagsActive,
  savedFilters,
  onActiveAll,
  onActiveTags,
  onActiveSavedFilter,
  onEditSavedFilter,
  onRemoveSavedFilter,
  onAddFilter,
  createAction,
  previewSize,
  onPreviewSizeChange,
  hiddenAdd,
}: {
  activeSavedFilterId: string | null;
  allActive: boolean;
  tagsActive: boolean;
  savedFilters: AllDocsSavedFilter[];
  onActiveAll: () => void;
  onActiveTags: () => void;
  onActiveSavedFilter: (savedFilterId: string) => void;
  onEditSavedFilter: () => void;
  onRemoveSavedFilter: (savedFilterId: string) => void;
  onAddFilter: (params: FilterParams) => void;
  createAction: ReactNode;
  previewSize?: ExplorerPreviewSize;
  onPreviewSizeChange: (size: ExplorerPreviewSize) => void;
  hiddenAdd?: boolean;
}) => {
  const t = useI18n();
  const tagService = useService(TagService);
  const tagCommands = useWorkspaceTagCommands();
  const catalogState = useLiveData(tagService.tagList.catalogState$);
  const { openPromptModal } = usePromptModal();
  const handleCreateTag = useCallback(() => {
    openPromptModal({
      title: t["com.myoxus.rootAppSidebar.tags.new-tag"](),
      inputOptions: {
        "aria-label": t["com.myoxus.rootAppSidebar.tags.new-tag"](),
        placeholder: t["com.myoxus.tags.create-tag.placeholder"](),
      },
      confirmText: t["Create"](),
      cancelText: t["Cancel"](),
      onConfirm: async (name) => {
        await tagCommands.createTag(name, tagService.randomTagColor());
      },
    });
  }, [openPromptModal, t, tagCommands, tagService]);

  return (
    <FilterBar data-myoxus-ui-role="saved-filter-bar">
      {createAction}
      <FilterChip active={allActive} data-myoxus-ui-role="all-documents-chip">
        <FilterChipTrigger
          tone={allActive ? "primary" : "secondary"}
          onClick={() => {
            // Avoid resetting the route when the All scope is already active.
            if (!allActive) {
              onActiveAll();
            }
          }}
        >
          {t["All content"]()}
        </FilterChipTrigger>
      </FilterChip>
      <FilterChip active={tagsActive} data-myoxus-ui-role="all-tags-chip">
        <FilterChipTrigger
          prefix={<TagsIcon />}
          tone={tagsActive ? "primary" : "secondary"}
          onClick={() => {
            if (!tagsActive) {
              onActiveTags();
            }
          }}
        >
          {t["Tags"]()}
        </FilterChipTrigger>
        {tagsActive ? (
          <IconButton
            aria-label={t["com.myoxus.rootAppSidebar.tags.new-tag"]()}
            disabled={catalogState.status !== "ready"}
            icon={<AddTagIcon />}
            onClick={(event) => {
              event.stopPropagation();
              handleCreateTag();
            }}
            size="small"
            tooltip={t["com.myoxus.rootAppSidebar.tags.new-tag"]()}
          />
        ) : null}
      </FilterChip>
      {!hiddenAdd && <AddAdHocFilter onAddFilter={onAddFilter} />}
      {savedFilters.map((savedFilter) => (
        <SavedFilterItem
          key={savedFilter.id}
          savedFilter={savedFilter}
          isActive={activeSavedFilterId === savedFilter.id}
          onClick={() => {
            if (activeSavedFilterId !== savedFilter.id) {
              onActiveSavedFilter(savedFilter.id);
            }
          }}
          onClickRemove={() => {
            onRemoveSavedFilter(savedFilter.id);
          }}
        />
      ))}
      {activeSavedFilterId && (
        <Tooltip content={t["com.myoxus.all-docs.saved-filters.edit"]()}>
          <IconButton
            aria-label={t["com.myoxus.all-docs.saved-filters.edit"]()}
            onClick={() => {
              onEditSavedFilter();
            }}
          >
            <EditIcon />
          </IconButton>
        </Tooltip>
      )}
      {previewSize ? (
        <>
          <FilterBarSpacer />
          <Group wrap="nowrap">
            <Text component="span">
              {t["com.myoxus.common.preview-size"]()}
            </Text>
            <MyoxusSegmentedControl
              aria-label={t["com.myoxus.common.preview-size"]()}
              data-myoxus-ui-role="all-docs-preview-size"
              value={previewSize}
              data={[
                {
                  value: "compact",
                  label: t["com.myoxus.common.preview-size.compact"](),
                },
                {
                  value: "normal",
                  label: t["com.myoxus.common.preview-size.normal"](),
                },
                {
                  value: "large",
                  label: t["com.myoxus.common.preview-size.large"](),
                },
              ]}
              onChange={(value) =>
                onPreviewSizeChange(value as ExplorerPreviewSize)
              }
            />
          </Group>
        </>
      ) : null}
    </FilterBar>
  );
};

/**
 * Explicit ad-hoc filter control.
 *
 * This owns the funnel icon path. Saved-filter shortcut management stays in
 * the separate "+" menu so the all-docs toolbar cannot imply that creating a
 * saved filter and adding a temporary filter are the same action.
 */
export const AddAdHocFilter = ({
  onAddFilter,
}: {
  onAddFilter: (params: FilterParams) => void;
}) => {
  const t = useI18n();
  const [open, setOpen] = useState(false);
  return (
    <Menu
      rootOptions={{
        closeOnItemClick: false,
        open,
        onOpenChange: setOpen,
      }}
      items={
        <AddFilterMenu
          includeAllPagesOnly
          onAdd={(params) => {
            onAddFilter(params);
            setOpen(false);
          }}
        />
      }
    >
      <FilterChipTrigger
        prefix={<FilterIcon />}
        aria-label={t["com.myoxus.filter"]()}
        data-myoxus-ui-role="all-docs-filter-trigger"
      >
        {t["com.myoxus.filter"]()}
      </FilterChipTrigger>
    </Menu>
  );
};
