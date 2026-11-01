/**
 * Templates — Catalog tab.
 *
 * Displays the central list of all templates with their metadata.
 * Fetches live data from the templateRegistry GraphQL API.
 * Each row has an action dropdown for archive, disable/enable, and export.
 * Native selection controls narrow the loaded catalog by source and category.
 */
import { useI18n } from "@myoxus/i18n";
import {
  ArchiveIcon,
  DownloadIcon,
  ExternalLinkIcon,
  MoreHorizontalIcon,
  PowerIcon,
  PowerOffIcon,
  RefreshCwIcon,
  XIcon,
} from "@myoxus/icons/react";
import {
  Button,
  Group,
  FormSelect,
  IconButton,
  Input,
  InlineActionButton,
  Menu,
  MenuItem,
  MenuSeparator,
  notify,
  SettingsCollectionToolbar,
  SettingsEmptyState,
  SettingsNotice,
  SettingsHeadingGroup,
  SettingsSectionHeading,
  SettingsSectionDescription,
  SettingsListItemMeta,
  SettingsListItemTitle,
  MonoText,
  SettingsSkeleton,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  Pagination,
} from "@myoxus/ui-facade";
import { useCallback, useMemo, useRef, useState } from "react";

import {
  archiveTemplate,
  disableTemplate,
  enableTemplate,
  useTemplateCatalogQuery,
} from "./api";
import {
  type TemplateSource,
  TemplateSourceBadge,
  type TemplateStatus,
  TemplateStatusBadge,
  templateStatusKind,
} from "./badges";
import { withTemplateErrorContext } from "./error-utils";
import type { CatalogEntryViewModel } from "./format-adapters";
import {
  templateCatalogCardCode,
  templateDisplayDescription,
  templateDisplayTags,
  templateDisplayTitle,
  translateTemplateCategory,
} from "./localized-builtins";
import { TemplateDetailDrawer } from "./template-detail-drawer";
import { WorkspaceSourceExportDialog } from "./workspace-source-export-dialog";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function CatalogSkeleton() {
  return <SettingsSkeleton />;
}

export function templateCatalogCountLabel(
  language: string | undefined,
  count: number,
) {
  const lang = language?.split("-")[0]?.toLowerCase();
  const plural = (locale: string) => new Intl.PluralRules(locale).select(count);
  const fromForms = (
    locale: string,
    forms: Partial<Record<Intl.LDMLPluralRule, string>> & { other: string },
  ) => `${count} ${forms[plural(locale)] ?? forms.other}`;

  switch (lang) {
    case "de":
      return `${count} ${count === 1 ? "Vorlage" : "Vorlagen"}`;
    case "fr":
      return `${count} ${count === 1 ? "modèle" : "modèles"}`;
    case "es":
      return `${count} ${count === 1 ? "plantilla" : "plantillas"}`;
    case "it":
      return `${count} ${count === 1 ? "modello" : "modelli"}`;
    case "ca":
      return `${count} ${count === 1 ? "plantilla" : "plantilles"}`;
    case "cs":
      return fromForms("cs", {
        one: "šablona",
        few: "šablony",
        other: "šablon",
      });
    case "el":
      return `${count} ${count === 1 ? "πρότυπο" : "πρότυπα"}`;
    case "hr":
      return fromForms("hr", {
        one: "predložak",
        few: "predloška",
        other: "predložaka",
      });
    case "hu":
      return `${count} sablon`;
    case "nb":
      return `${count} ${count === 1 ? "mal" : "maler"}`;
    case "nl":
      return `${count} ${count === 1 ? "sjabloon" : "sjablonen"}`;
    case "pl":
      return fromForms("pl", {
        one: "szablon",
        few: "szablony",
        many: "szablonów",
        other: "szablonu",
      });
    case "pt":
      return `${count} ${count === 1 ? "modelo" : "modelos"}`;
    case "ro":
      return `${count} ${count === 1 ? "șablon" : "șabloane"}`;
    case "ru":
      return fromForms("ru", {
        one: "шаблон",
        few: "шаблона",
        many: "шаблонов",
        other: "шаблона",
      });
    case "sk":
      return fromForms("sk", {
        one: "šablóna",
        few: "šablóny",
        other: "šablón",
      });
    case "sr":
      return fromForms("sr", {
        one: "šablon",
        few: "šablona",
        other: "šablona",
      });
    case "sv":
      return `${count} ${count === 1 ? "mall" : "mallar"}`;
    case "uk":
      return fromForms("uk", {
        one: "шаблон",
        few: "шаблони",
        many: "шаблонів",
        other: "шаблону",
      });
    default:
      return `${count} ${count === 1 ? "template" : "templates"}`;
  }
}

