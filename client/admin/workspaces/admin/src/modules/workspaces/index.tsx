/**
 * Workspaces page — compact inventory with a persistent detail panel.
 *
 * The page keeps the server-side filter and pagination contract while native
 * Facade navigation links expose a clear selected state without nested cards.
 * Large installations therefore keep the bounded master-detail workflow
 * without loading the full workspace set in the browser.
 */
import { adminToast as toast } from "@myoxus/admin/notifications";
import {
  adminWorkspacesListQuery,
  AdminWorkspaceSort,
  createWorkspaceInOrganizationUnitMutation,
  createWorkspaceMutation,
  type FeatureType,
  OrganizationUnitStatusEnum,
} from "@myoxus/graphql";
import { useI18n } from "@myoxus/i18n";
import { Plus } from "@myoxus/icons/react";
import {
  Badge,
  Button,
  DialogFooterActions,
  Divider,
  FormSelect,
  Modal,
  MyoxusSegmentedControl,
  NavigationLink,
  Pagination,
  SettingsEmptyState,
  SettingsMasterDetailLayout,
  SettingsStatusText,
  SettingsToolbar,
  Stack,
  SurfaceList,
} from "@myoxus/ui-facade";
import { useCallback, useEffect, useMemo, useState } from "react";

import { useMutateQueryResource, useMutation } from "../../use-mutation";
import { AdminConfirmModal } from "../../components/shared/admin-confirm-modal";
import { AdminPageFrame, AdminPageScroll } from "../admin-shell";
import {
  useOrganizationUnitsQuery,
  useOrganizationUnitTypesQuery,
} from "../organization/api";
import { WorkspacePanel } from "./components/workspace-panel";
import { WorkspaceToolbar } from "./components/workspace-toolbar";
import type {
  WorkspaceFlagFilter,
  WorkspaceGitSyncFilter,
  WorkspaceListItem,
  WorkspaceTypeFilter,
} from "./schema";
import { useWorkspaceList } from "./use-workspace-list";
import { formatBytes } from "./utils";

function workspaceName(workspace: WorkspaceListItem): string {
  return workspace.name?.trim() || workspace.id;
}

function workspaceTypeLabelKey(workspace: WorkspaceListItem): string {
  const typed = (workspace as WorkspaceListItem & { workspaceType?: string })
    .workspaceType;
  if (typed === "Shared") return "admin.workspaces.columns.shared";
  if (typed === "Personal") return "admin.workspaces.columns.personal";
  return "admin.workspaces.columns.user-owned";
}

function gitSyncLabel(workspace: WorkspaceListItem): string | null {
  const sync = workspace as WorkspaceListItem & {
    gitSyncEnabled?: boolean | null;
    gitSyncLastStatus?: string | null;
  };
  if (!sync.gitSyncEnabled) return null;
  return sync.gitSyncLastStatus ?? "admin.workspaces.columns.git-sync-active";
}

function WorkspaceInventoryItem({
  workspace,
  active,
  onSelect,
}: {
  workspace: WorkspaceListItem;
  active: boolean;
  onSelect: (id: string) => void;
}) {
  const i18n = useI18n();
  const storageBytes =
    (workspace.snapshotSize ?? 0) + (workspace.blobSize ?? 0);
  const sync = gitSyncLabel(workspace);
  const ownerLabel = i18n.t("admin.workspaces.columns.owner");
  const principalOwner = workspace as WorkspaceListItem & {
    ownerPrincipalName?: string | null;
  };
  const ownerValue =
    principalOwner.ownerPrincipalName ??
    workspace.owner?.email ??
    i18n.t("admin.workspaces.list.no-owner");
  const syncLabel = sync
    ? sync.startsWith("admin.")
      ? i18n.t(sync as never)
      : sync
    : null;
  const inventoryDetails = [
    `${workspace.memberCount} ${i18n.t("admin.workspaces.columns.members")}`,
    `${formatBytes(storageBytes)} ${i18n.t("admin.workspaces.list.storage-used")}`,
    workspace.public ? i18n.t("admin.workspaces.flags.public") : null,
    syncLabel,
  ]
    .filter(Boolean)
    .join(" · ");
  const description = (
    <>
      {ownerLabel}: {ownerValue}
      <br />
      {inventoryDetails}
    </>
  );

  return (
    <NavigationLink
      component="button"
      type="button"
      data-testid={`workspace-soft-row-${workspace.id}`}
      label={workspaceName(workspace)}
      description={description}
      active={active}
      aria-pressed={active}
      rightSection={
        <Badge tone="neutral">
          {i18n.t(workspaceTypeLabelKey(workspace) as never)}
        </Badge>
      }
      onClick={() => onSelect(workspace.id)}
    />
  );
}

