/**
 * Templates -- Jobs tab.
 *
 * Displays template import and reconcile job history fetched from the
 * templateRegistryJobs GraphQL query.
 */
import { useI18n } from "@myoxus/i18n";
import { RefreshCwIcon } from "@myoxus/icons/react";
import {
  Button,
  Group,
  MetricStack,
  MonoText,
  SettingsDefinitionItem,
  SettingsDefinitionList,
  SettingsDetailHeader,
  SettingsEmptyState,
  SettingsListItemMeta,
  SettingsListItemTitle,
  SettingsSkeleton,
  SettingsStatusText,
  Stack,
  SurfaceList,
  SurfaceListItem,
  SurfaceListItemMain,
} from "@myoxus/ui-facade";
import { Suspense, useCallback } from "react";

import { formatAdminDateTime } from "../../utils/locale-format";
import { useTemplateJobsQuery, useTemplateRegistryRevalidate } from "./api";
import {
  type TemplateJobKind,
  TemplateJobKindBadge,
  type TemplateJobState,
  TemplateJobStateBadge,
} from "./badges";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatDate(
  language: string | undefined,
  iso: string | null | undefined,
): string {
  return formatAdminDateTime(language, iso, "--");
}

// ---------------------------------------------------------------------------
// Content (Suspense boundary)
// ---------------------------------------------------------------------------

function JobsContent() {
  const i18n = useI18n();
  const { jobs } = useTemplateJobsQuery({ skip: 0, take: 50 });
  const { revalidateJobs } = useTemplateRegistryRevalidate();

  const handleRefresh = useCallback(() => {
    revalidateJobs();
  }, [revalidateJobs]);

  if (jobs.length === 0) {
    return (
      <SettingsEmptyState
        title={i18n.t("admin.templates.jobs.empty")}
        description={i18n.t("admin.templates.jobs.empty-hint")}
      />
    );
  }

  return (
    <Stack>
      <Group justify="flex-end">
        <Button
          type="button"
          variant="plain"
          prefix={<RefreshCwIcon />}
          onClick={handleRefresh}
        >
          {i18n.t("admin.templates.jobs.refresh")}
        </Button>
      </Group>
      <SurfaceList data-testid="templates-jobs-soft-list">
        {jobs.map((job: any) => (
          <SurfaceListItem key={job.id}>
            <Group align="flex-start" justify="space-between" wrap="wrap">
              <SurfaceListItemMain grow>
                <SettingsListItemTitle truncate>
                  {job.jobType}
                </SettingsListItemTitle>
                <SettingsListItemMeta lineClamp={2}>
                  {i18n.t("admin.templates.jobs.card.subtitle")}
                </SettingsListItemMeta>
                {job.id ? (
                  <SettingsStatusText mono truncate>
                    <MonoText>{job.id}</MonoText>
                  </SettingsStatusText>
                ) : null}
              </SurfaceListItemMain>
              <Group align="center" wrap="wrap">
                <TemplateJobKindBadge kind={job.jobType as TemplateJobKind} />
                <TemplateJobStateBadge state={job.state as TemplateJobState} />
              </Group>
            </Group>
            <SettingsDefinitionList>
              <SettingsDefinitionItem
                label={i18n.t("admin.templates.jobs.col.template")}
                mono
              >
                {job.templateId ? job.templateId : "\u2014"}
              </SettingsDefinitionItem>
              <SettingsDefinitionItem
                label={i18n.t("admin.templates.jobs.col.workspace")}
                mono
              >
                {job.workspaceId ? job.workspaceId : "\u2014"}
              </SettingsDefinitionItem>
              <SettingsDefinitionItem
                label={i18n.t("admin.templates.jobs.col.started")}
              >
                {formatDate(i18n.language, job.startedAt)}
              </SettingsDefinitionItem>
              <SettingsDefinitionItem
                label={i18n.t("admin.templates.jobs.col.finished")}
              >
                {formatDate(i18n.language, job.finishedAt)}
              </SettingsDefinitionItem>
            </SettingsDefinitionList>
          </SurfaceListItem>
        ))}
      </SurfaceList>
    </Stack>
  );
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function JobsTab() {
  const i18n = useI18n();
  return (
    <Stack component="section">
      <SettingsDetailHeader
        title={i18n.t("admin.templates.jobs.title")}
        description={i18n.t("admin.templates.jobs.description")}
        actions={
          <MetricStack
            rows={[
              {
                label: i18n.t("admin.templates.jobs.metric.window"),
                value: "50",
              },
              {
                label: i18n.t("admin.templates.jobs.metric.action-label"),
                value: i18n.t("admin.templates.jobs.metric.manual"),
              },
            ]}
          />
        }
        headingLevel={2}
      />
      <Suspense fallback={<SettingsSkeleton />}>
        <JobsContent />
      </Suspense>
    </Stack>
  );
}
