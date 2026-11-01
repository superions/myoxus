/**
 * @file PDF export module — Templates tab.
 *
 * Lists every PDF template in the registry with source/version/status
 * badges and a row-action menu (Inspect, Rename, Soft-delete). Includes
 * a toggle to show soft-deleted rows for diagnostic recovery.
 *
 * The centrepiece of the PDF-Export-V2 admin UI — operators upload new
 * templates here, inspect manifest+capabilities of existing ones, and
 * archive (soft-delete) templates they no longer want assigned.
 *
 * Source-of-truth contract:
 *  - GraphQL query: `admin { pdfTemplates(includeDeleted) }`
 *  - GraphQL mutations: `admin { uploadPdfTemplate,
 *    updatePdfTemplateMetadata, deletePdfTemplate }`
 *  - Server resolver: `crates/api/src/graphql/pdf_template_admin.rs`
 *  - Manifest schema: `docs/dev/server/pdf-export-v2-architecture.md` §1.2
 */
import { useI18n } from "@myoxus/i18n";
import {
  ArchiveIcon,
  EyeIcon,
  MoreHorizontalIcon,
  PencilIcon,
  PlusIcon,
  RefreshCwIcon,
  XIcon,
} from "@myoxus/icons/react";
import {
  Button,
  IconButton,
  InlineActionButton,
  Input,
  MonoText,
  FormSelect,
  SettingsCollectionToolbar,
  Table,
  TableHeader,
  TableHead,
  TableBody,
  TableRow,
  TableCell,
  Menu,
  MenuItem,
  MenuSeparator,
  notify,
  SettingsListItemMeta,
  SettingsListItemTitle,
  SettingsSection,
  SettingsSkeleton,
  SettingsStatusText,
  Stack,
} from "@myoxus/ui-facade";
import { Suspense, useCallback, useMemo, useState } from "react";

import { AdminConfirmModal } from "../../../components/shared/admin-confirm-modal";
import { formatAdminDateTime } from "../../../utils/locale-format";
import {
  useDeletePdfTemplateMutation,
  usePdfTemplateAssignedWorkspacesQuery,
  usePdfTemplatesQuery,
} from "../api";
import { PdfTemplateSourceBadge, PdfTemplateStatusBadge } from "../badges";
import {
  adaptPdfTemplate,
  type PdfTemplateRaw,
  type PdfTemplateViewModel,
} from "../format-adapters";
import { logPdfExportUiEvent } from "../logging";
import { EmptyState as RoleEmptyState } from "../pdf-role-primitives";
import {
  pdfTemplateDisplayName,
  pdfTemplateSearchText,
} from "../template-localization";
import { TemplateDetailDrawer } from "./template-detail-drawer";
import { UploadTemplateDialog } from "./upload-template-dialog";

// ---------------------------------------------------------------------------
// Skeleton
// ---------------------------------------------------------------------------

function TemplatesTabSkeleton() {
  return <SettingsSkeleton />;
}

// ---------------------------------------------------------------------------
// Empty state
// ---------------------------------------------------------------------------

function TemplateEmptyState({ filtered }: { filtered: boolean }) {
  const i18n = useI18n();
  return (
    <RoleEmptyState
      title={
        filtered
          ? i18n.t("admin.pdf-export.list.empty-filtered")
          : i18n.t("admin.pdf-export.list.empty")
      }
    />
  );
}

// ---------------------------------------------------------------------------
// Row actions
// ---------------------------------------------------------------------------

function RowActions({
  template,
  onInspect,
  onRequestDelete,
}: {
  template: PdfTemplateViewModel;
  onInspect: () => void;
  onRequestDelete: () => void;
}) {
  const i18n = useI18n();

  return (
    <Menu
      contentOptions={{ align: "end" }}
      items={
        <>
          <MenuItem prefixIcon={<EyeIcon aria-hidden />} onSelect={onInspect}>
            {i18n.t("admin.pdf-export.action.inspect")}
          </MenuItem>
          <MenuItem
            prefixIcon={<PencilIcon aria-hidden />}
            onSelect={onInspect}
          >
            {i18n.t("admin.pdf-export.action.rename")}
          </MenuItem>
          <MenuSeparator />
          <MenuItem
            type="danger"
            prefixIcon={<ArchiveIcon aria-hidden />}
            disabled={template.isDeleted}
            onSelect={onRequestDelete}
          >
            {i18n.t("admin.pdf-export.action.delete")}
          </MenuItem>
        </>
      }
    >
      <IconButton
        aria-label={i18n.t("admin.pdf-export.row-actions")}
        tooltip={i18n.t("admin.pdf-export.row-actions")}
        icon={<MoreHorizontalIcon aria-hidden />}
      />
    </Menu>
  );
}