// ---------------------------------------------------------------------------
// Row Actions
// ---------------------------------------------------------------------------

interface RowActionsProps {
  entry: {
    id: string;
    slug: string;
    title: string;
    source: TemplateSource;
    status: TemplateStatus;
  };
  onRefresh: () => void;
  onDetails: (trigger: HTMLButtonElement | null) => void;
}

function CatalogRowActions({ entry, onRefresh, onDetails }: RowActionsProps) {
  const triggerRef = useRef<HTMLButtonElement>(null);
  const i18n = useI18n();
  const displayTitle = templateDisplayTitle(i18n, entry);

  const handleArchive = useCallback(async () => {
    try {
      await archiveTemplate(entry.id);
      notify.success({
        title: i18n.t("admin.templates.catalog.toast.archived", {
          title: displayTitle,
        }),
      });
      onRefresh();
    } catch (e: unknown) {
      notify.error({
        title: withTemplateErrorContext(
          i18n.t("admin.templates.catalog.toast.archive-failed"),
          e,
        ),
      });
    }
  }, [entry.id, displayTitle, onRefresh, i18n]);

  const handleToggleDisable = useCallback(async () => {
    const isDisabled = templateStatusKind(entry.status) === "disabled";
    try {
      if (isDisabled) {
        await enableTemplate(entry.id);
        notify.success({
          title: i18n.t("admin.templates.catalog.toast.enabled", {
            title: displayTitle,
          }),
        });
      } else {
        await disableTemplate(entry.id);
        notify.success({
          title: i18n.t("admin.templates.catalog.toast.disabled", {
            title: displayTitle,
          }),
        });
      }
      onRefresh();
    } catch (e: unknown) {
      notify.error({
        title: withTemplateErrorContext(
          i18n.t("admin.templates.catalog.toast.toggle-failed", {
            action: isDisabled
              ? i18n.t("admin.common.enable")
              : i18n.t("admin.common.disable"),
          }),
          e,
        ),
      });
    }
  }, [entry.id, entry.status, displayTitle, onRefresh, i18n]);

  const handleExport = useCallback(() => {
    notify.warning({
      title: i18n.t("admin.templates.catalog.toast.export-unavailable"),
    });
  }, [i18n]);

  const isDisabled = templateStatusKind(entry.status) === "disabled";

  return (
    <Menu
      contentOptions={{ align: "end" }}
      items={
        <>
          <MenuItem
            prefixIcon={<ExternalLinkIcon />}
            onSelect={() => onDetails(triggerRef.current)}
            data-testid="templates-row-menu-details"
          >
            {i18n.t("admin.common.details")}
          </MenuItem>
          <MenuSeparator />
          <MenuItem prefixIcon={<DownloadIcon />} onSelect={handleExport}>
            {i18n.t("admin.templates.catalog.action.export-latest")}
          </MenuItem>
          <MenuSeparator />
          <MenuItem
            prefixIcon={isDisabled ? <PowerIcon /> : <PowerOffIcon />}
            onSelect={handleToggleDisable}
          >
            {isDisabled
              ? i18n.t("admin.common.enable")
              : i18n.t("admin.common.disable")}
          </MenuItem>
          <MenuItem
            type="danger"
            prefixIcon={<ArchiveIcon />}
            onSelect={handleArchive}
          >
            {i18n.t("admin.templates.catalog.action.archive")}
          </MenuItem>
        </>
      }
    >
      <IconButton
        aria-label={i18n.t("admin.common.open-menu")}
        tooltip={i18n.t("admin.common.open-menu")}
        ref={triggerRef}
        data-testid="templates-row-menu-trigger"
      >
        <MoreHorizontalIcon />
      </IconButton>
    </Menu>
  );
}

// ---------------------------------------------------------------------------
// Filter chip types
// ---------------------------------------------------------------------------

type SourceFilter = "all" | "Bundle" | "Builtin";
const ALL_CATEGORIES = "__all_categories__";

// ---------------------------------------------------------------------------
// Content (inside Suspense)
// ---------------------------------------------------------------------------

