// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Native queue overview page for worker queue operations.
 *
 * Fetches queue list and per-queue stats from AdminRoot GraphQL,
 * renders a native Facade table with keyboard-reachable queue buttons.
 * Clicking a queue row opens a detail panel with job listings.
 *
 * Supports interactive queue management:
 * - Pause/Resume per queue and global Pause All / Resume All (P35-E-04)
 * - Paused badge display (P35-E-02a)
 * - Clean completed / Empty queue per row (P35-E-05)
 */
import { useI18n } from "@myoxus/i18n";
import {
  AlertTriangle,
  CheckCircle,
  MoreHorizontal,
  Pause,
  PauseCircle,
  Play,
  RefreshCw,
  Trash2,
} from "@myoxus/icons/react";
import {
  Accordion,
  AccordionControl,
  AccordionItem,
  AccordionPanel,
  Badge,
  Sparkline,
  Tooltip,
  Text,
  Button,
  ConfirmModal,
  EmptyState,
  Group,
  IconButton,
  InlineActionButton,
  Menu,
  MenuItem,
  MenuSeparator,
  notify,
  SettingsSection,
  SettingsHeadingGroup,
  SettingsSectionHeading,
  SettingsSectionDescription,
  SettingsToolbar,
  Stack,
  SimpleGrid,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  Tabs,
  TabsContent,
} from "@myoxus/ui-facade";
import { useCallback, useEffect, useState } from "react";

import { AdminPageFrame, AdminPageScroll, AdminSubnav } from "../admin-shell";
import { useUrlSyncedAdminTab } from "../admin-tabs";
import { useAdminContext, useRevalidateServerConfig } from "../common";
import { useRightPanel } from "../panel/context";
import { ALL_CONFIG_DESCRIPTORS, type AppConfig } from "../settings/config";
import {
  ConfigBooleanField,
  type ConfigControlType,
  ConfigNumberField,
  ConfigSelectField,
  ConfigTextField,
} from "../settings/config-form-fields";
import { ConfigPageSaveButtons } from "../settings/config-page-save-buttons";
import {
  type AdminConfigSchemaField,
  buildSchemaFieldMap,
} from "../settings/schema-utils";
import { useAppConfig } from "../settings/use-app-config";
import { useFieldErrors } from "../settings/use-field-errors";
import { getByPath } from "../settings/utils";
import {
  cleanQueue,
  emptyQueue,
  fetchQueueStatus,
  pauseAllQueues,
  pauseQueue,
  type QueueWithCounts,
  resumeAllQueues,
  resumeQueue,
} from "./queue-api";
import { QueueDetailPanel } from "./queue-detail-panel";
import { queueHistorySeries } from "./queue-history";

type QueueHealth =
  | { state: "loading" }
  | { state: "ready"; queues: QueueWithCounts[] }
  | { state: "empty" }
  | { state: "error"; message: string };

async function fetchQueueList(): Promise<QueueHealth> {
  try {
    const status = await fetchQueueStatus();

    if (!status.redisAvailable) {
      return { state: "error", message: "Queue backend is unavailable." };
    }
    if (!Array.isArray(status.queues) || status.queues.length === 0) {
      return { state: "empty" };
    }

    return { state: "ready", queues: status.queues };
  } catch {
    return { state: "error", message: "Queue API could not be reached." };
  }
}

// ---------------------------------------------------------------------------
// Settings Tab — Job Config Fields (structured sections)
// ---------------------------------------------------------------------------

type JobFieldDef = {
  key: string;
  type?: ConfigControlType;
  descKey?: string;
  suffix?: string;
  options?: string[];
  labelKeys?: Record<string, string>;
  min?: number;
  max?: number;
};

type JobSection = {
  titleKey: string;
  /** When set, fields are sub-keys of this parent Object (e.g. "queue" → "queue/retryAttempts"). */
  parentKey?: string;
  /** When set, the displayed value is read from this sub-field of the Object (e.g. "concurrency"). */
  subField?: string;
  fields: JobFieldDef[];
};

