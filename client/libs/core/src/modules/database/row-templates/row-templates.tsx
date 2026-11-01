// SPDX-License-Identifier: AGPL-3.0-or-later

import { useMutation } from "@myoxus/core/components/hooks/use-mutation";
import { MemberSelectorInline } from "@myoxus/core/components/member-selector";
import {
  createDatabaseRowTemplateMutation,
  DatabaseFieldKind,
  deleteDatabaseRowTemplateMutation,
  TemplateSuggestionSurface,
  updateDatabaseRowTemplateMutation,
} from "@myoxus/graphql";
import { managedTaskFields } from "../managed";
import {
  useDatabaseConflictController,
  type DatabaseConflictDetails,
} from "../presence/conflict-controller";
import { useI18n } from "@myoxus/i18n";
import {
  ArrowDownSmallIcon,
  ArrowUpSmallIcon,
  PlusIcon,
  TrashIcon,
} from "@myoxus/icons/react";
import {
  Accordion,
  AccordionControl,
  AccordionItem,
  AccordionPanel,
  Button,
  Checkbox,
  EmptyState,
  FormFieldset,
  FormRow,
  Group,
  IconButton,
  Input,
  LocalizedDateInput,
  LocalizedDateTimeInput,
  Modal,
  MultiSelect,
  MyoxusText,
  NumberInput,
  notify,
  Select,
  Stack,
  Switch,
  Textarea,
} from "@myoxus/ui-facade";
import {
  useCallback,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useService } from "@myoxus/infra";
import { WorkspaceServerService } from "@myoxus/core/modules/server/services/workspace-server";
import { WorkspaceService } from "@myoxus/core/modules/workspace";
import { useRegionalPreferences } from "@myoxus/core/components/hooks/myoxus/use-user-preferences";
import { useTaskIdentity } from "../tasks/use-workspace-tasks";
import { useTaskFreshness } from "../tasks/use-task-freshness";
import { useTaskRelationSummaries } from "../row-detail/task-children";
import { readTaskCandidatePages } from "../relation/task-candidates";
import {
  taskParentErrorReason,
  taskParentReason,
} from "../relation/task-parent-reason";
import { taskBlockedByReason } from "../relation/task-blocked-by-reason";

import { TemplateListMenu } from "../../template-doc/view/template-list-menu";
import { isClearedCellValue, stringArrayCellValue } from "../cells";
import { DATABASE_CURRENCY_OPTIONS, type I18nShape } from "../field-settings";
import {
  createCellValueInput,
  formatDateOnly,
  formatDateTime,
  formatCurrencyValue,
  formatDurationValue,
  getFieldById,
  getSelectOptions,
  isDatabaseProjectionField,
  normalizeDatabaseCurrencyCellValue,
  normalizeDatabaseDurationCellValue,
  sortByPosition,
} from "../model";
import { formatRegionalDate, type RegionalFormatPreferences } from "../../i18n";
import type { DatabaseChangeHandler } from "../shared";
import type {
  DatabaseField,
  DatabaseRecord,
  DatabaseRowRecord,
  DatabaseRowTemplateBinding,
} from "../types";

export type DatabaseRowTemplateCell =
  DatabaseRowTemplateBinding["rowTemplate"]["initialCellValues"][number];

type RowTemplateContentPreview = { fieldId: string; value: unknown };

function rowTemplateConflictState(
  details: DatabaseConflictDetails,
  databaseId: string,
  rowTemplateId: string,
) {
  try {
    const value: unknown = JSON.parse(details.latestStateJson ?? "null");
    return value &&
      typeof value === "object" &&
      "kind" in value &&
      value.kind === "rowTemplate" &&
      "databaseId" in value &&
      value.databaseId === databaseId &&
      "rowTemplateId" in value &&
      value.rowTemplateId === rowTemplateId
      ? value
      : null;
  } catch {
    return null;
  }
}

/** Use the same native option labels as Cell controls, never transport IDs. */
function rowTemplatePreviewValue(
  field: DatabaseField | undefined,
  value: unknown,
  rows: DatabaseRowRecord[],
  t: I18nShape,
  regionalPreferences: RegionalFormatPreferences,
): string {
  const unavailable = t["com.myoxus.template-list.unavailable"]();
  if (!field) return unavailable;
  if (
    value == null ||
    value === "" ||
    (Array.isArray(value) && value.length === 0)
  )
    return t["com.myoxus.database.cell.empty"]();
  if (
    [
      DatabaseFieldKind.Select,
      DatabaseFieldKind.Status,
      DatabaseFieldKind.MultiSelect,
    ].includes(field.fieldType)
  ) {
    const ids = Array.isArray(value) ? value : [value];
    return ids
      .map((id) =>
        typeof id === "string"
          ? (getSelectOptions(field).find((option) => option.id === id)?.name ??
            unavailable)
          : unavailable,
      )
      .join(", ");
  }
  if (field.fieldType === DatabaseFieldKind.Relation) {
    return Array.isArray(value)
      ? value
          .map(
            (id) =>
              rows.find((row) => row.row.id === id)?.row.title ?? unavailable,
          )
          .join(", ")
      : unavailable;
  }
  if (
    [
      DatabaseFieldKind.Text,
      DatabaseFieldKind.Url,
      DatabaseFieldKind.Email,
      DatabaseFieldKind.Phone,
    ].includes(field.fieldType)
  )
    return typeof value === "string" ? value : unavailable;
  if (
    [DatabaseFieldKind.Number, DatabaseFieldKind.Percent].includes(
      field.fieldType,
    )
  )
    return typeof value === "number" && Number.isFinite(value)
      ? new Intl.NumberFormat(t.language).format(value) +
          (field.fieldType === DatabaseFieldKind.Percent ? "%" : "")
      : unavailable;
  if (field.fieldType === DatabaseFieldKind.Checkbox)
    return typeof value === "boolean"
      ? value
        ? t["com.myoxus.database.formula.boolean.true"]()
        : t["com.myoxus.database.cell.empty"]()
      : unavailable;
  if (field.fieldType === DatabaseFieldKind.Currency)
    return formatCurrencyValue(value, field, t.language) || unavailable;
  if (field.fieldType === DatabaseFieldKind.Duration)
    return formatDurationValue(value, field, t.language) || unavailable;
  if (
    field.fieldType === DatabaseFieldKind.Date ||
    field.fieldType === DatabaseFieldKind.DateTime
  ) {
    const start =
      typeof value === "string"
        ? value
        : value && typeof value === "object" && "start" in value
          ? value.start
          : null;
    if (typeof start !== "string" || Number.isNaN(new Date(start).getTime()))
      return unavailable;
    if (field.fieldType === DatabaseFieldKind.Date)
      return formatDateOnly(start, t.language, regionalPreferences);
    if (
      value &&
      typeof value === "object" &&
      "allDay" in value &&
      value.allDay === true
    ) {
      if (!("timeZone" in value) || typeof value.timeZone !== "string")
        return unavailable;
      // All-day cells display the calendar date in their native stored zone.
      try {
        return formatRegionalDate(new Date(start), {
          ...regionalPreferences,
          timezone: value.timeZone,
        });
      } catch {
        return unavailable;
      }
    }
    return formatDateTime(start, t.language, regionalPreferences);
  }
  // No authorized display resolver is available here for people/documents/tags
  // or opaque complex values. Do not expose their UUIDs as a readable value.
  return unavailable;
}

