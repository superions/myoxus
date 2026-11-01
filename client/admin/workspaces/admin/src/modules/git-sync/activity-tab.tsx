/**
 * Git Sync — Activity tab.
 *
 * Workspace-scoped runtime inspection for status, runs, conflicts and bindings.
 * The tab deliberately calls the server conflict-resolution mutations instead
 * of treating conflicts as local UI state; otherwise operators would see a
 * resolved row without the corresponding snapshot/blob/baseline side effect.
 */
import {
  getGitSyncBindingsQuery,
  getGitSyncConflictsQuery,
  getGitSyncFileBindingsQuery,
  getGitSyncFileConflictsQuery,
  getGitSyncRunsQuery,
  getGitSyncStatusQuery,
  GitSyncConflictResolution,
  resolveGitSyncConflictMutation,
  resolveGitSyncFileConflictMutation,
} from "@myoxus/graphql";
import { useI18n } from "@myoxus/i18n";
import { CopyIcon, ResetIcon } from "@myoxus/icons/react";
import {
  Accordion,
  AccordionControl,
  AccordionItem,
  AccordionPanel,
  Badge,
  Button,
  Group,
  IconButton,
  notify,
  SettingsCollectionToolbar,
  SettingsDefinitionItem,
  SettingsDefinitionList,
  SettingsEmptyState,
  SettingsListItemMeta,
  SettingsNotice,
  SettingsSectionHeading,
  SettingsStatusText,
  SettingsSummaryGrid,
  SettingsToolbar,
  Stack,
  StatCell,
  StatusDot,
  Textarea,
} from "@myoxus/ui-facade";
import { useMemo, useRef, useState } from "react";

import { WorkspacePicker } from "../../components/domain-pickers";
import { AdminConfirmModal } from "../../components/shared/admin-confirm-modal";
import { useMutateQueryResource, useMutation } from "../../use-mutation";
import { useQuery } from "../../use-query";
import { formatAdminDateTime } from "../../utils/locale-format";
import {
  GIT_SYNC_DIRECTION_LABELS,
  GIT_SYNC_RUN_SOURCE_LABELS,
} from "./git-sync-labels";
import { GitSyncQueryFailure } from "./git-sync-recovery";

const DOC_RESOLUTIONS = [
  GitSyncConflictResolution.MyoxusWins,
  GitSyncConflictResolution.GitWins,
  GitSyncConflictResolution.Dismissed,
] as const;
const FILE_RESOLUTIONS = DOC_RESOLUTIONS;

function formatLabel(value: string): string {
  return value
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/_/g, " ")
    .replace(/\b\w/g, (character) => character.toUpperCase());
}

type FileResolution = (typeof FILE_RESOLUTIONS)[number];
type Resolution = FileResolution | GitSyncConflictResolution.ManualMerge;
type PendingResolution = {
  workspaceId: string;
  conflictId: string;
  repoPath: string;
  kind: "document" | "file";
  resolution: Resolution;
  mergedContent?: string;
};

function statusTone(
  status?: string | null,
): "success" | "warning" | "error" | "neutral" {
  const normalized = status?.toLowerCase();
  if (normalized === "completed" || normalized === "success") return "success";
  if (normalized === "failed" || normalized === "error") return "error";
  if (normalized === "running" || normalized === "pending") return "warning";
  return "neutral";
}

function resolveLabel(
  i18n: ReturnType<typeof useI18n>,
  resolution: Resolution,
) {
  const labels = {
    MyoxusWins: "admin.git-sync.activity.resolve.MyoxusWins",
    GitWins: "admin.git-sync.activity.resolve.GitWins",
    Dismissed: "admin.git-sync.activity.resolve.Dismissed",
    ManualMerge: "admin.git-sync.activity.resolve.ManualMerge",
  } as const;
  return i18n.t(labels[resolution]);
}

const RESOLUTION_CONFIRM_KEYS = {
  MyoxusWins: "admin.git-sync.activity.confirm.MyoxusWins",
  GitWins: "admin.git-sync.activity.confirm.GitWins",
  Dismissed: "admin.git-sync.activity.confirm.Dismissed",
  ManualMerge: "admin.git-sync.activity.confirm.ManualMerge",
} as const;

