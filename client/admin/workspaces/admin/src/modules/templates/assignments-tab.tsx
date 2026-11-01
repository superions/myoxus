/**
 * Templates — Assignments tab.
 *
 * Displays workspace template assignments showing which templates are
 * deployed to which workspaces and their current policy configuration.
 * Fetches live data from the templateRegistry GraphQL API.
 *
 * User enters a workspace ID to view its template assignments.
 * Supports assigning new templates and removing existing assignments.
 */
import { ProvisioningModeType, SelectionModeType } from "@myoxus/graphql";
import { useI18n } from "@myoxus/i18n";
import {
  PlusIcon,
  RadarIcon,
  SearchIcon,
  Trash2Icon,
} from "@myoxus/icons/react";
import {
  Button,
  Group,
  Label,
  Select,
  SettingsEmptyState,
  SettingsSection,
  SettingsStatusText,
  Skeleton,
  Stack,
} from "@myoxus/ui-facade";
import { Suspense, useCallback, useState } from "react";

import { WorkspacePicker } from "../../components/domain-pickers";
import { AdminConfirmModal } from "../../components/shared/admin-confirm-modal";
import { mutateWithToast } from "../../hooks/mutate-with-toast";
import { formatAdminDateTime } from "../../utils/locale-format";
import {
  assignTemplateToWorkspace,
  removeTemplateAssignment,
  triggerTemplateDriftScan,
  useApplyTemplateManualUpdateMutation,
  useTemplateAssignmentsQuery,
  useTemplateCatalogQuery,
  useTemplateRegistryRevalidate,
  useTemplateRevisionsQuery,
  useWorkspaceTemplateInstancesQuery,
} from "./api";
import {
  TemplateEnabledBadge,
  TemplateProvisioningModeBadge,
  TemplateSelectionModeBadge,
} from "./badges";
import { useConfirmTarget, useDisclosure } from "./dialog-controller";
import {
  templateDisplayLabel,
  templateDisplayTitle,
} from "./localized-builtins";
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
function formatDate(language: string | undefined, iso: string | null): string {
  return formatAdminDateTime(language, iso, "\u2014");
}

// ---------------------------------------------------------------------------
// Assign Template Dialog
// ---------------------------------------------------------------------------

interface AssignDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  workspaceId: string;
  onSuccess: () => void;
}