function boundedRowTemplatePreview(value: string): string {
  return value.length > 256 ? `${value.slice(0, 256)}…` : value;
}

function rowTemplateFieldPreview(
  field: DatabaseField | undefined,
  value: unknown,
  rows: DatabaseRowRecord[],
  t: I18nShape,
  regionalPreferences: RegionalFormatPreferences,
) {
  return boundedRowTemplatePreview(
    field
      ? `${field.name}: ${rowTemplatePreviewValue(field, value, rows, t, regionalPreferences)}`
      : t["com.myoxus.template-list.unavailable"](),
  );
}

export function rowTemplateStatusLabel(
  t: I18nShape,
  binding: DatabaseRowTemplateBinding,
) {
  if (binding.disabled) {
    return t["com.myoxus.database.rowTemplate.status.disabled"]();
  }
  if (binding.archived) {
    return t["com.myoxus.database.rowTemplate.status.archived"]();
  }
  if (binding.detached) {
    return t["com.myoxus.database.rowTemplate.status.detached"]();
  }
  if (binding.reconcileRequired) {
    return t["com.myoxus.database.rowTemplate.status.reconcile-required"]();
  }
  return t["com.myoxus.database.rowTemplate.status.available"]();
}

export function rowTemplateCellPrimitive(
  cell: DatabaseRowTemplateCell | undefined,
) {
  const value = cell?.value;
  if (!value) return undefined;
  switch (cell.fieldType) {
    case DatabaseFieldKind.Checkbox:
      return Boolean(value.checkbox);
    case DatabaseFieldKind.Date:
      return typeof value.date?.start === "string"
        ? value.date.start
        : value.date?.start
          ? String(value.date.start)
          : undefined;
    case DatabaseFieldKind.DateTime:
      return typeof value.dateTime?.start === "string"
        ? value.dateTime.start
        : value.dateTime?.start
          ? String(value.dateTime.start)
          : undefined;
    case DatabaseFieldKind.Files:
      return value.files?.files ?? [];
    case DatabaseFieldKind.MultiSelect:
      return value.multiSelect ?? [];
    case DatabaseFieldKind.Tags:
      return value.tags ?? [];
    case DatabaseFieldKind.Number:
      return typeof value.number === "number" ? value.number : undefined;
    case DatabaseFieldKind.Percent:
      return typeof value.percent === "number" ? value.percent : undefined;
    case DatabaseFieldKind.Currency:
      return value.currency ?? undefined;
    case DatabaseFieldKind.Duration:
      return value.duration ?? undefined;
    case DatabaseFieldKind.Relation:
      return value.relation ?? [];
    case DatabaseFieldKind.Select:
      return value.select ?? "";
    case DatabaseFieldKind.Status:
      return value.status ?? "";
    case DatabaseFieldKind.Text:
      return value.text ?? "";
    case DatabaseFieldKind.Url:
      return value.url ?? "";
    case DatabaseFieldKind.Email:
      return value.email ?? "";
    case DatabaseFieldKind.Phone:
      return value.phone ?? "";
    case DatabaseFieldKind.User:
      return value.user ?? "";
    case DatabaseFieldKind.Users:
      return value.users ?? [];
    default:
      return undefined;
  }
}

export function rowTemplateInitialCellInputs(
  record: DatabaseRecord,
  binding: DatabaseRowTemplateBinding,
  field: DatabaseField,
  nextValue: unknown,
) {
  const valuesByFieldId = new Map<string, unknown>(
    binding.rowTemplate.initialCellValues
      .map((cell) => [cell.fieldId, rowTemplateCellPrimitive(cell)] as const)
      .filter(([, value]) => value !== undefined),
  );
  if (isClearedCellValue(field, nextValue)) {
    valuesByFieldId.delete(field.id);
  } else {
    valuesByFieldId.set(field.id, nextValue);
  }
  return [...valuesByFieldId.entries()]
    .map(([fieldId, value]) => {
      const targetField = getFieldById(record, fieldId);
      if (
        !targetField ||
        targetField.fieldType === DatabaseFieldKind.Title ||
        targetField.fieldType === DatabaseFieldKind.Rollup ||
        targetField.fieldType === DatabaseFieldKind.Formula ||
        isDatabaseProjectionField(targetField.fieldType)
      ) {
        return null;
      }
      return {
        fieldId,
        value: createCellValueInput(targetField, value),
      };
    })
    .filter(
      (
        input,
      ): input is {
        fieldId: string;
        value: ReturnType<typeof createCellValueInput>;
      } => Boolean(input),
    );
}