function DeleteTemplateAdminConfirmModal({
  template,
  onClose,
  onDeleted,
}: {
  template: PdfTemplateViewModel;
  onClose: () => void;
  onDeleted: () => void;
}) {
  const i18n = useI18n();
  const deleteMutation = useDeletePdfTemplateMutation();
  const assignmentQuery = usePdfTemplateAssignedWorkspacesQuery(template.id);
  const assignments = assignmentQuery.assignments ?? [];
  const displayName = pdfTemplateDisplayName(template, i18n.t);

  const handleDelete = useCallback(async () => {
    try {
      logPdfExportUiEvent("template.delete.confirmed", {
        templateId: template.id,
        slug: template.slug,
        assignedWorkspaceCount: assignments.length,
      });
      await deleteMutation.trigger({ id: template.id });
      notify.success({ title: i18n.t("admin.pdf-export.delete.success") });
      onDeleted();
      onClose();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logPdfExportUiEvent(
        "template.delete.failed",
        { templateId: template.id, slug: template.slug, error: message },
        "error",
      );
      notify.error({
        title: i18n.t("admin.pdf-export.delete.failed"),
        message,
      });
    }
  }, [assignments.length, deleteMutation, i18n, onClose, onDeleted, template]);

  return (
    <AdminConfirmModal
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title={i18n.t("admin.pdf-export.delete.title")}
      description={
        <Stack>
          <p>
            {i18n
              .t("admin.pdf-export.delete.description")
              .replace("{{name}}", displayName)}
          </p>
          <SettingsSection
            title={i18n.t("admin.pdf-export.delete.affected-workspaces")}
          >
            {assignmentQuery.isLoading ? (
              <SettingsStatusText>
                {i18n.t("admin.pdf-export.delete.loading-assignments")}
              </SettingsStatusText>
            ) : assignments.length === 0 ? (
              <SettingsStatusText>
                {i18n.t("admin.pdf-export.delete.no-assignments")}
              </SettingsStatusText>
            ) : (
              <Stack component="ul">
                {assignments.map((assignment) => (
                  <li key={assignment.workspaceId}>
                    {assignment.workspaceId}
                    {assignment.isDefault
                      ? ` ${i18n.t("admin.pdf-export.delete.default-marker")}`
                      : ""}
                  </li>
                ))}
              </Stack>
            )}
          </SettingsSection>
        </Stack>
      }
      cancelText={i18n.t("admin.common.cancel")}
      confirmText={i18n.t("admin.pdf-export.action.delete")}
      danger
      onConfirm={handleDelete}
      onCancel={onClose}
    />
  );
}

type SourceFilter = "all" | "system" | "admin";
type StatusFilter = "active" | "deleted" | "all";

// ---------------------------------------------------------------------------
// Inner content (suspense child)
// ---------------------------------------------------------------------------

