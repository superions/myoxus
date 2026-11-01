// SPDX-License-Identifier: AGPL-3.0-or-later

import { useRegionalPreferences } from "@myoxus/core/components/hooks/myoxus/use-user-preferences";
import { useMutation } from "@myoxus/core/components/hooks/use-mutation";
import { useQuery } from "@myoxus/core/components/hooks/use-query";
import { WorkspaceServerService } from "@myoxus/core/modules/server/services/workspace-server";
import { formatRegionalDateTime } from "@myoxus/core/modules/i18n";
import {
  type AssistantControlFragmentFragment as AssistantControlFragment,
  DatabaseFieldKind,
  DatabaseProfileKind,
  DatabaseStatusGroup,
  databaseRowRemindersQuery,
  deleteDatabaseRowReminderMutation,
  setDatabaseRowReminderMutation,
} from "@myoxus/graphql";
import { useI18n } from "@myoxus/i18n";
import { useLiveData, useService } from "@myoxus/infra";
import {
  NotificationIcon,
  RefreshCwIcon,
  TrashIcon,
} from "@myoxus/icons/react";
import {
  Button,
  Group,
  IconButton,
  Loading,
  Menu,
  MenuItem,
  MenuPanel,
  MenuSection,
  MenuSectionLabel,
  MyoxusText,
  Notice,
  notify,
  NumberInput,
  Stack,
  SurfaceListItem,
  SurfaceListItemMain,
  SurfaceListText,
} from "@myoxus/ui-facade";
import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { Middleware } from "swr";

import { managedTaskFields } from "../managed";
import { getCellValue } from "../model";
import { databaseWallTimeToInstant, databaseZonedDate } from "../shared";
import type {
  DatabaseField,
  DatabaseRecord,
  DatabaseRowRecord,
} from "../types";

const REMINDER_PRESETS = [0, 10, 30, 60, 1_440, 10_080] as const;

function allDayBaseline(start: string, timeZone: string) {
  const instant = databaseWallTimeToInstant(
    `${databaseZonedDate(start, timeZone)} 09:00:00`,
    timeZone,
  );
  return instant ? new Date(instant) : null;
}

function presetLabel(
  offsetMinutes: number,
  allDay: boolean,
  t: ReturnType<typeof useI18n>,
) {
  if (allDay && offsetMinutes === 0) {
    return t["com.myoxus.database.reminder.on-date-at-nine"]();
  }
  switch (offsetMinutes) {
    case 0:
      return t["com.myoxus.database.reminder.at-time"]();
    case 10:
      return t["com.myoxus.database.reminder.ten-minutes"]();
    case 30:
      return t["com.myoxus.database.reminder.thirty-minutes"]();
    case 60:
      return t["com.myoxus.database.reminder.one-hour"]();
    case 1_440:
      return t["com.myoxus.database.reminder.one-day"]();
    case 10_080:
      return t["com.myoxus.database.reminder.one-week"]();
    default:
      return t["com.myoxus.database.reminder.custom"]();
  }
}

type ReminderPresentation = Pick<
  AssistantControlFragment,
  "offsetsMinutes" | "defaultOffsetMinutes" | "allowCustomOffset"
>;

/** Undefined retains the ordinary Database control; null means the managed
 * presentation omitted reminders. Native permissions still own every write. */
export const DatabaseReminderPresentation = createContext<
  ReminderPresentation | null | undefined
>(undefined);

export function DatabaseReminderControl(props: {
  field: DatabaseField;
  record: DatabaseRecord;
  row: DatabaseRowRecord;
}) {
  const presentation = useContext(DatabaseReminderPresentation);
  return presentation === null ? null : (
    <NativeDatabaseReminderControl {...props} presentation={presentation} />
  );
}