function TemplateTaskRelation(props: {
  roleKey: "task.parent" | "task.blockedBy";
  record: DatabaseRecord;
  binding: DatabaseRowTemplateBinding;
  field: DatabaseField;
  onUpdate: (
    id: string,
    input: {
      initialCellValues: ReturnType<typeof rowTemplateInitialCellInputs>;
    },
    reloadDraft?: () => void,
    preview?: RowTemplateContentPreview,
  ) => Promise<void>;
}) {
  const owner = useTaskIdentity();
  return owner.identity &&
    owner.workspace.id === props.record.database.workspaceId ? (
    <TemplateTaskRelationSession
      key={JSON.stringify([
        owner.identity,
        props.record.database.id,
        props.binding.rowTemplate.id,
        props.field.id,
        props.roleKey,
      ])}
      {...props}
    />
  ) : null;
}

function TemplateTaskRelationSession({
  roleKey,
  record,
  binding,
  field,
  onUpdate,
}: Parameters<typeof TemplateTaskRelation>[0]) {
  const t = useI18n();
  const owner = useTaskIdentity();
  const servers = useService(WorkspaceServerService);
  const workspace = useService(WorkspaceService);
  const timeZone = useRegionalPreferences().timezone;
  const reasonMessage =
    roleKey === "task.blockedBy" ? taskBlockedByReason : taskParentReason;
  const relation = field.config.relation;
  const admissible = managedTaskFields(record)?.get(roleKey)?.id === field.id;
  const canonical = useMemo(
    () =>
      stringArrayCellValue(
        rowTemplateCellPrimitive(
          binding.rowTemplate.initialCellValues.find(
            (cell) => cell.fieldId === field.id,
          ),
        ),
      ),
    [binding.rowTemplate.initialCellValues, field.id],
  );
  const [draft, setDraft] = useState(canonical);
  const [dirty, setDirty] = useState(false);
  const [failure, setFailure] = useState<unknown>();
  const [busy, setBusy] = useState(false);
  const [opened, setOpened] = useState(false);
  const [search, setSearch] = useState("");
  const deferredSearch = useDeferredValue(search);
  const [options, setOptions] = useState<{ value: string; label: string }[]>(
    [],
  );
  const [chosen, setChosen] = useState<{ value: string; label: string }[]>([]);
  const [cursors, setCursors] = useState<(string | null)[]>([null, null]);
  const [loading, setLoading] = useState(false);
  const [readFailed, setReadFailed] = useState(false);
  const alive = useRef(true);
  const pending = useRef<AbortController | undefined>(undefined);
  const visible = useRef(false);
  const writing = useRef(false);
  const reading = useRef(false);
  const isCurrent = useCallback(() => {
    const server = servers.server$.value;
    return (
      alive.current &&
      Boolean(server) &&
      JSON.stringify([
        server?.id,
        server?.baseUrl,
        server?.account$.value?.id,
        workspace.workspace.id,
      ]) === owner.identity
    );
  }, [servers, workspace, owner.identity]);
  const close = useCallback(() => {
    visible.current = false;
    setOpened(false);
    pending.current?.abort();
  }, []);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      pending.current?.abort();
    };
  }, []);
  // Canonical delivery may refresh other template fields while a rejected or
  // uncertain selection remains an explicit local draft; never auto-save it.
  const canonicalKey = JSON.stringify(canonical);
  const [summaryRevision, setSummaryRevision] = useState(0);
  const refreshSummaries = useCallback(async () => {
    if (isCurrent()) setSummaryRevision((previous) => previous + 1);
  }, [isCurrent]);
  useTaskFreshness(owner, refreshSummaries);
  const selectedRead = useTaskRelationSummaries(
    record,
    canonical,
    JSON.stringify([
      canonicalKey,
      binding.rowTemplate.updatedAt,
      summaryRevision,
    ]),
    isCurrent,
  );
  useEffect(() => {
    if (!dirty && canonicalKey !== JSON.stringify(draft)) setDraft(canonical);
    else if (canonicalKey === JSON.stringify(draft)) setDirty(false);
  }, [canonical, canonicalKey, dirty, draft]);
  const gql = owner.server?.gql;
  const load = useCallback(
    async (after?: (string | null)[]) => {
      if (
        !gql ||
        !admissible ||
        !isCurrent() ||
        !visible.current ||
        writing.current ||
        (after && reading.current)
      )
        return;
      pending.current?.abort();
      const controller = new AbortController();
      pending.current = controller;
      reading.current = true;
      setLoading(true);
      setReadFailed(false);
      if (!after) {
        setOptions([]);
        setCursors([null, null]);
      }
      try {
        const pages = await readTaskCandidatePages({
          gql,
          workspaceId: record.database.workspaceId,
          databaseId: record.database.id,
          search: deferredSearch,
          timeZone,
          after,
          signal: AbortSignal.any([
            controller.signal,
            AbortSignal.timeout(15000),
          ]),
        });
        if (!isCurrent() || controller.signal.aborted || !visible.current)
          return;
        const incoming = pages
          .flatMap((page) => page?.rows ?? [])
          .filter(
            (task) =>
              task.databaseId === record.database.id &&
              task.workspaceId === record.database.workspaceId,
          )
          .map((task) => ({ value: task.rowId, label: task.title }));
        setOptions((previous) => [
          ...new Map(
            [...(after ? previous : []), ...incoming].map((option) => [
              option.value,
              option,
            ]),
          ).values(),
        ]);
        setCursors(pages.map((page) => page?.nextCursor ?? null));
      } catch {
        if (isCurrent() && !controller.signal.aborted && visible.current) {
          setOptions([]);
          setReadFailed(true);
        }
      } finally {
        if (isCurrent() && pending.current === controller) {
          reading.current = false;
          setLoading(false);
        }
      }
    },
    [
      gql,
      isCurrent,
      record.database.workspaceId,
      record.database.id,
      deferredSearch,
      timeZone,
      admissible,
    ],
  );
  useEffect(() => {
    if (!admissible) {
      close();
      setOptions([]);
      setReadFailed(false);
    }
  }, [admissible, close]);
  useEffect(() => {
    if (opened) void load();
    return () => pending.current?.abort();
  }, [opened, load]);
  const data = [
    ...new Map(
      [
        ...options,
        ...canonical.map((id) => ({
          value: id,
          label:
            selectedRead.summaries.find((task) => task.rowId === id)?.title ??
            (selectedRead.loading
              ? t["com.myoxus.database.relation.loading"]()
              : t["com.myoxus.template-list.unavailable"]()),
        })),
        ...(dirty
          ? chosen.filter((option) => !canonical.includes(option.value))
          : []),
        ...draft
          .filter(
            (id) =>
              !canonical.includes(id) &&
              !options.some((option) => option.value === id) &&
              !(dirty && chosen.some((option) => option.value === id)),
          )
          .map((id) => ({
            value: id,
            label: t["com.myoxus.template-list.unavailable"](),
          })),
      ].map((option) => [option.value, option]),
    ).values(),
  ];
  const save = async (next: string[]) => {
    if (
      !isCurrent() ||
      writing.current ||
      (!admissible && next.some((id) => !canonical.includes(id)))
    )
      return;
    writing.current = true;
    close();
    setChosen(data.filter((option) => next.includes(option.value)));
    setDraft(next);
    setDirty(true);
    setBusy(true);
    setFailure(undefined);
    try {
      await onUpdate(
        binding.rowTemplate.id,
        {
          initialCellValues: rowTemplateInitialCellInputs(
            record,
            binding,
            field,
            next,
          ),
        },
        () => setDirty(false),
        { fieldId: field.id, value: next },
      );
      // A successful ACK does not prove that the host has delivered the new
      // template props. Only matching canonical values release this draft.
    } catch (error) {
      if (isCurrent()) setFailure(error);
    } finally {
      writing.current = false;
      if (isCurrent()) setBusy(false);
    }
  };
  // One pill represents each endpoint; raw duplicate IDs remain retained until
  // the user explicitly removes that endpoint, rather than being auto-repaired.
  const selectedValues =
    roleKey === "task.blockedBy" ? [...new Set(draft)] : draft;
  return (
    <Stack>
      <MultiSelect
        aria-label={field.name}
        data={
          admissible
            ? data
            : data.filter((option) => draft.includes(option.value))
        }
        value={selectedValues}
        onChange={(next) =>
          void save(
            roleKey === "task.blockedBy"
              ? [
                  ...draft.filter((id) => next.includes(id)),
                  ...next.filter((id) => !draft.includes(id)),
                ]
              : next,
          )
        }
        maxValues={
          roleKey === "task.parent" || relation?.allowMultiple === false
            ? 1
            : (relation?.maxTargets ?? undefined)
        }
        readOnly={busy}
        clearable
        searchable
        block
        searchValue={search}
        onSearchChange={setSearch}
        filter={({ options }) => options}
        dropdownOpened={opened}
        onDropdownClose={close}
        onDropdownOpen={() => {
          if (!isCurrent() || writing.current || !admissible) return;
          void refreshSummaries();
          setOptions([]);
          setCursors([null, null]);
          setLoading(true);
          setReadFailed(false);
          visible.current = true;
          setOpened(true);
        }}
        scrollAreaProps={{
          onBottomReached: () => {
            if (cursors.some(Boolean)) void load(cursors);
          },
        }}
        placeholder={t["com.myoxus.database.cell.empty"]()}
        nothingFoundMessage={
          loading
            ? t["com.myoxus.database.relation.loading"]()
            : readFailed
              ? t["com.myoxus.common.operation-failed"]()
              : t["com.myoxus.database.relation.empty"]()
        }
      />
      {!admissible ? (
        <MyoxusText tone="secondary">
          {reasonMessage(t, "IncompatibleRoleConfiguration")}
        </MyoxusText>
      ) : null}
      {failure ? (
        <MyoxusText tone="danger">
          {reasonMessage(t, taskParentErrorReason(failure))}
        </MyoxusText>
      ) : null}
      {failure || readFailed ? (
        <Button
          disabled={
            busy || (!admissible && draft.some((id) => !canonical.includes(id)))
          }
          onClick={() => {
            if (!isCurrent()) return;
            if (failure) void save(draft);
            else if (visible.current) void load();
            else {
              visible.current = true;
              setOpened(true);
            }
          }}
        >
          {t.Retry()}
        </Button>
      ) : null}
    </Stack>
  );
}

