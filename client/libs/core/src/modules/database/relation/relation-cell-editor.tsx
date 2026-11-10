// SPDX-License-Identifier: AGPL-3.0-or-later

import { WorkspaceServerService } from "@myoxus/core/modules/server/services/workspace-server";
import { WorkspaceService } from "@myoxus/core/modules/workspace";
import { GraphQLService } from "@myoxus/core/modules/server/services/graphql";
import {
  databaseRowsQuery,
  databaseTaskParentQuery,
  databaseTaskReferencesQuery,
  DatabaseTaskReferenceState,
  type DatabaseTaskParentQuery,
} from "@myoxus/graphql";
import { useI18n } from "@myoxus/i18n";
import { useService } from "@myoxus/infra";
import {
  Button,
  Loading,
  MultiSelect,
  MyoxusText,
  Stack,
} from "@myoxus/ui-facade";
import {
  useCallback,
  useDeferredValue,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";

import { useRegionalPreferences } from "@myoxus/core/components/hooks/myoxus/use-user-preferences";
import { useDatabaseConflictController } from "../presence";
import type { TaskDetailEditSession } from "../row-detail/task-navigation";
import { taskParentErrorReason, taskParentReason } from "./task-parent-reason";
import { databaseConflictDetails } from "../presence/conflict-controller";
import { useTaskIdentity } from "../tasks/use-workspace-tasks";
import { useTaskFreshness } from "../tasks/use-task-freshness";
import { readTaskCandidatePages } from "./task-candidates";

import type {
  DatabaseCellValue,
  DatabaseField,
  DatabaseRecord,
  DatabaseRowRecord,
} from "../types";

const RELATION_TARGET_PAGE_SIZE = 50;
const RELATION_TARGET_MAX_ROWS = 200;

function relationTargetLabel(
  target: NonNullable<DatabaseCellValue["value"]["relationTargets"]>[number],
  labels: { deleted: string; redacted: string },
) {
  if (target.deleted) return target.title ?? labels.deleted;
  if (target.redacted) return labels.redacted;
  return target.title ?? target.rowId;
}

export function getRelationTargetOptions({
  field,
  record,
  row,
  rows,
  remoteRows = [],
  labels = { deleted: "Deleted", redacted: "No access" },
}: {
  field: DatabaseField;
  record: DatabaseRecord;
  row: DatabaseRowRecord;
  rows: DatabaseRowRecord[];
  remoteRows?: DatabaseRowRecord[];
  labels?: { deleted: string; redacted: string };
}) {
  const options = new Map<string, string>();
  const targetRows =
    field.config.relation?.targetDatabaseId === record.database.id
      ? [...rows, ...remoteRows]
      : [...remoteRows];

  for (const targetRow of targetRows) {
    if (targetRow.row.id === row.row.id || targetRow.redacted) continue;
    options.set(targetRow.row.id, targetRow.row.title);
  }

  // Selected relation targets are projected by the server with ACL-aware
  // labels. Keep them selectable even when the currently loaded page does not
  // contain the row, otherwise editing an existing relation would drop context.
  const relationTargets =
    row.cells.find((cell) => cell.fieldId === field.id)?.value
      .relationTargets ?? [];
  for (const target of relationTargets) {
    options.set(target.rowId, relationTargetLabel(target, labels));
  }

  return [...options].map(([value, label]) => ({ value, label }));
}

export function DatabaseRelationCellEditor({
  field,
  onChange,
  record,
  row,
  rows,
  value,
}: {
  field: DatabaseField;
  onChange: (value: string[]) => void;
  record: DatabaseRecord;
  row: DatabaseRowRecord;
  rows: DatabaseRowRecord[];
  value: string[];
}) {
  const t = useI18n();
  const graphQLService = useService(GraphQLService);
  const targetDatabaseId = field.config.relation?.targetDatabaseId;
  const maxValues =
    field.config.relation?.allowMultiple === false
      ? 1
      : (field.config.relation?.maxTargets ?? undefined);
  const [loadedRows, setLoadedRows] = useState<DatabaseRowRecord[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [loading, setLoading] = useState(false);
  const [opened, setOpened] = useState(false);

  useEffect(() => {
    setLoaded(false);
    setLoadedRows([]);
  }, [targetDatabaseId]);

  const loadRelationTargets = useCallback(async () => {
    if (!targetDatabaseId || loaded || loading) return;
    setLoading(true);
    try {
      const collected: DatabaseRowRecord[] = [];
      let offset = 0;
      let totalCount = Number.POSITIVE_INFINITY;
      while (
        offset < totalCount &&
        collected.length < RELATION_TARGET_MAX_ROWS
      ) {
        const response = await graphQLService.gql({
          query: databaseRowsQuery,
          variables: {
            workspaceId: record.database.workspaceId,
            databaseId: targetDatabaseId,
            first: RELATION_TARGET_PAGE_SIZE,
            offset,
          },
        });
        const page = response.workspace?.databaseRows;
        const pageRows = page?.rows ?? [];
        totalCount = page?.totalCount ?? collected.length + pageRows.length;
        collected.push(...pageRows);
        if (pageRows.length === 0) break;
        offset += pageRows.length;
      }
      setLoadedRows(collected);
      setLoaded(true);
    } finally {
      setLoading(false);
    }
  }, [
    graphQLService,
    loaded,
    loading,
    record.database.workspaceId,
    targetDatabaseId,
  ]);

  return (
    <MultiSelect
      fitViewport
      data={getRelationTargetOptions({
        field,
        record,
        row,
        rows,
        remoteRows: loadedRows,
        labels: {
          deleted: t["com.myoxus.documentGraph.state.deleted"](),
          redacted: t["com.myoxus.database.row.redacted"](),
        },
      })}
      value={value}
      onChange={(next) => {
        // Finish the native picker before a committed Cell refresh can replace it.
        setOpened(false);
        onChange(next);
      }}
      placeholder={
        loading
          ? t["com.myoxus.database.relation.loading"]()
          : t["com.myoxus.database.cell.empty"]()
      }
      nothingFoundMessage={t["com.myoxus.database.relation.empty"]()}
      dropdownOpened={opened}
      onDropdownOpen={() => {
        setOpened(true);
        void loadRelationTargets();
      }}
      onDropdownClose={() => setOpened(false)}
      maxValues={maxValues}
      clearable
      searchable
      block
    />
  );
}

/** One property opening owns the initial Cell write and any later Force.
 * Its scope disposes shared conflict UI; it is never persisted as graph data. */
export type TaskRelationEditLifetime = {
  scope: string;
  isCurrent: () => boolean;
  /** Presentation only; canonical relation IDs remain in the mutation intent. */
  localValue: string;
  /** Reauthorize canonical endpoints; never format IDs from latestState. */
  readServerValue: () => Promise<string | null>;
  onError: (error: unknown) => void;
  onDiscard: () => void;
  onCommitted: () => void;
};

export type ParentCapability = NonNullable<
  NonNullable<DatabaseTaskParentQuery["workspace"]>["databaseRow"]
>["row"]["taskParent"];

/** Current native Parent capability shared by its summary and Cell editor;
 * each consumer retains its own read/conflict lifetime. */
export function useTaskParentRead(
  record: DatabaseRecord,
  row: DatabaseRowRecord,
  onReadStarted?: () => void,
) {
  const owner = useTaskIdentity();
  const workspaceService = useService(WorkspaceService);
  const workspaceServer = useService(WorkspaceServerService);
  const conflicts = useDatabaseConflictController();
  const dismiss = useRef(conflicts.dismiss);
  dismiss.current = conflicts.dismiss;
  const instanceId = useId();
  const scope = JSON.stringify([
    "task-parent",
    owner.identity,
    record.database.id,
    row.row.id,
    instanceId,
  ]);
  const alive = useRef(true);
  const request = useRef<AbortController | undefined>(undefined);
  const conflictRequest = useRef<AbortController | undefined>(undefined);
  const [capability, setCapability] = useState<ParentCapability>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const isCurrent = useCallback(() => {
    const server = workspaceServer.server$.value;
    return (
      alive.current &&
      Boolean(server) &&
      JSON.stringify([
        server?.id,
        server?.baseUrl,
        server?.account$.value?.id,
        workspaceService.workspace.id,
      ]) === owner.identity
    );
  }, [workspaceServer, workspaceService, owner.identity]);
  const gql = owner.server?.gql;
  const read = useCallback(
    async (forConflict = false) => {
      if (!gql || !isCurrent()) return undefined;
      // Keep the conflict's role and target-summary reads in one independent
      // lifetime; ordinary hint delivery may replace only the editor's read.
      const requestOwner = forConflict ? conflictRequest : request;
      if (!forConflict) onReadStarted?.();
      requestOwner.current?.abort();
      const controller = new AbortController();
      requestOwner.current = controller;
      if (!forConflict) {
        setLoading(true);
        setError(false);
      }
      const signal = AbortSignal.any([
        controller.signal,
        AbortSignal.timeout(15000),
      ]);
      try {
        const result = await gql({
          query: databaseTaskParentQuery,
          variables: {
            workspaceId: record.database.workspaceId,
            databaseId: record.database.id,
            rowId: row.row.id,
          },
          context: {
            signal,
          },
        });
        if (!isCurrent() || signal.aborted) return undefined;
        const projected = result.workspace?.databaseRow?.row;
        if (
          result.workspace?.id !== record.database.workspaceId ||
          !projected ||
          projected.id !== row.row.id ||
          projected.databaseId !== record.database.id
        )
          throw new Error("Parent projection unavailable");
        if (!forConflict) setCapability(projected.taskParent);
        return { capability: projected.taskParent, signal };
      } catch {
        if (!forConflict && isCurrent() && !controller.signal.aborted) {
          setCapability(undefined);
          setError(true);
        }
      } finally {
        if (!forConflict && isCurrent() && request.current === controller)
          setLoading(false);
      }
      return undefined;
    },
    [
      gql,
      isCurrent,
      onReadStarted,
      record.database.workspaceId,
      record.database.id,
      row.row.id,
    ],
  );
  // Canonical Cell/Field/role delivery invalidates diagnostics after a repair or
  // schema change. Metadata schedules the read; only the server decides validity.
  const revision = JSON.stringify([
    record.database.editRevision,
    record.fieldRoles,
    record.fields.map((field) => [field.id, field.editRevision]),
    row.row.editRevision,
    row.cellRevisions,
  ]);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      request.current?.abort();
      conflictRequest.current?.abort();
      dismiss.current?.(scope);
    };
  }, [scope]);
  useEffect(() => {
    void read();
    return () => request.current?.abort();
  }, [read, revision]);
  // A target's trash/restore does not revise this child's retained Cell.
  useTaskFreshness(owner, read);
  return { capability, loading, error, read, isCurrent, scope };
}

