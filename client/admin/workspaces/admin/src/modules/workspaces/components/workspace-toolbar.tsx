/**
 * Workspace inventory search and server-side filters. Search and workspace
 * type stay directly accessible; secondary filters share one native popover.
 */
import { AdminWorkspaceSort, type FeatureType } from "@myoxus/graphql";
import { useI18n } from "@myoxus/i18n";
import { FilterIcon, SearchIcon, SortIcon } from "@myoxus/icons/react";
import {
  Badge,
  Button,
  FormSelect,
  IconButton,
  Input,
  Menu,
  MenuItem,
  MultiSelect,
  Popover,
  PopoverContent,
  PopoverTarget,
  SettingsCollectionToolbar,
  SettingsPanelTitle,
  Stack,
} from "@myoxus/ui-facade";
import { useMemo, useState } from "react";

import { useDebouncedSearch } from "../../../hooks/use-debounced-search";
import { useServerConfig } from "../../common";
import { adminEditableWorkspaceFeatures } from "../feature-visibility";
import type {
  WorkspaceFlagFilter,
  WorkspaceGitSyncFilter,
  WorkspaceTypeFilter,
} from "../schema";

/** Props for the workspaces filter and sort toolbar. */
interface WorkspaceToolbarProps {
  keyword: string;
  onKeywordChange: (keyword: string) => void;
  selectedFeatures: FeatureType[];
  onFeaturesChange: (features: FeatureType[]) => void;
  /** Active boolean flag filters. */
  flags: WorkspaceFlagFilter;
  onFlagsChange: (flags: WorkspaceFlagFilter) => void;
  /** Active workspace type filter. */
  typeFilter: WorkspaceTypeFilter;
  onTypeFilterChange: (type: WorkspaceTypeFilter) => void;
  /** Active Git Sync filter. */
  gitSyncFilter: WorkspaceGitSyncFilter;
  onGitSyncFilterChange: (filter: WorkspaceGitSyncFilter) => void;
  /** Active sort field. */
  sort: AdminWorkspaceSort | undefined;
  onSortChange: (sort: AdminWorkspaceSort | undefined) => void;
  /** When `true` all controls are disabled (loading state). */
  disabled?: boolean;
  /** Product-specific label for the shared feature filter trigger. */
  featureButtonLabel?: string;
}