export function RowTemplateInitialCellEditor({
  binding,
  field,
  onUpdate,
  onWriteError,
  record,
  rows,
}: {
  binding: DatabaseRowTemplateBinding;
  field: DatabaseField;
  onUpdate: (
    rowTemplateId: string,
    input: {
      initialCellValues: ReturnType<typeof rowTemplateInitialCellInputs>;
    },
    reloadDraft?: () => void,
    preview?: RowTemplateContentPreview,
  ) => Promise<void>;
  onWriteError: (error: unknown) => void;
  record: DatabaseRecord;
  rows: DatabaseRowRecord[];
}) {
  const t = useI18n();
  const cell = binding.rowTemplate.initialCellValues.find(
    (value) => value.fieldId === field.id,
  );
  const canonical = rowTemplateCellPrimitive(cell);
  const [draft, setDraft] = useState<unknown>(canonical);
  const [dirty, setDirty] = useState(false);
  useEffect(() => {
    if (!dirty || JSON.stringify(draft) === JSON.stringify(canonical)) {
      setDraft(canonical);
      setDirty(false);
    }
  }, [canonical, dirty, draft]);
  const primitiveValue = dirty ? draft : canonical;
  const save = (value: unknown) => {
    setDraft(value);
    setDirty(true);
    return onUpdate(
      binding.rowTemplate.id,
      {
        initialCellValues: rowTemplateInitialCellInputs(
          record,
          binding,
          field,
          value,
        ),
      },
      () => setDirty(false),
      { fieldId: field.id, value },
    ).catch(onWriteError);
  };

  const bindings =
    binding.rowTemplate.rowKind === "task" ? managedTaskFields(record) : null;
  const roleKey =
    bindings?.get("task.parent")?.id === field.id
      ? "task.parent"
      : bindings?.get("task.blockedBy")?.id === field.id
        ? "task.blockedBy"
        : null;
  if (roleKey)
    return (
      <TemplateTaskRelation
        roleKey={roleKey}
        record={record}
        binding={binding}
        field={field}
        onUpdate={onUpdate}
      />
    );

  switch (field.fieldType) {
    case DatabaseFieldKind.Checkbox:
      return (
        <Checkbox
          checked={Boolean(primitiveValue)}
          aria-label={field.name}
          onChange={(_, checked) => void save(checked)}
        />
      );
    case DatabaseFieldKind.Date:
      return (
        <LocalizedDateInput
          value={typeof primitiveValue === "string" ? primitiveValue : null}
          locale={t.language}
          aria-label={field.name}
          allowDeselect
          clearable
          placeholder={t["com.myoxus.database.cell.empty"]()}
          onChange={(value) => void save(value ?? "")}
          data-myoxus-ui-role="database-row-template-date-cell"
        />
      );
    case DatabaseFieldKind.DateTime:
      return (
        <LocalizedDateTimeInput
          value={typeof primitiveValue === "string" ? primitiveValue : null}
          locale={t.language}
          clearable
          placeholder={t["com.myoxus.database.cell.empty"]()}
          onChange={(value) => void save(value ?? "")}
          data-myoxus-ui-role="database-row-template-datetime-cell"
        />
      );
    case DatabaseFieldKind.Files: {
      const filesTemplateValue = Array.isArray(primitiveValue)
        ? primitiveValue
            .map((file) =>
              typeof file === "object" && file !== null && "blobKey" in file
                ? String(file.blobKey)
                : String(file),
            )
            .join("\n")
        : "";
      return (
        <Textarea
          value={
            typeof primitiveValue === "string"
              ? primitiveValue
              : filesTemplateValue
          }
          onChange={(value) => {
            setDraft(value);
            setDirty(true);
          }}
          aria-label={field.name}
          autosize
          minRows={1}
          placeholder={t["com.myoxus.database.cell.empty"]()}
          onBlur={(event) => void save(event.currentTarget.value)}
          data-myoxus-ui-role="database-row-template-files-cell"
        />
      );
    }
    case DatabaseFieldKind.MultiSelect:
      return (
        <MultiSelect
          data={getSelectOptions(field).map((option) => ({
            value: option.id,
            label: option.name,
          }))}
          value={stringArrayCellValue(primitiveValue)}
          onChange={(value) => void save(value)}
          placeholder={t["com.myoxus.database.cell.empty"]()}
          clearable
          block
        />
      );
    case DatabaseFieldKind.Number:
    case DatabaseFieldKind.Percent:
    case DatabaseFieldKind.Currency:
    case DatabaseFieldKind.Duration:
      if (field.fieldType === DatabaseFieldKind.Currency) {
        const currencyValue = normalizeDatabaseCurrencyCellValue(
          primitiveValue,
          field,
        );
        const currencyCode =
          currencyValue?.currencyCode ??
          field.config.currency?.defaultCurrency ??
          "EUR";
        const amountInput = (
          <NumberInput
            value={currencyValue?.amount}
            onChange={(amount) => void save({ amount, currencyCode })}
            min={field.config.currency?.minValue ?? undefined}
            max={field.config.currency?.maxValue ?? undefined}
            suffix={
              field.config.currency?.allowCurrencyOverride
                ? undefined
                : ` ${currencyCode}`
            }
            aria-label={field.name}
          />
        );

        if (!field.config.currency?.allowCurrencyOverride) {
          return amountInput;
        }

        return (
          <Group gap="xs" wrap="nowrap">
            {amountInput}
            <Select
              data={DATABASE_CURRENCY_OPTIONS.map((currency) => ({
                value: currency,
                label: currency,
              }))}
              value={currencyCode}
              onChange={(nextCurrency) =>
                void save({
                  amount: currencyValue?.amount ?? 0,
                  currencyCode: nextCurrency ?? currencyCode,
                })
              }
              aria-label={t["com.myoxus.database.field.currency-code"]()}
            />
          </Group>
        );
      }

      if (field.fieldType === DatabaseFieldKind.Duration) {
        const durationValue =
          normalizeDatabaseDurationCellValue(primitiveValue);
        return (
          <NumberInput
            value={durationValue?.minutes}
            onChange={(minutes) => void save({ minutes })}
            min={field.config.duration?.minMinutes ?? undefined}
            max={field.config.duration?.maxMinutes ?? undefined}
            suffix=" min"
            aria-label={field.name}
          />
        );
      }

      return (
        <NumberInput
          value={
            typeof primitiveValue === "number" ? primitiveValue : undefined
          }
          onChange={(value) => void save(value)}
          min={field.config.percent?.minValue ?? undefined}
          max={field.config.percent?.maxValue ?? undefined}
          suffix={
            field.fieldType === DatabaseFieldKind.Percent ? "%" : undefined
          }
          aria-label={field.name}
        />
      );
    case DatabaseFieldKind.Relation:
      return (
        <MultiSelect
          data={rows.map((row) => ({
            value: row.row.id,
            label: row.row.title,
          }))}
          value={stringArrayCellValue(primitiveValue)}
          onChange={(value) => void save(value)}
          placeholder={t["com.myoxus.database.cell.empty"]()}
          clearable
          block
        />
      );
    case DatabaseFieldKind.Select:
    case DatabaseFieldKind.Status:
      return (
        <Select
          data={getSelectOptions(field).map((option) => ({
            value: option.id,
            label: option.name,
          }))}
          value={typeof primitiveValue === "string" ? primitiveValue : ""}
          onChange={(value) => void save(value ?? "")}
          onClear={() => void save("")}
          placeholder={t["com.myoxus.database.cell.empty"]()}
          clearable
          block
        />
      );
    case DatabaseFieldKind.Text:
    case DatabaseFieldKind.Url:
    case DatabaseFieldKind.Email:
    case DatabaseFieldKind.Phone:
      return (
        <Input
          value={typeof primitiveValue === "string" ? primitiveValue : ""}
          onChange={(value) => void save(value)}
          placeholder={t["com.myoxus.database.cell.empty"]()}
          block
        />
      );
    case DatabaseFieldKind.User:
      return (
        <MemberSelectorInline
          selected={
            typeof primitiveValue === "string" && primitiveValue
              ? [primitiveValue]
              : []
          }
          placeholder={t["com.myoxus.database.cell.empty"]()}
          onChange={(selected) => void save(selected.at(-1) ?? "")}
        />
      );
    case DatabaseFieldKind.Users:
      return (
        <MemberSelectorInline
          selected={stringArrayCellValue(primitiveValue)}
          placeholder={t["com.myoxus.database.cell.empty"]()}
          onChange={(selected) => void save(selected)}
        />
      );
    default:
      return null;
  }
}