function AssignTemplateDialog({
  open,
  onOpenChange,
  workspaceId,
  onSuccess,
}: AssignDialogProps) {
  const i18n = useI18n();
  const [templateId, setTemplateId] = useState("");
  const [provisioningMode, setProvisioningMode] =
    useState<ProvisioningModeType>(ProvisioningModeType.SeedOnce);
  const [selectionMode, setSelectionMode] = useState<SelectionModeType>(
    SelectionModeType.Published,
  );
  const [selectedRevisionId, setSelectedRevisionId] = useState<string | null>(
    null,
  );
  const [isAssigning, setIsAssigning] = useState(false);

  const { entries: templates } = useTemplateCatalogQuery({
    skip: 0,
    take: 100,
  });
  const { revisions } = useTemplateRevisionsQuery(templateId || null, {
    skip: 0,
    take: 100,
  });
  const usableRevisions = revisions.filter(
    (revision: any) =>
      revision.state === "Published" || revision.state === "Deprecated",
  );
  const selectedBundleRevision =
    selectionMode === SelectionModeType.PinnedRevision
      ? usableRevisions.find(
          (revision: any) => revision.id === selectedRevisionId,
        )
      : usableRevisions[0];
  const isGuideAssignment =
    selectedBundleRevision?.manifest?.purpose === "guide";

  const handleAssign = useCallback(async () => {
    if (
      !templateId ||
      (selectionMode === SelectionModeType.PinnedRevision &&
        !selectedRevisionId)
    )
      return;
    setIsAssigning(true);
    const result = await mutateWithToast(
      () =>
        assignTemplateToWorkspace({
          workspaceId,
          templateId,
          provisioningMode: isGuideAssignment
            ? ProvisioningModeType.SeedOnce
            : provisioningMode,
          selectionMode,
          selectedRevisionId:
            selectionMode === SelectionModeType.PinnedRevision
              ? (selectedRevisionId ?? undefined)
              : undefined,
        }),
      i18n.t("admin.templates.action.assign.success"),
      i18n.t("admin.common.save-failed"),
    );
    setIsAssigning(false);
    if (result) {
      onOpenChange(false);
      setTemplateId("");
      setProvisioningMode(ProvisioningModeType.SeedOnce);
      setSelectionMode(SelectionModeType.Published);
      setSelectedRevisionId(null);
      onSuccess();
    }
  }, [
    templateId,
    workspaceId,
    provisioningMode,
    isGuideAssignment,
    selectionMode,
    selectedRevisionId,
    onOpenChange,
    onSuccess,
    i18n,
  ]);

  return (
    <AdminConfirmModal
      open={open}
      onOpenChange={onOpenChange}
      title={i18n.t("admin.templates.action.assign.confirm.title")}
      description={
        <Stack>
          <Stack>
            <Label htmlFor="assign-template">
              {i18n.t("admin.templates.assignments.dialog.template-label")}
            </Label>
            <Select
              id="assign-template"
              value={templateId || null}
              onChange={(value) => {
                setTemplateId(value);
                setSelectedRevisionId(null);
              }}
              placeholder={i18n.t(
                "admin.templates.assignments.dialog.template-placeholder",
              )}
              data={templates.map((t: any) => ({
                value: t.id,
                label: templateDisplayLabel(i18n, t),
              }))}
              controlMaxWidth="100%"
            />
          </Stack>
          <Stack>
            <Label htmlFor="assign-selection">
              {i18n.t("admin.templates.assignments.dialog.selection-label")}
            </Label>
            <Select
              id="assign-selection"
              value={selectionMode}
              onChange={(value) => {
                setSelectionMode(value as SelectionModeType);
                if (value !== SelectionModeType.PinnedRevision) {
                  setSelectedRevisionId(null);
                }
              }}
              data={[
                {
                  value: SelectionModeType.Published,
                  label: i18n.t("admin.templates.assignments.mode.published"),
                },
                {
                  value: SelectionModeType.PinnedRevision,
                  label: i18n.t(
                    "admin.templates.assignments.mode.pinned-revision",
                  ),
                },
              ]}
              controlMaxWidth="100%"
            />
          </Stack>
          {selectionMode === SelectionModeType.PinnedRevision && (
            <Stack>
              <Label htmlFor="assign-revision">
                {i18n.t("admin.templates.assignments.dialog.revision-label")}
              </Label>
              <Select
                id="assign-revision"
                value={selectedRevisionId}
                onChange={setSelectedRevisionId}
                placeholder={i18n.t(
                  "admin.templates.assignments.dialog.revision-placeholder",
                )}
                data={usableRevisions.map((revision: any) => ({
                  value: revision.id,
                  label: `${revision.version} · ${revision.state}`,
                }))}
                controlMaxWidth="100%"
              />
            </Stack>
          )}
          <Stack>
            <Label htmlFor="assign-provisioning">
              {i18n.t("admin.templates.assignments.dialog.provisioning-label")}
            </Label>
            <Select
              id="assign-provisioning"
              value={
                isGuideAssignment
                  ? ProvisioningModeType.SeedOnce
                  : provisioningMode
              }
              disabled={isGuideAssignment}
              onChange={(value) =>
                setProvisioningMode(value as ProvisioningModeType)
              }
              data={[
                {
                  value: ProvisioningModeType.SeedOnce,
                  label: i18n.t("admin.templates.assignments.mode.seed-once"),
                },
                {
                  value: ProvisioningModeType.ManagedUntilLocalEdit,
                  label: i18n.t("admin.templates.assignments.mode.managed"),
                },
                {
                  value: ProvisioningModeType.ManualUpdate,
                  label: i18n.t(
                    "admin.templates.assignments.mode.manual-update",
                  ),
                },
              ]}
              controlMaxWidth="100%"
            />
          </Stack>
        </Stack>
      }
      confirmText={
        isAssigning
          ? i18n.t("admin.templates.assignments.dialog.assigning")
          : i18n.t("admin.templates.action.assign")
      }
      onConfirm={handleAssign}
    />
  );
}