function CatalogContent() {
  const i18n = useI18n();
  const [pageNum, setPageNum] = useState(0);
  const {
    entries,
    totalCount,
    isLoading: catalogLoading,
    error: catalogError,
    mutate,
  } = useTemplateCatalogQuery(
    {
      skip: pageNum * 50,
      take: 50,
    },
    { suspense: false },
  );
  const [sourceFilter, setSourceFilter] = useState<SourceFilter>("all");
  const [categoryFilter, setCategoryFilter] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [detailEntry, setDetailEntry] = useState<CatalogEntryViewModel | null>(
    null,
  );
  const [detailOpen, setDetailOpen] = useState(false);
  const detailTriggerRef = useRef<HTMLElement | null>(null);
  // Mount on first use and retain the frame while closing so Mantine can
  // finish its transition and return focus to the durable toolbar action.
  const [workspaceExportOpen, setWorkspaceExportOpen] = useState<
    boolean | null
  >(null);
  const workspaceExportTriggerRef = useRef<HTMLButtonElement>(null);

  const handleRefresh = useCallback(() => {
    // SWR retains the failure for the notice; retry must not also reject an
    // unobserved event-handler promise.
    void mutate(undefined, { throwOnError: false });
  }, [mutate]);

  const openDetail = useCallback(
    (entry: CatalogEntryViewModel, trigger: HTMLElement | null) => {
      // The menu item unmounts before the drawer closes; retain its durable trigger.
      detailTriggerRef.current = trigger;
      setDetailEntry(entry);
      setDetailOpen(true);
    },
    [],
  );

  const categories = useMemo(
    () =>
      Array.from(
        new Set(
          entries.map((e: any) => e.category).filter(Boolean) as string[],
        ),
      ).sort(),
    [entries],
  );

  const filtered = useMemo(
    () =>
      entries.filter((e: CatalogEntryViewModel) => {
        if (sourceFilter !== "all" && e.source !== sourceFilter) return false;
        if (categoryFilter !== null && e.category !== categoryFilter)
          return false;
        const text = [
          templateDisplayTitle(i18n, e),
          templateDisplayDescription(i18n, e),
          e.slug,
          translateTemplateCategory(i18n, e.category),
          ...templateDisplayTags(i18n, e),
        ]
          .join(" ")
          .toLocaleLowerCase();
        return text.includes(search.trim().toLocaleLowerCase());
      }),
    [entries, sourceFilter, categoryFilter, search, i18n],
  );

  const hasFilters =
    sourceFilter !== "all" || categoryFilter !== null || search.trim() !== "";
  const clearFilters = () => {
    setSourceFilter("all");
    setCategoryFilter(null);
    setSearch("");
  };

  if (catalogLoading && !catalogError && entries.length === 0) {
    return <CatalogSkeleton />;
  }

  return (
    <Stack component="section" data-myoxus-ui-role="template-tab-frame">
      <SettingsHeadingGroup>
        <SettingsSectionHeading level={2}>
          {i18n.t("admin.templates.catalog.title")}
        </SettingsSectionHeading>
        {!catalogError && (
          <SettingsSectionDescription>
            {i18n.t("admin.templates.catalog.description", {
              // Count labels are built in code so every locale receives the same
              // interpolation token without leaking English suffixes into UI text.
              countLabel: templateCatalogCountLabel(i18n.language, totalCount),
            })}
          </SettingsSectionDescription>
        )}
      </SettingsHeadingGroup>
      <SettingsCollectionToolbar
        search={
          <Input
            value={search}
            onChange={setSearch}
            placeholder={i18n.t("admin.templates.catalog.filter.page-search")}
            aria-label={i18n.t("admin.templates.catalog.filter.page-search")}
          />
        }
        filters={
          <>
            <FormSelect
              value={sourceFilter}
              aria-label={i18n.t("admin.templates.catalog.filter.label")}
              allowDeselect={false}
              onChange={(value) => setSourceFilter(value as SourceFilter)}
              data={[
                {
                  value: "all",
                  label: i18n.t("admin.templates.catalog.filter.source.all"),
                },
                {
                  value: "Bundle",
                  label: i18n.t("admin.templates.source.bundle"),
                },
                {
                  value: "Builtin",
                  label: i18n.t("admin.templates.source.builtin"),
                },
              ]}
            />
            {categories.length > 0 && (
              <FormSelect
                aria-label={i18n.t("admin.templates.catalog.col.category")}
                value={categoryFilter ?? ALL_CATEGORIES}
                allowDeselect={false}
                onChange={(value) =>
                  setCategoryFilter(value === ALL_CATEGORIES ? null : value)
                }
                data={[
                  {
                    value: ALL_CATEGORIES,
                    label: i18n.t(
                      "admin.templates.catalog.filter.category.all",
                    ),
                  },
                  ...categories.map((value) => ({
                    value,
                    label: translateTemplateCategory(i18n, value),
                  })),
                ]}
              />
            )}
          </>
        }
        actions={
          <>
            <Button
              ref={workspaceExportTriggerRef}
              onClick={() => setWorkspaceExportOpen(true)}
            >
              <DownloadIcon aria-hidden />
              {i18n.t("admin.templates.export.from-workspace")}
            </Button>
            {!catalogError && (
              <SettingsListItemMeta>
                {i18n.t("admin.templates.catalog.metric.visible")}:{" "}
                {new Intl.NumberFormat(i18n.language).format(filtered.length)}
              </SettingsListItemMeta>
            )}
            <IconButton
              tooltip={i18n.t("admin.common.refresh")}
              onClick={handleRefresh}
            >
              <RefreshCwIcon aria-hidden />
            </IconButton>
            <IconButton
              tooltip={i18n.t("admin.templates.catalog.filter.clear")}
              disabled={!hasFilters}
              onClick={clearFilters}
            >
              <XIcon aria-hidden />
            </IconButton>
          </>
        }
      />

      {catalogError ? (
        <SettingsNotice
          tone="error"
          title={i18n.t("com.myoxus.settings.common.load-error")}
        >
          <Stack>
            {catalogError.message}
            <Group>
              <Button onClick={handleRefresh} disabled={catalogLoading}>
                {i18n.t("admin.error.retry")}
              </Button>
            </Group>
          </Stack>
        </SettingsNotice>
      ) : entries.length === 0 ? (
        <SettingsEmptyState
          title={i18n.t("admin.templates.catalog.empty-title")}
          description={i18n.t("admin.templates.catalog.empty-hint")}
        />
      ) : filtered.length === 0 ? (
        <SettingsEmptyState
          title={i18n.t("admin.templates.catalog.filter.no-results")}
        />
      ) : (
        <Table
          aria-label={i18n.t("admin.templates.catalog.title")}
          data-testid="templates-catalog-table"
        >
          <TableHeader>
            <TableRow>
              <TableHead>
                {i18n.t("admin.templates.catalog.col.title")}
              </TableHead>
              <TableHead>
                {i18n.t("admin.templates.catalog.col.category")}
              </TableHead>
              <TableHead>
                {i18n.t("admin.templates.catalog.col.source")}
              </TableHead>
              <TableHead>{i18n.t("admin.common.status")}</TableHead>
              <TableHead>{i18n.t("admin.common.actions")}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {filtered.map((entry: CatalogEntryViewModel) => {
              const displayTitle = templateDisplayTitle(i18n, entry);
              const displayDescription = templateDisplayDescription(
                i18n,
                entry,
              );
              return (
                <TableRow key={entry.id}>
                  <TableCell>
                    <InlineActionButton
                      onClick={(event) =>
                        openDetail(entry, event.currentTarget)
                      }
                    >
                      <SettingsListItemTitle>
                        {displayTitle}
                      </SettingsListItemTitle>
                    </InlineActionButton>
                    {displayDescription ? (
                      <SettingsListItemMeta lineClamp={2}>
                        {displayDescription}
                      </SettingsListItemMeta>
                    ) : null}
                    {templateCatalogCardCode(entry) ? (
                      <SettingsListItemMeta>
                        <MonoText>{templateCatalogCardCode(entry)}</MonoText>
                      </SettingsListItemMeta>
                    ) : null}
                  </TableCell>
                  <TableCell>
                    {translateTemplateCategory(i18n, entry.category)}
                  </TableCell>
                  <TableCell>
                    <TemplateSourceBadge
                      source={entry.source as TemplateSource}
                    />
                  </TableCell>
                  <TableCell>
                    <TemplateStatusBadge
                      status={entry.status as TemplateStatus}
                    />
                  </TableCell>
                  <TableCell>
                    <CatalogRowActions
                      entry={entry}
                      onRefresh={handleRefresh}
                      onDetails={(trigger) => openDetail(entry, trigger)}
                    />
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      )}

      <TemplateDetailDrawer
        entry={detailEntry}
        returnFocusRef={detailTriggerRef}
        open={detailOpen}
        onOpenChange={setDetailOpen}
      />
      {workspaceExportOpen !== null ? (
        <WorkspaceSourceExportDialog
          open={workspaceExportOpen}
          onOpenChange={setWorkspaceExportOpen}
          returnFocusRef={workspaceExportTriggerRef}
        />
      ) : null}
      {totalCount > 50 ? (
        <Pagination
          totalCount={totalCount}
          countPerPage={50}
          pageNum={pageNum}
          disabled={catalogLoading}
          onPageChange={(_skip, nextPage) => {
            clearFilters();
            setPageNum(nextPage);
          }}
        />
      ) : null}
    </Stack>
  );
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function CatalogTab() {
  return <CatalogContent />;
}
