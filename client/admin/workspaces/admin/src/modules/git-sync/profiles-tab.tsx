/**
 * Git Sync — Profiles tab.
 *
 * Shows the operator-facing projection of workspace sync profiles. The list
 * intentionally reuses the existing adminWorkspaces query for the status rows;
 * WorkspacePicker only narrows the visible profile set and must not create a
 * second Git-Sync-specific workspace API root.
 */
import {
  adminWorkspacesQuery,
  GitTokenRotationProvider,
  GitTokenRotationState,
} from "@myoxus/graphql";
import { useI18n } from "@myoxus/i18n";
import { CloseIcon } from "@myoxus/icons";
import {
  Divider,
  FormSelect,
  Group,
  IconButton,
  NavigationLink,
  Pagination,
  SettingsCollectionToolbar,
  SettingsDetailHeader,
  SettingsEmptyState,
  SettingsHeadingGroup,
  SettingsMasterDetailLayout,
  SettingsSectionDescription,
  SettingsSectionHeading,
  SettingsStatusText,
  Stack,
  StatusDot,
} from "@myoxus/ui-facade";
import { useMemo, useState } from "react";

import { WorkspacePicker } from "../../components/domain-pickers";
import { AdminConfirmModal } from "../../components/shared/admin-confirm-modal";
import { useQuery } from "../../use-query";
import { formatAdminDateTime } from "../../utils/locale-format";
import {
  GIT_SYNC_TRIGGER_LABELS,
  isGitSyncTriggerMode,
} from "./git-sync-labels";
import { GitSyncQueryFailure } from "./git-sync-recovery";
import { GitSyncProfileEditor } from "./profile-editor";

interface WorkspaceRow {
  id: string;
  name: string | null;
  gitSyncEnabled: boolean;
  gitSyncProfileId: string | null;
  gitSyncLastStatus: string | null;
  gitSyncTriggerMode: string | null;
  gitSyncNextScheduledAt: string | null;
  gitSyncTokenRotationProvider: GitTokenRotationProvider | null;
  gitSyncTokenRotationEnabled: boolean | null;
  gitSyncTokenRotationState: GitTokenRotationState | null;
}

const ROTATION_STATE_LABELS = {
  [GitTokenRotationState.Configured]:
    "admin.git-sync.rotation.state.configured",
  [GitTokenRotationState.Rotating]: "admin.git-sync.rotation.state.rotating",
  [GitTokenRotationState.Completed]: "admin.git-sync.rotation.state.completed",
  [GitTokenRotationState.Failed]: "admin.git-sync.rotation.state.failed",
  [GitTokenRotationState.ManualIntervention]:
    "admin.git-sync.rotation.state.manual-intervention",
} as const;

const PROFILES_PER_PAGE = 10;

function RotationStatusDot({
  provider,
  enabled,
  state,
  i18n,
}: {
  provider: GitTokenRotationProvider | null;
  enabled: boolean | null;
  state: GitTokenRotationState | null;
  i18n: ReturnType<typeof useI18n>;
}) {
  if (!provider || !state) return null;
  const labelKey = ROTATION_STATE_LABELS[state];
  const tone =
    !enabled || state === GitTokenRotationState.Configured
      ? "neutral"
      : state === GitTokenRotationState.Completed
        ? "success"
        : state === GitTokenRotationState.Rotating
          ? "info"
          : "error";
  return <StatusDot tone={tone} label={`${provider} · ${i18n.t(labelKey)}`} />;
}

function formatLabel(value: string): string {
  return value
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/_/g, " ")
    .replace(/\b\w/g, (character) => character.toUpperCase());
}

function statusTone(
  status: string | null,
): "neutral" | "success" | "info" | "error" {
  if (!status) return "neutral";
  const lower = status.toLowerCase();
  if (lower === "success" || lower === "ok") return "success";
  if (lower === "running" || lower === "in_progress") return "info";
  if (lower === "error" || lower === "failed") return "error";
  return "neutral";
}

function SyncStatusDot({
  status,
  i18n,
}: {
  status: string | null;
  i18n: ReturnType<typeof useI18n>;
}) {
  if (!status) {
    return (
      <StatusDot
        tone="neutral"
        label={i18n.t("admin.git-sync.profiles.status.no-sync")}
      />
    );
  }

  const lower = status.toLowerCase();
  if (lower === "success" || lower === "ok") {
    return (
      <StatusDot
        tone="success"
        label={i18n.t("admin.git-sync.profiles.status.success")}
      />
    );
  }
  if (lower === "running" || lower === "in_progress") {
    return (
      <StatusDot
        tone="info"
        label={i18n.t("admin.git-sync.profiles.status.running")}
      />
    );
  }
  if (lower === "error" || lower === "failed") {
    return (
      <StatusDot
        tone="error"
        label={i18n.t("admin.git-sync.profiles.status.failed")}
      />
    );
  }

  return <StatusDot tone={statusTone(status)} label={status} />;
}