function QueueConfigField({
  module,
  section,
  field,
  schemaField,
  defaultValue,
  labels,
  error,
  onErrorChange,
  onUpdate,
  onSaveField,
}: {
  module: string;
  section: JobSection;
  field: JobFieldDef;
  schemaField?: AdminConfigSchemaField | null;
  defaultValue: unknown;
  labels?: Record<string, string>;
  error?: string;
  onErrorChange: (field: string, error?: string) => void;
  onUpdate: (path: string, value: unknown) => void;
  onSaveField: (field: string, value: unknown) => Promise<void>;
}) {
  const configJsonKey = section.parentKey ?? field.key;
  const descriptor = ALL_CONFIG_DESCRIPTORS[module]?.[configJsonKey];
  const fieldPath = section.parentKey
    ? `${module}/${section.parentKey}/${field.key}`
    : section.subField
      ? `${module}/${field.key}/${section.subField}`
      : `${module}/${field.key}`;
  const type = (field.type ??
    schemaField?.valueType ??
    "String") as ConfigControlType;
  const commonProps = {
    field: fieldPath,
    desc: field.descKey ? field.descKey : (descriptor?.desc ?? ""),
    defaultValue,
    onChange: onUpdate,
    databaseWritable: schemaField?.databaseWritable,
    restartRequired: Boolean(schemaField?.restart_required),
    error,
    onErrorChange,
  };
  const sensitive = Boolean(schemaField?.sensitive);

  if (type === "Boolean") {
    return (
      <ConfigBooleanField
        {...commonProps}
        immediateApply={Boolean(schemaField?.immediate_apply)}
        onSave={schemaField?.immediate_apply ? onSaveField : undefined}
      />
    );
  }
  if (type === "Number") {
    return (
      <ConfigNumberField
        {...commonProps}
        suffix={field.suffix ?? descriptor?.suffix}
        min={field.min ?? schemaField?.min ?? undefined}
        max={field.max ?? schemaField?.max ?? undefined}
      />
    );
  }
  if (type === "Enum") {
    return (
      <ConfigSelectField
        {...commonProps}
        options={field.options ?? []}
        labels={labels}
      />
    );
  }
  return <ConfigTextField {...commonProps} sensitive={sensitive} />;
}

/**
 * Server API contract (keys match the canonical server descriptor paths):
 * - job.queue.attempts               Number
 * - job.queue.removeOnComplete       Boolean
 * - job.queue.backoff.type           Enum (exponential|fixed)
 * - job.queue.backoff.delay          Number (ms)
 * - job.queue.removeOnFail.age       Number (seconds)
 * - job.queue.removeOnFail.count     Number
 * - job.worker.pollTimeoutSeconds    Number
 * - job.queues.*.concurrency         Number for every registered worker queue
 *
 * The useAppConfig hook's 3-segment path format ("module/field/subField") merges
 * sub-field edits into the parent Object before sending the mutation.
 * parentKey may contain dots (e.g. "queue.backoff") to address nested objects.
 */
