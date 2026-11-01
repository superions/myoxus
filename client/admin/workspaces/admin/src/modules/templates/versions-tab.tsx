/**
 * Templates — Versions tab.
 *
 * Displays a table of template revisions with their status lifecycle
 * (draft -> validated -> published -> deprecated).
 * Fetches live data from the templateRegistry GraphQL API.
 *
 * User selects a template from the catalog, then sees its revisions.
 * The "Publish" button is wired to the publishRevision mutation.
 * The "Export" button downloads the revision ZIP bundle from the admin REST API.
 */
import { RevisionStateType } from "@myoxus/graphql";
import { useI18n } from "@myoxus/i18n";
import { DownloadIcon, EyeIcon } from "@myoxus/icons/react";
import {
  Button,
  Drawer,
  Group,
  MonoText,
  Select,
  SettingsEmptyState,
  SettingsNotice,
  SettingsSkeleton,
  SettingsStatusText,
  Skeleton,
  Stack,
} from "@myoxus/ui-facade";
import { Suspense, useCallback, useState } from "react";

import { fetchTemplateRevisionExport } from "../../api/download-api";
import { AdminConfirmModal } from "../../components/shared/admin-confirm-modal";
import { mutateWithToast } from "../../hooks/mutate-with-toast";
import { formatAdminDate } from "../../utils/locale-format";
import {
  usePublishRevisionMutation,
  useTemplateCatalogQuery,
  useTemplateRegistryRevalidate,
  useTemplateRevisionsQuery,
} from "./api";
import {
  type TemplateRevisionState,
  TemplateRevisionStateBadge,
} from "./badges";
import { useConfirmTarget } from "./dialog-controller";
import { templateDisplayLabel } from "./localized-builtins";
import {
  parseTemplateExportFilename,
  readTemplateExportError,
} from "./status-models";
import {
  MetaField,
  MetaGrid,
  SoftList,
  SoftListItem,
  TemplateCardTitle,
  TemplateShoulder,
  TemplateTabFrame,
} from "./template-role-primitives";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatDate(language: string | undefined, iso: string | null): string {
  return formatAdminDate(language, iso, "\u2014");
}

function VersionsSkeleton() {
  return <SettingsSkeleton />;
}

