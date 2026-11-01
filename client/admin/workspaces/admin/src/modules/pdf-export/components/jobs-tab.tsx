/**
 * @file PDF export module — render jobs tab.
 *
 * Admin diagnostics for PDF render jobs live in this tab so operational
 * state stays colocated with the rest of the PDF export surface. The tab uses
 * module-local GraphQL hooks from `../api`; no separate API root is introduced.
 */
import { useI18n } from "@myoxus/i18n";
import { EyeIcon, RefreshCwIcon, XCircleIcon } from "@myoxus/icons/react";
import {
  Badge,
  Button,
  Drawer,
  ErrorMessage,
  Group,
  Input,
  notify,
  FormSelect,
  SettingsDefinitionItem,
  SettingsDefinitionList,
  SettingsFilterActions,
  SimpleGrid,
  SettingsFilterField,
  Table,
  TableHeader,
  TableHead,
  TableBody,
  TableRow,
  TableCell,
  TableScrollContainer,
  MonoText,
  IconButton,
  SettingsSection,
  SettingsStatusText,
  SettingsNotice,
  SettingsSkeleton,
  Stack,
  Textarea,
} from "@myoxus/ui-facade";
import { useCallback, useEffect, useMemo, useState } from "react";

import { AdminConfirmModal } from "../../../components/shared/admin-confirm-modal";
import { formatAdminDateTime } from "../../../utils/locale-format";
import {
  type PdfExportAdminJob,
  type PdfExportJobStatusFilter,
  useAdminPdfExportJobsQuery,
  useCancelPdfExportJobMutation,
} from "../api";
import { logPdfExportUiEvent } from "../logging";
import { PdfPanelHeader } from "../pdf-role-primitives";

const ALL_STATUSES = "__all__";
const JOBS_EVENT_SOURCE_URL = "/api/admin/pdf-export/jobs/events";

function formatDate(
  language: string | undefined,
  value: string | null | undefined,
) {
  return formatAdminDateTime(language, value, "-");
}