export function WorkspaceToolbar({
  keyword,
  onKeywordChange,
  selectedFeatures,
  onFeaturesChange,
  flags,
  onFlagsChange,
  typeFilter,
  onTypeFilterChange,
  gitSyncFilter,
  onGitSyncFilterChange,
  sort,
  onSortChange,
  disabled = false,
  featureButtonLabel,
}: WorkspaceToolbarProps) {
  const i18n = useI18n();
  const [filtersOpen, setFiltersOpen] = useState(false);
  const { value, onTextChange } = useDebouncedSearch({
    keyword,
    onKeywordChange,
    delay: 400,
  });
  const serverConfig = useServerConfig();
  const availableFeatures = useMemo(
    () =>
      adminEditableWorkspaceFeatures(
        serverConfig?.availableWorkspaceFeatures ?? [],
      ),
    [serverConfig?.availableWorkspaceFeatures],
  );

  const sortOptions: { value: AdminWorkspaceSort; label: string }[] = useMemo(
    () => [
      {
        value: AdminWorkspaceSort.CreatedAt,
        label: i18n.t("admin.workspaces.sort.created-time"),
      },
      {
        value: AdminWorkspaceSort.BlobCount,
        label: i18n.t("admin.workspaces.sort.blob-count"),
      },
      {
        value: AdminWorkspaceSort.BlobSize,
        label: i18n.t("admin.workspaces.sort.blob-size"),
      },
      {
        value: AdminWorkspaceSort.SnapshotCount,
        label: i18n.t("admin.workspaces.sort.snapshot-count"),
      },
      {
        value: AdminWorkspaceSort.SnapshotSize,
        label: i18n.t("admin.workspaces.sort.snapshot-size"),
      },
      {
        value: AdminWorkspaceSort.MemberCount,
        label: i18n.t("admin.workspaces.sort.member-count"),
      },
      {
        value: AdminWorkspaceSort.PublicPageCount,
        label: i18n.t("admin.workspaces.sort.public-pages"),
      },
    ],
    [i18n],
  );

  const typeOptions: { value: WorkspaceTypeFilter; label: string }[] = useMemo(
    () => [
      { value: "all", label: i18n.t("admin.workspaces.type.all") },
      { value: "personal", label: i18n.t("admin.workspaces.type.personal") },
      {
        value: "user-owned",
        label: i18n.t("admin.workspaces.columns.user-owned"),
      },
      { value: "shared", label: i18n.t("admin.workspaces.type.shared") },
    ],
    [i18n],
  );

  const gitSyncOptions: { value: WorkspaceGitSyncFilter; label: string }[] =
    useMemo(
      () => [
        { value: "all", label: i18n.t("admin.workspaces.git-sync-filter.all") },
        {
          value: "enabled",
          label: i18n.t("admin.workspaces.git-sync-filter.enabled"),
        },
        {
          value: "disabled",
          label: i18n.t("admin.workspaces.git-sync-filter.disabled"),
        },
        {
          value: "completed",
          label: i18n.t("admin.workspaces.git-sync-filter.completed"),
        },
        {
          value: "failed",
          label: i18n.t("admin.workspaces.git-sync-filter.failed"),
        },
        {
          value: "running",
          label: i18n.t("admin.workspaces.git-sync-filter.running"),
        },
        {
          value: "pending",
          label: i18n.t("admin.workspaces.git-sync-filter.pending"),
        },
        {
          value: "cancelled",
          label: i18n.t("admin.workspaces.git-sync-filter.cancelled"),
        },
      ],
      [i18n],
    );

  const selectedSortLabel = useMemo(
    () =>
      sortOptions.find((option) => option.value === sort)?.label ??
      i18n.t("admin.workspaces.sort.created-time"),
    // oxlint-disable-next-line react/exhaustive-deps
    [sort, sortOptions],
  );

  const flagOptions: { key: keyof WorkspaceFlagFilter; label: string }[] =
    useMemo(
      () => [
        {
          key: "public",
          label: i18n.t("admin.workspaces.flags.public-filter"),
        },
        {
          key: "enableSharing",
          label: i18n.t("admin.workspaces.flags.enable-sharing-filter"),
        },
        {
          key: "enableAi",
          label: i18n.t("admin.workspaces.flags.enable-ai-filter"),
        },
        {
          key: "enableUrlPreview",
          label: i18n.t("admin.workspaces.flags.enable-url-preview-filter"),
        },
        {
          key: "enableDocEmbedding",
          label: i18n.t("admin.workspaces.flags.enable-doc-embedding-filter"),
        },
      ],
      [i18n],
    );

  const activeFeatures = selectedFeatures.filter((feature) =>
    availableFeatures.includes(feature),
  );
  const secondaryFilterCount =
    activeFeatures.length +
    Object.values(flags).filter((flag) => flag !== undefined).length +
    (gitSyncFilter === "all" ? 0 : 1);
  const hasFilters =
    Boolean(value.trim()) || typeFilter !== "all" || secondaryFilterCount > 0;

  return (
    <SettingsCollectionToolbar
      data-testid="workspace-filter-controls"
      search={
        <Input
          id="workspace-search-input"
          data-testid="workspace-search-input"
          placeholder={i18n.t("admin.workspaces.toolbar.search-placeholder")}
          aria-label={i18n.t("admin.common.search")}
          preFix={<SearchIcon aria-hidden />}
          value={value}
          onChange={onTextChange}
          disabled={disabled}
        />
      }
      filters={
        <>
          <Menu
            rootOptions={{ open: disabled ? false : undefined }}
            items={typeOptions.map((option) => (
              <MenuItem
                key={option.value}
                selected={option.value === typeFilter}
                disabled={disabled}
                onClick={() => onTypeFilterChange(option.value)}
              >
                {option.label}
              </MenuItem>
            ))}
          >
            <Button variant="secondary" disabled={disabled}>
              {i18n.t("admin.workspaces.toolbar.type-label", {
                label:
                  typeOptions.find((o) => o.value === typeFilter)?.label ??
                  i18n.t("admin.workspaces.type.all"),
              })}
            </Button>
          </Menu>
          <Popover
            opened={disabled ? false : filtersOpen}
            onChange={setFiltersOpen}
            position="bottom-end"
            returnFocus
          >
            <PopoverTarget>
              <Button
                variant="secondary"
                prefix={<FilterIcon aria-hidden />}
                suffix={
                  secondaryFilterCount ? (
                    <Badge tone="info">{secondaryFilterCount}</Badge>
                  ) : undefined
                }
                onClick={() => setFiltersOpen((open) => !open)}
                aria-expanded={filtersOpen && !disabled}
                disabled={disabled}
                data-testid="workspace-filters-trigger"
              >
                {i18n.t("admin.workspaces.toolbar.filter")}
              </Button>
            </PopoverTarget>
            <PopoverContent data-testid="workspace-filters-popover">
              <Stack>
                <SettingsPanelTitle>
                  {i18n.t("admin.workspaces.toolbar.filter")}
                </SettingsPanelTitle>
                <FormSelect
                  label={i18n.t("admin.workspaces.columns.git-sync")}
                  data={gitSyncOptions}
                  value={gitSyncFilter}
                  onChange={(next) =>
                    onGitSyncFilterChange(next as WorkspaceGitSyncFilter)
                  }
                  disabled={disabled}
                  comboboxProps={{ withinPortal: false }}
                />
                {flagOptions.map((option) => (
                  <FormSelect
                    key={option.key}
                    label={option.label}
                    data={[
                      {
                        value: "any",
                        label: i18n.t("admin.workspaces.toolbar.flag-any"),
                      },
                      {
                        value: "on",
                        label: i18n.t("admin.workspaces.toolbar.flag-on"),
                      },
                      {
                        value: "off",
                        label: i18n.t("admin.workspaces.toolbar.flag-off"),
                      },
                    ]}
                    value={
                      flags[option.key] === undefined
                        ? "any"
                        : flags[option.key]
                          ? "on"
                          : "off"
                    }
                    onChange={(next) =>
                      onFlagsChange({
                        ...flags,
                        [option.key]:
                          next === "any" ? undefined : next === "on",
                      })
                    }
                    disabled={disabled}
                    comboboxProps={{ withinPortal: false }}
                  />
                ))}
                {availableFeatures.length ? (
                  <MultiSelect
                    label={
                      featureButtonLabel ??
                      i18n.t("admin.workspaces.panel.features")
                    }
                    data={availableFeatures}
                    value={activeFeatures}
                    onChange={(features) =>
                      onFeaturesChange(features as FeatureType[])
                    }
                    disabled={disabled}
                    searchable
                    clearable
                    comboboxProps={{ withinPortal: false }}
                  />
                ) : null}
              </Stack>
            </PopoverContent>
          </Popover>
        </>
      }
      actions={
        <>
          <Menu
            rootOptions={{ open: disabled ? false : undefined }}
            items={sortOptions.map((option) => (
              <MenuItem
                key={option.value}
                selected={option.value === sort}
                disabled={disabled}
                onClick={() => onSortChange(option.value)}
              >
                {option.label}
              </MenuItem>
            ))}
          >
            <IconButton
              icon={<SortIcon aria-hidden />}
              tooltip={i18n.t("admin.workspaces.toolbar.sort-label", {
                label: selectedSortLabel,
              })}
              aria-label={i18n.t("admin.workspaces.toolbar.sort-label", {
                label: selectedSortLabel,
              })}
              disabled={disabled}
              data-testid="workspace-sort-trigger"
            />
          </Menu>
          {hasFilters ? (
            <Button
              variant="plain"
              disabled={disabled}
              data-testid="workspace-filters-reset"
              onClick={() => {
                // Cancel the local debounce as well as the server-bound filters.
                onTextChange("");
                onKeywordChange("");
                onFeaturesChange([]);
                onFlagsChange({});
                onTypeFilterChange("all");
                onGitSyncFilterChange("all");
                setFiltersOpen(false);
              }}
            >
              {i18n.t("admin.actions.reset")}
            </Button>
          ) : null}
        </>
      }
    />
  );
}