function TemplatesTabContent() {
  const i18n = useI18n();
  const [showDeleted, setShowDeleted] = useState(false);
  const [sourceFilter, setSourceFilter] = useState<SourceFilter>("all");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("active");
  const [search, setSearch] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<PdfTemplateViewModel | null>(
    null,
  );
  const [uploadOpen, setUploadOpen] = useState(false);

  const query = usePdfTemplatesQuery(showDeleted || statusFilter !== "active");
  const templates: PdfTemplateViewModel[] = useMemo(
    () => (query.templates as PdfTemplateRaw[]).map(adaptPdfTemplate),
    [query.templates],
  );
  const selected = templates.find((template) => template.id === selectedId);
  const filteredTemplates = useMemo(() => {
    const normalizedSearch = search.trim().toLocaleLowerCase();
    return templates.filter((tpl) => {
      if (sourceFilter !== "all" && tpl.source !== sourceFilter) return false;
      if (statusFilter === "active" && tpl.isDeleted) return false;
      if (statusFilter === "deleted" && !tpl.isDeleted) return false;
      if (normalizedSearch === "") return true;
      return pdfTemplateSearchText(tpl, i18n.t).includes(normalizedSearch);
    });
  }, [i18n.t, search, sourceFilter, statusFilter, templates]);
  const hasActiveFilters =
    sourceFilter !== "all" || statusFilter !== "active" || search.trim() !== "";

  const handleRefresh = useCallback(() => {
    void query.mutate();
  }, [query]);

  const onUploaded = useCallback(() => {
    setUploadOpen(false);
    handleRefresh();
    logPdfExportUiEvent("template.upload.completed");
    notify.success({ title: i18n.t("admin.pdf-export.upload.success") });
  }, [handleRefresh, i18n]);

  return (
    <>
      <Stack>
        <SettingsCollectionToolbar
          search={
            <Input
              value={search}
              onChange={setSearch}
              placeholder={i18n.t("admin.pdf-export.filter.search")}
              aria-label={i18n.t("admin.pdf-export.filter.search")}
            />
          }
          filters={
            <>
              <FormSelect
                value={sourceFilter}
                allowDeselect={false}
                aria-label={i18n.t("admin.pdf-export.filter.source")}
                onChange={(value) =>
                  setSourceFilter(value as typeof sourceFilter)
                }
                data={[
                  {
                    value: "all",
                    label: i18n.t("admin.pdf-export.filter.source.all"),
                  },
                  {
                    value: "system",
                    label: i18n.t("admin.pdf-export.source.system"),
                  },
                  {
                    value: "admin",
                    label: i18n.t("admin.pdf-export.source.admin"),
                  },
                ]}
              />
              <FormSelect
                value={statusFilter}
                allowDeselect={false}
                aria-label={i18n.t("admin.pdf-export.filter.status")}
                onChange={(value) => {
                  setStatusFilter(value as typeof statusFilter);
                  setShowDeleted(value !== "active");
                }}
                data={[
                  {
                    value: "active",
                    label: i18n.t("admin.pdf-export.status.active"),
                  },
                  {
                    value: "deleted",
                    label: i18n.t("admin.pdf-export.status.deleted"),
                  },
                  {
                    value: "all",
                    label: i18n.t("admin.pdf-export.filter.status.all"),
                  },
                ]}
              />
            </>
          }
          actions={
            <>
              <IconButton
                tooltip={i18n.t("admin.common.refresh")}
                onClick={handleRefresh}
              >
                <RefreshCwIcon aria-hidden />
              </IconButton>
              <IconButton
                tooltip={i18n.t("admin.pdf-export.filter.reset")}
                disabled={!hasActiveFilters}
                onClick={() => {
                  setSearch("");
                  setSourceFilter("all");
                  setStatusFilter("active");
                  setShowDeleted(false);
                }}
              >
                <XIcon aria-hidden />
              </IconButton>
              <Button
                onClick={() => setUploadOpen(true)}
                prefix={<PlusIcon aria-hidden />}
              >
                {i18n.t("admin.pdf-export.upload.button")}
              </Button>
            </>
          }
        />

        {filteredTemplates.length === 0 ? (
          <TemplateEmptyState filtered={hasActiveFilters} />
        ) : (
          <Table aria-label={i18n.t("admin.pdf-export.list.aria-label")}>
            <TableHeader>
              <TableRow>
                <TableHead>{i18n.t("admin.pdf-export.column.name")}</TableHead>
                <TableHead>
                  {i18n.t("admin.pdf-export.column.source")}
                </TableHead>
                <TableHead>
                  {i18n.t("admin.pdf-export.column.version")}
                </TableHead>
                <TableHead>
                  {i18n.t("admin.pdf-export.column.status")}
                </TableHead>
                <TableHead>
                  {i18n.t("admin.pdf-export.column.created-at")}
                </TableHead>
                <TableHead>{i18n.t("admin.pdf-jobs.column.actions")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filteredTemplates.map((tpl) => (
                <TableRow key={tpl.id}>
                  <TableCell>
                    <InlineActionButton onClick={() => setSelectedId(tpl.id)}>
                      <SettingsListItemTitle>
                        {pdfTemplateDisplayName(tpl, i18n.t)}
                      </SettingsListItemTitle>
                    </InlineActionButton>
                    <SettingsListItemMeta>
                      <MonoText>{tpl.slug}</MonoText>
                    </SettingsListItemMeta>
                  </TableCell>
                  <TableCell>
                    <PdfTemplateSourceBadge source={tpl.source} />
                  </TableCell>
                  <TableCell>
                    {tpl.version}
                    <SettingsListItemMeta>
                      {i18n.t("admin.pdf-export.column.schema-version")}:{" "}
                      {tpl.schemaVersion}
                    </SettingsListItemMeta>
                  </TableCell>
                  <TableCell>
                    <PdfTemplateStatusBadge deleted={tpl.isDeleted} />
                  </TableCell>
                  <TableCell>
                    {formatAdminDateTime(i18n.language, tpl.createdAt)}
                    <SettingsListItemMeta>
                      {tpl.createdBy ??
                        i18n.t("admin.pdf-export.source.system")}
                    </SettingsListItemMeta>
                  </TableCell>
                  <TableCell>
                    <RowActions
                      template={tpl}
                      onInspect={() => setSelectedId(tpl.id)}
                      onRequestDelete={() => setDeleteTarget(tpl)}
                    />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </Stack>

      {selected ? (
        <TemplateDetailDrawer
          template={selected}
          onClose={() => setSelectedId(null)}
          onChanged={handleRefresh}
        />
      ) : null}

      {uploadOpen ? (
        <UploadTemplateDialog
          onClose={() => setUploadOpen(false)}
          onUploaded={onUploaded}
        />
      ) : null}

      {deleteTarget ? (
        <DeleteTemplateAdminConfirmModal
          template={deleteTarget}
          onClose={() => setDeleteTarget(null)}
          onDeleted={handleRefresh}
        />
      ) : null}
    </>
  );
}

// ---------------------------------------------------------------------------
// Public entry — wraps content in Suspense.
// ---------------------------------------------------------------------------

export function TemplatesTab() {
  return (
    <Suspense fallback={<TemplatesTabSkeleton />}>
      <TemplatesTabContent />
    </Suspense>
  );
}