function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.style.visibility = "hidden";
  document.body.append(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

// ---------------------------------------------------------------------------
// Revisions list (requires selected template ID)
// ---------------------------------------------------------------------------

function RevisionsList({
  templateId,
  isBuiltin,
}: {
  templateId: string;
  isBuiltin: boolean;
}) {
  const i18n = useI18n();
  const { revalidateCatalog, revalidateRevisions } =
    useTemplateRegistryRevalidate();
  const { trigger: publishTrigger, isMutating: isPublishing } =
    usePublishRevisionMutation();
  const { revisions } = useTemplateRevisionsQuery(templateId, {
    skip: 0,
    take: 50,
  });

  const publishDialog = useConfirmTarget<{ id: string; version: string }>();
  const publishTarget = publishDialog.target;
  const [detailRevision, setDetailRevision] = useState<any | null>(null);

  const handlePublishConfirm = useCallback(
    async () => {
      if (!publishTarget) return;
      publishDialog.clear();
      const result = await mutateWithToast(
        () => publishTrigger({ revisionId: publishTarget.id }),
        i18n.t("admin.templates.versions.toast.publish-success"),
        i18n.t("admin.templates.versions.toast.publish-failed"),
      );
      if (result) {
        revalidateRevisions().catch(() => {});
        revalidateCatalog().catch(() => {});
      }
    },
    // oxlint-disable-next-line react/exhaustive-deps
    [
      publishDialog.clear,
      publishTarget,
      publishTrigger,
      revalidateCatalog,
      revalidateRevisions,
      i18n,
    ],
  );

  // Export handler — downloads revision bundle via REST
  const handleExport = useCallback(
    async (revisionId: string, version: string) => {
      await mutateWithToast(
        async () => {
          const response = await fetchTemplateRevisionExport(revisionId);

          if (!response.ok) {
            throw new Error(await readTemplateExportError(response));
          }

          const blob = await response.blob();
          const filename =
            parseTemplateExportFilename(
              response.headers.get("content-disposition"),
            ) ?? `template-revision-${version}.zip`;

          downloadBlob(blob, filename);
          return filename;
        },
        i18n.t("admin.templates.versions.toast.export-success"),
        i18n.t("admin.templates.versions.toast.export-failed"),
      );
    },

    [i18n],
  );

  if (revisions.length === 0) {
    return (
      <SettingsEmptyState
        title={
          isBuiltin
            ? i18n.t("admin.templates.versions.no-revisions-builtin")
            : i18n.t("admin.templates.versions.no-revisions")
        }
        description={
          isBuiltin
            ? i18n.t("admin.templates.versions.no-revisions-builtin-hint")
            : i18n.t("admin.templates.versions.no-revisions-hint")
        }
      />
    );
  }

  return (
    <>
      <AdminConfirmModal
        open={publishDialog.open}
        onOpenChange={publishDialog.onOpenChange}
        title={i18n.t("admin.templates.versions.publish-dialog.title")}
        description={i18n.t(
          "admin.templates.versions.publish-dialog.description",
          { version: publishTarget?.version ?? "" },
        )}
        confirmText={i18n.t("admin.templates.versions.publish-dialog.confirm")}
        onConfirm={handlePublishConfirm}
      />
      <Drawer
        open={detailRevision !== null}
        onOpenChange={(open) => {
          if (!open) setDetailRevision(null);
        }}
        title={i18n.t("admin.templates.versions.detail.title")}
        description={
          detailRevision ? <MonoText>{detailRevision.id}</MonoText> : undefined
        }
        size={520}
      >
        {detailRevision ? (
          <Stack>
            <MetaGrid>
              <MetaField
                label={i18n.t("admin.templates.versions.col.version")}
                value={detailRevision.version}
                mono
              />
              <MetaField
                label={i18n.t("admin.templates.versions.col.state")}
                value={detailRevision.state}
                mono
              />
              <MetaField
                label={i18n.t("admin.templates.versions.col.created")}
                value={formatDate(i18n.language, detailRevision.createdAt)}
              />
              <MetaField
                label={i18n.t("admin.templates.versions.col.published")}
                value={formatDate(i18n.language, detailRevision.publishedAt)}
              />
            </MetaGrid>
            <SettingsNotice
              tone="neutral"
              title={i18n.t("admin.templates.versions.detail.release-notes")}
              data-myoxus-ui-role="template-release-notes"
            >
              {detailRevision.releaseNotes ??
                i18n.t("admin.templates.versions.detail.no-release-notes")}
            </SettingsNotice>
          </Stack>
        ) : null}
      </Drawer>
      <SoftList data-testid="templates-versions-soft-list">
        {revisions.map((entry: any) => (
          <SoftListItem key={entry.id}>
            <Group align="flex-start" justify="space-between" wrap="wrap">
              <Stack flex={1}>
                <TemplateCardTitle
                  title={entry.version}
                  subtitle={i18n.t("admin.templates.versions.detail.subtitle")}
                  mono={entry.id}
                />
                <TemplateRevisionStateBadge
                  state={entry.state as TemplateRevisionState}
                />
              </Stack>
              <Group align="center" justify="flex-end" wrap="wrap">
                <Button
                  type="button"
                  variant="plain"
                  prefix={<EyeIcon />}
                  onClick={() => setDetailRevision(entry)}
                >
                  {i18n.t("admin.common.details")}
                </Button>
                {!isBuiltin && (
                  <Button
                    type="button"
                    variant="plain"
                    prefix={<DownloadIcon />}
                    disabled={
                      entry.state !== RevisionStateType.Published &&
                      entry.state !== RevisionStateType.Deprecated
                    }
                    onClick={() => handleExport(entry.id, entry.version)}
                    title={i18n.t(
                      entry.state === RevisionStateType.Published ||
                        entry.state === RevisionStateType.Deprecated
                        ? "admin.templates.versions.export-title"
                        : "admin.templates.versions.export-unavailable",
                    )}
                  >
                    {i18n.t("admin.templates.versions.export")}
                  </Button>
                )}
                {!isBuiltin && entry.state === RevisionStateType.Validated ? (
                  <Button
                    type="button"
                    variant="primary"
                    disabled={isPublishing}
                    onClick={() =>
                      publishDialog.request({
                        id: entry.id,
                        version: entry.version,
                      })
                    }
                  >
                    {isPublishing
                      ? i18n.t("admin.templates.versions.publishing")
                      : i18n.t("admin.templates.versions.publish")}
                  </Button>
                ) : null}
                {isBuiltin && (
                  <SettingsStatusText>
                    {i18n.t("admin.templates.versions.builtin-managed")}
                  </SettingsStatusText>
                )}
              </Group>
            </Group>
            <MetaGrid>
              <MetaField
                label={i18n.t("admin.templates.versions.col.published")}
                value={formatDate(i18n.language, entry.publishedAt)}
              />
              <MetaField
                label={i18n.t("admin.templates.versions.col.created")}
                value={formatDate(i18n.language, entry.createdAt)}
              />
              <MetaField
                label={i18n.t("admin.templates.versions.col.state")}
                value={entry.state}
                mono
              />
              <MetaField
                label={i18n.t("admin.templates.versions.col.actions")}
                value={"\u2014"}
              />
            </MetaGrid>
          </SoftListItem>
        ))}
      </SoftList>
    </>
  );
}

// ---------------------------------------------------------------------------
// Content (inside Suspense)
// ---------------------------------------------------------------------------

function VersionsContent() {
  const i18n = useI18n();
  const [selectedTemplateId, setSelectedTemplateId] = useState<string>("");

  const { entries: templates } = useTemplateCatalogQuery({
    skip: 0,
    take: 100,
  });

  const selectedTemplate = templates.find(
    (t: any) => t.id === selectedTemplateId,
  );
  const isBuiltin = selectedTemplate?.source === "Builtin";

  return (
    <TemplateTabFrame
      title={i18n.t("admin.templates.versions.title")}
      description={i18n.t("admin.templates.versions.description")}
      shoulder={
        <TemplateShoulder
          rows={[
            {
              label: i18n.t("admin.templates.versions.metric.templates"),
              value: templates.length,
              tone: templates.length > 0 ? "info" : "neutral",
            },
            {
              label: i18n.t("admin.templates.versions.metric.selected"),
              value: selectedTemplateId ? "01" : "00",
              tone: selectedTemplateId ? "success" : "neutral",
            },
          ]}
        />
      }
    >
      <Stack>
        {templates.length === 0 ? (
          <SettingsEmptyState
            title={i18n.t("admin.templates.versions.no-templates")}
            description={i18n.t("admin.templates.versions.no-templates-hint")}
          />
        ) : (
          <>
            <Select
              value={selectedTemplateId}
              onChange={setSelectedTemplateId}
              placeholder={i18n.t(
                "admin.templates.versions.select-placeholder",
              )}
              data={templates.map((t: any) => ({
                value: t.id,
                label: `${templateDisplayLabel(i18n, t)}${
                  t.source === "Builtin" ? " ★" : ""
                }`,
              }))}
              controlMaxWidth="100%"
            />

            {selectedTemplateId ? (
              <Suspense
                fallback={
                  <Stack>
                    <Skeleton h={32} />
                    <Skeleton h={32} />
                  </Stack>
                }
              >
                <RevisionsList
                  templateId={selectedTemplateId}
                  isBuiltin={isBuiltin}
                />
              </Suspense>
            ) : (
              <SettingsEmptyState
                title={i18n.t("admin.templates.versions.select-hint")}
              />
            )}
          </>
        )}
      </Stack>
    </TemplateTabFrame>
  );
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function VersionsTab() {
  return (
    <Suspense fallback={<VersionsSkeleton />}>
      <VersionsContent />
    </Suspense>
  );
}