function NativeDatabaseReminderControl({
  field,
  record,
  row,
  presentation,
}: {
  presentation?: ReminderPresentation;
  field: DatabaseField;
  record: DatabaseRecord;
  row: DatabaseRowRecord;
}) {
  const t = useI18n();
  const presets: readonly number[] =
    presentation?.offsetsMinutes ?? REMINDER_PRESETS;
  const regionalPreferences = useRegionalPreferences();
  const servers = useService(WorkspaceServerService);
  const server = useLiveData(servers.server$);
  const account = useLiveData(server?.account$);
  const accountId = account?.id;
  const task =
    record.database.profileKind === DatabaseProfileKind.Project &&
    row.row.rowKind === "task";
  const statusField = managedTaskFields(record)?.get("task.status");
  const statusConfig = statusField?.config.status;
  const statusCell = statusField
    ? getCellValue(row, statusField.id)
    : undefined;
  const statusId = statusCell?.value.status;
  const status = statusConfig?.options.find((option) => option.id === statusId);
  const statusKnown = Boolean(
    statusField &&
    statusConfig &&
    (!statusCell ||
      (statusCell.value.kind === DatabaseFieldKind.Status && status)),
  );
  const canSchedule =
    !task ||
    (statusKnown &&
      !row.row.deletedAt &&
      !record.database.deletedAt &&
      status?.group !== DatabaseStatusGroup.Complete &&
      status?.group !== DatabaseStatusGroup.Archived);
  // A reopen has a new canonical revision: never reuse the pre-cancellation
  // personal list, even when the status value returns to the same option.
  const lifecycle = task
    ? JSON.stringify([
        row.row.editRevision,
        row.row.deletedAt,
        record.database.deletedAt,
        record.managedSchema?.schemaRevision,
        statusField,
        statusCell,
        row.cellRevisions.find(
          (revision) => revision.fieldId === statusField?.id,
        ),
        getCellValue(row, field.id),
        row.cellRevisions.find((revision) => revision.fieldId === field.id),
        field,
      ])
    : null;
  const scopeQuery = useMemo<Middleware>(
    () => (next) => (key, fetcher, config) =>
      next(
        () => {
          const resolvedKey = typeof key === "function" ? key() : key;
          return resolvedKey && server
            ? accountId
              ? [
                  server.id,
                  server.baseUrl,
                  accountId,
                  ...(lifecycle ? [lifecycle] : []),
                  resolvedKey,
                ]
              : null
            : resolvedKey;
        },
        fetcher,
        config,
      ),
    [server, accountId, lifecycle],
  );
  const value = getCellValue(row, field.id)?.value.dateTime;
  const enabled = Boolean(
    field.config.dateTime?.allowReminders && value?.start,
  );
  const disabledReason = !field.config.dateTime?.allowReminders
    ? t["com.myoxus.database.reminder.disabled-by-field"]()
    : t["com.myoxus.database.reminder.date-required"]();
  const query = useQuery(
    enabled
      ? {
          query: databaseRowRemindersQuery,
          variables: {
            workspaceId: record.database.workspaceId,
            databaseId: record.database.id,
            rowId: row.row.id,
            fieldId: field.id,
          },
        }
      : undefined,
    {
      suspense: false,
      suppressErrorNotification: true,
      keepPreviousData: false,
      // Personal reminders must not reuse another account/server's cached list.
      use: [scopeQuery],
    },
  );
  const scope = JSON.stringify([
    server?.id,
    server?.baseUrl,
    accountId,
    record.database.workspaceId,
    record.database.id,
    row.row.id,
    field.id,
    lifecycle,
  ]);
  const currentScope = useRef(scope);
  currentScope.current = scope;
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const isCurrent = () =>
    alive.current &&
    currentScope.current === scope &&
    servers.server$?.value?.id === server?.id &&
    servers.server$?.value?.baseUrl === server?.baseUrl &&
    servers.server$?.value?.account$?.value?.id === accountId;
  const setReminder = useMutation({ mutation: setDatabaseRowReminderMutation });
  const deleteReminder = useMutation({
    mutation: deleteDatabaseRowReminderMutation,
  });
  const confirmedReminders = query.data?.workspace?.databaseRowReminders;
  // An unresolved read cannot decide whether a preset means Set or Delete.
  const remindersReady = enabled && !query.error && confirmedReminders != null;
  const reminders = remindersReady ? confirmedReminders : [];
  const [customOffset, setCustomOffset] = useState<number | string>(
    presentation?.defaultOffsetMinutes ?? 120,
  );
  const [menuOpen, setMenuOpen] = useState(false);
  const pending = setReminder.isMutating || deleteReminder.isMutating;
  const allDay = Boolean(value?.allDay);
  const timeZone = value?.timeZone || "UTC";
  const baseline = useMemo(() => {
    if (!value?.start) return null;
    return allDay
      ? allDayBaseline(String(value.start), timeZone)
      : new Date(String(value.start));
  }, [allDay, timeZone, value?.start]);
  const formattedTrigger = (offsetMinutes: number, triggerAt?: string) => {
    if (triggerAt) {
      return formatRegionalDateTime(triggerAt, {
        ...regionalPreferences,
        timezone: timeZone,
      });
    }
    if (!baseline) return "";
    return formatRegionalDateTime(
      new Date(baseline.getTime() - offsetMinutes * 60_000),
      {
        ...regionalPreferences,
        timezone: timeZone,
      },
    );
  };
  const reportError = (error: unknown) =>
    notify.error({
      title: t["com.myoxus.database.reminder.error-title"](),
      message:
        error instanceof Error
          ? error.message
          : t["com.myoxus.database.reminder.error-description"](),
    });
  const toggleOffset = async (offsetMinutes: number) => {
    if (!remindersReady || pending) return;
    try {
      const existing = reminders.find(
        (reminder) => reminder.offsetMinutes === offsetMinutes,
      );
      if (existing) {
        await deleteReminder.trigger({
          input: { databaseId: record.database.id, reminderId: existing.id },
        });
      } else {
        if (!canSchedule) return;
        await setReminder.trigger({
          input: {
            databaseId: record.database.id,
            rowId: row.row.id,
            fieldId: field.id,
            offsetMinutes,
          },
        });
      }
      if (isCurrent()) await query.mutate();
    } catch (error) {
      if (isCurrent()) reportError(error);
    }
  };
  const addCustomOffset = async () => {
    if (pending || !canSchedule) return;
    const offsetMinutes = Number(customOffset);
    if (
      customOffset === "" ||
      !Number.isInteger(offsetMinutes) ||
      offsetMinutes < 0
    ) {
      notify.error({
        title: t["com.myoxus.database.reminder.custom-invalid"](),
      });
      return;
    }
    try {
      await setReminder.trigger({
        input: {
          databaseId: record.database.id,
          rowId: row.row.id,
          fieldId: field.id,
          offsetMinutes,
        },
      });
      if (isCurrent()) await query.mutate();
    } catch (error) {
      if (isCurrent()) reportError(error);
    }
  };
  const removeReminder = async (reminderId: string) => {
    if (!remindersReady || pending) return;
    try {
      await deleteReminder.trigger({
        input: { databaseId: record.database.id, reminderId },
      });
      if (isCurrent()) await query.mutate();
    } catch (error) {
      if (isCurrent()) reportError(error);
    }
  };
  const customReminders = reminders.filter(
    (reminder) => !presets.includes(reminder.offsetMinutes),
  );

  const trigger = (
    <IconButton
      aria-label={t["com.myoxus.database.reminder.open"]()}
      tooltip={
        enabled ? t["com.myoxus.database.reminder.open"]() : disabledReason
      }
      tooltipOptions={{ opened: menuOpen ? false : undefined }}
      disabled={!enabled}
      data-testid="database-reminder-trigger"
    >
      <NotificationIcon />
    </IconButton>
  );
  if (!enabled) return trigger;

  return (
    <Menu
      rootOptions={{ open: menuOpen, onOpenChange: setMenuOpen }}
      items={
        <MenuPanel panelWidth="comfortable" panelPadding="comfortable">
          {!canSchedule ? (
            <Notice
              tone="warning"
              title={
                statusKnown
                  ? t["com.myoxus.database.reminder.task-not-open"]()
                  : t["com.myoxus.template-list.unavailable"]()
              }
            />
          ) : null}
          {query.error ? (
            <MenuSection>
              <Notice
                tone="warning"
                title={t["com.myoxus.database.reminder.unavailable"]()}
              />
              <Button
                variant="secondary"
                prefix={<RefreshCwIcon />}
                onClick={() => void query.mutate()}
              >
                {t["Retry"]()}
              </Button>
            </MenuSection>
          ) : (
            <>
              <MenuSection>
                <MenuSectionLabel>
                  {t["com.myoxus.database.reminder.personal"]()}
                </MenuSectionLabel>
                {!remindersReady ? (
                  <Group role="status" aria-label={t["Loading"]()}>
                    <Loading />
                  </Group>
                ) : (
                  presets.map((offsetMinutes) =>
                    (() => {
                      const existing = reminders.find(
                        (reminder) => reminder.offsetMinutes === offsetMinutes,
                      );
                      return (
                        <MenuItem
                          key={offsetMinutes}
                          checked={Boolean(existing)}
                          disabled={pending || (!existing && !canSchedule)}
                          closeMenuOnClick={false}
                          onSelect={() => void toggleOffset(offsetMinutes)}
                          suffix={formattedTrigger(
                            offsetMinutes,
                            existing?.triggerAt,
                          )}
                        >
                          {presetLabel(offsetMinutes, allDay, t)}
                        </MenuItem>
                      );
                    })(),
                  )
                )}
              </MenuSection>
              {customReminders.length ? (
                <MenuSection>
                  <MenuSectionLabel>
                    {t["com.myoxus.database.reminder.custom"]()}
                  </MenuSectionLabel>
                  {customReminders.map((reminder) => (
                    <SurfaceListItem
                      key={reminder.id}
                      appearance="row"
                      layout="row"
                    >
                      <SurfaceListItemMain>
                        <SurfaceListText kind="title">
                          {reminder.offsetMinutes}{" "}
                          {t["com.myoxus.database.reminder.minutes"]()}
                        </SurfaceListText>
                        <SurfaceListText kind="description">
                          {formattedTrigger(
                            reminder.offsetMinutes,
                            reminder.triggerAt,
                          )}
                        </SurfaceListText>
                      </SurfaceListItemMain>
                      <IconButton
                        icon={<TrashIcon />}
                        aria-label={t["com.myoxus.database.reminder.remove"]()}
                        disabled={pending}
                        onClick={() => void removeReminder(reminder.id)}
                      />
                    </SurfaceListItem>
                  ))}
                </MenuSection>
              ) : null}
              {presentation?.allowCustomOffset !== false ? (
                <MenuSection>
                  <Stack gap="xs">
                    <MyoxusText typographySlot="body-small" tone="secondary">
                      {t["com.myoxus.database.reminder.custom-offset"]()}
                    </MyoxusText>
                    <Group align="end" wrap="nowrap">
                      <NumberInput
                        aria-label={t[
                          "com.myoxus.database.reminder.custom-offset"
                        ]()}
                        disabled={!canSchedule}
                        value={customOffset}
                        min={0}
                        allowDecimal={false}
                        onChange={setCustomOffset}
                        suffix={` ${t["com.myoxus.database.reminder.minutes"]()}`}
                      />
                      <Button
                        loading={setReminder.isMutating}
                        disabled={
                          pending ||
                          !canSchedule ||
                          customOffset === "" ||
                          !Number.isInteger(Number(customOffset)) ||
                          Number(customOffset) < 0
                        }
                        onClick={() => void addCustomOffset()}
                      >
                        {t["com.myoxus.database.reminder.add"]()}
                      </Button>
                    </Group>
                    <MyoxusText typographySlot="body-small" tone="secondary">
                      {Number.isInteger(Number(customOffset)) &&
                      Number(customOffset) >= 0
                        ? formattedTrigger(Number(customOffset))
                        : ""}
                    </MyoxusText>
                  </Stack>
                </MenuSection>
              ) : null}
            </>
          )}
        </MenuPanel>
      }
    >
      {trigger}
    </Menu>
  );
}