export function ProfilesTab() {
  const i18n = useI18n();
  const [showAll, setShowAll] = useState(true);
  const [pageIndex, setPageIndex] = useState(0);
  const [filterWorkspaceId, setFilterWorkspaceId] = useState<string | null>(
    null,
  );
  const [selectedWorkspace, setSelectedWorkspace] =
    useState<WorkspaceRow | null>(null);
  const [detailDirty, setDetailDirty] = useState(false);
  const [detailBusy, setDetailBusy] = useState(false);
  const [pendingWorkspace, setPendingWorkspace] = useState<
    WorkspaceRow | null | undefined
  >();

  function selectWorkspace(workspace: WorkspaceRow | null) {
    if (detailBusy || workspace?.id === selectedWorkspace?.id) return;
    if (detailDirty) setPendingWorkspace(workspace);
    else setSelectedWorkspace(workspace);
  }

  const { data, error, isLoading, mutate } = useQuery({
    query: adminWorkspacesQuery,
    variables: {
      filter: {
        first: 100,
        skip: 0,
      },
    },
  });

  const allWorkspaces: WorkspaceRow[] = useMemo(() => {
    return (data?.admin?.adminWorkspaces ?? []) as WorkspaceRow[];
  }, [data]);

  const workspaces: WorkspaceRow[] = useMemo(() => {
    const scoped = showAll
      ? allWorkspaces
      : allWorkspaces.filter((ws) => ws.gitSyncEnabled);
    if (!filterWorkspaceId) return scoped;
    return scoped.filter((ws) => ws.id === filterWorkspaceId);
  }, [allWorkspaces, filterWorkspaceId, showAll]);
  const page = Math.min(
    pageIndex,
    Math.max(0, Math.ceil(workspaces.length / PROFILES_PER_PAGE) - 1),
  );
  const visibleWorkspaces = workspaces.slice(
    page * PROFILES_PER_PAGE,
    (page + 1) * PROFILES_PER_PAGE,
  );
  // Filtering and revalidation must not change the identity of an open draft.
  const currentWorkspace = selectedWorkspace
    ? (allWorkspaces.find((ws) => ws.id === selectedWorkspace.id) ??
      selectedWorkspace)
    : null;

  return (
    <Stack>
      <SettingsHeadingGroup>
        <SettingsSectionHeading level={2}>
          {i18n.t("admin.git-sync.profiles.title")}
        </SettingsSectionHeading>
        <SettingsSectionDescription>
          {i18n.t("com.myoxus.integration.git-sync.desc")}
        </SettingsSectionDescription>
      </SettingsHeadingGroup>
      <SettingsCollectionToolbar
        search={
          <WorkspacePicker
            label={i18n.t("admin.git-sync.profiles.workspace-picker.label")}
            value={filterWorkspaceId}
            onChange={(id) => {
              setFilterWorkspaceId(id);
              setPageIndex(0);
            }}
            placeholder={i18n.t(
              "admin.git-sync.profiles.workspace-picker.placeholder",
            )}
            data-testid="git-sync-workspace-picker"
          />
        }
        filters={
          <FormSelect
            aria-label={i18n.t("admin.common.status")}
            value={showAll ? "all" : "enabled"}
            data={[
              {
                value: "all",
                label: i18n.t("admin.workspaces.git-sync-filter.all"),
              },
              {
                value: "enabled",
                label: i18n.t("admin.workspaces.git-sync-filter.enabled"),
              },
            ]}
            onChange={(value) => {
              setShowAll(value === "all");
              setPageIndex(0);
            }}
          />
        }
      />
      <Divider />
      <SettingsMasterDetailLayout
        detailOpen={currentWorkspace !== null}
        detailPriority="detail"
        detail={
          currentWorkspace ? (
            <Stack
              key={currentWorkspace.id}
              data-testid="git-sync-profile-detail"
            >
              <SettingsDetailHeader
                title={currentWorkspace.name || currentWorkspace.id}
                description={currentWorkspace.id}
                headingLevel={2}
                actions={
                  <IconButton
                    icon={<CloseIcon aria-hidden />}
                    aria-label={i18n.t("admin.actions.close")}
                    tooltip={i18n.t("admin.actions.close")}
                    autoFocus
                    disabled={detailBusy}
                    onClick={() => selectWorkspace(null)}
                  />
                }
              />
              <GitSyncProfileEditor
                key={currentWorkspace.id}
                workspaceId={currentWorkspace.id}
                onDirtyChange={setDetailDirty}
                onBusyChange={setDetailBusy}
                onDiscard={() => {
                  setDetailDirty(false);
                  setSelectedWorkspace(null);
                }}
                onChanged={async () => {
                  await mutate();
                }}
              />
            </Stack>
          ) : null
        }
      >
        <Stack>
          {isLoading ? (
            <SettingsEmptyState title={i18n.t("admin.common.loading")} />
          ) : error ? (
            <GitSyncQueryFailure
              tab="profiles"
              operationName="adminWorkspaces"
              onReload={async () => {
                await mutate();
              }}
            />
          ) : workspaces.length === 0 ? (
            <SettingsEmptyState
              title={i18n.t("admin.git-sync.profiles.no-workspaces")}
              description={i18n.t("admin.git-sync.profiles.no-workspaces.desc")}
            />
          ) : (
            <Stack
              role="list"
              aria-label={i18n.t("admin.git-sync.profiles.list-aria")}
              gap={0}
            >
              {visibleWorkspaces.map((ws) => (
                <div role="listitem" key={ws.id}>
                  <NavigationLink
                    component="button"
                    type="button"
                    active={currentWorkspace?.id === ws.id}
                    aria-pressed={currentWorkspace?.id === ws.id}
                    disabled={detailBusy}
                    onClick={() => selectWorkspace(ws)}
                    label={ws.name || ws.id}
                    aria-label={`${ws.name || ws.id}: ${i18n.t(ws.gitSyncProfileId ? "admin.actions.edit" : "com.myoxus.integration.git-sync.create-profile")}`}
                    description={
                      <Stack>
                        <Group>
                          <StatusDot
                            tone={ws.gitSyncEnabled ? "success" : "neutral"}
                            label={i18n.t(
                              ws.gitSyncEnabled
                                ? "admin.git-sync.profiles.status.enabled"
                                : "admin.git-sync.profiles.status.disabled",
                            )}
                          />
                          <SyncStatusDot
                            status={ws.gitSyncLastStatus}
                            i18n={i18n}
                          />
                          <RotationStatusDot
                            provider={ws.gitSyncTokenRotationProvider}
                            enabled={ws.gitSyncTokenRotationEnabled}
                            state={ws.gitSyncTokenRotationState}
                            i18n={i18n}
                          />
                        </Group>
                        {ws.gitSyncTriggerMode ? (
                          <SettingsStatusText>
                            {isGitSyncTriggerMode(ws.gitSyncTriggerMode)
                              ? i18n.t(
                                  GIT_SYNC_TRIGGER_LABELS[
                                    ws.gitSyncTriggerMode
                                  ],
                                )
                              : formatLabel(ws.gitSyncTriggerMode)}
                            {ws.gitSyncNextScheduledAt
                              ? ` · ${formatAdminDateTime(
                                  i18n.language,
                                  ws.gitSyncNextScheduledAt,
                                )}`
                              : ""}
                          </SettingsStatusText>
                        ) : null}
                      </Stack>
                    }
                  />
                </div>
              ))}
            </Stack>
          )}
          {workspaces.length > PROFILES_PER_PAGE ? (
            <Pagination
              totalCount={workspaces.length}
              countPerPage={PROFILES_PER_PAGE}
              pageNum={page}
              onPageChange={(_skip, nextPage) => setPageIndex(nextPage)}
            />
          ) : null}
          {allWorkspaces.length >= 100 ? (
            <SettingsStatusText>
              {i18n.t("admin.git-sync.profiles.pagination-hint")}
            </SettingsStatusText>
          ) : null}
        </Stack>
      </SettingsMasterDetailLayout>
      <AdminConfirmModal
        open={pendingWorkspace !== undefined}
        onOpenChange={(open) => {
          if (!open) setPendingWorkspace(undefined);
        }}
        title={i18n.t("admin.unsaved.discard-title")}
        description={i18n.t("admin.unsaved.discard-description")}
        confirmText={i18n.t("admin.common.discard-changes")}
        onConfirm={() => {
          setDetailDirty(false);
          setDetailBusy(false);
          setSelectedWorkspace(pendingWorkspace ?? null);
          setPendingWorkspace(undefined);
        }}
      />
    </Stack>
  );
}
