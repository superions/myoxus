/**
 * Right-panel detail view for a single workspace in the admin workspaces module.
 *
 * Loads full workspace details (members, flags, feature flags, metrics) and
 * allows admins to toggle boolean flags, rename the workspace, and manage
 * feature entitlements. Dirty-change tracking is surfaced via the right panel header.
 */
import { adminToast as toast } from "@myoxus/admin/notifications";
import {
  adminAssignOrganizationUnitWorkspaceMutation,
  type AdminAuditLogEntryType,
  adminAuditLogQuery,
  adminDeleteWorkspaceMutation,
  adminTriggerWorkspaceReindexMutation,
  adminUnassignOrganizationUnitWorkspaceMutation,
  adminUpdateWorkspaceMutation,
  adminWorkspaceOrganizationUnitWorkspacesQuery,
  adminWorkspaceQuery,
  adminWorkspacesListQuery,
  type FeatureType,
  OrganizationUnitWorkspaceRelationshipEnum,
} from "@myoxus/graphql";
import { useI18n } from "@myoxus/i18n";
import { CloseIcon, UnlinkIcon } from "@myoxus/icons/react";
import {
  Badge,
  Button,
  FormSelect,
  IconButton,
  Group,
  NumberInput,
  Progress,
  SettingsEmptyState,
  SettingsDetailHeader,
  SettingsListItemMeta,
  SettingsListItemTitle,
  SettingsHeadingGroup,
  SettingsSectionDescription,
  SettingsSectionHeading,
  SettingsStatusText,
  SettingsToolbar,
  Stack,
  SimpleGrid,
  SurfaceListItemMain,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  Table,
  TableHeader,
  TableHead,
  TableBody,
  TableRow,
  TableCell,
} from "@myoxus/ui-facade";
import {
  Component,
  type ErrorInfo,
  type ReactNode,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import { OuPicker } from "../../../components/domain-pickers";
import { AdminConfirmModal } from "../../../components/shared/admin-confirm-modal";
import { AdminTypeConfirmModal } from "../../../components/shared/admin-type-confirm-modal";
import { useMutateQueryResource, useMutation } from "../../../use-mutation";
import { useQuery } from "../../../use-query";
import {
  formatAdminDate,
  formatAdminDateTime,
} from "../../../utils/locale-format";
import { eventLabel } from "../../audit-log/audit-labels";
import { useServerConfig } from "../../common";
import { RightPanelHeader } from "../../header";
import {
  useTemplateCatalogQuery,
  useWorkspaceTemplateInstancesQuery,
} from "../../templates/api";
import {
  type TemplateInstanceState,
  TemplateInstanceStateBadge,
} from "../../templates/badges";
import {
  adminEditableWorkspaceFeatures,
  mergeEditableWorkspaceFeatureSelection,
} from "../feature-visibility";
import type { WorkspaceDetail } from "../schema";
import { formatBytes } from "../utils";
import { WorkspaceBasicsTab } from "./workspace-basics-tab";
import { WorkspaceBrandingTab } from "./workspace-branding-tab";
import { WorkspaceMembersSection } from "./workspace-panel-members";
import { WorkspaceQuotaInspector } from "./workspace-quota-inspector";
import { WorkspaceTemplateDrawer } from "./workspace-template-drawer";

const DRAWER_TABS = [
  "basics",
  "members",
  "branding",
  "ou-link",
  "quota",
  "audit",
] as const;

type WorkspaceDrawerTab = (typeof DRAWER_TABS)[number];

function organizationWorkspaceRelationshipKey(
  value: OrganizationUnitWorkspaceRelationshipEnum | string,
) {
  return String(value).toLowerCase();
}

/**
 * Entry point for the workspace detail panel.
 * Fetches workspace data by ID and renders `WorkspacePanelContent` once loaded,
 * or a "not found" state if the workspace no longer exists.
 */
export function WorkspacePanel({
  workspaceId,
  onClose,
  initialTab = "basics",
  onDirtyChange,
}: {
  workspaceId: string;
  onClose: () => void;
  initialTab?: WorkspaceDrawerTab;
  onDirtyChange?: (dirty: boolean) => void;
}) {
  const i18n = useI18n();
  const { data } = useQuery({
    query: adminWorkspaceQuery,
    variables: {
      id: workspaceId,
      memberSkip: 0,
      memberTake: 20,
    },
  });
  const workspace = data?.admin.adminWorkspace;

  if (!data) {
    return (
      <Stack component="section">
        <RightPanelHeader
          title={i18n.t("admin.workspaces.panel.title")}
          handleClose={onClose}
        />
        <SettingsEmptyState title={i18n.t("admin.common.loading")} />
      </Stack>
    );
  }

  if (!workspace) {
    return (
      <Stack component="section">
        <RightPanelHeader
          title={i18n.t("admin.workspaces.panel.title")}
          handleClose={onClose}
        />
        <SettingsEmptyState
          title={i18n.t("admin.workspaces.panel.not-found")}
        />
      </Stack>
    );
  }

  return (
    <WorkspacePanelContent
      key={workspace.id}
      workspace={workspace}
      onClose={onClose}
      initialTab={initialTab}
      onDirtyChange={onDirtyChange}
    />
  );
}

function WorkspacePanelContent({
  workspace,
  onClose,
  initialTab,
  onDirtyChange,
}: {
  workspace: WorkspaceDetail;
  onClose: () => void;
  initialTab: WorkspaceDrawerTab;
  onDirtyChange?: (dirty: boolean) => void;
}) {
  const i18n = useI18n();
  const serverConfig = useServerConfig();
  const revalidate = useMutateQueryResource();
  const { trigger: updateWorkspace, isMutating } = useMutation({
    mutation: adminUpdateWorkspaceMutation,
  });
  const { trigger: triggerReindex } = useMutation({
    mutation: adminTriggerWorkspaceReindexMutation,
  });
  const { trigger: triggerDeleteWorkspace } = useMutation({
    mutation: adminDeleteWorkspaceMutation,
  });

  const [reindexDialogOpen, setReindexDialogOpen] = useState(false);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);

  const handleReindex = useCallback(() => {
    triggerReindex({ workspaceId: workspace.id })
      .then(() => {
        toast.success(i18n.t("admin.workspace.reindex-success"));
        setReindexDialogOpen(false);
      })
      .catch((e) => {
        toast.error(
          i18n.t("admin.workspace.reindex-error", {
            message: (e as Error).message,
          }),
        );
      });
  }, [triggerReindex, workspace.id, i18n]);

  const handleDeleteWorkspace = useCallback(() => {
    triggerDeleteWorkspace({ id: workspace.id })
      .then(async () => {
        toast.success(i18n.t("admin.workspace.delete-success"));
        setDeleteDialogOpen(false);
        await revalidate(adminWorkspacesListQuery);
        onClose();
      })
      .catch((e) => {
        toast.error(
          i18n.t("admin.workspace.delete-error", {
            message: (e as Error).message,
          }),
        );
      });
  }, [triggerDeleteWorkspace, workspace.id, i18n, revalidate, onClose]);

  // Storage quota: bytes from server, displayed as MB in the UI
  const rawQuotaBytes: number | null =
    "storageQuotaBytes" in workspace
      ? (workspace as any).storageQuotaBytes
      : null;
  const rawQuotaUsed: number =
    "storageQuotaUsed" in workspace
      ? (workspace as any).storageQuotaUsed
      : ((workspace as any).snapshotSize ?? 0) +
        ((workspace as any).blobSize ?? 0);

  const featureIdentity = JSON.stringify([...workspace.features].sort());
  const serverFeatures = useMemo(
    () => JSON.parse(featureIdentity) as FeatureType[],
    [featureIdentity],
  );
  const normalizedWorkspace = useMemo(
    () => ({
      features: serverFeatures,
      flags: {
        public: workspace.public,
        enableAi: workspace.enableAi,
        enableSharing: workspace.enableSharing,
        enableUrlPreview: workspace.enableUrlPreview,
        enableDocEmbedding: workspace.enableDocEmbedding,
        name: workspace.name ?? "",
      },
      storageQuotaMb:
        rawQuotaBytes != null
          ? Math.round(rawQuotaBytes / (1024 * 1024))
          : null,
    }),
    [
      serverFeatures,
      workspace.public,
      workspace.enableAi,
      workspace.enableSharing,
      workspace.enableUrlPreview,
      workspace.enableDocEmbedding,
      workspace.name,
      rawQuotaBytes,
    ],
  );

  const [featureSelection, setFeatureSelection] = useState<FeatureType[]>(
    normalizedWorkspace.features,
  );
  const [flags, setFlags] = useState(normalizedWorkspace.flags);
  const [storageQuotaMb, setStorageQuotaMb] = useState<number | null>(
    normalizedWorkspace.storageQuotaMb,
  );
  const [baseline, setBaseline] = useState(normalizedWorkspace);
  const acceptedServerSnapshot = useRef(normalizedWorkspace);
  const editableWorkspaceFeatures = useMemo(
    () =>
      adminEditableWorkspaceFeatures(
        serverConfig?.availableWorkspaceFeatures ?? [],
      ),
    [serverConfig?.availableWorkspaceFeatures],
  );

  const hasChanges = useMemo(() => {
    return (
      flags.public !== baseline.flags.public ||
      flags.enableAi !== baseline.flags.enableAi ||
      flags.enableSharing !== baseline.flags.enableSharing ||
      flags.enableUrlPreview !== baseline.flags.enableUrlPreview ||
      flags.enableDocEmbedding !== baseline.flags.enableDocEmbedding ||
      flags.name !== baseline.flags.name ||
      storageQuotaMb !== baseline.storageQuotaMb ||
      featureSelection.length !== baseline.features.length ||
      featureSelection.some((f) => !baseline.features.includes(f))
    );
  }, [baseline, featureSelection, flags, storageQuotaMb]);

  useEffect(() => {
    // Inventory/filter renders and refreshed metrics must not replace a draft.
    // Adopt refreshed editable values only once the operator is no longer dirty.
    if (hasChanges || acceptedServerSnapshot.current === normalizedWorkspace)
      return;
    acceptedServerSnapshot.current = normalizedWorkspace;
    setFeatureSelection(normalizedWorkspace.features);
    setFlags(normalizedWorkspace.flags);
    setStorageQuotaMb(normalizedWorkspace.storageQuotaMb);
    setBaseline(normalizedWorkspace);
  }, [normalizedWorkspace, hasChanges]);

  useEffect(() => {
    onDirtyChange?.(hasChanges);
    return () => onDirtyChange?.(false);
  }, [hasChanges, onDirtyChange]);

  const discardChanges = () => {
    setFlags(baseline.flags);
    setFeatureSelection(baseline.features);
    setStorageQuotaMb(baseline.storageQuotaMb);
  };

  const handleFeaturesChange = useCallback(
    (features: FeatureType[]) => {
      setFeatureSelection((currentSelection) =>
        mergeEditableWorkspaceFeatureSelection(
          currentSelection,
          editableWorkspaceFeatures,
          features,
        ),
      );
    },
    [editableWorkspaceFeatures],
  );

  const handleSave = useCallback(() => {
    const update = async () => {
      try {
        await updateWorkspace({
          input: {
            id: workspace.id,
            public: flags.public,
            enableAi: flags.enableAi,
            enableSharing: flags.enableSharing,
            enableUrlPreview: flags.enableUrlPreview,
            enableDocEmbedding: flags.enableDocEmbedding,
            name: flags.name || null,
            features: featureSelection,
            ...(storageQuotaMb !== baseline.storageQuotaMb
              ? {
                  storageQuotaBytes:
                    storageQuotaMb != null
                      ? storageQuotaMb * 1024 * 1024
                      : null,
                }
              : {}),
          },
        });
        await Promise.all([
          revalidate(adminWorkspacesListQuery),
          revalidate(adminWorkspaceQuery, (vars) => vars?.id === workspace.id),
        ]);
        toast.success(i18n.t("admin.workspaces.panel.update-success"));
        setBaseline({
          flags: { ...flags },
          features: [...featureSelection],
          storageQuotaMb,
        });
      } catch (e) {
        toast.error(
          i18n.t("admin.workspaces.panel.update-failed", {
            message: (e as Error).message,
          }),
        );
      }
    };
    update().catch(() => {});
  }, [
    baseline.storageQuotaMb,
    featureSelection,
    flags,
    i18n,
    revalidate,
    setBaseline,
    storageQuotaMb,
    updateWorkspace,
    workspace.id,
  ]);
  const drawerTabItems = useMemo(
    () =>
      DRAWER_TABS.map((tab) => ({
        value: tab,
        label: i18n.t(`admin.workspaces.drawer.tab.${tab}` as never),
        testId: `workspace-drawer-tab-${tab}`,
      })),
    [i18n],
  );

  return (
    <Stack component="section" data-testid="workspace-detail-content">
      <SettingsDetailHeader
        title={workspace.name?.trim() || workspace.id}
        headingLevel={2}
        description={
          hasChanges ? i18n.t("admin.state.unsaved-changes") : undefined
        }
        actions={
          <>
            {hasChanges ? (
              <Button
                variant="secondary"
                onClick={discardChanges}
                disabled={isMutating}
              >
                {i18n.t("admin.common.discard-changes")}
              </Button>
            ) : null}
            <IconButton
              icon={<CloseIcon aria-hidden />}
              aria-label={i18n.t("admin.common.close")}
              tooltip={i18n.t("admin.common.close")}
              onClick={onClose}
              disabled={isMutating}
            />
            <Button
              variant="primary"
              onClick={handleSave}
              disabled={!hasChanges || isMutating}
              loading={isMutating}
            >
              {i18n.t("admin.common.save")}
            </Button>
          </>
        }
      />
      <Tabs defaultValue={initialTab} layout="embedded" variant="default">
        <TabsList variant="panel" data-testid="workspace-drawer-tabs-nav">
          {drawerTabItems.map((item) => (
            <TabsTrigger
              key={item.value}
              value={item.value}
              variant="panel"
              data-testid={item.testId}
            >
              {item.label}
            </TabsTrigger>
          ))}
        </TabsList>
        <TabsContent
          value="basics"
          layout="stack"
          data-testid="workspace-drawer-panel-basics"
        >
          <WorkspaceBasicsTab
            workspace={workspace}
            flags={flags}
            setFlags={setFlags}
            featureSelection={featureSelection}
            availableFeatures={editableWorkspaceFeatures}
            onFeaturesChange={handleFeaturesChange}
            onReindex={() => setReindexDialogOpen(true)}
            onDelete={() => setDeleteDialogOpen(true)}
            templates={
              workspace.memberCount > 1 ? (
                <WorkspaceTemplatesSection workspaceId={workspace.id} />
              ) : undefined
            }
          />
        </TabsContent>

        <TabsContent
          value="members"
          layout="stack"
          data-testid="workspace-drawer-panel-members"
        >
          <WorkspaceMembersSection
            workspaceId={workspace.id}
            ownerId={workspace.owner?.id ?? null}
          />
        </TabsContent>

        <TabsContent
          value="branding"
          layout="stack"
          data-testid="workspace-drawer-panel-branding"
        >
          <WorkspaceBrandingTab
            workspaceId={workspace.id}
            workspaceName={workspace.name}
          />
        </TabsContent>

        <TabsContent
          value="ou-link"
          layout="stack"
          data-testid="workspace-drawer-panel-ou-link"
        >
          <WorkspaceOuLinkSection
            workspaceId={workspace.id}
            workspaceName={workspace.name}
          />
        </TabsContent>

        <TabsContent
          value="quota"
          layout="stack"
          data-testid="workspace-drawer-panel-quota"
        >
          <Stack component="section">
            <SettingsSectionHeading level={3}>
              {i18n.t("admin.workspaces.panel.storage-quota")}
            </SettingsSectionHeading>
            <StorageQuotaSection
              usedBytes={rawQuotaUsed}
              quotaMb={storageQuotaMb}
              onQuotaChange={setStorageQuotaMb}
            />
            <WorkspaceQuotaInspector workspaceId={workspace.id} />
          </Stack>
        </TabsContent>

        <TabsContent
          value="audit"
          layout="stack"
          data-testid="workspace-drawer-panel-audit"
        >
          <WorkspaceAuditSection workspaceId={workspace.id} />
        </TabsContent>

        {/* Reindex confirmation dialog */}
        <AdminConfirmModal
          open={reindexDialogOpen}
          onOpenChange={setReindexDialogOpen}
          title={i18n.t("admin.workspace.reindex-confirm-title")}
          description={i18n.t("admin.workspace.reindex-confirm-desc")}
          confirmText={i18n.t("admin.workspace.reindex")}
          onConfirm={handleReindex}
          onCancel={() => setReindexDialogOpen(false)}
        />

        {/* Delete confirmation dialog — requires typing workspace name */}
        <AdminTypeConfirmModal
          open={deleteDialogOpen}
          onOpenChange={setDeleteDialogOpen}
          title={i18n.t("admin.workspace.delete-confirm-title")}
          description={i18n.t("admin.workspace.delete-confirm-desc")}
          targetText={workspace.name ?? workspace.id}
          inputPlaceholder={i18n.t(
            "admin.workspace.delete-confirm-placeholder",
          )}
          confirmText={i18n.t("admin.workspace.delete")}
          onConfirm={handleDeleteWorkspace}
          onCancel={() => setDeleteDialogOpen(false)}
        />
      </Tabs>
    </Stack>
  );
}

