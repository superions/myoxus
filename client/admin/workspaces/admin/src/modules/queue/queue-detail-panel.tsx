// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Right-panel detail view for a single queue.
 *
 * Shows job list (paginated by status) fetched from AdminRoot GraphQL.
 *
 * Per-job actions (P35-E-03):
 * - Retry button for failed jobs
 * - Promote button for delayed jobs
 */
import {
  useI18n,
  workspaceContentFailureKey,
  workspaceContentStatusKey,
} from "@myoxus/i18n";
import { ArrowUpCircle, RefreshCw, RotateCcw, X } from "@myoxus/icons/react";
import {
  Badge,
  Button,
  EmptyState,
  FormSelect,
  Group,
  IconButton,
  MonoText,
  notify,
  SettingsListItemMeta,
  SettingsListItemTitle,
  SettingsNotice,
  SettingsDetailHeader,
  SettingsToolbar,
  Stack,
  StatusDot,
  SurfaceList,
  SurfaceListItem,
} from "@myoxus/ui-facade";
import { useCallback, useEffect, useRef, useState } from "react";

import { formatAdminDateTime } from "../../utils/locale-format";
import {
  fetchQueueJobs,
  promoteQueueJob,
  type QueueJobListResponse,
  type QueueJobStatus,
  retryQueueJob,
} from "./queue-api";

const STATUSES = [
  "waiting",
  "active",
  "completed",
  "failed",
  "delayed",
] as const;
type Status = Extract<(typeof STATUSES)[number], QueueJobStatus>;

const STATUS_LABEL_KEYS: Record<Status, string> = {
  waiting: "admin.queue.detail.status.waiting",
  active: "admin.queue.detail.status.active",
  completed: "admin.queue.detail.status.completed",
  failed: "admin.queue.detail.status.failed",
  delayed: "admin.queue.detail.status.delayed",
};

const STATUS_TONES: Record<
  Status,
  "neutral" | "success" | "warning" | "error" | "info"
> = {
  waiting: "warning",
  active: "success",
  completed: "info",
  failed: "error",
  delayed: "neutral",
};

function formatTs(
  language: string | undefined,
  ms: number | null | undefined,
): string {
  return formatAdminDateTime(language, ms, "\u2014");
}