export function RowTemplateManagementPanel({
  canEdit = true,
  databaseId,
  onChanged,
  record,
  rowTemplates,
  rows,
}: {
  canEdit?: boolean;
  databaseId: string;
  onChanged: DatabaseChangeHandler;
  record: DatabaseRecord;
  rowTemplates: DatabaseRowTemplateBinding[];
  rows: DatabaseRowRecord[];
}) {
  const t = useI18n();
  const regionalPreferences = useRegionalPreferences();
  const conflicts = useDatabaseConflictController();
  const owner = useTaskIdentity();
  const servers = useService(WorkspaceServerService);
  const workspace = useService(WorkspaceService);
  const canEditRef = useRef(canEdit);
  // A retired request may finish after a new owner starts writing. It may
  // release only its own slot, never that new owner's pending operation.
  const writing = useRef<object | null>(null);
  const [busy, setBusy] = useState(false);
  const scope = JSON.stringify([owner.identity, databaseId, "row-templates"]);
  // A retired account/database owner stays retired even after returning to it.
  const lifetime = useMemo(() => ({ scope, active: true }), [scope]);
  const isCurrent = useCallback(() => {
    const server = servers.server$.value;
    return (
      lifetime.active &&
      canEditRef.current &&
      Boolean(owner.identity) &&
      JSON.stringify([
        server?.id,
        server?.baseUrl,
        server?.account$.value?.id,
        workspace.workspace.id,
      ]) === owner.identity
    );
  }, [lifetime, owner.identity, servers, workspace]);
  useEffect(() => {
    lifetime.active = true;
    writing.current = null;
    setBusy(false);
    return () => {
      lifetime.active = false;
      conflicts.dismiss?.(scope);
    };
  }, [conflicts.dismiss, lifetime, scope]);
  useEffect(() => {
    canEditRef.current = canEdit;
    if (!canEdit) conflicts.dismiss?.(scope);
  }, [canEdit, conflicts.dismiss, scope]);
  const createRowTemplate = useMutation(
    {
      mutation: createDatabaseRowTemplateMutation,
    },
    { suppressErrorNotification: true },
  );
  const updateRowTemplate = useMutation(
    {
      mutation: updateDatabaseRowTemplateMutation,
    },
    { suppressErrorNotification: true },
  );
  const deleteRowTemplate = useMutation(
    {
      mutation: deleteDatabaseRowTemplateMutation,
    },
    { suppressErrorNotification: true },
  );

  // Void events own generic failures; Relation editors keep their explicit
  // failure/retry state through the rejecting onUpdate promise instead.
  const reportWriteFailure = useCallback(() => {
    if (!isCurrent()) return;
    notify.error({
      title: t["com.myoxus.database.rowTemplate.manage"](),
      message: t["com.myoxus.common.operation-failed"](),
    });
  }, [isCurrent, t]);

  const bindTemplate = useCallback(
    async (item: { templateId: string; title: string }) => {
      if (!isCurrent() || writing.current) return;
      const write = {};
      writing.current = write;
      setBusy(true);
      try {
        await createRowTemplate.trigger({
          input: {
            databaseId,
            templateId: item.templateId,
            name: item.title,
            enabled: true,
            isDefault: rowTemplates.length === 0,
          },
        });
        if (isCurrent()) await onChanged({ kind: "row_template_created" });
      } finally {
        if (writing.current === write) {
          writing.current = null;
          if (isCurrent()) setBusy(false);
        }
      }
    },
    [isCurrent, createRowTemplate, databaseId, onChanged, rowTemplates.length],
  );

  const updateTemplate = useCallback(
    async (
      rowTemplateId: string,
      input: {
        enabled?: boolean;
        initialCellValues?: ReturnType<typeof rowTemplateInitialCellInputs>;
        isDefault?: boolean;
      },
      reloadDraft?: () => void,
      preview?: RowTemplateContentPreview,
    ) => {
      const binding = rowTemplates.find(
        (binding) => binding.rowTemplate.id === rowTemplateId,
      );
      if (!binding || !isCurrent() || writing.current) return;
      const write = {};
      writing.current = write;
      setBusy(true);
      try {
        await conflicts.execute({
          scope,
          canOverwrite: isCurrent,
          allowOverwrite: false,
          attemptedAction: preview
            ? `${binding.rowTemplate.name} · ${getFieldById(record, preview.fieldId)?.name ?? t["com.myoxus.template-list.unavailable"]()}`
            : binding.rowTemplate.name,
          localValue: preview
            ? rowTemplateFieldPreview(
                getFieldById(record, preview.fieldId),
                preview.value,
                rows,
                t,
                regionalPreferences,
              )
            : input.enabled !== undefined
              ? input.enabled
                ? t["com.myoxus.database.rowTemplate.enabled"]()
                : t["com.myoxus.database.rowTemplate.status.disabled"]()
              : t["com.myoxus.database.rowTemplate.default"](),
          readServerValue: async (details) => {
            const state = rowTemplateConflictState(
              details,
              databaseId,
              rowTemplateId,
            );
            if (!state) return null;
            if (!preview) {
              if (input.enabled !== undefined)
                return "enabled" in state && typeof state.enabled === "boolean"
                  ? state.enabled
                    ? t["com.myoxus.database.rowTemplate.enabled"]()
                    : t["com.myoxus.database.rowTemplate.status.disabled"]()
                  : null;
              return "isDefault" in state &&
                typeof state.isDefault === "boolean"
                ? state.isDefault
                  ? t["com.myoxus.database.rowTemplate.default"]()
                  : t["com.myoxus.database.rowTemplate.set-default"]()
                : null;
            }
            const field = getFieldById(record, preview.fieldId);
            if (
              !field ||
              !("initialCellValues" in state) ||
              !state.initialCellValues ||
              typeof state.initialCellValues !== "object" ||
              Array.isArray(state.initialCellValues)
            )
              return null;
            const values = state.initialCellValues;
            if (!(preview.fieldId in values))
              return rowTemplateFieldPreview(
                field,
                null,
                rows,
                t,
                regionalPreferences,
              );
            const cell: unknown = Reflect.get(values, preview.fieldId);
            if (
              !cell ||
              typeof cell !== "object" ||
              !("kind" in cell) ||
              !("value" in cell)
            )
              return null;
            const nativeKind = field.fieldType
              .replace(/([a-z])([A-Z])/g, "$1_$2")
              .toLowerCase();
            if (cell.kind !== nativeKind) return null;
            return rowTemplateFieldPreview(
              field,
              cell.value,
              rows,
              t,
              regionalPreferences,
            );
          },
          mutate: () =>
            updateRowTemplate.trigger({
              input: {
                rowTemplateId,
                expectedEditRevision: binding.rowTemplate.editRevision,
                ...input,
              },
            }),
          reloadLatest: async () => {
            if (!isCurrent()) return;
            await onChanged({ kind: "row_template_updated" });
            if (isCurrent()) reloadDraft?.();
          },
          afterSuccess: async () => {
            if (isCurrent()) await onChanged({ kind: "row_template_updated" });
          },
        });
      } finally {
        if (writing.current === write) {
          writing.current = null;
          if (isCurrent()) setBusy(false);
        }
      }
    },
    [
      conflicts,
      databaseId,
      isCurrent,
      onChanged,
      record,
      regionalPreferences,
      rows,
      rowTemplates,
      scope,
      t,
      updateRowTemplate,
    ],
  );

  const deleteTemplate = useCallback(
    async (rowTemplateId: string) => {
      const binding = rowTemplates.find(
        (binding) => binding.rowTemplate.id === rowTemplateId,
      );
      if (!binding || !isCurrent() || writing.current) return;
      const write = {};
      writing.current = write;
      setBusy(true);
      try {
        await conflicts.execute({
          scope,
          canOverwrite: isCurrent,
          allowOverwrite: false,
          attemptedAction: t["com.myoxus.database.rowTemplate.delete"](),
          localValue: binding.rowTemplate.name,
          readServerValue: async (details) => {
            const state = rowTemplateConflictState(
              details,
              databaseId,
              rowTemplateId,
            );
            return state && "name" in state && typeof state.name === "string"
              ? boundedRowTemplatePreview(state.name)
              : null;
          },
          mutate: () =>
            deleteRowTemplate.trigger({
              input: {
                rowTemplateId,
                expectedEditRevision: binding.rowTemplate.editRevision,
              },
            }),
          reloadLatest: async () => {
            if (isCurrent()) await onChanged({ kind: "row_template_updated" });
          },
          afterSuccess: async () => {
            if (isCurrent()) await onChanged({ kind: "row_template_deleted" });
          },
        });
      } finally {
        if (writing.current === write) {
          writing.current = null;
          if (isCurrent()) setBusy(false);
        }
      }
    },
    [
      conflicts,
      deleteRowTemplate,
      databaseId,
      isCurrent,
      onChanged,
      rowTemplates,
      scope,
      t,
    ],
  );

  const orderedBindings = sortByPosition(
    rowTemplates.map((binding) => binding.rowTemplate),
  )
    .map((rowTemplate) =>
      rowTemplates.find((binding) => binding.rowTemplate.id === rowTemplate.id),
    )
    .filter((binding): binding is DatabaseRowTemplateBinding =>
      Boolean(binding),
    );
  const moveTemplate = useCallback(
    async (
      rowTemplateId: string,
      direction: "up" | "down",
      ordered: DatabaseRowTemplateBinding[],
    ) => {
      if (!canEdit) return;
      const currentIndex = ordered.findIndex(
        (binding) => binding.rowTemplate.id === rowTemplateId,
      );
      const targetIndex =
        direction === "up" ? currentIndex - 1 : currentIndex + 1;
      if (
        currentIndex < 0 ||
        targetIndex < 0 ||
        targetIndex >= ordered.length
      ) {
        return;
      }

      const nextOrder = [...ordered];
      const [moved] = nextOrder.splice(currentIndex, 1);
      if (!moved) return;
      nextOrder.splice(targetIndex, 0, moved);

      if (!isCurrent() || writing.current) return;
      const write = {};
      writing.current = write;
      setBusy(true);
      try {
        // Each native update has its own observed revision. A conflict stops
        // this sequence; already acknowledged positions are read back normally.
        await conflicts.execute({
          scope,
          canOverwrite: isCurrent,
          allowOverwrite: false,
          attemptedAction: t["com.myoxus.database.rowTemplate.manage"](),
          localValue: boundedRowTemplatePreview(
            nextOrder.map((binding) => binding.rowTemplate.name).join(", "),
          ),
          readServerValue: async (details) => {
            const state = rowTemplateConflictState(
              details,
              databaseId,
              rowTemplateId,
            );
            return state && "name" in state && typeof state.name === "string"
              ? boundedRowTemplatePreview(state.name)
              : null;
          },
          mutate: async () => {
            for (const [position, binding] of nextOrder.entries()) {
              if (!isCurrent()) return;
              await updateRowTemplate.trigger({
                input: {
                  rowTemplateId: binding.rowTemplate.id,
                  expectedEditRevision: binding.rowTemplate.editRevision,
                  position,
                },
              });
            }
          },
          reloadLatest: async () => {
            if (isCurrent()) await onChanged({ kind: "row_template_updated" });
          },
          afterSuccess: async () => {
            if (isCurrent()) await onChanged({ kind: "row_template_updated" });
          },
        });
      } finally {
        if (writing.current === write) {
          writing.current = null;
          if (isCurrent()) setBusy(false);
        }
      }
    },
    [
      canEdit,
      conflicts,
      databaseId,
      isCurrent,
      onChanged,
      scope,
      t,
      updateRowTemplate,
    ],
  );
  const editableFields = sortByPosition(record.fields).filter(
    (field) =>
      field.fieldType !== DatabaseFieldKind.Title &&
      field.fieldType !== DatabaseFieldKind.Rollup &&
      field.fieldType !== DatabaseFieldKind.Formula &&
      !isDatabaseProjectionField(field.fieldType),
  );

  return (
    <Stack>
      <Group justify="space-between" wrap="wrap">
        <MyoxusText tone="secondary">
          {t["com.myoxus.database.rowTemplate.manage-description"]()}
        </MyoxusText>
        <TemplateListMenu
          suggestionSurface={TemplateSuggestionSurface.DatabaseRowTemplate}
          onSelectTemplate={(item) =>
            void bindTemplate(item).catch(reportWriteFailure)
          }
        >
          <Button
            variant="primary"
            prefix={<PlusIcon />}
            disabled={!canEdit || busy}
          >
            {t["com.myoxus.database.rowTemplate.add"]()}
          </Button>
        </TemplateListMenu>
      </Group>
      {orderedBindings.length ? (
        <Accordion
          multiple
          defaultValue={orderedBindings.map(
            (binding) => binding.rowTemplate.id,
          )}
        >
          {orderedBindings.map((binding, index) => (
            <AccordionItem
              key={binding.rowTemplate.id}
              value={binding.rowTemplate.id}
            >
              <AccordionControl>
                <Stack gap="none">
                  <MyoxusText component="span" typographySlot="body-small">
                    {binding.rowTemplate.name}
                  </MyoxusText>
                  <MyoxusText
                    component="span"
                    typographySlot="body-small"
                    tone="secondary"
                  >
                    {rowTemplateStatusLabel(t, binding)}
                  </MyoxusText>
                </Stack>
              </AccordionControl>
              <AccordionPanel>
                <FormFieldset disabled={!canEdit || busy} variant="unstyled">
                  <Stack>
                    <Group wrap="wrap">
                      <IconButton
                        tooltip={t["com.myoxus.database.rowTemplate.move-up"]()}
                        aria-label={t[
                          "com.myoxus.database.rowTemplate.move-up"
                        ]()}
                        disabled={index === 0}
                        onClick={() =>
                          void moveTemplate(
                            binding.rowTemplate.id,
                            "up",
                            orderedBindings,
                          ).catch(reportWriteFailure)
                        }
                      >
                        <ArrowUpSmallIcon />
                      </IconButton>
                      <IconButton
                        tooltip={t[
                          "com.myoxus.database.rowTemplate.move-down"
                        ]()}
                        aria-label={t[
                          "com.myoxus.database.rowTemplate.move-down"
                        ]()}
                        disabled={index === orderedBindings.length - 1}
                        onClick={() =>
                          void moveTemplate(
                            binding.rowTemplate.id,
                            "down",
                            orderedBindings,
                          ).catch(reportWriteFailure)
                        }
                      >
                        <ArrowDownSmallIcon />
                      </IconButton>
                      <Switch
                        checked={binding.rowTemplate.enabled}
                        onChange={(checked) =>
                          void updateTemplate(binding.rowTemplate.id, {
                            enabled: checked,
                          }).catch(reportWriteFailure)
                        }
                      >
                        {t["com.myoxus.database.rowTemplate.enabled"]()}
                      </Switch>
                      <Button
                        variant={
                          binding.rowTemplate.isDefault
                            ? "primary"
                            : "secondary"
                        }
                        disabled={
                          !binding.rowTemplate.enabled ||
                          binding.rowTemplate.isDefault
                        }
                        onClick={() =>
                          void updateTemplate(binding.rowTemplate.id, {
                            isDefault: true,
                          }).catch(reportWriteFailure)
                        }
                      >
                        {binding.rowTemplate.isDefault
                          ? t["com.myoxus.database.rowTemplate.default"]()
                          : t["com.myoxus.database.rowTemplate.set-default"]()}
                      </Button>
                      <IconButton
                        tooltip={t["com.myoxus.database.rowTemplate.delete"]()}
                        aria-label={t[
                          "com.myoxus.database.rowTemplate.delete"
                        ]()}
                        onClick={() =>
                          void deleteTemplate(binding.rowTemplate.id).catch(
                            reportWriteFailure,
                          )
                        }
                      >
                        <TrashIcon />
                      </IconButton>
                    </Group>
                    {editableFields.length ? (
                      <Stack gap="xs">
                        <MyoxusText
                          typographySlot="body-small"
                          tone="secondary"
                        >
                          {t[
                            "com.myoxus.database.rowTemplate.initial-values"
                          ]()}
                        </MyoxusText>
                        <Stack>
                          {editableFields.map((field) => (
                            <FormRow
                              key={JSON.stringify([scope, field.id])}
                              label={field.name}
                            >
                              <RowTemplateInitialCellEditor
                                binding={binding}
                                field={field}
                                onUpdate={updateTemplate}
                                onWriteError={reportWriteFailure}
                                record={record}
                                rows={rows}
                              />
                            </FormRow>
                          ))}
                        </Stack>
                      </Stack>
                    ) : null}
                  </Stack>
                </FormFieldset>
              </AccordionPanel>
            </AccordionItem>
          ))}
        </Accordion>
      ) : (
        <EmptyState title={t["com.myoxus.database.rowTemplate.empty"]()} />
      )}
    </Stack>
  );
}

export function RowTemplateManagementModal({
  databaseId,
  onChanged,
  onClose,
  open,
  record,
  rowTemplates,
  rows,
}: {
  databaseId: string;
  onChanged: DatabaseChangeHandler;
  onClose: () => void;
  open: boolean;
  record: DatabaseRecord;
  rowTemplates: DatabaseRowTemplateBinding[];
  rows: DatabaseRowRecord[];
}) {
  const t = useI18n();
  if (!open) return null;
  return (
    <Modal
      open
      onOpenChange={(nextOpen) => {
        if (!nextOpen) onClose();
      }}
      title={t["com.myoxus.database.rowTemplate.manage"]()}
    >
      <RowTemplateManagementPanel
        databaseId={databaseId}
        onChanged={onChanged}
        record={record}
        rowTemplates={rowTemplates}
        rows={rows}
      />
    </Modal>
  );
}