/** Missing or aliased fields have no safe Cell editor. Still authorize the
 * actual capability read before presenting its diagnosis in the native form. */
export function DatabaseTaskParentCapability({
  record,
  row,
}: {
  record: DatabaseRecord;
  row: DatabaseRowRecord;
}) {
  const owner = useTaskIdentity();
  return owner.identity &&
    owner.workspace.id === record.database.workspaceId ? (
    <TaskParentCapabilitySession
      key={JSON.stringify([owner.identity, record.database.id, row.row.id])}
      record={record}
      row={row}
    />
  ) : null;
}
function TaskParentCapabilitySession({
  record,
  row,
}: {
  record: DatabaseRecord;
  row: DatabaseRowRecord;
}) {
  const t = useI18n();
  const read = useTaskParentRead(record, row);
  if (read.loading) return <Loading />;
  if (read.error || !read.capability)
    return (
      <Stack>
        <MyoxusText tone="danger">
          {t["com.myoxus.common.operation-failed"]()}
        </MyoxusText>
        <Button onClick={() => void read.read()}>{t["Retry"]()}</Button>
      </Stack>
    );
  return (
    <MyoxusText tone="secondary">
      {read.capability.available
        ? t["com.myoxus.template-list.unavailable"]()
        : t["com.myoxus.database.task-parent.unavailable"]()}
    </MyoxusText>
  );
}