export function ActivityTab() {
  const i18n = useI18n();
  const [selectedWorkspaceId, setSelectedWorkspaceId] = useState<string | null>(
    null,
  );
  const [manualMergeByConflict, setManualMergeByConflict] = useState<
    Record<string, string>
  >({});
  const [pickerGeneration, setPickerGeneration] = useState(0);
  const [pendingResolution, setPendingResolution] =
    useState<PendingResolution | null>(null);
  const [discardOpen, setDiscardOpen] = useState(false);
  const [resolving, setResolving] = useState(false);
  const [readbackRequired, setReadbackRequired] = useState(false);
  const resolvingRef = useRef(false);
  const [resolutionError, setResolutionError] = useState<string | null>(null);
  const revalidate = useMutateQueryResource();
  const { trigger: resolveDocConflict, isMutating: resolvingDoc } = useMutation(
    {
      mutation: resolveGitSyncConflictMutation,
    },
  );
  const { trigger: resolveFileConflict, isMutating: resolvingFile } =
    useMutation({
      mutation: resolveGitSyncFileConflictMutation,
    });

  const variables = selectedWorkspaceId
    ? { workspaceId: selectedWorkspaceId }
    : undefined;
  const statusQuery = useQuery(
    variables ? { query: getGitSyncStatusQuery, variables } : undefined,
  );
  const runsQuery = useQuery(
    variables
      ? { query: getGitSyncRunsQuery, variables: { ...variables, take: 10 } }
      : undefined,
  );
  const docConflictsQuery = useQuery(
    variables ? { query: getGitSyncConflictsQuery, variables } : undefined,
  );
  const fileConflictsQuery = useQuery(
    variables
      ? {
          query: getGitSyncFileConflictsQuery,
          variables: { ...variables, resolved: false },
        }
      : undefined,
  );
  const docBindingsQuery = useQuery(
    variables ? { query: getGitSyncBindingsQuery, variables } : undefined,
  );
  const fileBindingsQuery = useQuery(
    variables
      ? {
          query: getGitSyncFileBindingsQuery,
          variables: { ...variables, includeTombstoned: true },
        }
      : undefined,
  );

  const status = statusQuery.data?.workspace?.gitSyncStatus;
  const runs = runsQuery.data?.workspace?.gitSyncRuns ?? [];
  const docConflicts =
    docConflictsQuery.data?.workspace?.gitSyncConflicts ?? [];
  const fileConflicts =
    fileConflictsQuery.data?.workspace?.gitSyncFileConflicts ?? [];
  const docBindings = docBindingsQuery.data?.workspace?.gitSyncBindings ?? [];
  const fileBindings =
    fileBindingsQuery.data?.workspace?.gitSyncFileBindings ?? [];
  const isLoading = Boolean(
    selectedWorkspaceId &&
    (statusQuery.isLoading ||
      runsQuery.isLoading ||
      docConflictsQuery.isLoading ||
      fileConflictsQuery.isLoading ||
      docBindingsQuery.isLoading ||
      fileBindingsQuery.isLoading),
  );
  const hasErrors = Boolean(
    statusQuery.error ||
    runsQuery.error ||
    docConflictsQuery.error ||
    fileConflictsQuery.error ||
    docBindingsQuery.error ||
    fileBindingsQuery.error,
  );
  const failedQuery = [
    { query: statusQuery, operationName: "getGitSyncStatus" },
    { query: runsQuery, operationName: "getGitSyncRuns" },
    { query: docConflictsQuery, operationName: "getGitSyncConflicts" },
    { query: fileConflictsQuery, operationName: "getGitSyncFileConflicts" },
    { query: docBindingsQuery, operationName: "getGitSyncBindings" },
    { query: fileBindingsQuery, operationName: "getGitSyncFileBindings" },
  ].find(({ query }) => query.error)?.operationName;
  const busy = resolving || resolvingDoc || resolvingFile || readbackRequired;
  const hasDraft = Object.values(manualMergeByConflict).some(
    (value) => value.length > 0,
  );

  const totals = useMemo(
    () => ({
      openDocConflicts: status?.openDocConflicts ?? docConflicts.length,
      openFileConflicts: status?.openFileConflicts ?? fileConflicts.length,
      totalDocBindings: status?.totalDocBindings ?? docBindings.length,
      totalFileBindings: status?.totalFileBindings ?? fileBindings.length,
    }),
    [
      docBindings.length,
      docConflicts.length,
      fileBindings.length,
      fileConflicts.length,
      status,
    ],
  );

  async function copyRunValue(value: string) {
    try {
      if (!navigator.clipboard) throw new Error("Clipboard API unavailable");
      await navigator.clipboard.writeText(value);
      notify.success({
        title: i18n.t("admin.actions.copy"),
      });
    } catch {
      notify.error({
        title: i18n.t("admin.git-sync.activity.copy-failed"),
      });
    }
  }

  function runValue(label: string, value?: string | null) {
    return (
      <SettingsDefinitionItem label={label} mono={Boolean(value)}>
        {value ?? i18n.t("admin.common.none")}
        {value ? (
          <IconButton
            type="button"
            size="small"
            icon={<CopyIcon aria-hidden="true" />}
            tooltip={`${i18n.t("admin.actions.copy")}: ${label}`}
            onClick={() => void copyRunValue(value)}
          />
        ) : null}
      </SettingsDefinitionItem>
    );
  }

  async function refreshWorkspaceRuntime(workspaceId: string) {
    const onlySelectedWorkspace = (
      vars: { workspaceId?: string } | undefined,
    ) => vars?.workspaceId === workspaceId;
    await Promise.all([
      revalidate(getGitSyncStatusQuery, onlySelectedWorkspace),
      revalidate(getGitSyncRunsQuery, onlySelectedWorkspace),
      revalidate(getGitSyncConflictsQuery, onlySelectedWorkspace),
      revalidate(getGitSyncFileConflictsQuery, onlySelectedWorkspace),
      revalidate(getGitSyncBindingsQuery, onlySelectedWorkspace),
      revalidate(getGitSyncFileBindingsQuery, onlySelectedWorkspace),
    ]);
  }

  function requestResolution(
    conflictId: string,
    resolution: Resolution,
    kind: "document" | "file",
    repoPath: string,
  ) {
    if (!selectedWorkspaceId || busy) return;
    const mergedContent =
      resolution === GitSyncConflictResolution.ManualMerge
        ? manualMergeByConflict[conflictId]
        : undefined;
    if (
      resolution === GitSyncConflictResolution.ManualMerge &&
      !mergedContent?.trim()
    ) {
      notify.error({
        title: i18n.t("admin.git-sync.activity.manual-merge-required"),
      });
      return;
    }
    setResolutionError(null);
    setPendingResolution({
      workspaceId: selectedWorkspaceId,
      conflictId,
      repoPath,
      resolution,
      kind,
      mergedContent,
    });
  }

  async function confirmResolution() {
    const pending = pendingResolution;
    if (!pending || resolvingRef.current) return;
    const conflicts =
      pending.kind === "document" ? docConflicts : fileConflicts;
    if (
      pending.workspaceId !== selectedWorkspaceId ||
      !conflicts.some((conflict) => conflict.id === pending.conflictId)
    ) {
      setPendingResolution(null);
      setResolutionError(i18n.t("admin.git-sync.activity.conflict-changed"));
      return;
    }
    // Keep ownership locked through mutation AND readback; a successful write
    // must never refresh another workspace or invite a duplicate submission.
    resolvingRef.current = true;
    setResolving(true);
    let applied = false;
    try {
      if (pending.kind === "document") {
        const result = await resolveDocConflict({
          input: {
            conflictId: pending.conflictId,
            resolution: pending.resolution,
            mergedContent: pending.mergedContent,
          },
        });
        if (result?.resolveGitSyncConflict !== true)
          throw new Error("Conflict action not acknowledged");
      } else {
        const result = await resolveFileConflict({
          input: {
            conflictId: pending.conflictId,
            resolution: pending.resolution as FileResolution,
          },
        });
        if (result?.resolveGitSyncFileConflict !== true)
          throw new Error("Conflict action not acknowledged");
      }
      applied = true;
      setReadbackRequired(true);
      setPendingResolution(null);
      setManualMergeByConflict((previous) => {
        const next = { ...previous };
        delete next[pending.conflictId];
        return next;
      });
      await refreshWorkspaceRuntime(pending.workspaceId);
      setReadbackRequired(false);
      notify.success({
        title: i18n.t("admin.git-sync.activity.resolve-success"),
      });
    } catch {
      // Raw conflict/error payloads can contain document content or credentials.
      setResolutionError(
        i18n.t(
          applied
            ? "admin.git-sync.activity.readback-failed"
            : "admin.git-sync.activity.resolution-failed",
        ),
      );
    } finally {
      resolvingRef.current = false;
      setResolving(false);
    }
  }

  return (
    <Stack>
      <Stack>
        <SettingsSectionHeading level={2}>
          {i18n.t("admin.git-sync.activity.title")}
        </SettingsSectionHeading>
        <SettingsStatusText>
          {i18n.t("admin.git-sync.activity.description")}
        </SettingsStatusText>
        <SettingsCollectionToolbar
          search={
            <WorkspacePicker
              key={pickerGeneration}
              label={i18n.t("admin.git-sync.activity.workspace-picker.label")}
              value={selectedWorkspaceId}
              onChange={setSelectedWorkspaceId}
              disabled={busy || hasDraft || Boolean(pendingResolution)}
              placeholder={i18n.t(
                "admin.git-sync.activity.workspace-picker.placeholder",
              )}
              data-testid="git-sync-activity-workspace-picker"
            />
          }
          actions={
            <IconButton
              type="button"
              icon={<ResetIcon aria-hidden="true" />}
              tooltip={i18n.t("admin.actions.reset")}
              disabled={busy || hasDraft || Boolean(pendingResolution)}
              onClick={() => {
                setSelectedWorkspaceId(null);
                setPickerGeneration((value) => value + 1);
                setResolutionError(null);
              }}
            />
          }
        />
        {hasDraft ? (
          <SettingsNotice
            tone="info"
            title={i18n.t("admin.state.unsaved-changes")}
          >
            <Stack>
              {i18n.t("admin.git-sync.activity.draft-workspace-lock")}
              <Button
                type="button"
                variant="ghost"
                disabled={busy || Boolean(pendingResolution)}
                onClick={() => setDiscardOpen(true)}
              >
                {i18n.t("admin.actions.discard")}
              </Button>
            </Stack>
          </SettingsNotice>
        ) : null}
        {resolutionError && !pendingResolution ? (
          <SettingsNotice tone="error">
            <Stack>
              {resolutionError}
              {readbackRequired && selectedWorkspaceId ? (
                <Button
                  type="button"
                  disabled={resolving}
                  onClick={async () => {
                    if (resolvingRef.current || !selectedWorkspaceId) return;
                    resolvingRef.current = true;
                    setResolving(true);
                    try {
                      await refreshWorkspaceRuntime(selectedWorkspaceId);
                      setReadbackRequired(false);
                      setResolutionError(null);
                    } catch {
                      setResolutionError(
                        i18n.t("admin.git-sync.activity.readback-failed"),
                      );
                    } finally {
                      resolvingRef.current = false;
                      setResolving(false);
                    }
                  }}
                >
                  {i18n.t("admin.git-sync.recovery.reload")}
                </Button>
              ) : null}
            </Stack>
          </SettingsNotice>
        ) : null}

        {!selectedWorkspaceId ? (
          <SettingsEmptyState
            title={i18n.t("admin.git-sync.activity.no-workspace")}
            description={i18n.t("admin.git-sync.activity.no-workspace.desc")}
          />
        ) : hasErrors && !readbackRequired ? (
          <GitSyncQueryFailure
            tab="activity"
            operationName={failedQuery ?? "getGitSyncStatus"}
            onReload={async () => {
              await Promise.all([
                statusQuery.mutate(),
                runsQuery.mutate(),
                docConflictsQuery.mutate(),
                fileConflictsQuery.mutate(),
                docBindingsQuery.mutate(),
                fileBindingsQuery.mutate(),
              ]);
            }}
          />
        ) : isLoading ? (
          <SettingsEmptyState title={i18n.t("admin.common.loading")} />
        ) : null}
      </Stack>

      {selectedWorkspaceId && !isLoading && !hasErrors ? (
        <>
          <SettingsSummaryGrid cols={4}>
            <StatCell
              label={i18n.t("admin.git-sync.activity.open-doc-conflicts")}
              value={totals.openDocConflicts}
            />
            <StatCell
              label={i18n.t("admin.git-sync.activity.open-file-conflicts")}
              value={totals.openFileConflicts}
            />
            <StatCell
              label={i18n.t("admin.git-sync.activity.doc-bindings")}
              value={totals.totalDocBindings}
            />
            <StatCell
              label={i18n.t("admin.git-sync.activity.file-bindings")}
              value={totals.totalFileBindings}
            />
          </SettingsSummaryGrid>

          {status?.partialSessionId ? (
            <SettingsNotice
              tone={status.partialFailedItems ? "warning" : "info"}
            >
              {i18n.t("admin.git-sync.activity.partial-summary", {
                status: formatLabel(status.partialStatus ?? ""),
                processed: String(status.partialProcessedItems ?? 0),
                total: String(status.partialTotalItems ?? 0),
                failed: String(status.partialFailedItems ?? 0),
              })}
              {status.partialHasMore
                ? ` ${i18n.t("admin.git-sync.activity.partial-has-more")}`
                : ""}
            </SettingsNotice>
          ) : null}

          <Stack>
            <SettingsSectionHeading level={2}>
              {i18n.t("admin.git-sync.activity.doc-conflicts.title")}
            </SettingsSectionHeading>
            {docConflicts.length === 0 ? (
              <SettingsEmptyState
                title={i18n.t("admin.git-sync.activity.no-doc-conflicts")}
              />
            ) : (
              <Accordion
                multiple
                keepMounted={false}
                aria-label={i18n.t(
                  "admin.git-sync.activity.doc-conflicts.aria",
                )}
              >
                {docConflicts.map((conflict) => (
                  <AccordionItem key={conflict.id} value={conflict.id}>
                    <AccordionControl>
                      <Group>
                        <SettingsStatusText mono>
                          {conflict.repoPath}
                        </SettingsStatusText>
                        <Badge tone="warning">
                          {formatLabel(conflict.conflictType)}
                        </Badge>
                      </Group>
                    </AccordionControl>
                    <AccordionPanel>
                      <Stack>
                        <SettingsDefinitionList>
                          <SettingsDefinitionItem
                            label={i18n.t(
                              "admin.git-sync.activity.myoxus-content",
                            )}
                            mono
                          >
                            {conflict.myoxusContent?.slice(0, 240) || "—"}
                          </SettingsDefinitionItem>
                          <SettingsDefinitionItem
                            label={i18n.t(
                              "admin.git-sync.activity.git-content",
                            )}
                            mono
                          >
                            {conflict.gitContent?.slice(0, 240) || "—"}
                          </SettingsDefinitionItem>
                        </SettingsDefinitionList>
                        <Textarea
                          label={i18n.t(
                            "admin.git-sync.activity.manual-merge.label",
                          )}
                          placeholder={i18n.t(
                            "admin.git-sync.activity.manual-merge.placeholder",
                          )}
                          minRows={3}
                          mono
                          disabled={busy || Boolean(pendingResolution)}
                          value={manualMergeByConflict[conflict.id] ?? ""}
                          onChange={(value) =>
                            setManualMergeByConflict((prev) => ({
                              ...prev,
                              [conflict.id]: value,
                            }))
                          }
                        />
                        <SettingsToolbar justify="flex-start">
                          {DOC_RESOLUTIONS.map((resolution) => (
                            <Button
                              key={resolution}
                              type="button"
                              variant="ghost"
                              disabled={busy || Boolean(pendingResolution)}
                              onClick={() =>
                                requestResolution(
                                  conflict.id,
                                  resolution,
                                  "document",
                                  conflict.repoPath,
                                )
                              }
                            >
                              {resolveLabel(i18n, resolution)}
                            </Button>
                          ))}
                          <Button
                            type="button"
                            disabled={
                              busy ||
                              Boolean(pendingResolution) ||
                              !manualMergeByConflict[conflict.id]?.trim()
                            }
                            onClick={() =>
                              requestResolution(
                                conflict.id,
                                GitSyncConflictResolution.ManualMerge,
                                "document",
                                conflict.repoPath,
                              )
                            }
                          >
                            {resolveLabel(
                              i18n,
                              GitSyncConflictResolution.ManualMerge,
                            )}
                          </Button>
                        </SettingsToolbar>
                      </Stack>
                    </AccordionPanel>
                  </AccordionItem>
                ))}
              </Accordion>
            )}
          </Stack>

          <Stack>
            <SettingsSectionHeading level={2}>
              {i18n.t("admin.git-sync.activity.file-conflicts.title")}
            </SettingsSectionHeading>
            {fileConflicts.length === 0 ? (
              <SettingsEmptyState
                title={i18n.t("admin.git-sync.activity.no-file-conflicts")}
              />
            ) : (
              <Accordion
                multiple
                keepMounted={false}
                aria-label={i18n.t(
                  "admin.git-sync.activity.file-conflicts.aria",
                )}
              >
                {fileConflicts.map((conflict) => (
                  <AccordionItem key={conflict.id} value={conflict.id}>
                    <AccordionControl>
                      <Group>
                        <SettingsStatusText mono>
                          {conflict.repoPath}
                        </SettingsStatusText>
                        <Badge tone="warning">
                          {formatLabel(conflict.conflictType)}
                        </Badge>
                      </Group>
                    </AccordionControl>
                    <AccordionPanel>
                      <Stack>
                        <SettingsListItemMeta>
                          {i18n.t(
                            "admin.git-sync.activity.file-conflict-hashes",
                            {
                              git: conflict.gitHash ?? "—",
                              myoxus: conflict.myoxusHash ?? "—",
                            },
                          )}
                        </SettingsListItemMeta>
                        <SettingsToolbar justify="flex-start">
                          {FILE_RESOLUTIONS.map((resolution) => (
                            <Button
                              key={resolution}
                              type="button"
                              variant="ghost"
                              disabled={busy || Boolean(pendingResolution)}
                              onClick={() =>
                                requestResolution(
                                  conflict.id,
                                  resolution,
                                  "file",
                                  conflict.repoPath,
                                )
                              }
                            >
                              {resolveLabel(i18n, resolution)}
                            </Button>
                          ))}
                        </SettingsToolbar>
                      </Stack>
                    </AccordionPanel>
                  </AccordionItem>
                ))}
              </Accordion>
            )}
          </Stack>

          <Stack>
            <SettingsSectionHeading level={2}>
              {i18n.t("admin.git-sync.activity.runs.title")}
            </SettingsSectionHeading>
            {runs.length === 0 ? (
              <SettingsEmptyState
                title={i18n.t("admin.git-sync.activity.no-runs")}
              />
            ) : (
              <Stack aria-label={i18n.t("admin.git-sync.activity.runs.aria")}>
                {runs.map((run) => (
                  <Stack key={run.id}>
                    <Group justify="space-between">
                      <Group>
                        <Badge tone={statusTone(run.status)}>
                          {formatLabel(run.status)}
                        </Badge>
                        <SettingsStatusText>
                          {i18n.t(GIT_SYNC_DIRECTION_LABELS[run.direction])} ·{" "}
                          {i18n.t(
                            GIT_SYNC_RUN_SOURCE_LABELS[run.triggerSource],
                          )}
                        </SettingsStatusText>
                      </Group>
                      <SettingsListItemMeta>
                        {i18n.t("admin.git-sync.activity.started")}{" "}
                        {formatAdminDateTime(i18n.language, run.startedAt)}
                      </SettingsListItemMeta>
                      {run.scheduledFor ? (
                        <SettingsListItemMeta>
                          {i18n.t(
                            "com.myoxus.integration.git-sync.scheduled-for",
                            {
                              date: formatAdminDateTime(
                                i18n.language,
                                run.scheduledFor,
                              ),
                            },
                          )}
                        </SettingsListItemMeta>
                      ) : null}
                    </Group>

                    {run.reconciliationRequired ? (
                      <SettingsNotice
                        tone="warning"
                        title={i18n.t(
                          "admin.git-sync.activity.reconciliation.title",
                        )}
                      >
                        {i18n.t(
                          "admin.git-sync.activity.reconciliation.description",
                        )}{" "}
                        {run.reconciliationReason}
                      </SettingsNotice>
                    ) : null}

                    <Accordion keepMounted={false}>
                      <AccordionItem value={run.id}>
                        <AccordionControl>
                          {i18n.t("com.myoxus.common.technical-details")}
                        </AccordionControl>
                        <AccordionPanel>
                          <SettingsDefinitionList>
                            <SettingsDefinitionItem
                              label={i18n.t(
                                "admin.git-sync.activity.materialized-actions",
                              )}
                            >
                              {i18n.t(
                                "admin.git-sync.activity.run-docs-summary",
                                {
                                  created: String(run.docsCreated),
                                  updated: String(run.docsUpdated),
                                  deleted: String(run.docsDeleted),
                                  conflicts: String(run.conflictsFound),
                                },
                              )}
                            </SettingsDefinitionItem>
                            <SettingsDefinitionItem
                              label={i18n.t(
                                "admin.git-sync.activity.error-class",
                              )}
                            >
                              {run.errorClass
                                ? formatLabel(run.errorClass)
                                : i18n.t("admin.common.none")}
                            </SettingsDefinitionItem>
                            {runValue(
                              i18n.t("admin.git-sync.activity.job-id"),
                              run.jobId,
                            )}
                            {runValue(
                              i18n.t("admin.git-sync.activity.commit-before"),
                              run.commitBefore,
                            )}
                            {runValue(
                              i18n.t("admin.git-sync.activity.commit-after"),
                              run.commitAfter,
                            )}
                            {runValue(
                              i18n.t(
                                "admin.git-sync.activity.observed-remote-oid",
                              ),
                              run.observedRemoteOid,
                            )}
                          </SettingsDefinitionList>
                        </AccordionPanel>
                      </AccordionItem>
                    </Accordion>
                  </Stack>
                ))}
              </Stack>
            )}
          </Stack>

          <Stack>
            <SettingsSectionHeading level={2}>
              {i18n.t("admin.git-sync.activity.bindings.title")}
            </SettingsSectionHeading>
            <SettingsToolbar justify="space-between">
              <SettingsStatusText>
                {i18n.t("admin.git-sync.activity.bindings.summary", {
                  docs: String(docBindings.length),
                  files: String(fileBindings.length),
                })}
              </SettingsStatusText>
              <StatusDot
                tone="info"
                label={i18n.t(
                  "admin.git-sync.activity.bindings.includes-tombstones",
                )}
              />
            </SettingsToolbar>
          </Stack>
        </>
      ) : null}
      <AdminConfirmModal
        open={Boolean(pendingResolution)}
        autoFocusConfirm={false}
        title={
          pendingResolution
            ? resolveLabel(i18n, pendingResolution.resolution)
            : i18n.t("admin.common.confirm")
        }
        confirmButtonOptions={{ disabled: busy }}
        cancelButtonOptions={{ disabled: busy }}
        onOpenChange={(open) => {
          if (!open && !busy) setPendingResolution(null);
        }}
        onConfirm={confirmResolution}
      >
        {pendingResolution ? (
          <Stack>
            <SettingsDefinitionList>
              <SettingsDefinitionItem
                label={i18n.t("admin.git-sync.activity.workspace-picker.label")}
                mono
              >
                {pendingResolution.workspaceId}
              </SettingsDefinitionItem>
              <SettingsDefinitionItem
                label={i18n.t("admin.storage.dir.path")}
                mono
              >
                {pendingResolution.repoPath}
              </SettingsDefinitionItem>
            </SettingsDefinitionList>
            {i18n.t(RESOLUTION_CONFIRM_KEYS[pendingResolution.resolution])}
            {resolutionError ? (
              <SettingsNotice tone="error">{resolutionError}</SettingsNotice>
            ) : null}
          </Stack>
        ) : undefined}
      </AdminConfirmModal>
      <AdminConfirmModal
        open={discardOpen}
        title={i18n.t("admin.unsaved.discard-title")}
        description={i18n.t("admin.unsaved.discard-description")}
        confirmText={i18n.t("admin.actions.discard")}
        onOpenChange={setDiscardOpen}
        onConfirm={() => {
          setManualMergeByConflict({});
          setDiscardOpen(false);
        }}
      />
    </Stack>
  );
}