function ManualUpdateControl({
  workspaceId,
  templateId,
  instance,
  enabled,
}: {
  workspaceId: string;
  templateId: string;
  instance: any;
  enabled: boolean;
}) {
  const i18n = useI18n();
  const { revisions } = useTemplateRevisionsQuery(templateId, {
    skip: 0,
    take: 100,
  });
  const currentRevision = revisions.find(
    (revision: any) => revision.id === instance?.revisionId,
  );
  const isGuide =
    (currentRevision ?? revisions[0])?.manifest?.purpose === "guide";
  const usableRevisions = revisions.filter(
    (revision: any) =>
      (isGuide
        ? revision.manifest?.purpose === "guide"
        : revision.id !== instance?.revisionId) &&
      (revision.state === "Published" || revision.state === "Deprecated"),
  );
  const [selectedRevisionId, setSelectedRevisionId] = useState<string | null>(
    null,
  );
  const { trigger, isMutating } = useApplyTemplateManualUpdateMutation();
  const { revalidateAssignments, revalidateWorkspaceInstances } =
    useTemplateRegistryRevalidate();
  const revisionId = selectedRevisionId ?? usableRevisions[0]?.id ?? null;

  if (!isGuide && (!instance || instance.state !== "UpdateAvailable"))
    return null;

  const applyUpdate = async () => {
    if (!revisionId) return;
    const result = await mutateWithToast(
      () => trigger({ workspaceId, templateId, revisionId }),
      isGuide
        ? i18n.t("admin.templates.assignments.guide-copy.success")
        : i18n.t("admin.templates.assignments.manual-update.success"),
      i18n.t("admin.templates.assignments.manual-update.failed"),
    );
    if (result) {
      await Promise.all([
        revalidateAssignments(workspaceId),
        revalidateWorkspaceInstances(workspaceId),
      ]);
    }
  };

  return (
    <Stack>
      {isGuide && (
        <SettingsStatusText>
          {i18n.t("admin.templates.assignments.guide-copy.hint")}
        </SettingsStatusText>
      )}
      <Group align="end" wrap="wrap">
        <Select
          value={revisionId}
          onChange={setSelectedRevisionId}
          data={usableRevisions.map((revision: any) => ({
            value: revision.id,
            label: `${revision.version} · ${revision.state}`,
          }))}
          aria-label={i18n.t(
            "admin.templates.assignments.manual-update.revision-label",
          )}
        />
        <Button
          type="button"
          variant="primary"
          disabled={!enabled || isMutating || !revisionId}
          onClick={applyUpdate}
        >
          {isGuide
            ? i18n.t("admin.templates.assignments.guide-copy.action")
            : i18n.t("admin.templates.assignments.manual-update.action")}
        </Button>
      </Group>
    </Stack>
  );
}

// ---------------------------------------------------------------------------
// Assignments list for a workspace
// ---------------------------------------------------------------------------

