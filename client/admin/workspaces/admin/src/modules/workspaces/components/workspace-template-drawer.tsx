/**
 * Template Assignment Drawer (P41-B).
 *
 * Opens as a Sheet overlay from the workspace detail panel "Manage Templates"
 * button. Two tabs:
 *   - Catalog: browse available templates and assign them to the workspace
 *   - Assigned: view/manage existing template assignments (remove, reconcile)
 */
import { adminToast as toast } from "@myoxus/admin/notifications";
import { ProvisioningModeType, SelectionModeType } from "@myoxus/graphql";
import { useI18n } from "@myoxus/i18n";
import {
  Badge,
  Button,
  Drawer,
  Group,
  MyoxusSelect,
  SettingsEmptyState,
  SettingsListItemTitle,
  SettingsNotice,
  SettingsSkeleton,
  SettingsStatusText,
  SettingsToolbar,
  SurfaceList,
  SurfaceListItem,
  SurfaceListItemMain,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@myoxus/ui-facade";
import { useCallback, useMemo, useState } from "react";

import { formatAdminDate } from "../../../utils/locale-format";
import { AdminConfirmModal } from "../../../components/shared/admin-confirm-modal";
import {
  useAssignTemplateToWorkspaceMutation,
  useRemoveTemplateAssignmentMutation,
  useTemplateAssignmentsQuery,
  useTemplateCatalogQuery,
  useTemplateRegistryRevalidate,
  useTriggerTemplateReconcileMutation,
  useWorkspaceTemplateInstancesQuery,
} from "../../templates/api";
import {
  type TemplateInstanceState,
  TemplateInstanceStateBadge,
  type TemplateStatus,
  TemplateStatusBadge,
} from "../../templates/badges";

// ---------------------------------------------------------------------------
// Inline policy-change editor state
// ---------------------------------------------------------------------------

type ChangePolicyState =
  { active: false } | { active: true; provisioningMode: ProvisioningModeType };

function normalizeProvisioningMode(value: string | null | undefined) {
  switch (value) {
    case ProvisioningModeType.ManagedUntilLocalEdit:
    case "MANAGED_UNTIL_LOCAL_EDIT":
      return ProvisioningModeType.ManagedUntilLocalEdit;
    case ProvisioningModeType.ManualUpdate:
    case "MANUAL_UPDATE":
      return ProvisioningModeType.ManualUpdate;
    case ProvisioningModeType.SeedOnce:
    case "SEED_ONCE":
    default:
      return ProvisioningModeType.SeedOnce;
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function WorkspaceTemplateDrawer({
  workspaceId,
  open,
  onOpenChange,
}: {
  workspaceId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const i18n = useI18n();
  return (
    <Drawer
      open={open}
      onOpenChange={onOpenChange}
      position="right"
      title={i18n.t("admin.workspaces.templates.drawer-title")}
      description={i18n.t("admin.workspaces.templates.drawer-desc")}
    >
      <Tabs defaultValue="catalog" layout="page" variant="default">
        <TabsList
          variant="panel"
          data-testid="workspace-template-drawer-tabs-nav"
        >
          <TabsTrigger
            value="catalog"
            grow
            variant="panel"
            data-testid="workspace-template-drawer-tab-catalog"
          >
            {i18n.t("admin.workspaces.templates.tab-catalog")}
          </TabsTrigger>
          <TabsTrigger
            value="assigned"
            grow
            variant="panel"
            data-testid="workspace-template-drawer-tab-assigned"
          >
            {i18n.t("admin.workspaces.templates.tab-assigned")}
          </TabsTrigger>
        </TabsList>
        <TabsContent value="catalog" fill scroll>
          <CatalogTab workspaceId={workspaceId} />
        </TabsContent>
        <TabsContent value="assigned" fill scroll>
          <AssignedTab workspaceId={workspaceId} />
        </TabsContent>
      </Tabs>
    </Drawer>
  );
}

// ---------------------------------------------------------------------------
// Tab 1: Catalog — browse and assign templates
// ---------------------------------------------------------------------------

function CatalogTab({ workspaceId }: { workspaceId: string }) {
  const i18n = useI18n();
  const catalog = useTemplateCatalogQuery({
    skip: 0,
    take: 100,
  });
  const assigned = useTemplateAssignmentsQuery(workspaceId, {
    skip: 0,
    take: 100,
  });
  const { entries: catalogEntries } = catalog;
  const { assignments } = assigned;

  const assignedTemplateIds = useMemo(
    () =>
      new Set(
        assignments.map((a: { templateId: string }) => String(a.templateId)),
      ),
    [assignments],
  );

  // Assignment state must be known before exposing an Assign action.
  const error = catalog.error ?? assigned.error;
  if (error) {
    return (
      <SettingsNotice
        tone="error"
        title={i18n.t("com.myoxus.settings.common.load-error")}
      >
        {error.message}
        <Group>
          <Button
            onClick={() => {
              void catalog.mutate(undefined, { throwOnError: false });
              void assigned.mutate(undefined, { throwOnError: false });
            }}
          >
            {i18n.t("admin.error.retry")}
          </Button>
        </Group>
      </SettingsNotice>
    );
  }
  if (catalog.isLoading || assigned.isLoading) {
    return (
      <SettingsSkeleton
        aria-label={i18n.t("admin.workspaces.templates.loading-catalog")}
      />
    );
  }

  if (catalogEntries.length === 0) {
    return (
      <SettingsEmptyState
        title={i18n.t("admin.workspaces.templates.no-catalog")}
      />
    );
  }

  return (
    <SurfaceList>
      {catalogEntries.map(
        (entry: {
          id: string;
          title: string;
          description: string | null;
          category: string | null;
          status: string;
        }) => (
          <CatalogEntry
            key={entry.id}
            entry={entry}
            workspaceId={workspaceId}
            isAssigned={assignedTemplateIds.has(String(entry.id))}
          />
        ),
      )}
    </SurfaceList>
  );
}

function CatalogEntry({
  entry,
  workspaceId,
  isAssigned,
}: {
  entry: {
    id: string;
    title: string;
    description: string | null;
    category: string | null;
    status: string;
  };
  workspaceId: string;
  isAssigned: boolean;
}) {
  const i18n = useI18n();
  const [provisioningMode, setProvisioningMode] = useState(
    ProvisioningModeType.SeedOnce,
  );
  const [showModeSelect, setShowModeSelect] = useState(false);
  const { revalidateAssignments, revalidateWorkspaceInstances } =
    useTemplateRegistryRevalidate();
  const { trigger: assignTemplate, isMutating } =
    useAssignTemplateToWorkspaceMutation();

  const provisioningModes = useMemo(
    () => [
      {
        value: ProvisioningModeType.SeedOnce,
        label: i18n.t("admin.workspaces.templates.mode-seed-once"),
      },
      {
        value: ProvisioningModeType.ManagedUntilLocalEdit,
        label: i18n.t("admin.workspaces.templates.mode-managed-until-edit"),
      },
      {
        value: ProvisioningModeType.ManualUpdate,
        label: i18n.t("admin.workspaces.templates.mode-manual-update"),
      },
    ],
    [i18n],
  );

  const handleAssign = useCallback(async () => {
    if (!showModeSelect) {
      setShowModeSelect(true);
      return;
    }
    try {
      await assignTemplate({
        workspaceId,
        templateId: entry.id,
        provisioningMode,
        selectionMode: SelectionModeType.Published,
      });
      toast.success(
        i18n.t("admin.workspaces.templates.assign-success", {
          title: entry.title,
        }),
      );
      setShowModeSelect(false);
      await Promise.all([
        revalidateAssignments(workspaceId),
        revalidateWorkspaceInstances(workspaceId),
      ]);
    } catch (e) {
      toast.error(
        i18n.t("admin.workspaces.templates.assign-failed", {
          message: (e as Error).message,
        }),
      );
    }
  }, [
    assignTemplate,
    entry.id,
    entry.title,
    i18n,
    provisioningMode,
    revalidateAssignments,
    revalidateWorkspaceInstances,
    showModeSelect,
    workspaceId,
  ]);

  return (
    <SurfaceListItem density="compact" role="listitem">
      <SurfaceListItemMain compact>
        <SettingsToolbar justify="flex-start" align="center">
          <SettingsListItemTitle truncate>{entry.title}</SettingsListItemTitle>
          <TemplateStatusBadge status={entry.status as TemplateStatus} />
          {isAssigned && (
            <Badge tone="neutral">
              {i18n.t("admin.workspaces.templates.assigned-badge")}
            </Badge>
          )}
        </SettingsToolbar>
        {entry.category && (
          <SettingsStatusText>{entry.category}</SettingsStatusText>
        )}
        {entry.description && (
          <SettingsStatusText lineClamp={2}>
            {entry.description}
          </SettingsStatusText>
        )}
        {!isAssigned && (
          <Group>
            <Button
              type="button"
              variant="secondary"
              disabled={isMutating}
              onClick={handleAssign}
            >
              {isMutating
                ? i18n.t("admin.workspaces.templates.assigning")
                : showModeSelect
                  ? i18n.t("admin.workspaces.templates.confirm")
                  : i18n.t("admin.workspaces.templates.assign")}
            </Button>
          </Group>
        )}
      </SurfaceListItemMain>
      {showModeSelect && !isAssigned && (
        <SettingsToolbar justify="flex-start" align="flex-end">
          <MyoxusSelect
            label={i18n.t("admin.workspaces.templates.provisioning-mode-label")}
            value={provisioningMode}
            onChange={(mode) =>
              setProvisioningMode(mode as ProvisioningModeType)
            }
            data={provisioningModes}
          />
          <Button
            type="button"
            variant="plain"
            onClick={() => setShowModeSelect(false)}
          >
            {i18n.t("admin.common.cancel")}
          </Button>
        </SettingsToolbar>
      )}
    </SurfaceListItem>
  );
}

// ---------------------------------------------------------------------------
// Tab 2: Assigned — manage existing assignments
// ---------------------------------------------------------------------------

function AssignedTab({ workspaceId }: { workspaceId: string }) {
  const i18n = useI18n();
  const instanceQuery = useWorkspaceTemplateInstancesQuery(workspaceId);
  const assigned = useTemplateAssignmentsQuery(workspaceId, {
    skip: 0,
    take: 100,
  });
  const catalog = useTemplateCatalogQuery({
    skip: 0,
    take: 100,
  });
  const { instances } = instanceQuery;
  const { assignments } = assigned;
  const { entries: catalogEntries } = catalog;

  // Build lookup maps
  const catalogMap = useMemo(() => {
    const map = new Map<string, string>();
    for (const entry of catalogEntries) {
      map.set(String(entry.id), entry.title);
    }
    return map;
  }, [catalogEntries]);

  // Merge assignments with instance data
  const mergedAssignments = useMemo(() => {
    const instanceByTemplate = new Map<
      string,
      {
        id: string;
        templateId: string;
        revisionId: string;
        state: string;
        lastSyncedAt: string | null;
        lastErrorMessage: string | null;
      }
    >();
    for (const inst of instances) {
      instanceByTemplate.set(String(inst.templateId), inst);
    }
    return assignments.map(
      (a: {
        id: string;
        templateId: string;
        provisioningMode: ProvisioningModeType;
        isEnabled: boolean;
      }) => ({
        ...a,
        templateName:
          catalogMap.get(String(a.templateId)) ?? String(a.templateId),
        instance: instanceByTemplate.get(String(a.templateId)) ?? null,
      }),
    );
  }, [assignments, catalogMap, instances]);

  const error = assigned.error ?? instanceQuery.error ?? catalog.error;
  if (error) {
    return (
      <SettingsNotice
        tone="error"
        title={i18n.t("com.myoxus.settings.common.load-error")}
      >
        {error.message}
        <Group>
          <Button
            onClick={() => {
              void assigned.mutate(undefined, { throwOnError: false });
              void instanceQuery.mutate(undefined, { throwOnError: false });
              void catalog.mutate(undefined, { throwOnError: false });
            }}
          >
            {i18n.t("admin.error.retry")}
          </Button>
        </Group>
      </SettingsNotice>
    );
  }
  if (assigned.isLoading || instanceQuery.isLoading || catalog.isLoading) {
    return (
      <SettingsSkeleton
        aria-label={i18n.t("admin.workspaces.templates.loading-assignments")}
      />
    );
  }

  if (mergedAssignments.length === 0) {
    return (
      <SettingsEmptyState
        title={i18n.t("admin.workspaces.templates.no-assigned")}
      />
    );
  }

  return (
    <SurfaceList>
      {mergedAssignments.map(
        (assignment: {
          id: string;
          templateId: string;
          templateName: string;
          provisioningMode: ProvisioningModeType;
          isEnabled: boolean;
          instance: {
            id: string;
            revisionId: string;
            state: string;
            lastSyncedAt: string | null;
            lastErrorMessage: string | null;
          } | null;
        }) => (
          <AssignmentEntry
            key={assignment.id}
            assignment={assignment}
            workspaceId={workspaceId}
          />
        ),
      )}
    </SurfaceList>
  );
}

function AssignmentEntry({
  assignment,
  workspaceId,
}: {
  assignment: {
    id: string;
    templateId: string;
    templateName: string;
    provisioningMode: ProvisioningModeType;
    isEnabled: boolean;
    instance: {
      id: string;
      revisionId: string;
      state: string;
      lastSyncedAt: string | null;
      lastErrorMessage: string | null;
    } | null;
  };
  workspaceId: string;
}) {
  const i18n = useI18n();
  const { revalidateAssignments, revalidateWorkspaceInstances } =
    useTemplateRegistryRevalidate();
  const { trigger: removeAssignment, isMutating: isRemoving } =
    useRemoveTemplateAssignmentMutation();
  const { trigger: reconcile, isMutating: isReconciling } =
    useTriggerTemplateReconcileMutation();
  // Inline provisioning mode editor for an existing assignment
  const { trigger: assignTemplate, isMutating: isChangingPolicy } =
    useAssignTemplateToWorkspaceMutation();
  const [changePolicy, setChangePolicy] = useState<ChangePolicyState>({
    active: false,
  });
  const [removeOpen, setRemoveOpen] = useState(false);

  const provisioningModes = useMemo(
    () => [
      {
        value: ProvisioningModeType.SeedOnce,
        label: i18n.t("admin.workspaces.templates.mode-seed-once"),
      },
      {
        value: ProvisioningModeType.ManagedUntilLocalEdit,
        label: i18n.t("admin.workspaces.templates.mode-managed-until-edit"),
      },
      {
        value: ProvisioningModeType.ManualUpdate,
        label: i18n.t("admin.workspaces.templates.mode-manual-update"),
      },
    ],
    [i18n],
  );

  const handleRemove = useCallback(async () => {
    setRemoveOpen(false);
    try {
      await removeAssignment({ policyId: assignment.id });
      toast.success(
        i18n.t("admin.workspaces.templates.remove-success", {
          title: assignment.templateName,
        }),
      );
      await Promise.all([
        revalidateAssignments(workspaceId),
        revalidateWorkspaceInstances(workspaceId),
      ]);
    } catch (e) {
      toast.error(
        i18n.t("admin.workspaces.templates.remove-failed", {
          message: (e as Error).message,
        }),
      );
    }
  }, [
    assignment.id,
    assignment.templateName,
    i18n,
    removeAssignment,
    revalidateAssignments,
    revalidateWorkspaceInstances,
    workspaceId,
  ]);

  const handleReconcile = useCallback(async () => {
    try {
      await reconcile({
        workspaceId,
      });
      toast.success(i18n.t("admin.workspaces.templates.reconcile-success"));
      await revalidateWorkspaceInstances(workspaceId);
    } catch (e) {
      toast.error(
        i18n.t("admin.workspaces.templates.reconcile-failed", {
          message: (e as Error).message,
        }),
      );
    }
  }, [i18n, reconcile, revalidateWorkspaceInstances, workspaceId]);

  const handleChangePolicyOpen = useCallback(() => {
    setChangePolicy({
      active: true,
      provisioningMode: normalizeProvisioningMode(assignment.provisioningMode),
    });
  }, [assignment.provisioningMode]);

  const handleChangePolicyCancel = useCallback(() => {
    setChangePolicy({ active: false });
  }, []);

  const handleChangePolicySave = useCallback(async () => {
    if (!changePolicy.active) return;
    try {
      await assignTemplate({
        workspaceId,
        templateId: assignment.templateId,
        provisioningMode: changePolicy.provisioningMode,
        selectionMode: SelectionModeType.Published,
      });
      toast.success(
        i18n.t("admin.workspaces.templates.policy-updated", {
          title: assignment.templateName,
          mode: changePolicy.provisioningMode,
        }),
      );
      setChangePolicy({ active: false });
      await Promise.all([
        revalidateAssignments(workspaceId),
        revalidateWorkspaceInstances(workspaceId),
      ]);
    } catch (e) {
      toast.error(
        i18n.t("admin.workspaces.templates.policy-failed", {
          message: (e as Error).message,
        }),
      );
    }
  }, [
    assignTemplate,
    assignment.templateId,
    assignment.templateName,
    changePolicy,
    i18n,
    revalidateAssignments,
    revalidateWorkspaceInstances,
    workspaceId,
  ]);

  const inst = assignment.instance;

  // Format provisioning mode for display
  const modeLabel =
    provisioningModes.find(
      (m) => m.value === normalizeProvisioningMode(assignment.provisioningMode),
    )?.label ?? assignment.provisioningMode;

  return (
    <>
      <AdminConfirmModal
        open={removeOpen}
        onOpenChange={setRemoveOpen}
        title={i18n.t("admin.templates.action.remove.confirm.title")}
        description={i18n.t(
          "admin.templates.action.remove.confirm.description",
        )}
        confirmText={i18n.t("admin.workspaces.templates.remove")}
        danger
        onConfirm={handleRemove}
      />
      <SurfaceListItem density="compact" role="listitem">
        <SurfaceListItemMain compact>
          <SettingsToolbar justify="flex-start" align="center">
            <SettingsListItemTitle truncate>
              {assignment.templateName}
            </SettingsListItemTitle>
            {inst && (
              <TemplateInstanceStateBadge
                state={(inst.state ?? "OK") as TemplateInstanceState}
              />
            )}
          </SettingsToolbar>
          <SettingsStatusText>
            <span>{modeLabel}</span>
            {inst?.revisionId && (
              <>
                <span>|</span>
                <span>v{String(inst.revisionId).slice(0, 8)}</span>
              </>
            )}
            {inst?.lastSyncedAt && (
              <>
                <span>|</span>
                <span>
                  {i18n.t("admin.workspaces.templates.synced", {
                    date: formatAdminDate(i18n.language, inst.lastSyncedAt),
                  })}
                </span>
              </>
            )}
          </SettingsStatusText>
          {inst?.lastErrorMessage && (
            <SettingsStatusText tone="error">
              {inst.lastErrorMessage}
            </SettingsStatusText>
          )}
        </SurfaceListItemMain>

        {/* Inline policy editor — only visible when active */}
        {changePolicy.active && (
          <SettingsToolbar justify="flex-start" align="flex-end">
            <MyoxusSelect
              label={i18n.t("admin.workspaces.templates.new-mode-label")}
              value={changePolicy.provisioningMode}
              onChange={(mode) =>
                setChangePolicy({
                  active: true,
                  provisioningMode: mode as ProvisioningModeType,
                })
              }
              aria-label={i18n.t(
                "admin.templates.workspace-override.provisioning-mode-select",
              )}
              data={provisioningModes}
            />
            <Button
              type="button"
              variant="plain"
              onClick={handleChangePolicyCancel}
            >
              {i18n.t("admin.common.cancel")}
            </Button>
          </SettingsToolbar>
        )}

        <SettingsToolbar justify="flex-start">
          {changePolicy.active ? (
            <Button
              type="button"
              variant="primary"
              disabled={isChangingPolicy}
              onClick={handleChangePolicySave}
              aria-label={i18n.t("admin.workspaces.templates.save-policy-aria")}
            >
              {isChangingPolicy
                ? i18n.t("admin.workspaces.templates.saving")
                : i18n.t("admin.workspaces.templates.save-changes")}
            </Button>
          ) : (
            <Button
              type="button"
              variant="secondary"
              onClick={handleChangePolicyOpen}
              aria-label={i18n.t(
                "admin.workspaces.templates.change-policy-aria",
              )}
            >
              {i18n.t("admin.workspaces.templates.change-policy")}
            </Button>
          )}
          <Button
            type="button"
            variant="secondary"
            disabled={isReconciling}
            onClick={handleReconcile}
          >
            {isReconciling
              ? i18n.t("admin.workspaces.templates.reconciling")
              : i18n.t("admin.workspaces.templates.reconcile")}
          </Button>
          <Button
            type="button"
            variant="error"
            disabled={isRemoving}
            onClick={() => setRemoveOpen(true)}
          >
            {isRemoving
              ? i18n.t("admin.workspaces.templates.removing")
              : i18n.t("admin.workspaces.templates.remove")}
          </Button>
        </SettingsToolbar>
      </SurfaceListItem>
    </>
  );
}