export function WorkspacePage() {
  const i18n = useI18n();
  const revalidate = useMutateQueryResource();
  const { trigger: createWorkspace, isMutating: creatingWorkspace } =
    useMutation({
      mutation: createWorkspaceMutation,
    });
  const {
    trigger: createSharedWorkspace,
    isMutating: creatingSharedWorkspace,
  } = useMutation({
    mutation: createWorkspaceInOrganizationUnitMutation,
  });
  const { units } = useOrganizationUnitsQuery(
    OrganizationUnitStatusEnum.Active,
  );
  const { types: unitTypes } = useOrganizationUnitTypesQuery();
  const ownerUnitTypeIds = useMemo(
    () =>
      new Set(
        unitTypes
          .filter((unitType) => unitType.canOwnWorkspaces)
          .map((unitType) => unitType.id),
      ),
    [unitTypes],
  );
  const ownerUnits = useMemo(
    () => units.filter((unit) => ownerUnitTypeIds.has(unit.unitTypeId)),
    [ownerUnitTypeIds, units],
  );
  const ownerUnitIds = useMemo(
    () => new Set(ownerUnits.map((unit) => unit.id)),
    [ownerUnits],
  );
  const [createOpen, setCreateOpen] = useState(false);
  const [createType, setCreateType] = useState<"user-owned" | "shared">(
    "user-owned",
  );
  const [ownerUnitId, setOwnerUnitId] = useState("");
  const [keyword, setKeyword] = useState("");
  const [featureFilters, setFeatureFilters] = useState<FeatureType[]>([]);
  const [flagFilters, setFlagFilters] = useState<WorkspaceFlagFilter>({});
  const [typeFilter, setTypeFilter] = useState<WorkspaceTypeFilter>("all");
  const [gitSyncFilter, setGitSyncFilter] =
    useState<WorkspaceGitSyncFilter>("all");
  const [sort, setSort] = useState<AdminWorkspaceSort | undefined>(
    AdminWorkspaceSort.CreatedAt,
  );
  const [selectedWorkspaceId, setSelectedWorkspaceId] = useState<
    string | null | undefined
  >(undefined);
  const [detailDirty, setDetailDirty] = useState(false);
  const [pendingSelection, setPendingSelection] = useState<
    string | null | undefined
  >(undefined);
  const selectWorkspace = (id: string | null) => {
    if (id === selectedWorkspaceId) return;
    if (detailDirty) setPendingSelection(id);
    else setSelectedWorkspaceId(id);
  };

  const { workspaces, pagination, setPagination, workspacesCount, loading } =
    useWorkspaceList({
      keyword,
      features: featureFilters,
      orderBy: sort,
      flags: flagFilters,
      typeFilter,
      gitSyncFilter,
    });

  const selectedId = useMemo(
    () =>
      selectedWorkspaceId &&
      (detailDirty || workspaces.some((w) => w.id === selectedWorkspaceId))
        ? selectedWorkspaceId
        : null,
    [detailDirty, selectedWorkspaceId, workspaces],
  );

  useEffect(() => {
    if (selectedWorkspaceId !== undefined || workspaces.length === 0) return;
    setSelectedWorkspaceId(workspaces[0].id);
  }, [selectedWorkspaceId, workspaces]);

  const pageStart =
    workspacesCount === 0 ? 0 : pagination.pageIndex * pagination.pageSize + 1;
  const pageEnd = Math.min(
    workspacesCount,
    (pagination.pageIndex + 1) * pagination.pageSize,
  );
  const hasMultiplePages = workspacesCount > pagination.pageSize;

  const creating = creatingWorkspace || creatingSharedWorkspace;
  const handleCreateWorkspace = useCallback(async () => {
    if (createType === "shared" && !ownerUnitIds.has(ownerUnitId)) {
      return;
    }
    try {
      const workspaceId =
        createType === "shared"
          ? (
              await createSharedWorkspace({
                input: { unitId: ownerUnitId },
              })
            ).createWorkspaceInOrganizationUnit.id
          : (await createWorkspace({})).createWorkspace.id;

      setKeyword("");
      setFeatureFilters([]);
      setFlagFilters({});
      setTypeFilter("all");
      setGitSyncFilter("all");
      setSort(AdminWorkspaceSort.CreatedAt);
      setPagination((prev) => ({ ...prev, pageIndex: 0 }));
      setSelectedWorkspaceId(workspaceId);
      setCreateOpen(false);
      setCreateType("user-owned");
      setOwnerUnitId("");

      await revalidate(adminWorkspacesListQuery);
      toast.success(i18n.t("admin.workspaces.create.created"));
    } catch (error) {
      toast.error(
        i18n.t("admin.workspaces.create.failed", {
          message: error instanceof Error ? error.message : String(error),
        }),
      );
    }
  }, [
    createSharedWorkspace,
    createType,
    createWorkspace,
    i18n,
    ownerUnitId,
    ownerUnitIds,
    revalidate,
    setPagination,
  ]);

  return (
    <AdminPageFrame
      title={i18n.t("admin.workspaces.title")}
      routeAnchor="admin-route-workspaces"
      testId="workspaces-page-shell"
      actions={
        <Button
          type="button"
          variant="primary"
          prefix={<Plus aria-hidden />}
          onClick={() => setCreateOpen(true)}
          disabled={creating || detailDirty}
          data-testid="workspace-create-button"
        >
          {creating
            ? i18n.t("admin.workspaces.create.creating")
            : i18n.t("admin.workspaces.create.button")}
        </Button>
      }
    >
      <AdminPageScroll>
        <Stack>
          <WorkspaceToolbar
            keyword={keyword}
            onKeywordChange={setKeyword}
            selectedFeatures={featureFilters}
            onFeaturesChange={setFeatureFilters}
            flags={flagFilters}
            onFlagsChange={setFlagFilters}
            typeFilter={typeFilter}
            onTypeFilterChange={setTypeFilter}
            gitSyncFilter={gitSyncFilter}
            onGitSyncFilterChange={setGitSyncFilter}
            sort={sort}
            onSortChange={setSort}
            disabled={loading}
            featureButtonLabel={i18n.t("admin.workspaces.panel.features")}
          />
          <Divider />

          <SettingsMasterDetailLayout
            detailOpen={Boolean(selectedId)}
            detailPriority="detail"
            mainTestId="workspace-list-section"
            detailTestId="workspace-detail-aside"
            detail={
              selectedId ? (
                <WorkspacePanel
                  key={selectedId}
                  workspaceId={selectedId}
                  onClose={() => selectWorkspace(null)}
                  onDirtyChange={setDetailDirty}
                />
              ) : null
            }
          >
            <Stack component="section">
              {workspaces.length === 0 ? (
                <SettingsEmptyState
                  title={
                    loading
                      ? i18n.t("admin.state.loading")
                      : i18n.t("admin.workspaces.list.no-matches")
                  }
                />
              ) : (
                <SurfaceList
                  label={i18n.t("admin.workspaces.title")}
                  data-testid="workspace-soft-list"
                >
                  {workspaces.map((workspace) => (
                    <WorkspaceInventoryItem
                      key={workspace.id}
                      workspace={workspace}
                      active={workspace.id === selectedId}
                      onSelect={selectWorkspace}
                    />
                  ))}
                </SurfaceList>
              )}

              <SettingsToolbar justify="space-between">
                <SettingsStatusText>
                  {i18n.t("admin.workspaces.list.page-range", {
                    from: pageStart,
                    to: pageEnd,
                    total: workspacesCount,
                  })}
                </SettingsStatusText>
                {hasMultiplePages ? (
                  <Pagination
                    totalCount={workspacesCount}
                    countPerPage={pagination.pageSize}
                    pageNum={pagination.pageIndex}
                    disabled={loading}
                    onPageChange={(_skip, nextPageIndex) =>
                      setPagination((prev) => ({
                        ...prev,
                        pageIndex: nextPageIndex,
                      }))
                    }
                  />
                ) : null}
              </SettingsToolbar>
            </Stack>
          </SettingsMasterDetailLayout>
        </Stack>
      </AdminPageScroll>
      <AdminConfirmModal
        open={pendingSelection !== undefined}
        onOpenChange={(open) => {
          if (!open) setPendingSelection(undefined);
        }}
        title={i18n.t("admin.unsaved.discard-title")}
        description={i18n.t("admin.workspaces.actions.discard-desc")}
        confirmText={i18n.t("admin.common.discard-changes")}
        onConfirm={() => {
          setDetailDirty(false);
          setSelectedWorkspaceId(pendingSelection);
          setPendingSelection(undefined);
        }}
        onCancel={() => setPendingSelection(undefined)}
      />
      <Modal
        open={createOpen}
        onOpenChange={setCreateOpen}
        title={i18n.t("admin.workspaces.create.button")}
        contentOptions={{ "data-testid": "workspace-create-dialog" }}
      >
        <Stack>
          <MyoxusSegmentedControl
            value={createType}
            onChange={(value) =>
              setCreateType(value as "user-owned" | "shared")
            }
            data={[
              {
                value: "user-owned",
                label: i18n.t("admin.workspaces.columns.user-owned"),
                testId: "workspace-create-type-user-owned",
              },
              {
                value: "shared",
                label: i18n.t("admin.workspaces.columns.shared"),
                testId: "workspace-create-type-shared",
              },
            ]}
            aria-label={i18n.t("admin.workspaces.create.button")}
          />
          {createType === "shared" ? (
            <FormSelect
              label={i18n.t("admin.organization.unit-detail.eyebrow")}
              placeholder={i18n.t("admin.organization.unit-detail.empty-title")}
              data={ownerUnits.map((unit) => ({
                value: unit.id,
                label: unit.name,
              }))}
              value={ownerUnitId || null}
              onChange={setOwnerUnitId}
              onClear={() => setOwnerUnitId("")}
              clearable
              data-testid="workspace-create-owner-unit"
            />
          ) : null}
          <Divider />
          <DialogFooterActions>
            <Button
              type="button"
              variant="secondary"
              onClick={() => setCreateOpen(false)}
            >
              {i18n.t("admin.actions.cancel")}
            </Button>
            <Button
              type="button"
              onClick={() => void handleCreateWorkspace()}
              variant="primary"
              disabled={
                creating ||
                (createType === "shared" && !ownerUnitIds.has(ownerUnitId))
              }
              data-testid="workspace-create-submit"
            >
              {creating
                ? i18n.t("admin.workspaces.create.creating")
                : i18n.t("admin.workspaces.create.button")}
            </Button>
          </DialogFooterActions>
        </Stack>
      </Modal>
    </AdminPageFrame>
  );
}

export { WorkspacePage as Component };
