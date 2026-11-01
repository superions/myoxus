// SPDX-License-Identifier: AGPL-3.0-or-later
import { MemberSelectorInline } from "@myoxus/core/components/member-selector";
import { useRegionalPreferences } from "@myoxus/core/components/hooks/myoxus/use-user-preferences";
import {
  DatabaseFieldKind,
  TaskContentFindingKind,
  databaseSchemaQuery,
  type PreparedTaskMaintenanceFragmentFragment,
} from "@myoxus/graphql";
import { useI18n } from "@myoxus/i18n";
import { useFramework, useService } from "@myoxus/infra";
import { WorkbenchService } from "@myoxus/core/modules/workbench/services/workbench";
import { Button, Loading, MyoxusText, Notice, Stack } from "@myoxus/ui-facade";
import { useEffect, useState } from "react";
import { TaskRowReference } from "../database-block-adapter/task-row-reference";
import { formatDateOnly, formatDateTime } from "../model";
import { useTaskIdentity } from "../tasks/use-workspace-tasks";
import type { DatabaseField } from "../types";
import { formatRegionalDate } from "../../i18n";

type NativeValue =
  PreparedTaskMaintenanceFragmentFragment["proposal"]["patches"][number]["oldValue"];

function supportsPreview(field: DatabaseField | undefined, value: NativeValue) {
  if (!field) return false;
  if (!value) return true;
  switch (field.fieldType) {
    case DatabaseFieldKind.Date:
      return Boolean(value.date?.start);
    case DatabaseFieldKind.DateTime:
      return Boolean(value.dateTime?.start);
    case DatabaseFieldKind.Users:
      return Array.isArray(value.users);
    case DatabaseFieldKind.User:
      return typeof value.user === "string";
    default:
      return false;
  }
}

/** Labels are current authorized schema facts; values remain the frozen proposal.
 * No synthetic RowRecord is materialized to format a proposed Cell. */