function AssignmentsList({ workspaceId }: { workspaceId: string }) {
  const i18n = useI18n();
  const { assignments } = useTemplateAssignmentsQuery(workspaceId, {
    skip: 0,
    take: 50,
  });
  const { entries: templates } = useTemplateCatalogQuery({
    skip: 0,
    take: 100,
  });
  const { instances } = useWorkspaceTemplateInstancesQuery(workspaceId);
  const { revalidateAssignments } = useTemplateRegistryRevalidate();
  const templateById = new Map(
    templates.map((entry: any) => [entry.id, entry]),
  );

  const removeDialog = useConfirmTarget<{ id: string; templateId: string }>();
  const assignDialog = useDisclosure();
  const driftScanDialog = useDisclosure();
  const removeTarget = removeDialog.target;
  const clearRemoveDialog = removeDialog.clear;
  const closeDriftScanDialog = driftScanDialog.closeDialog;
  const [isDriftScanning, setIsDriftScanning] = useState(false);

  const handleRemoveConfirm = useCallback(async () => {
    if (!removeTarget) return;
    clearRemoveDialog();
    const result = await mutateWithToast(
      () => removeTemplateAssignment(removeTarget.id),
      i18n.t("admin.templates.action.remove.success"),
      i18n.t("admin.common.save-failed"),
    );
    if (result) revalidateAssignments().catch(() => {});
  }, [clearRemoveDialog, removeTarget, revalidateAssignments, i18n]);

  const handleAssignSuccess = useCallback(() => {
    revalidateAssignments().catch(() => {});
  }, [revalidateAssignments]);

  const handleDriftScanConfirm = useCallback(async () => {
    closeDriftScanDialog();
    setIsDriftScanning(true);
    await mutateWithToast(
      () => triggerTemplateDriftScan(workspaceId),
      i18n.t("admin.templates.action.driftScan.success"),
      i18n.t("admin.common.save-failed"),
    );
    setIsDriftScanning(false);
  }, [closeDriftScanDialog, workspaceId, i18n]);

  return (
    <>
      <AdminConfirmModal
        open={removeDialog.open}
        onOpenChange={removeDialog.onOpenChange}
        title={i18n.t("admin.templates.action.remove.confirm.title")}
        description={i18n.t(
          "admin.templates.action.remove.confirm.description",
        )}
        confirmText={i18n.t("admin.templates.action.remove")}
        danger
        onConfirm={handleRemoveConfirm}
      />
      <AssignTemplateDialog
        open={assignDialog.open}
        onOpenChange={assignDialog.onOpenChange}
        workspaceId={workspaceId}
        onSuccess={handleAssignSuccess}
      />
      <AdminConfirmModal
        open={driftScanDialog.open}
        onOpenChange={driftScanDialog.onOpenChange}
        title={i18n.t("admin.templates.action.driftScan.confirm.title")}
        description={i18n.t(
          "admin.templates.action.driftScan.confirm.description",
          { workspaceId },
        )}
        confirmText={i18n.t("admin.templates.action.driftScan")}
        onConfirm={handleDriftScanConfirm}
      />
      <Group align="center" justify="flex-end" wrap="wrap">
        <Button
          type="button"
          variant="plain"
          prefix={<RadarIcon />}
          disabled={isDriftScanning}
          onClick={driftScanDialog.openDialog}
        >
          {isDriftScanning
            ? i18n.t("admin.templates.assignments.scanning")
            : i18n.t("admin.templates.action.driftScan")}
        </Button>
        <Button
          type="button"
          variant="primary"
          prefix={<PlusIcon />}
          onClick={assignDialog.openDialog}
        >
          {i18n.t("admin.templates.action.assign")}
        </Button>
      </Group>
      {assignments.length === 0 ? (
        <SettingsEmptyState
          title={i18n.t("admin.templates.assignments.empty-title")}
          description={i18n.t("admin.templates.assignments.empty-hint")}
        />
      ) : (
        <SoftList data-testid="templates-assignments-soft-list">
          {assignments.map((entry: any) => (
            <SoftListItem key={entry.id}>
              <Group align="flex-start" justify="space-between" wrap="wrap">
                <TemplateCardTitle
                  title={
                    templateById.has(entry.templateId)
                      ? templateDisplayTitle(
                          i18n,
                          templateById.get(entry.templateId),
                        )
                      : entry.templateId
                  }
                  subtitle={i18n.t("admin.templates.assignments.card.subtitle")}
                  mono={entry.id}
                />
                <Button
                  type="button"
                  variant="destructive"
                  prefix={<Trash2Icon />}
                  onClick={() =>
                    removeDialog.request({
                      id: entry.id,
                      templateId: entry.templateId,
                    })
                  }
                >
                  {i18n.t("admin.templates.action.remove")}
                </Button>
              </Group>
              <Group align="center" wrap="wrap">
                <TemplateSelectionModeBadge mode={entry.selectionMode} />
                <TemplateProvisioningModeBadge mode={entry.provisioningMode} />
                <TemplateEnabledBadge enabled={entry.isEnabled} />
              </Group>
              {(entry.provisioningMode === "ManualUpdate" ||
                entry.provisioningMode === "SeedOnce") && (
                <ManualUpdateControl
                  workspaceId={workspaceId}
                  templateId={entry.templateId}
                  enabled={entry.isEnabled}
                  instance={instances.find(
                    (instance: any) => instance.templateId === entry.templateId,
                  )}
                />
              )}
              <MetaGrid>
                <MetaField
                  label={i18n.t("admin.templates.assignments.col.selection")}
                  value={
                    entry.selectedRevisionId
                      ? `${entry.selectionMode} · ${entry.selectedRevisionId}`
                      : entry.selectionMode
                  }
                  mono
                />
                <MetaField
                  label={i18n.t("admin.templates.assignments.col.provisioning")}
                  value={entry.provisioningMode}
                  mono
                />
                <MetaField
                  label={i18n.t("admin.templates.assignments.col.enabled")}
                  value={
                    entry.isEnabled
                      ? i18n.t("admin.templates.badge.yes")
                      : i18n.t("admin.templates.badge.no")
                  }
                />
                <MetaField
                  label={i18n.t("admin.templates.assignments.col.updated")}
                  value={formatDate(i18n.language, entry.updatedAt)}
                />
              </MetaGrid>
            </SoftListItem>
          ))}
        </SoftList>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function AssignmentsTab() {
  const i18n = useI18n();
  const [pickedWorkspaceId, setPickedWorkspaceId] = useState<string | null>(
    null,
  );
  const [activeWorkspaceId, setActiveWorkspaceId] = useState<string | null>(
    null,
  );

  const handleSearch = useCallback(() => {
    if (pickedWorkspaceId) {
      setActiveWorkspaceId(pickedWorkspaceId);
    }
  }, [pickedWorkspaceId]);

  const handleWorkspaceChange = useCallback((workspaceId: string | null) => {
    setPickedWorkspaceId(workspaceId);
    setActiveWorkspaceId(workspaceId);
  }, []);

  return (
    <TemplateTabFrame
      title={i18n.t("admin.templates.assignments.title")}
      description={i18n.t("admin.templates.assignments.description")}
      shoulder={
        <TemplateShoulder
          rows={[
            {
              label: i18n.t("admin.templates.assignments.metric.workspace"),
              value: activeWorkspaceId ? "01" : "00",
              tone: activeWorkspaceId ? "success" : "neutral",
            },
            {
              label: i18n.t("admin.templates.assignments.metric.mode"),
              value: i18n.t("admin.templates.assignments.metric.picker"),
              tone: "info",
            },
          ]}
        />
      }
    >
      <Stack>
        <SettingsSection
          description={i18n.t("admin.templates.assignments.picker-hint")}
          actions={
            <Button
              type="button"
              variant="plain"
              prefix={<SearchIcon />}
              onClick={handleSearch}
              disabled={!pickedWorkspaceId}
            >
              {i18n.t("admin.common.search")}
            </Button>
          }
        >
          <WorkspacePicker
            value={pickedWorkspaceId}
            onChange={handleWorkspaceChange}
            placeholder={i18n.t(
              "admin.templates.assignments.search-placeholder",
            )}
            data-testid="templates-assignment-workspace-picker"
          />
        </SettingsSection>

        {activeWorkspaceId ? (
          <Suspense
            fallback={
              <Stack>
                <Skeleton h={32} />
                <Skeleton h={32} />
              </Stack>
            }
          >
            <AssignmentsList workspaceId={activeWorkspaceId} />
          </Suspense>
        ) : (
          <SettingsEmptyState
            title={i18n.t("admin.templates.assignments.empty-workspace-title")}
            description={i18n.t(
              "admin.templates.assignments.enter-workspace-hint",
            )}
          />
        )}
      </Stack>
    </TemplateTabFrame>
  );
}