const JOB_SECTIONS: JobSection[] = [
  {
    titleKey: "admin.queue.settings.queue-defaults",
    parentKey: "queue",
    fields: [
      {
        key: "attempts",
        type: "Number",
        min: 0,
        max: 50,
        descKey: "admin.queue.settings.field.attempts.desc",
      },
      {
        key: "removeOnComplete",
        type: "Boolean",
        descKey: "admin.queue.settings.field.remove-on-complete.desc",
      },
    ],
  },
  {
    titleKey: "admin.queue.settings.backoff",
    parentKey: "queue.backoff",
    fields: [
      {
        key: "type",
        type: "Enum",
        options: ["exponential", "fixed"],
        labelKeys: {
          exponential: "admin.queue.settings.field.backoff-type.exponential",
          fixed: "admin.queue.settings.field.backoff-type.fixed",
        },
        descKey: "admin.queue.settings.field.backoff-type.desc",
      },
      {
        key: "delay",
        type: "Number",
        suffix: "ms",
        min: 100,
        descKey: "admin.queue.settings.field.backoff-delay.desc",
      },
    ],
  },
  {
    titleKey: "admin.queue.settings.remove-on-fail",
    parentKey: "queue.removeOnFail",
    fields: [
      {
        key: "age",
        type: "Number",
        suffix: "s",
        min: 0,
        descKey: "admin.queue.settings.field.remove-on-fail-age.desc",
      },
      {
        key: "count",
        type: "Number",
        min: 0,
        descKey: "admin.queue.settings.field.remove-on-fail-count.desc",
      },
    ],
  },
  {
    titleKey: "admin.queue.settings.per-queue",
    subField: "concurrency",
    fields: [
      { key: "queues.copilot", type: "Number", min: 1 },
      { key: "queues.doc", type: "Number", min: 1 },
      { key: "queues.indexer", type: "Number", min: 1 },
      { key: "queues.document-graph", type: "Number", min: 1 },
      { key: "queues.notification", type: "Number", min: 1 },
      { key: "queues.nightly", type: "Number", min: 1 },
      { key: "queues.calendar-reminder", type: "Number", min: 1 },
      { key: "queues.git-sync", type: "Number", min: 1 },
      { key: "queues.template-registry", type: "Number", min: 1 },
      { key: "queues.caldav-sync", type: "Number", min: 1 },
      { key: "queues.google-calendar-sync", type: "Number", min: 1 },
      { key: "queues.pdf-export", type: "Number", min: 1 },
      { key: "queues.database", type: "Number", min: 1 },
      { key: "queues.workspace-automation", type: "Number", min: 1 },
      { key: "queues.workspace-content-operation", type: "Number", min: 1 },
    ],
  },
  {
    titleKey: "admin.queue.settings.worker",
    parentKey: "worker",
    fields: [
      {
        key: "pollTimeoutSeconds",
        type: "Number",
        suffix: "s",
        min: 1,
        max: 60,
      },
    ],
  },
];