function formatDuration(ms: number | null) {
  if (ms == null) return "-";
  if (ms < 1000) return `${ms} ms`;
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds} s`;
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

function statusTone(status: PdfExportJobStatusFilter) {
  if (status === "failed") return "error" as const;
  if (status === "done") return "success" as const;
  if (status === "running") return "info" as const;
  return "neutral" as const;
}

function userLabel(job: PdfExportAdminJob) {
  return job.requestedByEmail || job.requestedByName || job.requestedBy;
}

function startOfDayIso(date: string) {
  return date ? new Date(`${date}T00:00:00.000`).toISOString() : undefined;
}

function endOfDayIso(date: string) {
  return date ? new Date(`${date}T23:59:59.999`).toISOString() : undefined;
}

function JobDetailSheet({
  job,
  onClose,
}: {
  job: PdfExportAdminJob | null;
  onClose: () => void;
}) {
  const i18n = useI18n();
  return (
    <Drawer
      open={!!job}
      onOpenChange={(open) => !open && onClose()}
      title={i18n.t("admin.pdf-jobs.detail.title")}
      description={job?.id ?? ""}
      size="min(42rem, 100vw)"
    >
      {job ? (
        <Stack>
          <SettingsDefinitionList>
            <Info
              label={i18n.t("admin.pdf-jobs.column.workspace")}
              value={job.workspaceId}
              mono
            />
            <Info
              label={i18n.t("admin.pdf-jobs.column.doc")}
              value={job.docId}
              mono
            />
            <Info
              label={i18n.t("admin.pdf-jobs.column.template")}
              value={job.templateId}
              mono
            />
            <Info
              label={i18n.t("admin.pdf-jobs.column.user")}
              value={userLabel(job)}
            />
            <Info
              label={i18n.t("admin.pdf-jobs.column.started")}
              value={formatDate(i18n.language, job.startedAt)}
            />
            <Info
              label={i18n.t("admin.pdf-jobs.column.duration")}
              value={formatDuration(job.durationMs)}
            />
          </SettingsDefinitionList>
          <Stack component="section">
            <PdfPanelHeader title={i18n.t("admin.pdf-jobs.detail.audit")} />
            <Stack>
              {job.audit ? (
                <>
                  <SettingsDefinitionList>
                    <Info
                      label={i18n.t(
                        "admin.pdf-jobs.detail.audit.template-version",
                      )}
                      value={job.audit.templateVersion}
                    />
                    <Info
                      label={i18n.t(
                        "admin.pdf-jobs.detail.audit.appearance-hash",
                      )}
                      value={job.audit.renderAppearanceHash}
                      mono
                    />
                    <Info
                      label={i18n.t("admin.pdf-jobs.detail.audit.locale")}
                      value={job.audit.locale}
                    />
                    <Info
                      label={i18n.t(
                        "admin.pdf-jobs.detail.audit.classification",
                      )}
                      value={job.audit.classification ?? "-"}
                    />
                  </SettingsDefinitionList>
                  <Textarea
                    readOnly
                    mono
                    rows={10}
                    value={JSON.stringify(job.audit.l3Inputs, null, 2)}
                    aria-label={i18n.t("admin.pdf-jobs.detail.audit")}
                  />
                </>
              ) : (
                <SettingsStatusText>
                  {i18n.t("admin.pdf-jobs.detail.no-audit")}
                </SettingsStatusText>
              )}
            </Stack>
          </Stack>
          {job.errorClass || job.errorDetail ? (
            <SettingsSection
              component="section"
              title={i18n.t("admin.pdf-jobs.detail.error")}
              danger
            >
              <Stack>
                <SettingsDefinitionList>
                  <Info label="Class" value={job.errorClass ?? "-"} />
                </SettingsDefinitionList>
                <ErrorMessage>{job.errorDetail ?? "-"}</ErrorMessage>
              </Stack>
            </SettingsSection>
          ) : null}
        </Stack>
      ) : null}
    </Drawer>
  );
}

function Info({
  label,
  value,
  mono = false,
}: {
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <SettingsDefinitionItem label={label} mono={mono}>
      {value}
    </SettingsDefinitionItem>
  );
}

/** Render recent PDF export jobs with filters and queued-job cancellation. */
export function JobsTab() {
  const i18n = useI18n();
  const statusOptions = [
    { value: ALL_STATUSES, label: i18n.t("admin.pdf-jobs.filter.all") },
    ...(["queued", "running", "done", "failed"] as const).map((value) => ({
      value,
      label: i18n.t(`admin.pdf-jobs.status.${value}`),
    })),
  ];
  const [status, setStatus] = useState<string>(ALL_STATUSES);
  const [workspaceId, setWorkspaceId] = useState("");
  const [userId, setUserId] = useState("");
  const [createdAfter, setCreatedAfter] = useState("");
  const [createdBefore, setCreatedBefore] = useState("");
  const [selectedJob, setSelectedJob] = useState<PdfExportAdminJob | null>(
    null,
  );
  const [cancelJob, setCancelJob] = useState<PdfExportAdminJob | null>(null);
  const filters = useMemo(
    () => ({
      status:
        status === ALL_STATUSES
          ? undefined
          : (status as PdfExportJobStatusFilter),
      workspaceId: workspaceId.trim() || undefined,
      userId: userId.trim() || undefined,
      createdAfter: startOfDayIso(createdAfter),
      createdBefore: endOfDayIso(createdBefore),
      limit: 100,
    }),
    [createdAfter, createdBefore, status, userId, workspaceId],
  );
  const query = useAdminPdfExportJobsQuery(filters);
  const { mutate: revalidateJobs } = query;
  const refreshJobs = useCallback(() => {
    void revalidateJobs(undefined, { throwOnError: false });
  }, [revalidateJobs]);
  const cancelMutation = useCancelPdfExportJobMutation();

  useEffect(() => {
    if (typeof EventSource === "undefined") {
      logPdfExportUiEvent(
        "jobs.sse.unavailable",
        { endpoint: JOBS_EVENT_SOURCE_URL },
        "warn",
      );
      return undefined;
    }

    const source = new EventSource(JOBS_EVENT_SOURCE_URL);
    source.addEventListener("jobs", refreshJobs);
    source.onerror = () => {
      logPdfExportUiEvent(
        "jobs.sse.failed",
        { endpoint: JOBS_EVENT_SOURCE_URL },
        "warn",
      );
      source.close();
    };
    logPdfExportUiEvent("jobs.sse.connected", {
      endpoint: JOBS_EVENT_SOURCE_URL,
    });

    return () => {
      source.removeEventListener("jobs", refreshJobs);
      source.close();
    };
  }, [refreshJobs]);

  const handleCancel = async () => {
    if (!cancelJob) return;
    try {
      const result = await cancelMutation.trigger({
        jobId: cancelJob.id,
      });
      logPdfExportUiEvent("jobs.cancel.completed", {
        jobId: cancelJob.id,
        cancelled: !!result.admin?.cancelPdfExportJob,
      });
      notify.success({ title: i18n.t("admin.pdf-jobs.cancel.success") });
      setCancelJob(null);
      refreshJobs();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logPdfExportUiEvent(
        "jobs.cancel.failed",
        { jobId: cancelJob.id, message },
        "error",
      );
      notify.error({
        title: i18n.t("admin.pdf-jobs.cancel.failed"),
        message,
      });
    }
  };

  return (
    <>
      <Stack>
        <SimpleGrid cols={3}>
          <SettingsFilterField
            htmlFor="pdf-jobs-status"
            label={i18n.t("admin.pdf-jobs.filter.status")}
          >
            <FormSelect
              id="pdf-jobs-status"
              value={status}
              onChange={setStatus}
              data={statusOptions}
            />
          </SettingsFilterField>
          <SettingsFilterField
            htmlFor="pdf-jobs-workspace"
            label={i18n.t("admin.pdf-jobs.filter.workspace")}
          >
            <Input
              id="pdf-jobs-workspace"
              value={workspaceId}
              onChange={setWorkspaceId}
              placeholder={i18n.t("admin.pdf-jobs.filter.workspace")}
            />
          </SettingsFilterField>
          <SettingsFilterField
            htmlFor="pdf-jobs-user"
            label={i18n.t("admin.pdf-jobs.filter.user")}
          >
            <Input
              id="pdf-jobs-user"
              value={userId}
              onChange={setUserId}
              placeholder={i18n.t("admin.pdf-jobs.filter.user")}
            />
          </SettingsFilterField>
          <SettingsFilterField
            htmlFor="pdf-jobs-created-after"
            label={i18n.t("admin.pdf-jobs.filter.created-after")}
          >
            <Input
              id="pdf-jobs-created-after"
              type="date"
              lang={i18n.language}
              value={createdAfter}
              onChange={setCreatedAfter}
            />
          </SettingsFilterField>
          <SettingsFilterField
            htmlFor="pdf-jobs-created-before"
            label={i18n.t("admin.pdf-jobs.filter.created-before")}
          >
            <Input
              id="pdf-jobs-created-before"
              type="date"
              lang={i18n.language}
              value={createdBefore}
              onChange={setCreatedBefore}
            />
          </SettingsFilterField>
          <SettingsFilterActions>
            <Button
              variant="ghost"
              onClick={refreshJobs}
              disabled={query.isValidating}
              prefix={<RefreshCwIcon aria-hidden />}
            >
              {i18n.t("admin.pdf-jobs.action.refresh")}
            </Button>
          </SettingsFilterActions>
        </SimpleGrid>

        {query.error ? (
          <SettingsNotice
            tone="error"
            title={i18n.t("com.myoxus.settings.common.load-error")}
          >
            {query.error.message}
            <Group>
              <Button onClick={refreshJobs} disabled={query.isValidating}>
                {i18n.t("admin.error.retry")}
              </Button>
            </Group>
          </SettingsNotice>
        ) : query.isLoading ? (
          <SettingsSkeleton />
        ) : query.jobs.length === 0 ? (
          <SettingsStatusText>
            {i18n.t("admin.pdf-export.jobs.empty")}
          </SettingsStatusText>
        ) : (
          <TableScrollContainer>
            <Table aria-label={i18n.t("admin.pdf-jobs.list.aria-label")}>
              <TableHeader>
                <TableRow>
                  {[
                    "user",
                    "status",
                    "workspace",
                    "doc",
                    "template",
                    "started",
                    "duration",
                    "actions",
                  ].map((column) => (
                    <TableHead key={column}>
                      {i18n.t("admin.pdf-jobs.column." + column)}
                    </TableHead>
                  ))}
                </TableRow>
              </TableHeader>
              <TableBody>
                {query.jobs.map((job) => (
                  <TableRow key={job.id}>
                    <TableCell>{userLabel(job)}</TableCell>
                    <TableCell>
                      <Badge tone={statusTone(job.status)}>
                        {i18n.t(`admin.pdf-jobs.status.${job.status}`)}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      <MonoText>{job.workspaceId}</MonoText>
                    </TableCell>
                    <TableCell>
                      <MonoText>{job.docId}</MonoText>
                    </TableCell>
                    <TableCell>
                      <MonoText>{job.templateId}</MonoText>
                    </TableCell>
                    <TableCell>
                      {formatDate(
                        i18n.language,
                        job.startedAt ?? job.createdAt,
                      )}
                    </TableCell>
                    <TableCell>{formatDuration(job.durationMs)}</TableCell>
                    <TableCell>
                      <Group wrap="nowrap">
                        <IconButton
                          tooltip={i18n.t("admin.pdf-jobs.action.details")}
                          onClick={() => setSelectedJob(job)}
                        >
                          <EyeIcon aria-hidden />
                        </IconButton>
                        <IconButton
                          variant="destructive"
                          tooltip={i18n.t("admin.pdf-jobs.action.cancel")}
                          disabled={job.status !== "queued"}
                          onClick={() => setCancelJob(job)}
                        >
                          <XCircleIcon aria-hidden />
                        </IconButton>
                      </Group>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </TableScrollContainer>
        )}
      </Stack>

      <JobDetailSheet job={selectedJob} onClose={() => setSelectedJob(null)} />
      <AdminConfirmModal
        open={!!cancelJob}
        onOpenChange={(open) => !open && setCancelJob(null)}
        title={i18n.t("admin.pdf-jobs.cancel.title")}
        description={i18n.t("admin.pdf-jobs.cancel.description")}
        cancelText={i18n.t("admin.common.cancel")}
        confirmText={i18n.t("admin.pdf-jobs.action.cancel")}
        danger
        onConfirm={handleCancel}
      />
    </>
  );
}
