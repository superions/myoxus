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
  SettingsEmptyState,
  SettingsSkeleton,
  Stack,
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
      <SoftList data-testid="templates-jobs-soft-list">
        {jobs.map((job: any) => (
          <SoftListItem key={job.id}>
            <Group align="flex-start" justify="space-between" wrap="wrap">
              <TemplateCardTitle
                title={job.jobType}
                subtitle={i18n.t("admin.templates.jobs.card.subtitle")}
                mono={job.id}
              />
              <Group align="center" wrap="wrap">
                <TemplateJobKindBadge kind={job.jobType as TemplateJobKind} />
                <TemplateJobStateBadge state={job.state as TemplateJobState} />
              </Group>
            </Group>
            <MetaGrid>
              <MetaField
                label={i18n.t("admin.templates.jobs.col.template")}
                value={job.templateId ? job.templateId : "\u2014"}
                mono
              />
              <MetaField
                label={i18n.t("admin.templates.jobs.col.workspace")}
                value={job.workspaceId ? job.workspaceId : "\u2014"}
                mono
              />
              <MetaField
                label={i18n.t("admin.templates.jobs.col.started")}
                value={formatDate(i18n.language, job.startedAt)}
              />
              <MetaField
                label={i18n.t("admin.templates.jobs.col.finished")}
                value={formatDate(i18n.language, job.finishedAt)}
              />
            </MetaGrid>
          </SoftListItem>
        ))}
      </SoftList>
    </Stack>
  );
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function JobsTab() {
  const i18n = useI18n();
  return (
    <TemplateTabFrame
      title={i18n.t("admin.templates.jobs.title")}
      description={i18n.t("admin.templates.jobs.description")}
      shoulder={
        <TemplateShoulder
          rows={[
            {
              label: i18n.t("admin.templates.jobs.metric.window"),
              value: "50",
              tone: "info",
            },
            {
              label: i18n.t("admin.templates.jobs.metric.action-label"),
              value: i18n.t("admin.templates.jobs.metric.manual"),
              tone: "neutral",
            },
          ]}
        />
      }
    >
      <Suspense fallback={<SettingsSkeleton />}>
        <JobsContent />
      </Suspense>
    </TemplateTabFrame>
  );
}