function JobSettingsTab({
  appConfig,
  patchedAppConfig,
  schema,
  onUpdate,
  onSaveGroup,
  onSaveField,
  onResetGroup,
  isGroupDirty,
  isGroupSaving,
  getGroupVersion,
  fieldErrorsByPath,
}: {
  appConfig: AppConfig;
  patchedAppConfig: AppConfig;
  schema?: any;
  onUpdate: (path: string, value: any) => void;
  onSaveGroup: (module: string) => Promise<void>;
  onSaveField: (field: string, value: any) => Promise<void>;
  onResetGroup: (module: string) => void;
  isGroupDirty: (module: string) => boolean;
  isGroupSaving: (module: string) => boolean;
  getGroupVersion: (module: string) => number;
  fieldErrorsByPath: Record<string, { message: string }>;
}) {
  const i18n = useI18n();
  const module = "job";
  const dirty = isGroupDirty(module);
  const saving = isGroupSaving(module);
  const sourceConfig = patchedAppConfig[module] ?? appConfig[module];
  const version = getGroupVersion(module);

  // Build schema field map for the job module
  const schemaFieldMap = buildSchemaFieldMap(schema, module);

  const { fieldErrors, onFieldErrorChange } = useFieldErrors();
  const hasErrors = Object.keys(fieldErrors).length > 0;

  return (
    <Stack>
      {JOB_SECTIONS.map((section) => {
        const fields = (
          <SimpleGrid cols={2} key={`${module}-${section.titleKey}-${version}`}>
            {section.fields.map((field) => {
              // Build the 3-segment path ("module/serverKey/subField") so
              // useAppConfig merges sub-field edits into the parent Object.
              let fieldPath: string;
              let defaultValue: any;

              if (section.parentKey) {
                // Sub-field of a parent Object: job/queue/retryAttempts
                fieldPath = `${module}/${section.parentKey}/${field.key}`;
                defaultValue = getByPath(
                  sourceConfig,
                  `${section.parentKey}.${field.key}`,
                );
              } else if (section.subField) {
                // Object field with a sub-field to read/write: job/queues.copilot/concurrency
                fieldPath = `${module}/${field.key}/${section.subField}`;
                defaultValue = getByPath(
                  sourceConfig,
                  `${field.key}.${section.subField}`,
                );
              } else {
                fieldPath = `${module}/${field.key}`;
                defaultValue = getByPath(sourceConfig, field.key);
              }

              // Determine the schema key: for parentKey sections, use parentKey;
              // for subField sections (queues.*), use the field key directly.
              const schemaLookupKey = section.parentKey ?? field.key;
              const schemaField = schemaFieldMap[schemaLookupKey];
              const labels = field.labelKeys
                ? Object.fromEntries(
                    Object.entries(field.labelKeys).map(([value, key]) => [
                      value,
                      i18n.t(key),
                    ]),
                  )
                : undefined;

              return (
                <QueueConfigField
                  key={fieldPath}
                  module={module}
                  section={section}
                  field={field}
                  schemaField={schemaField}
                  defaultValue={defaultValue}
                  labels={labels}
                  error={fieldErrorsByPath[fieldPath]?.message}
                  onErrorChange={onFieldErrorChange}
                  onUpdate={onUpdate}
                  onSaveField={onSaveField}
                />
              );
            })}
          </SimpleGrid>
        );
        const description =
          section.titleKey === "admin.queue.settings.queue-defaults"
            ? i18n.t("admin.queue.settings.description")
            : i18n.t("admin.config.changes-without-restart");

        if (section.subField === "concurrency") {
          return (
            <Accordion key={section.titleKey} variant="default">
              <AccordionItem value={section.titleKey}>
                <AccordionControl>{i18n.t(section.titleKey)}</AccordionControl>
                <AccordionPanel>{fields}</AccordionPanel>
              </AccordionItem>
            </Accordion>
          );
        }

        return (
          <Stack key={section.titleKey} component="section">
            <SettingsHeadingGroup>
              <SettingsSectionHeading level={3}>
                {i18n.t(section.titleKey)}
              </SettingsSectionHeading>
              <SettingsSectionDescription>
                {description}
              </SettingsSectionDescription>
            </SettingsHeadingGroup>
            {fields}
          </Stack>
        );
      })}

      {/* Save / Cancel */}
      <ConfigPageSaveButtons
        dirty={dirty}
        hasFieldError={hasErrors}
        saving={saving}
        onReset={() => onResetGroup(module)}
        onSave={() => {
          onSaveGroup(module).catch((err) => {
            notify.error({
              title: i18n.t("admin.common.save-failed"),
              message: err?.message ?? String(err),
            });
          });
        }}
      />
    </Stack>
  );
}

// ---------------------------------------------------------------------------
// Main Page
// ---------------------------------------------------------------------------

const TAB_IDS = ["queues", "settings"] as const;