type ParentEditorProps = {
  field: DatabaseField;
  record: DatabaseRecord;
  row: DatabaseRowRecord;
  value: string[];
  readonly?: boolean;
  onCapability?: (value: ParentCapability | null) => void;
  onEditSessionChange?: (session: TaskDetailEditSession | null) => void;
  onChange: (
    value: string[],
    lifetime: TaskRelationEditLifetime,
  ) => Promise<boolean | undefined>;
};

/** The keyed session never carries candidate titles or a rejected draft into
 * another actor/row. Candidates come from Task projection, never generic rows. */
export function DatabaseTaskParentCellEditor(props: ParentEditorProps) {
  const owner = useTaskIdentity();
  return owner.identity &&
    owner.workspace.id === props.record.database.workspaceId ? (
    <TaskParentSession
      key={JSON.stringify([
        owner.identity,
        props.record.database.id,
        props.row.row.id,
        props.field.id,
      ])}
      {...props}
    />
  ) : null;
}

function TaskParentSession({
  field,
  record,
  row,
  value,
  readonly,
  onChange,
  onCapability,
  onEditSessionChange,
}: ParentEditorProps) {
  const t = useI18n();
  const owner = useTaskIdentity();
  const timeZone = useRegionalPreferences().timezone;
  const gql = owner.server?.gql;
  const [search, setSearch] = useState("");
  const deferredSearch = useDeferredValue(search);
  const [draft, setDraft] = useState(value);
  const [dirty, setDirty] = useState(false);
  const [draftOptions, setDraftOptions] = useState<
    { value: string; label: string }[]
  >([]);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<unknown>();
  const [options, setOptions] = useState<{ value: string; label: string }[]>(
    [],
  );
  const [cursors, setCursors] = useState<(string | null)[]>([null, null]);
  const [loading, setLoading] = useState(false);
  const [readFailed, setReadFailed] = useState(false);
  const [opened, setOpened] = useState(false);
  const pending = useRef<AbortController | undefined>(undefined);
  const dropdownOpen = useRef(opened);
  dropdownOpen.current = opened;
  const closeDropdown = useCallback(() => {
    dropdownOpen.current = false;
    setOpened(false);
    pending.current?.abort();
  }, []);
  // Close at canonical read admission, including immediately resolved reads;
  // its completion never opens/reloads the popup while Floating measures it.
  const parentRead = useTaskParentRead(record, row, closeDropdown);
  const diagnoseLoading = useRef(parentRead.loading);
  diagnoseLoading.current = parentRead.loading;
  const saving = useRef(false);
  const candidateLoading = useRef(false);
  const [retry, setRetry] = useState(0);
  const { isCurrent, scope } = parentRead;
  const capability = parentRead.capability;
  useEffect(() => {
    onCapability?.(
      parentRead.loading || parentRead.error ? null : (capability ?? null),
    );
    return () => onCapability?.(null);
  }, [onCapability, capability, parentRead.loading, parentRead.error]);
  const available = Boolean(
    capability?.available && capability.fieldId === field.id,
  );
  const diagnostics = parentRead.loading ? [] : (capability?.diagnostics ?? []);
  useEffect(() => () => pending.current?.abort(), []);
  useEffect(() => {
    if (!capability) return;
    if (!dirty) setDraft(capability.parentRowIds);
    else if (JSON.stringify(capability.parentRowIds) === JSON.stringify(draft))
      setDirty(false);
  }, [capability, dirty, draft]);
  const load = useCallback(
    async (after?: (string | null)[]) => {
      if (
        !gql ||
        readonly ||
        !available ||
        diagnoseLoading.current ||
        !dropdownOpen.current ||
        !isCurrent() ||
        (after && candidateLoading.current)
      )
        return;
      pending.current?.abort();
      const controller = new AbortController();
      pending.current = controller;
      candidateLoading.current = true;
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
        if (
          !isCurrent() ||
          controller.signal.aborted ||
          !dropdownOpen.current ||
          diagnoseLoading.current
        )
          return;
        const candidates = pages
          .flatMap((page) => page?.rows ?? [])
          .filter(
            (task) =>
              task.databaseId === record.database.id &&
              task.workspaceId === record.database.workspaceId &&
              task.rowId !== row.row.id,
          )
          .map((task) => ({ value: task.rowId, label: task.title }));
        setOptions((previous) => [
          ...new Map(
            [...(after ? previous : []), ...candidates].map((option) => [
              option.value,
              option,
            ]),
          ).values(),
        ]);
        setCursors(pages.map((page) => page?.nextCursor ?? null));
      } catch {
        if (
          isCurrent() &&
          !controller.signal.aborted &&
          dropdownOpen.current &&
          !diagnoseLoading.current
        ) {
          setReadFailed(true);
          setOptions([]);
        }
      } finally {
        if (isCurrent() && pending.current === controller) {
          candidateLoading.current = false;
          setLoading(false);
        }
      }
    },
    [
      gql,
      isCurrent,
      record.database.id,
      record.database.workspaceId,
      row.row.id,
      deferredSearch,
      timeZone,
      readonly,
      available,
    ],
  );
  useEffect(() => {
    if (opened) void load();
    return () => pending.current?.abort();
  }, [load, opened, retry]);
  useEffect(() => {
    if (readonly) closeDropdown();
  }, [readonly, closeDropdown]);

  const save = async (next: string[]): Promise<boolean> => {
    if (
      !isCurrent() ||
      parentRead.loading ||
      readonly ||
      saving.current ||
      busy ||
      (!available && next.some((id) => !capability?.parentRowIds.includes(id)))
    )
      return false;
    saving.current = true;
    closeDropdown();
    setDraftOptions(data.filter((option) => next.includes(option.value)));
    setDraft(next);
    setDirty(true);
    setBusy(true);
    setFailure(undefined);
    try {
      const saved = await onChange(next, {
        scope,
        isCurrent,
        localValue: next.length
          ? next
              .map((id) => {
                const label = data.find((option) => option.value === id)?.label;
                return label && label !== id
                  ? label
                  : t["com.myoxus.template-list.unavailable"]();
              })
              .join("\n")
          : t["com.myoxus.database.conflict.empty"](),
        readServerValue: async () => {
          const latest = await parentRead.read(true);
          if (!latest || !gql || !isCurrent() || latest.signal.aborted)
            return null;
          if (
            !latest.capability.available ||
            latest.capability.fieldId !== field.id
          )
            return t["com.myoxus.template-list.unavailable"]();
          const ids = latest.capability.parentRowIds;
          if (!ids.length) return t["com.myoxus.database.conflict.empty"]();
          const labels: string[] = [];
          try {
            // Legacy multiple parents still need bounded, current authorization;
            // neither generic relationTargets nor conflict payloads supply titles.
            for (let offset = 0; offset < ids.length; offset += 500) {
              const targets = ids.slice(offset, offset + 500).map((rowId) => ({
                workspaceId: record.database.workspaceId,
                databaseId: record.database.id,
                rowId,
              }));
              const result = await gql({
                query: databaseTaskReferencesQuery,
                variables: {
                  workspaceId: record.database.workspaceId,
                  targets,
                },
                context: { signal: latest.signal },
              });
              if (!isCurrent() || latest.signal.aborted) return null;
              const references = result.workspace?.databaseTaskReferences;
              if (
                result.workspace?.id !== record.database.workspaceId ||
                references?.length !== targets.length
              )
                return null;
              for (let index = 0; index < targets.length; index++) {
                const target = targets[index]!;
                const reference = references[index]!;
                if (
                  reference.workspaceId !== target.workspaceId ||
                  reference.databaseId !== target.databaseId ||
                  reference.rowId !== target.rowId
                )
                  return null;
                const task = reference.task;
                labels.push(
                  reference.state === DatabaseTaskReferenceState.Available &&
                    task?.workspaceId === target.workspaceId &&
                    task.databaseId === target.databaseId &&
                    task.rowId === target.rowId
                    ? task.title
                    : t["com.myoxus.template-list.unavailable"](),
                );
              }
            }
            return labels.join("\n");
          } catch {
            return null;
          }
        },
        onError: (error) => {
          if (isCurrent() && !databaseConflictDetails(error)) setFailure(error);
        },
        onDiscard: () => {
          if (isCurrent()) {
            setDirty(false);
            setFailure(undefined);
          }
        },
        onCommitted: () => {
          if (isCurrent()) {
            setFailure(undefined);
            void parentRead.read();
          }
        },
      });
      return saved === true;
    } catch (error) {
      if (isCurrent()) setFailure(error);
      return false;
    } finally {
      saving.current = false;
      if (isCurrent()) setBusy(false);
    }
  };
  const selected = getRelationTargetOptions({
    field,
    record,
    row,
    rows: [],
    labels: {
      deleted: t["com.myoxus.documentGraph.state.deleted"](),
      redacted: t["com.myoxus.database.row.redacted"](),
    },
  })
    .filter((option) => draft.includes(option.value))
    .map((option) =>
      capability?.diagnostics.length
        ? { ...option, label: t["com.myoxus.template-list.unavailable"]() }
        : option,
    );
  const data = [
    ...new Map(
      [
        ...options,
        ...(dirty ? draftOptions : []),
        ...selected,
        ...draft
          .filter(
            (id) =>
              !options.some((option) => option.value === id) &&
              !selected.some((option) => option.value === id) &&
              !(dirty && draftOptions.some((option) => option.value === id)),
          )
          .map((id) => ({
            value: id,
            label: t["com.myoxus.template-list.unavailable"](),
          })),
      ].map((option) => [option.value, option]),
    ).values(),
  ];
  const editActions = useRef({
    apply: async (): Promise<boolean> => false,
    discard: () => {},
  });
  editActions.current = {
    // Unselected search text is not a relation intent and cannot be committed.
    apply: () =>
      search.length || !dirty ? Promise.resolve(false) : save(draft),
    discard: () => {
      if (saving.current || busy || !isCurrent() || !capability) return;
      closeDropdown();
      setSearch("");
      setDraft(capability.parentRowIds);
      setDraftOptions([]);
      setDirty(false);
      setFailure(undefined);
    },
  };
  const sessionDirty = dirty || search.length > 0;
  useEffect(() => {
    onEditSessionChange?.(
      isCurrent() && (sessionDirty || busy)
        ? {
            dirty: sessionDirty,
            pending: busy,
            apply: () => editActions.current.apply(),
            discard: () => editActions.current.discard(),
          }
        : null,
    );
  }, [onEditSessionChange, isCurrent, sessionDirty, busy]);
  useEffect(() => () => onEditSessionChange?.(null), [onEditSessionChange]);
  if (parentRead.loading && !capability) return <Loading />;
  if (parentRead.error || !capability || capability.fieldId !== field.id)
    return (
      <Stack>
        <MyoxusText tone="danger">
          {t["com.myoxus.common.operation-failed"]()}
        </MyoxusText>
        <Button onClick={() => void parentRead.read()}>{t["Retry"]()}</Button>
      </Stack>
    );
  return (
    <Stack>
      <MultiSelect
        aria-label={field.name}
        data={
          available
            ? data
            : data.filter((option) => draft.includes(option.value))
        }
        value={draft}
        onChange={(next) => void save(next)}
        searchValue={search}
        // Server search owns candidate matching across every cursor page.
        filter={({ options }) => options}
        onSearchChange={setSearch}
        dropdownOpened={opened}
        onDropdownOpen={() => {
          if (
            !readonly &&
            !saving.current &&
            !diagnoseLoading.current &&
            isCurrent()
          ) {
            // Start the native opening with its loading state, rather than
            // measuring a previous page and clearing it in a later effect.
            setOptions([]);
            setCursors([null, null]);
            setReadFailed(false);
            setLoading(available);
            dropdownOpen.current = true;
            setOpened(true);
          }
        }}
        onDropdownClose={closeDropdown}
        scrollAreaProps={{
          onBottomReached: () => {
            if (dropdownOpen.current && cursors.some(Boolean))
              void load(cursors);
          },
        }}
        maxValues={1}
        readOnly={readonly || busy || parentRead.loading}
        aria-busy={parentRead.loading}
        clearable
        searchable
        block
        placeholder={
          loading
            ? t["com.myoxus.database.relation.loading"]()
            : t["com.myoxus.database.cell.empty"]()
        }
        nothingFoundMessage={
          loading
            ? t["com.myoxus.database.relation.loading"]()
            : readFailed
              ? t["com.myoxus.common.operation-failed"]()
              : t["com.myoxus.database.relation.empty"]()
        }
      />
      {!available ? (
        <MyoxusText tone="secondary">
          {t["com.myoxus.database.task-parent.unavailable"]()}
        </MyoxusText>
      ) : null}
      {diagnostics
        .filter(
          (reason) =>
            available ||
            (reason !== "MissingRole" &&
              reason !== "IncompatibleRoleConfiguration"),
        )
        .map((reason) => (
          <MyoxusText key={reason} tone="secondary">
            {taskParentReason(t, reason)}
          </MyoxusText>
        ))}
      {failure ? (
        <MyoxusText tone="danger">
          {taskParentReason(t, taskParentErrorReason(failure))}
        </MyoxusText>
      ) : null}
      {readFailed && available ? (
        <Button
          disabled={readonly || busy || parentRead.loading}
          onClick={() => {
            if (
              !isCurrent() ||
              saving.current ||
              diagnoseLoading.current ||
              readonly
            )
              return;
            dropdownOpen.current = true;
            setOpened(true);
            setRetry((value) => value + 1);
          }}
        >
          {t["Retry"]()}
        </Button>
      ) : null}
      {failure ? (
        <Button disabled={readonly || busy} onClick={() => void save(draft)}>
          {t["Retry"]()}
        </Button>
      ) : null}
    </Stack>
  );
}