function WorkspaceOuLinkSection({
  workspaceId,
  workspaceName,
}: {
  workspaceId: string;
  workspaceName: string | null;
}) {
  const i18n = useI18n();
  const revalidate = useMutateQueryResource();
  const { data, isLoading } = useQuery(
    {
      query: adminWorkspaceOrganizationUnitWorkspacesQuery,
      variables: { workspaceId },
    },
    { keepPreviousData: true },
  );
  const { trigger: assignWorkspace, isMutating: isAssigning } = useMutation({
    mutation: adminAssignOrganizationUnitWorkspaceMutation,
  });
  const { trigger: unassignWorkspace, isMutating: isUnassigning } = useMutation(
    {
      mutation: adminUnassignOrganizationUnitWorkspaceMutation,
    },
  );
  const [selectedUnitId, setSelectedUnitId] = useState<string | null>(null);
  const [relationship, setRelationship] =
    useState<OrganizationUnitWorkspaceRelationshipEnum>(
      OrganizationUnitWorkspaceRelationshipEnum.Managed,
    );
  const links = data?.admin?.workspaceOrganizationUnitWorkspaces ?? [];

  const refreshLinks = useCallback(
    () =>
      revalidate(
        adminWorkspaceOrganizationUnitWorkspacesQuery,
        (vars: { workspaceId?: string } | undefined) =>
          vars?.workspaceId === workspaceId,
      ),
    [revalidate, workspaceId],
  );

  const handleAssign = useCallback(async () => {
    if (!selectedUnitId) return;
    try {
      await assignWorkspace({
        input: {
          unitId: selectedUnitId,
          workspaceId,
          relationship,
        },
      });
      toast.success(i18n.t("admin.workspaces.drawer.ou-link.add-success"));
      setSelectedUnitId(null);
      await refreshLinks();
    } catch (e) {
      toast.error(
        i18n.t("admin.workspaces.drawer.ou-link.add-failed", {
          message: (e as Error).message,
        }),
      );
    }
  }, [
    assignWorkspace,
    i18n,
    refreshLinks,
    relationship,
    selectedUnitId,
    workspaceId,
  ]);

  const handleUnassign = useCallback(
    async (
      unitId: string,
      linkRelationship: OrganizationUnitWorkspaceRelationshipEnum,
    ) => {
      try {
        await unassignWorkspace({
          unitId,
          workspaceId,
          relationship: linkRelationship,
        });
        toast.success(i18n.t("admin.workspaces.drawer.ou-link.remove-success"));
        await refreshLinks();
      } catch (e) {
        toast.error(
          i18n.t("admin.workspaces.drawer.ou-link.remove-failed", {
            message: (e as Error).message,
          }),
        );
      }
    },
    [i18n, refreshLinks, unassignWorkspace, workspaceId],
  );

  const handleRelationshipChange = useCallback(
    async (
      unitId: string,
      nextRelationship: OrganizationUnitWorkspaceRelationshipEnum,
    ) => {
      try {
        await assignWorkspace({
          input: {
            unitId,
            workspaceId,
            relationship: nextRelationship,
          },
        });
        toast.success(i18n.t("admin.workspaces.panel.update-success"));
        await refreshLinks();
      } catch (e) {
        toast.error(
          i18n.t("admin.workspaces.drawer.ou-link.add-failed", {
            message: (e as Error).message,
          }),
        );
      }
    },
    [assignWorkspace, i18n, refreshLinks, workspaceId],
  );

  const relationshipLabel = useCallback(
    (value: OrganizationUnitWorkspaceRelationshipEnum) =>
      i18n.t(
        `admin.workspaces.drawer.ou-link.relationship-${organizationWorkspaceRelationshipKey(value)}` as never,
      ),
    [i18n],
  );

  return (
    <Stack component="section">
      <SettingsHeadingGroup>
        <SettingsSectionHeading level={3}>
          {i18n.t("admin.workspaces.drawer.ou-link.title")}
        </SettingsSectionHeading>
        <SettingsSectionDescription>
          {i18n.t("admin.workspaces.drawer.ou-link.description", {
            name: workspaceName ?? workspaceId,
          })}
        </SettingsSectionDescription>
      </SettingsHeadingGroup>
      <SimpleGrid cols={2}>
        <OuPicker
          label={i18n.t("admin.workspaces.drawer.ou-link.unit-label")}
          value={selectedUnitId}
          onChange={setSelectedUnitId}
          placeholder={i18n.t(
            "admin.workspaces.drawer.ou-link.unit-placeholder",
          )}
          data-testid="workspace-ou-picker"
        />
        <FormSelect
          label={i18n.t("admin.workspaces.drawer.ou-link.relationship-label")}
          value={relationship}
          onChange={(value) =>
            setRelationship(value as OrganizationUnitWorkspaceRelationshipEnum)
          }
          aria-label={i18n.t(
            "admin.workspaces.drawer.ou-link.relationship-label",
          )}
          data={Object.values(OrganizationUnitWorkspaceRelationshipEnum).map(
            (value) => ({
              value,
              label: relationshipLabel(value),
            }),
          )}
          data-testid="workspace-ou-relationship-select"
        />
      </SimpleGrid>
      <Group justify="flex-end">
        <Button
          type="button"
          disabled={!selectedUnitId || isAssigning}
          onClick={handleAssign}
          data-testid="workspace-ou-assign-btn"
        >
          {i18n.t("admin.workspaces.drawer.ou-link.add")}
        </Button>
      </Group>

      {isLoading ? (
        <SettingsStatusText>{i18n.t("admin.state.loading")}</SettingsStatusText>
      ) : links.length === 0 ? (
        <SettingsEmptyState
          title={i18n.t("admin.workspaces.drawer.ou-link.none")}
        />
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>
                {i18n.t("admin.workspaces.drawer.ou-link.unit-label")}
              </TableHead>
              <TableHead>
                {i18n.t("admin.workspaces.drawer.ou-link.relationship-label")}
              </TableHead>
              <TableHead>{i18n.t("admin.common.actions")}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {links.map((link) => (
              <TableRow key={`${link.unitId}-${link.relationship}`}>
                <TableCell>
                  <SettingsListItemTitle truncate>
                    {link.unitName ?? link.unitId}
                  </SettingsListItemTitle>
                  <SettingsListItemMeta truncate>
                    {link.unitSlug ?? link.unitId}
                  </SettingsListItemMeta>
                </TableCell>
                <TableCell>
                  <FormSelect
                    value={link.relationship}
                    onChange={(value) =>
                      handleRelationshipChange(
                        link.unitId,
                        value as OrganizationUnitWorkspaceRelationshipEnum,
                      )
                    }
                    aria-label={i18n.t(
                      "admin.workspaces.drawer.ou-link.relationship-label",
                    )}
                    data={Object.values(
                      OrganizationUnitWorkspaceRelationshipEnum,
                    ).map((value) => ({
                      value,
                      label: relationshipLabel(value),
                    }))}
                    disabled={isAssigning}
                    data-testid={`workspace-ou-link-relationship-${link.unitId}`}
                  />
                </TableCell>
                <TableCell>
                  <IconButton
                    icon={<UnlinkIcon aria-hidden />}
                    aria-label={i18n.t(
                      "admin.workspaces.drawer.ou-link.remove",
                    )}
                    tooltip={i18n.t("admin.workspaces.drawer.ou-link.remove")}
                    type="button"
                    variant="plain"
                    disabled={isUnassigning}
                    onClick={() =>
                      handleUnassign(link.unitId, link.relationship)
                    }
                    data-testid={`workspace-ou-unassign-${link.unitId}`}
                  />
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </Stack>
  );
}

function WorkspaceAuditSection({ workspaceId }: { workspaceId: string }) {
  const i18n = useI18n();
  const { data, isLoading } = useQuery(
    {
      query: adminAuditLogQuery,
      variables: {
        filter: { targetType: "workspace", targetId: workspaceId },
        limit: 12,
        offset: 0,
      },
    },
    { keepPreviousData: true },
  );
  const entries: AdminAuditLogEntryType[] = data?.admin?.adminAuditLog ?? [];

  return (
    <Stack component="section">
      <SettingsHeadingGroup>
        <SettingsSectionHeading level={3}>
          {i18n.t("admin.workspaces.drawer.audit.title")}
        </SettingsSectionHeading>
        <SettingsSectionDescription>
          {i18n.t("admin.workspaces.drawer.audit.description")}
        </SettingsSectionDescription>
      </SettingsHeadingGroup>
      {isLoading ? (
        <SettingsStatusText>{i18n.t("admin.state.loading")}</SettingsStatusText>
      ) : entries.length === 0 ? (
        <SettingsEmptyState
          title={i18n.t("admin.workspaces.drawer.audit.none")}
        />
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{i18n.t("admin.audit-log.col.eventKey")}</TableHead>
              <TableHead>{i18n.t("admin.audit-log.col.actor")}</TableHead>
              <TableHead>{i18n.t("admin.audit-log.col.time")}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {entries.map((entry) => (
              <TableRow key={entry.id}>
                <TableCell>{eventLabel(entry.eventKey, i18n.t)}</TableCell>
                <TableCell>
                  {entry.actor?.label ??
                    i18n.t("admin.workspaces.drawer.audit.system-actor")}
                </TableCell>
                <TableCell>
                  {formatAdminDateTime(i18n.language, entry.createdAt)}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </Stack>
  );
}

function StorageQuotaSection({
  usedBytes,
  quotaMb,
  onQuotaChange,
}: {
  usedBytes: number;
  quotaMb: number | null;
  onQuotaChange: (value: number | null) => void;
}) {
  const i18n = useI18n();
  const usedMb = usedBytes / (1024 * 1024);
  const percent =
    quotaMb != null && quotaMb > 0
      ? Math.min(100, (usedMb / quotaMb) * 100)
      : 0;
  return (
    <>
      <SettingsListItemMeta>
        {quotaMb != null
          ? i18n.t("admin.workspaces.panel.storage-quota-used", {
              used: formatBytes(usedBytes),
              total: formatBytes(quotaMb * 1024 * 1024),
            })
          : i18n.t("admin.workspaces.panel.storage-quota-no-limit")}
      </SettingsListItemMeta>
      {quotaMb != null ? (
        <Progress
          value={percent}
          showValueLabel={false}
          ariaLabel={i18n.t("admin.workspaces.panel.storage-quota")}
        />
      ) : null}
      <NumberInput
        label={i18n.t("admin.workspaces.panel.quota-override-label")}
        min={0}
        aria-label={i18n.t("admin.workspaces.panel.quota-override-label")}
        value={quotaMb ?? ""}
        onChange={(val) => {
          onQuotaChange(val === "" ? null : Math.max(0, Number(val) || 0));
        }}
      />
      {quotaMb != null ? (
        <Group>
          <Button
            type="button"
            variant="secondary"
            size="sm"
            onClick={() => onQuotaChange(null)}
          >
            {i18n.t("admin.workspaces.panel.quota-clear")}
          </Button>
        </Group>
      ) : null}
    </>
  );
}

/**
 * Lightweight error boundary to catch GraphQL errors when the template
 * registry feature is disabled on the server. Falls back to a hidden state
 * instead of crashing the entire workspace panel.
 */
class TemplateErrorBoundary extends Component<
  { children: ReactNode },
  { hasError: boolean }
> {
  constructor(props: { children: ReactNode }) {
    super(props);
    this.state = { hasError: false };
  }

  static getDerivedStateFromError(_error: Error) {
    return { hasError: true };
  }

  override componentDidCatch(_error: Error, _info: ErrorInfo) {
    // Template registry disabled or unavailable — silently hide the section
  }

  override render() {
    if (this.state.hasError) {
      return null;
    }
    return this.props.children;
  }
}

/**
 * Templates section for the workspace detail panel.
 * Wraps the data-fetching content in Suspense + ErrorBoundary so that
 * loading, error, and disabled-registry states are handled gracefully.
 */
function WorkspaceTemplatesSection({ workspaceId }: { workspaceId: string }) {
  const i18n = useI18n();
  return (
    <TemplateErrorBoundary>
      <Suspense
        fallback={
          <Stack>
            <SettingsSectionHeading level={3}>
              {i18n.t("admin.workspaces.panel.templates")}
            </SettingsSectionHeading>
            <SettingsEmptyState
              title={i18n.t("admin.workspaces.panel.templates-loading")}
            />
          </Stack>
        }
      >
        <WorkspaceTemplatesSectionContent workspaceId={workspaceId} />
      </Suspense>
    </TemplateErrorBoundary>
  );
}

/**
 * Inner content component that performs the GraphQL queries.
 * Rendered inside Suspense so the parent shows a loading fallback
 * while data is being fetched.
 */
function WorkspaceTemplatesSectionContent({
  workspaceId,
}: {
  workspaceId: string;
}) {
  const i18n = useI18n();
  const [drawerOpen, setDrawerOpen] = useState(false);

  const { instances } = useWorkspaceTemplateInstancesQuery(workspaceId);
  const { entries: catalogEntries } = useTemplateCatalogQuery({
    skip: 0,
    take: 100,
  });

  // Build a lookup map: template ID → title
  const catalogMap = useMemo(() => {
    const map = new Map<string, string>();
    for (const entry of catalogEntries) {
      map.set(String(entry.id), entry.title);
    }
    return map;
  }, [catalogEntries]);

  return (
    <Stack>
      <Group justify="space-between">
        <Group>
          <SettingsSectionHeading level={3}>
            {i18n.t("admin.workspaces.panel.templates")}
          </SettingsSectionHeading>
          <Badge tone="neutral">{instances.length}</Badge>
        </Group>
        <Button
          type="button"
          variant="secondary"
          onClick={() => setDrawerOpen(true)}
        >
          {i18n.t("admin.workspaces.panel.templates-manage")}
        </Button>
      </Group>
      <WorkspaceTemplateDrawer
        workspaceId={workspaceId}
        open={drawerOpen}
        onOpenChange={setDrawerOpen}
      />
      <Stack>
        {instances.length === 0 ? (
          <SettingsEmptyState
            title={i18n.t("admin.workspaces.panel.templates-none")}
          />
        ) : (
          instances.map(
            (inst: {
              id: string;
              templateId: string;
              revisionId: string;
              state: string;
              lastSyncedAt: string | null;
              lastErrorMessage: string | null;
            }) => {
              const templateName =
                catalogMap.get(String(inst.templateId)) ??
                String(inst.templateId);
              return (
                <SettingsToolbar key={inst.id} justify="space-between">
                  <SurfaceListItemMain grow>
                    <SettingsListItemTitle truncate>
                      {templateName}
                    </SettingsListItemTitle>
                    <SettingsStatusText>
                      <SettingsListItemMeta>
                        {String(inst.revisionId).slice(0, 8)}
                      </SettingsListItemMeta>
                      {inst.lastSyncedAt && (
                        <SettingsListItemMeta>
                          {i18n.t("admin.workspaces.panel.template-synced", {
                            date: formatAdminDate(
                              i18n.language,
                              inst.lastSyncedAt,
                            ),
                          })}
                        </SettingsListItemMeta>
                      )}
                    </SettingsStatusText>
                    {inst.lastErrorMessage && (
                      <SettingsStatusText tone="error">
                        {inst.lastErrorMessage}
                      </SettingsStatusText>
                    )}
                  </SurfaceListItemMain>
                  <TemplateInstanceStateBadge
                    state={(inst.state ?? "OK") as TemplateInstanceState}
                  />
                </SettingsToolbar>
              );
            },
          )
        )}
      </Stack>
    </Stack>
  );
}