export function QueuePage() {
  const i18n = useI18n();
  const historyTime = new Intl.DateTimeFormat(i18n.language, {
    dateStyle: "short",
    timeStyle: "short",
  });
  const [activeTab, setActiveTab] = useUrlSyncedAdminTab(TAB_IDS, "queues");
  const {
    capabilities: { hasQueueDashboard },
  } = useAdminContext();
  const [health, setHealth] = useState<QueueHealth>({ state: "loading" });
  const [emptyTarget, setEmptyTarget] = useState<QueueWithCounts | null>(null);
  const { setPanelContent, openPanel, isOpen, closePanel } = useRightPanel();

  // Settings tab: useAppConfig for job config
  const {
    appConfig,
    update,
    saveGroup,
    saveField,
    resetGroup,
    patchedAppConfig,
    schema,
    isGroupDirty,
    isGroupSaving,
    getGroupVersion,
    fieldErrorsByPath = {},
  } = useAppConfig();
  const revalidateServerConfig = useRevalidateServerConfig();

  const handleSaveGroup = useCallback(
    async (module: string) => {
      await saveGroup(module);
      await revalidateServerConfig();
    },
    [saveGroup, revalidateServerConfig],
  );

  const configProps = {
    appConfig,
    patchedAppConfig,
    schema,
    onUpdate: update,
    onSaveGroup: handleSaveGroup,
    onSaveField: saveField,
    onResetGroup: resetGroup,
    isGroupDirty,
    isGroupSaving,
    getGroupVersion,
    fieldErrorsByPath,
  };

  const loadQueues = useCallback(async () => {
    setHealth({ state: "loading" });
    const result = await fetchQueueList();
    setHealth(result);
  }, []);

  useEffect(() => {
    if (!hasQueueDashboard) return;
    void loadQueues();
  }, [hasQueueDashboard, loadQueues]);

  const handleQueueClick = useCallback(
    (queue: QueueWithCounts) => {
      setPanelContent(
        <QueueDetailPanel
          key={queue.name}
          queueName={queue.name}
          onClose={closePanel}
        />,
      );
      if (!isOpen) openPanel();
    },
    [closePanel, isOpen, openPanel, setPanelContent],
  );

  // --- Queue management actions ---

  const handlePauseResume = useCallback(
    async (queue: QueueWithCounts) => {
      try {
        if (queue.paused) {
          await resumeQueue(queue.name);
        } else {
          await pauseQueue(queue.name);
        }
        notify.success({
          title: queue.paused
            ? i18n.t("admin.queue.toast.resumed", { name: queue.displayName })
            : i18n.t("admin.queue.toast.paused", { name: queue.displayName }),
        });
        void loadQueues();
      } catch (err) {
        notify.error({
          title: queue.paused
            ? i18n.t("admin.queue.toast.resume-failed", {
                message: (err as Error).message,
              })
            : i18n.t("admin.queue.toast.pause-failed", {
                message: (err as Error).message,
              }),
        });
      }
    },
    [i18n, loadQueues],
  );

  const handlePauseAll = useCallback(async () => {
    try {
      await pauseAllQueues();
      notify.success({ title: i18n.t("admin.queue.toast.all-paused") });
      void loadQueues();
    } catch (err) {
      notify.error({
        title: i18n.t("admin.queue.toast.pause-all-failed", {
          message: (err as Error).message,
        }),
      });
    }
  }, [i18n, loadQueues]);

  const handleResumeAll = useCallback(async () => {
    try {
      await resumeAllQueues();
      notify.success({ title: i18n.t("admin.queue.toast.all-resumed") });
      void loadQueues();
    } catch (err) {
      notify.error({
        title: i18n.t("admin.queue.toast.resume-all-failed", {
          message: (err as Error).message,
        }),
      });
    }
  }, [i18n, loadQueues]);

  const handleClean = useCallback(
    async (queue: QueueWithCounts, e?: { stopPropagation(): void }) => {
      e?.stopPropagation();
      try {
        await cleanQueue(queue.name, "completed");
        notify.success({
          title: i18n.t("admin.queue.toast.cleaned", {
            name: queue.displayName,
          }),
        });
        void loadQueues();
      } catch (err) {
        notify.error({
          title: i18n.t("admin.queue.toast.clean-failed", {
            message: (err as Error).message,
          }),
        });
      }
    },
    [i18n, loadQueues],
  );

  const handleEmpty = useCallback(async () => {
    if (!emptyTarget) return;
    try {
      await emptyQueue(emptyTarget.name);
      notify.success({
        title: i18n.t("admin.queue.toast.emptied", {
          name: emptyTarget.displayName,
        }),
      });
      setEmptyTarget(null);
      void loadQueues();
    } catch (err) {
      notify.error({
        title: i18n.t("admin.queue.toast.empty-failed", {
          message: (err as Error).message,
        }),
      });
      setEmptyTarget(null);
    }
  }, [emptyTarget, i18n, loadQueues]);

  if (!hasQueueDashboard) {
    return (
      <AdminPageFrame
        title={i18n.t("admin.queue.title")}
        routeAnchor="admin-route-queue"
      >
        <Tabs
          value="settings"
          onValueChange={setActiveTab}
          layout="page"
          variant="default"
        >
          <AdminSubnav
            items={[
              {
                value: "settings",
                label: i18n.t("admin.queue.tab.settings"),
              },
            ]}
          />
          <AdminPageScroll>
            <Stack>
              <SettingsSection
                title={i18n.t("admin.queue.unavailable-title")}
                description={i18n.t("admin.queue.unavailable-description")}
                actions={<AlertTriangle aria-hidden />}
              />
              <TabsContent value="settings" forceMount layout="stack">
                <JobSettingsTab {...configProps} />
              </TabsContent>
            </Stack>
          </AdminPageScroll>
        </Tabs>
      </AdminPageFrame>
    );
  }

  return (
    <AdminPageFrame
      routeAnchor="admin-route-queue"
      title={i18n.t("admin.queue.title")}
    >
      <Tabs
        value={activeTab}
        onValueChange={setActiveTab}
        layout="page"
        variant="default"
      >
        <AdminSubnav
          items={[
            {
              value: "queues",
              label: i18n.t("admin.queue.tab.queues"),
            },
            {
              value: "settings",
              label: i18n.t("admin.queue.tab.settings"),
            },
          ]}
        />
        <AdminPageScroll>
          <Stack>
            <TabsContent value="queues" forceMount layout="stack">
              <Stack>
                {health.state === "ready" ? (
                  <SettingsToolbar>
                    <Button
                      variant="plain"
                      prefix={<PauseCircle aria-hidden />}
                      onClick={handlePauseAll}
                    >
                      {i18n.t("admin.queue.pause-all")}
                    </Button>
                    <Button
                      variant="plain"
                      prefix={<Play aria-hidden />}
                      onClick={handleResumeAll}
                    >
                      {i18n.t("admin.queue.resume-all")}
                    </Button>
                    <Button
                      variant="plain"
                      prefix={<RefreshCw aria-hidden />}
                      onClick={loadQueues}
                    >
                      {i18n.t("admin.queue.refresh")}
                    </Button>
                  </SettingsToolbar>
                ) : null}
                {health.state === "loading" && (
                  <EmptyState
                    title={i18n.t("admin.queue.loading-title")}
                    description={i18n.t("admin.queue.loading-description")}
                  />
                )}
                {health.state === "empty" && (
                  <EmptyState
                    title={i18n.t("admin.queue.empty-title")}
                    description={i18n.t("admin.queue.empty-description")}
                  />
                )}
                {health.state === "error" && (
                  <EmptyState
                    title={i18n.t("admin.queue.unavailable-title")}
                    description={health.message}
                    cta={
                      <Button
                        onClick={loadQueues}
                        variant="secondary"
                        prefix={<RefreshCw aria-hidden />}
                      >
                        {i18n.t("admin.queue.retry")}
                      </Button>
                    }
                  />
                )}
                {health.state === "ready" && (
                  <Table
                    highlightOnHover
                    aria-label={i18n.t("admin.queue.list-aria")}
                  >
                    <TableHeader>
                      <TableRow>
                        <TableHead>{i18n.t("admin.queue.title")}</TableHead>
                        <TableHead>
                          {i18n.t("admin.queue.summary.state")}
                        </TableHead>
                        <TableHead>
                          {i18n.t("admin.queue.count.waiting")}
                        </TableHead>
                        <TableHead>
                          {i18n.t("admin.queue.count.active")}
                        </TableHead>
                        <TableHead>
                          {i18n.t("admin.queue.count.delayed")}
                        </TableHead>
                        <TableHead>
                          {i18n.t("admin.queue.count.completed")}
                        </TableHead>
                        <TableHead>
                          {i18n.t("admin.queue.count.failed")}
                        </TableHead>
                        <TableHead>
                          {i18n.t("admin.queue.history.title")}
                        </TableHead>
                        <TableHead>{i18n.t("admin.common.actions")}</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {health.queues.map((q) => {
                        const history = queueHistorySeries(q.history ?? []);
                        const description = history
                          ? i18n.t("admin.queue.history.summary", {
                              queue: q.displayName,
                              start: historyTime.format(history.start),
                              end: historyTime.format(history.end),
                              count: new Intl.NumberFormat(
                                i18n.language,
                              ).format(history.last),
                            })
                          : q.history === null
                            ? i18n.t("admin.queue.history.unavailable")
                            : i18n.t("admin.queue.history.insufficient");
                        return (
                          <TableRow
                            key={q.name}
                            onClick={() => handleQueueClick(q)}
                            data-myoxus-ui-role="queue-row"
                          >
                            <TableCell>
                              <InlineActionButton
                                onClick={(event) => {
                                  event.stopPropagation();
                                  handleQueueClick(q);
                                }}
                              >
                                {q.displayName}
                              </InlineActionButton>
                            </TableCell>
                            <TableCell>
                              <Badge tone={q.paused ? "warning" : "success"}>
                                {q.paused
                                  ? i18n.t("admin.queue.paused")
                                  : i18n.t("admin.queue.running")}
                              </Badge>
                            </TableCell>
                            <TableCell tabular>{q.counts.waiting}</TableCell>
                            <TableCell tabular>{q.counts.active}</TableCell>
                            <TableCell tabular>{q.counts.delayed}</TableCell>
                            <TableCell tabular>{q.counts.completed}</TableCell>
                            <TableCell tabular>{q.counts.failed}</TableCell>
                            <TableCell>
                              <Tooltip
                                content={description}
                                events={{
                                  hover: true,
                                  focus: true,
                                  touch: false,
                                }}
                              >
                                {history ? (
                                  <Sparkline
                                    data={history.data}
                                    role="img"
                                    aria-label={description}
                                    tabIndex={0}
                                    data-myoxus-ui-role="queue-history"
                                  />
                                ) : (
                                  <Text aria-label={description} tabIndex={0}>
                                    —
                                  </Text>
                                )}
                              </Tooltip>
                            </TableCell>
                            <TableCell>
                              <Group
                                onClick={(e) => e.stopPropagation()}
                                data-myoxus-ui-role="queue-row-actions"
                              >
                                <Menu
                                  contentOptions={{ align: "end" }}
                                  items={
                                    <>
                                      <MenuItem
                                        prefixIcon={
                                          q.paused ? (
                                            <Play aria-hidden />
                                          ) : (
                                            <Pause aria-hidden />
                                          )
                                        }
                                        onSelect={() => handlePauseResume(q)}
                                      >
                                        {q.paused
                                          ? i18n.t("admin.queue.resume-queue")
                                          : i18n.t("admin.queue.pause-queue")}
                                      </MenuItem>
                                      <MenuSeparator />
                                      <MenuItem
                                        prefixIcon={<CheckCircle aria-hidden />}
                                        onSelect={() => handleClean(q)}
                                      >
                                        {i18n.t("admin.queue.clean-completed")}
                                      </MenuItem>
                                      <MenuSeparator />
                                      <MenuItem
                                        type="danger"
                                        prefixIcon={<Trash2 aria-hidden />}
                                        onSelect={() => setEmptyTarget(q)}
                                      >
                                        {i18n.t("admin.queue.empty-queue")}
                                      </MenuItem>
                                    </>
                                  }
                                >
                                  <IconButton
                                    icon={<MoreHorizontal aria-hidden />}
                                    tooltip={i18n.t("admin.queue.actions-aria")}
                                    aria-label={i18n.t(
                                      "admin.queue.actions-aria",
                                    )}
                                  />
                                </Menu>
                              </Group>
                            </TableCell>
                          </TableRow>
                        );
                      })}
                    </TableBody>
                  </Table>
                )}
              </Stack>
            </TabsContent>

            <TabsContent value="settings" forceMount layout="stack">
              <JobSettingsTab {...configProps} />
            </TabsContent>
          </Stack>
        </AdminPageScroll>
      </Tabs>

      {/* Confirm dialog for emptying a queue */}
      <ConfirmModal
        open={emptyTarget !== null}
        onOpenChange={(open) => {
          if (!open) setEmptyTarget(null);
        }}
        title={i18n.t("admin.queue.empty-queue")}
        description={i18n.t("admin.queue.empty-queue-confirm", {
          name: emptyTarget?.displayName ?? "",
        })}
        cancelText={i18n.t("admin.common.cancel")}
        confirmText={i18n.t("admin.queue.empty-button")}
        confirmButtonOptions={{ variant: "error" }}
        onConfirm={handleEmpty}
      />
    </AdminPageFrame>
  );
}

export { QueuePage as Component };