export function TaskMaintenancePlan({
  plan,
  current,
  onReady,
}: {
  plan: PreparedTaskMaintenanceFragmentFragment;
  current: () => boolean;
  onReady?: (digest: string | undefined) => void;
}) {
  const t = useI18n();
  const regional = useRegionalPreferences();
  const owner = useTaskIdentity();
  const framework = useFramework();
  const workbench = useService(WorkbenchService).workbench;
  const openTask = (target: {
    workspaceId: string;
    databaseId: string;
    rowId: string;
  }) => {
    if (current() && target.workspaceId === owner.workspace.id)
      workbench.open(
        `/tasks?${new URLSearchParams({ databaseId: target.databaseId, rowId: target.rowId })}`,
        { at: "tail" },
      );
  };
  const [fields, setFields] = useState<DatabaseField[]>();
  const [failed, setFailed] = useState(false);
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    let active = true;
    if (!current()) return;
    setFields(undefined);
    setFailed(false);
    void owner
      .server!.gql({
        query: databaseSchemaQuery,
        variables: {
          workspaceId: owner.workspace.id,
          databaseId: plan.proposal.databaseId,
        },
      })
      .then(
        (response) => {
          if (!active || !current()) return;
          const record = response.workspace?.database;
          if (
            !record ||
            record.database.workspaceId !== owner.workspace.id ||
            record.database.id !== plan.proposal.databaseId
          ) {
            setFailed(true);
            return;
          }
          setFields(record.fields);
        },
        () => {
          if (active && current()) setFailed(true);
        },
      );
    return () => {
      active = false;
    };
  }, [
    owner.server,
    owner.workspace.id,
    plan.proposal.databaseId,
    plan.proposal,
    current,
    revision,
  ]);
  useEffect(() => {
    const ready =
      fields &&
      plan.proposal.patches.every(
        (patch) =>
          supportsPreview(
            fields.find((field) => field.id === patch.fieldId),
            patch.oldValue,
          ) &&
          supportsPreview(
            fields.find((field) => field.id === patch.fieldId),
            patch.clear ? null : patch.value,
          ),
      );
    onReady?.(ready ? plan.proposal.digest : undefined);
    return () => onReady?.(undefined);
  }, [fields, plan.proposal, onReady]);
  const unavailable = t["com.myoxus.database.row_detail.unavailable"]();
  const valueLabel = (field: DatabaseField | undefined, value: NativeValue) => {
    if (!value) return t["com.myoxus.database.cell.empty"]();
    if (!field) return unavailable;
    const date =
      field.fieldType === DatabaseFieldKind.Date ? value.date : undefined;
    if (date)
      return [date.start, date.end]
        .filter(Boolean)
        .map((value) => formatDateOnly(value, t.language, regional))
        .join(" – ");
    const dateTime =
      field.fieldType === DatabaseFieldKind.DateTime
        ? value.dateTime
        : undefined;
    if (dateTime) {
      try {
        return [dateTime.start, dateTime.end]
          .filter(Boolean)
          .map((value) =>
            dateTime.allDay
              ? formatRegionalDate(new Date(value!), {
                  ...regional,
                  timezone: dateTime.timeZone,
                })
              : formatDateTime(value, t.language, regional),
          )
          .join(" – ");
      } catch {
        return unavailable;
      }
    }
    if (field.fieldType === DatabaseFieldKind.Users && value.users)
      return (
        <MemberSelectorInline
          readonly
          selected={value.users}
          onChange={() => {}}
          placeholder={t["com.myoxus.database.cell.empty"]()}
        />
      );
    if (field.fieldType === DatabaseFieldKind.User && value.user)
      return (
        <MemberSelectorInline
          readonly
          selected={[value.user]}
          onChange={() => {}}
          placeholder={t["com.myoxus.database.cell.empty"]()}
        />
      );
    // Other opaque reference kinds have no admitted correction/display here.
    return unavailable;
  };
  const findings = {
    [TaskContentFindingKind.RequiredValueMissing]:
      t["com.myoxus.database.maintenance.required"](),
    [TaskContentFindingKind.DueBeforeStart]:
      t["com.myoxus.database.maintenance.due-before-start"](),
    [TaskContentFindingKind.ReferenceUnavailable]:
      t["com.myoxus.database.maintenance.reference-unavailable"](),
    [TaskContentFindingKind.AssignmentSuggestion]:
      t["com.myoxus.database.maintenance.assignment-suggestion"](),
  };
  return (
    <Stack>
      {failed ? (
        <Notice tone="warning">
          {unavailable}
          <Button onClick={() => setRevision((value) => value + 1)}>
            {t.Retry()}
          </Button>
        </Notice>
      ) : !fields ? (
        <Loading />
      ) : null}
      {plan.proposal.patches.length > 0 && !plan.executionAvailable ? (
        <Notice tone="warning">
          {t["com.myoxus.database.setup.status.unavailable"]()}
        </Notice>
      ) : null}
      {plan.proposal.findings.length === 0 ? (
        <MyoxusText>
          {t["com.myoxus.database.maintenance.no-findings"]()}
        </MyoxusText>
      ) : null}
      {plan.proposal.findings.map((finding, index) => (
        <Stack
          key={`${finding.task.rowId}:${finding.fieldId}:${finding.kind}:${index}`}
        >
          <TaskRowReference
            onOpen={openTask}
            framework={framework}
            target={{ workspaceId: owner.workspace.id, ...finding.task }}
          />
          <MyoxusText>
            {fields?.find((field) => field.id === finding.fieldId)?.name ??
              unavailable}
          </MyoxusText>
          <MyoxusText>{findings[finding.kind]}</MyoxusText>
        </Stack>
      ))}
      {plan.proposal.patches.length ? (
        plan.proposal.patches.map((patch) => {
          const field = fields?.find((field) => field.id === patch.fieldId);
          return (
            <Stack key={`${patch.rowId}:${patch.fieldId}`}>
              <TaskRowReference
                onOpen={openTask}
                framework={framework}
                target={{
                  workspaceId: owner.workspace.id,
                  databaseId: plan.proposal.databaseId,
                  rowId: patch.rowId,
                }}
              />
              <MyoxusText>{field?.name ?? unavailable}</MyoxusText>
              <Stack>
                <MyoxusText>
                  {t["com.myoxus.database.maintenance.before"]()}
                </MyoxusText>
                {valueLabel(field, patch.oldValue)}
              </Stack>
              <Stack>
                <MyoxusText>
                  {t["com.myoxus.database.maintenance.proposed"]()}
                </MyoxusText>
                {valueLabel(field, patch.clear ? null : patch.value)}
              </Stack>
            </Stack>
          );
        })
      ) : (
        <MyoxusText>
          {t["com.myoxus.database.maintenance.no-corrections"]()}
        </MyoxusText>
      )}
    </Stack>
  );
}