export function QueueDetailPanel({
  queueName,
  onClose,
}: {
  queueName: string;
  onClose: () => void;
}) {
  const i18n = useI18n();
  const [status, setStatus] = useState<Status>("waiting");
  const [cursor, setCursor] = useState(0);
  const [data, setData] = useState<QueueJobListResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);
  const [refreshVersion, setRefreshVersion] = useState(0);
  const requestGeneration = useRef(0);
  const limit = 20;

  const load = useCallback(async () => {
    const generation = ++requestGeneration.current;
    setLoading(true);
    setLoadFailed(false);
    setData(null);
    try {
      const result = await fetchQueueJobs({ queueName, status, cursor, limit });
      if (generation === requestGeneration.current) setData(result);
    } catch {
      if (generation === requestGeneration.current) setLoadFailed(true);
    } finally {
      if (generation === requestGeneration.current) setLoading(false);
    }
  }, [queueName, status, cursor]);

  useEffect(() => {
    void load();
    // Responses belong to one queue/status/page, not the panel's later state.
    return () => {
      ++requestGeneration.current;
    };
  }, [load, refreshVersion]);

  const handleStatusChange = (newStatus: Status) => {
    setStatus(newStatus);
    setCursor(0);
  };

  const handleRetry = useCallback(
    async (jobId: string) => {
      try {
        await retryQueueJob(queueName, jobId);
        notify.success({
          title: i18n.t("admin.queue.detail.toast.retry-queued", { jobId }),
        });
        setRefreshVersion((version) => version + 1);
      } catch (err) {
        notify.error({
          title: i18n.t("admin.queue.detail.toast.retry-failed", {
            message: (err as Error).message,
          }),
        });
      }
    },
    [i18n, queueName],
  );

  const handlePromote = useCallback(
    async (jobId: string) => {
      try {
        await promoteQueueJob(queueName, jobId);
        notify.success({
          title: i18n.t("admin.queue.detail.toast.promoted", { jobId }),
        });
        setRefreshVersion((version) => version + 1);
      } catch (err) {
        notify.error({
          title: i18n.t("admin.queue.detail.toast.promote-failed", {
            message: (err as Error).message,
          }),
        });
      }
    },
    [i18n, queueName],
  );

  const showActions = status === "failed" || status === "delayed";
  const statusLabel = i18n.t(STATUS_LABEL_KEYS[status]);

  return (
    <Stack component="section">
      <SettingsDetailHeader
        title={i18n.t("admin.queue.detail.title", { queueName })}
        actions={
          <>
            <IconButton
              icon={<RefreshCw />}
              tooltip={i18n.t("admin.actions.refresh")}
              aria-label={i18n.t("admin.actions.refresh")}
              onClick={load}
              disabled={loading}
            />
            <IconButton
              icon={<X />}
              tooltip={i18n.t("admin.common.close")}
              aria-label={i18n.t("admin.common.close")}
              onClick={onClose}
            />
          </>
        }
      />
      <Stack>
        <FormSelect
          label={i18n.t("admin.common.status")}
          aria-label={i18n.t("admin.common.status")}
          value={status}
          data={STATUSES.map((value) => ({
            value,
            label: i18n.t(STATUS_LABEL_KEYS[value]),
          }))}
          onChange={(value) => {
            if (STATUSES.includes(value as Status))
              handleStatusChange(value as Status);
          }}
        />
        {loading || data ? (
          <SettingsListItemMeta>
            {data
              ? i18n.t("admin.queue.detail.jobs-total", {
                  count: data.totalCount,
                })
              : i18n.t("admin.common.loading")}
          </SettingsListItemMeta>
        ) : null}

        {loadFailed ? (
          <SettingsNotice tone="error" role="alert">
            {i18n["admin.queue.detail.load-failed"]()}
          </SettingsNotice>
        ) : null}

        {data && data.jobs.length > 0 ? (
          <>
            <SurfaceList label={i18n.t("admin.queue.detail.list-aria")}>
              {data.jobs.map((job) => (
                <SurfaceListItem key={job.id} density="compact">
                  <Group align="flex-start" justify="space-between" wrap="wrap">
                    <Stack gap="2xs">
                      <Group align="center" wrap="wrap">
                        <StatusDot
                          tone={STATUS_TONES[status]}
                          label={statusLabel}
                        />
                        <SettingsListItemTitle>
                          {job.name}
                        </SettingsListItemTitle>
                      </Group>
                      <MonoText>{job.id}</MonoText>
                      {job.workspaceContentOperation ? (
                        <SettingsNotice
                          tone={
                            job.workspaceContentOperation.status === "Failed" ||
                            job.workspaceContentOperation.status ===
                              "CleanupRequired"
                              ? "error"
                              : "info"
                          }
                          title={i18n[
                            "admin.queue.detail.workspace-operation-status"
                          ]({
                            status:
                              i18n[
                                workspaceContentStatusKey(
                                  job.workspaceContentOperation.status,
                                )
                              ](),
                          })}
                        >
                          <Stack>
                            <SettingsListItemMeta>
                              {i18n[
                                "com.myoxus.workspace-content-operation.error.operation-id"
                              ]({ id: job.workspaceContentOperation.id })}
                            </SettingsListItemMeta>
                            {job.workspaceContentOperation.errorCode ||
                            job.workspaceContentOperation.status ===
                              "Failed" ? (
                              <SettingsListItemMeta>
                                {i18n[
                                  workspaceContentFailureKey(
                                    job.workspaceContentOperation.errorMessage,
                                    job.workspaceContentOperation.errorCode,
                                  ) ??
                                    "com.myoxus.workspace-content-operation.status.failed-detail"
                                ]()}
                              </SettingsListItemMeta>
                            ) : null}
                            {job.workspaceContentOperation.errorPhase ? (
                              <SettingsListItemMeta>
                                {i18n[
                                  "com.myoxus.workspace-content-operation.error.phase"
                                ]({
                                  phase:
                                    job.workspaceContentOperation.errorPhase,
                                })}
                              </SettingsListItemMeta>
                            ) : null}
                            {job.workspaceContentOperation.status ===
                            "CleanupRequired" ? (
                              <SettingsListItemMeta>
                                {i18n[
                                  "com.myoxus.workspace-content-operation.status.cleanup-detail"
                                ]()}
                              </SettingsListItemMeta>
                            ) : null}
                            {job.workspaceContentOperation.status ===
                              "Failed" ||
                            job.workspaceContentOperation.status ===
                              "CleanupRequired" ? (
                              <SettingsListItemMeta>
                                {i18n[
                                  "admin.queue.detail.workspace-operation-retry-hint"
                                ]()}
                              </SettingsListItemMeta>
                            ) : null}
                          </Stack>
                        </SettingsNotice>
                      ) : queueName === "workspace-content-operation" ? (
                        <SettingsNotice tone="warning">
                          {i18n[
                            "com.myoxus.workspace-content-operation.status.unknown"
                          ]()}
                        </SettingsNotice>
                      ) : status === "failed" ? (
                        <SettingsListItemMeta lineClamp={3} tone="error">
                          {job.failedReason ?? "\u2014"}
                        </SettingsListItemMeta>
                      ) : null}
                    </Stack>
                    <Group>
                      <Badge tone="neutral">
                        {i18n.t("admin.queue.detail.table.created")}:{" "}
                        {formatTs(i18n.language, job.timestamp)}
                      </Badge>
                      <Badge tone="neutral">
                        {i18n.t("admin.queue.detail.table.attempts")}:{" "}
                        {job.attemptsMade ?? 0}
                      </Badge>
                    </Group>
                    {showActions ? (
                      <Group>
                        {status === "failed" &&
                        queueName !== "workspace-content-operation" ? (
                          <Button
                            variant="plain"
                            prefix={<RotateCcw aria-hidden />}
                            title={i18n.t("admin.queue.detail.retry-title")}
                            onClick={() => handleRetry(job.id)}
                          >
                            {i18n.t("admin.queue.detail.retry-title")}
                          </Button>
                        ) : null}
                        {status === "delayed" ? (
                          <Button
                            variant="plain"
                            prefix={<ArrowUpCircle aria-hidden />}
                            title={i18n.t("admin.queue.detail.promote-title")}
                            onClick={() => handlePromote(job.id)}
                          >
                            {i18n.t("admin.queue.detail.promote-title")}
                          </Button>
                        ) : null}
                      </Group>
                    ) : null}
                  </Group>
                </SurfaceListItem>
              ))}
            </SurfaceList>

            <SettingsToolbar justify="space-between">
              <Button
                variant="ghost"
                disabled={cursor === 0}
                onClick={() => setCursor((c) => Math.max(0, c - limit))}
              >
                {i18n.t("admin.common.previous")}
              </Button>
              <SettingsListItemMeta>
                {i18n.t("admin.queue.detail.range", {
                  start: cursor + 1,
                  end: Math.min(cursor + limit, data.totalCount),
                  total: data.totalCount,
                })}
              </SettingsListItemMeta>
              <Button
                variant="ghost"
                disabled={data.nextCursor === null}
                onClick={() =>
                  data.nextCursor !== null && setCursor(data.nextCursor)
                }
              >
                {i18n.t("admin.common.next")}
              </Button>
            </SettingsToolbar>
          </>
        ) : data ? (
          <EmptyState
            title={i18n.t("admin.queue.detail.no-jobs", {
              status: statusLabel,
            })}
          />
        ) : null}
      </Stack>
    </Stack>
  );
}
