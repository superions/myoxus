// SPDX-License-Identifier: AGPL-3.0-or-later

import { WorkspaceServerService } from "@myoxus/core/modules/server/services/workspace-server";
import { WorkspaceService } from "@myoxus/core/modules/workspace";
import { useRegionalPreferences } from "@myoxus/core/components/hooks/myoxus/use-user-preferences";
import {
  databaseTaskBlockedByQuery,
  type DatabaseTaskBlockedByQuery,
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

import { useDatabaseConflictController } from "../presence";
import { databaseFieldDisplayName } from "../presentation/task-labels";
import type { TaskDetailEditSession } from "../row-detail/task-navigation";
import { databaseConflictDetails } from "../presence/conflict-controller";
import { useTaskIdentity } from "../tasks/use-workspace-tasks";
import { useTaskFreshness } from "../tasks/use-task-freshness";
import type {
  DatabaseField,
  DatabaseRecord,
  DatabaseRowRecord,
} from "../types";
import type { TaskRelationEditLifetime } from "./relation-cell-editor";
import { readTaskCandidatePages } from "./task-candidates";
import {
  taskBlockedByErrorReason,
  taskBlockedByReason,
} from "./task-blocked-by-reason";

export type BlockedByCapability = NonNullable<
  NonNullable<DatabaseTaskBlockedByQuery["workspace"]>["databaseRow"]
>["row"]["taskBlockedBy"];
type Capability = BlockedByCapability;
export type BlockedByProjection = {
  capability?: BlockedByCapability;
  loading: boolean;
  error: boolean;
};
type Option = { value: string; label: string };
type Props = {
  field: DatabaseField;
  record: DatabaseRecord;
  row: DatabaseRowRecord;
  value: string[];
  readonly?: boolean;
  onProjection?: (value: BlockedByProjection | null) => void;
  onEditSessionChange?: (session: TaskDetailEditSession | null) => void;
  onChange: (
    value: string[],
    lifetime: TaskRelationEditLifetime,
  ) => Promise<boolean | undefined>;
};

/** One native property editor owns an actor-scoped edit. Only its native
 * Cell/clear callbacks write; this reader never mirrors edges or infers Blocks. */
export function DatabaseTaskBlockedByCellEditor(props: Props) {
  const owner = useTaskIdentity();
  return owner.identity &&
    owner.workspace.id === props.record.database.workspaceId ? (
    <BlockedBySession
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

function BlockedBySession({
  field,
  record,
  row,
  value,
  readonly,
  onChange,
  onProjection,
  onEditSessionChange,
}: Props) {
  const t = useI18n();
  const owner = useTaskIdentity();
  const servers = useService(WorkspaceServerService);
  const workspace = useService(WorkspaceService);
  const conflicts = useDatabaseConflictController();
  const dismiss = useRef(conflicts.dismiss);
  dismiss.current = conflicts.dismiss;
  const instance = useId();
  const scope = JSON.stringify([
    "task-blocked-by",
    owner.identity,
    record.database.id,
    row.row.id,
    field.id,
    instance,
  ]);
  const alive = useRef(true);
  const reading = useRef<AbortController | undefined>(undefined);
  const conflictReading = useRef<AbortController | undefined>(undefined);
  const candidates = useRef<AbortController | undefined>(undefined);
  const writing = useRef(false);
  const candidateBusy = useRef(false);
  const visible = useRef(false);
  const [capability, setCapability] = useState<Capability>();
  const [loading, setLoading] = useState(true);
  const [readFailed, setReadFailed] = useState(false);
  const [draft, setDraft] = useState(value);
  const [dirty, setDirty] = useState(false);
  const [failure, setFailure] = useState<unknown>();
  const [busy, setBusy] = useState(false);
  const [chosen, setChosen] = useState<Option[]>([]);
  const [options, setOptions] = useState<Option[]>([]);
  const [opened, setOpened] = useState(false);
  const [search, setSearch] = useState("");
  const deferredSearch = useDeferredValue(search);
  const [cursors, setCursors] = useState<(string | null)[]>([null, null]);
  const [candidateLoading, setCandidateLoading] = useState(false);
  const [candidateFailed, setCandidateFailed] = useState(false);
  const diagnosing = useRef(loading);
  diagnosing.current = loading;
  const timeZone = useRegionalPreferences().timezone;
  const gql = owner.server?.gql;
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
    candidates.current?.abort();
  }, []);
  const read = useCallback(
    async (forConflict = false) => {
      if (!gql || !isCurrent()) return undefined;
      // Hints/canonical refresh must not cancel an explicit conflict readback.
      const requestOwner = forConflict ? conflictReading : reading;
      if (!forConflict) {
        close();
        setCandidateFailed(false);
      }
      requestOwner.current?.abort();
      const controller = new AbortController();
      requestOwner.current = controller;
      const signal = AbortSignal.any([
        controller.signal,
        AbortSignal.timeout(15000),
      ]);
      if (!forConflict) {
        setLoading(true);
        setReadFailed(false);
      }
      try {
        let projection: Capability | undefined;
        let after: string | undefined;
        let remaining = 1;
        const seen = new Set<string>();
        do {
          const response = await gql({
            query: databaseTaskBlockedByQuery,
            variables: {
              workspaceId: record.database.workspaceId,
              databaseId: record.database.id,
              rowId: row.row.id,
              after,
            },
            context: { signal },
          });
          if (!isCurrent() || signal.aborted) return undefined;
          const source = response.workspace?.databaseRow?.row;
          if (
            response.workspace?.id !== record.database.workspaceId ||
            source?.id !== row.row.id ||
            source?.databaseId !== record.database.id
          )
            throw new Error("Blocker projection unavailable");
          const page = source.taskBlockedBy;
          if (!projection) {
            projection = { ...page, rows: [...page.rows] };
            // Read only this Cell's selected endpoints, in bounded server pages.
            // Neither Tasks inventory nor the inverse graph is scanned here.
            remaining = page.retainedRowIds.length + 1;
          } else {
            if (
              page.available !== projection.available ||
              page.fieldId !== projection.fieldId ||
              JSON.stringify(page.retainedRowIds) !==
                JSON.stringify(projection.retainedRowIds)
            )
              throw new Error("Blocker selection changed during read");
            projection.rows.push(...page.rows);
          }
          if (
            page.rows.some(
              (entry) => !page.retainedRowIds.includes(entry.rowId),
            )
          )
            throw new Error("Unexpected blocker endpoint");
          after = page.nextCursor ?? undefined;
          if (after) {
            if (seen.has(after) || !page.rows.length || --remaining <= 0)
              throw new Error("Invalid blocker continuation");
            seen.add(after);
          }
        } while (after);
        if (
          projection?.available &&
          projection.retainedRowIds.some(
            (id) => !projection.rows.some((entry) => entry.rowId === id),
          )
        )
          throw new Error("Incomplete blocker selection projection");
        if (isCurrent() && !signal.aborted) {
          if (!forConflict) setCapability(projection);
          return { capability: projection, signal };
        }
      } catch {
        if (!forConflict && isCurrent() && !controller.signal.aborted) {
          setCapability(undefined);
          setReadFailed(true);
        }
      } finally {
        if (!forConflict && isCurrent() && reading.current === controller)
          setLoading(false);
      }
      return undefined;
    },
    [
      gql,
      isCurrent,
      close,
      record.database.workspaceId,
      record.database.id,
      row.row.id,
    ],
  );
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      reading.current?.abort();
      conflictReading.current?.abort();
      candidates.current?.abort();
      dismiss.current?.(scope);
    };
  }, [scope]);
  const revision = JSON.stringify([
    record.database.editRevision,
    record.fieldRoles,
    record.fields.map((field) => [field.id, field.editRevision]),
    row.row.editRevision,
    row.cellRevisions,
  ]);
  useEffect(() => {
    void read();
    return () => reading.current?.abort();
  }, [read, revision]);
  useTaskFreshness(owner, read);
  useEffect(() => {
    const offline = () => {
      reading.current?.abort();
      close();
      if (isCurrent()) {
        setCapability(undefined);
        setLoading(false);
        setReadFailed(true);
      }
    };
    const online = () => void read();
    window.addEventListener("offline", offline);
    window.addEventListener("online", online);
    return () => {
      window.removeEventListener("offline", offline);
      window.removeEventListener("online", online);
    };
  }, [read, close, isCurrent]);
  useEffect(() => {
    onProjection?.({ capability, loading, error: readFailed });
    return () => onProjection?.(null);
  }, [onProjection, capability, loading, readFailed]);
  useEffect(() => {
    if (!capability || capability.fieldId !== field.id) return;
    if (!dirty) setDraft(capability.retainedRowIds);
    else if (
      JSON.stringify(draft) === JSON.stringify(capability.retainedRowIds)
    )
      setDirty(false);
  }, [capability, dirty, draft, field.id]);
  const available = Boolean(
    capability?.available && capability.fieldId === field.id,
  );
  const load = useCallback(
    async (after?: (string | null)[]) => {
      if (
        !gql ||
        !isCurrent() ||
        !visible.current ||
        diagnosing.current ||
        readonly ||
        !available ||
        (after && candidateBusy.current)
      )
        return;
      candidates.current?.abort();
      const controller = new AbortController();
      candidates.current = controller;
      candidateBusy.current = true;
      setCandidateLoading(true);
      setCandidateFailed(false);
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
          !visible.current ||
          diagnosing.current
        )
          return;
        const next = pages
          .flatMap((page) => page?.rows ?? [])
          .filter(
            (task) =>
              task.workspaceId === record.database.workspaceId &&
              task.databaseId === record.database.id &&
              task.rowId !== row.row.id,
          )
          .map((task) => ({ value: task.rowId, label: task.title }));
        setOptions((previous) => [
          ...new Map(
            [...(after ? previous : []), ...next].map((option) => [
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
          visible.current &&
          !diagnosing.current
        ) {
          setOptions([]);
          setCandidateFailed(true);
        }
      } finally {
        if (isCurrent() && candidates.current === controller) {
          candidateBusy.current = false;
          setCandidateLoading(false);
        }
      }
    },
    [
      gql,
      isCurrent,
      readonly,
      available,
      record.database.workspaceId,
      record.database.id,
      row.row.id,
      deferredSearch,
      timeZone,
    ],
  );
  useEffect(() => {
    if (opened) void load();
    return () => candidates.current?.abort();
  }, [load, opened]);
  useEffect(() => {
    if (readonly) close();
  }, [readonly, close]);
  const selected = (capability?.retainedRowIds ?? []).map((id) => {
    const entry = capability?.rows.find((entry) => entry.rowId === id);
    const task = entry?.task;
    return {
      value: id,
      label:
        task?.workspaceId === record.database.workspaceId &&
        task.databaseId === record.database.id &&
        task.rowId === id
          ? task.title
          : t["com.myoxus.template-list.unavailable"](),
    };
  });
  const data = [
    ...new Map(
      [
        ...options,
        ...(dirty ? chosen : []),
        ...selected,
        ...draft
          .filter(
            (id) =>
              !options.some((option) => option.value === id) &&
              !selected.some((option) => option.value === id) &&
              !(dirty && chosen.some((option) => option.value === id)),
          )
          .map((id) => ({
            value: id,
            label: t["com.myoxus.template-list.unavailable"](),
          })),
      ].map((option) => [option.value, option]),
    ).values(),
  ];
  const save = async (next: string[]): Promise<boolean> => {
    if (
      !isCurrent() ||
      readonly ||
      diagnosing.current ||
      writing.current ||
      (!available &&
        next.some((id) => !capability?.retainedRowIds.includes(id)))
    )
      return false;
    writing.current = true;
    close();
    setChosen(data.filter((option) => next.includes(option.value)));
    setDraft(next);
    setDirty(true);
    setFailure(undefined);
    setBusy(true);
    try {
      const saved = await onChange(next, {
        scope,
        isCurrent,
        localValue: next.length
          ? next
              .map(
                (id) =>
                  data.find((option) => option.value === id)?.label ??
                  t["com.myoxus.template-list.unavailable"](),
              )
              .join("\n")
          : t["com.myoxus.database.conflict.empty"](),
        readServerValue: async () => {
          const latest = await read(true);
          if (!latest?.capability || !isCurrent() || latest.signal.aborted)
            return null;
          const projection = latest.capability;
          if (!projection.available || projection.fieldId !== field.id)
            return t["com.myoxus.template-list.unavailable"]();
          if (!projection.retainedRowIds.length)
            return t["com.myoxus.database.conflict.empty"]();
          return projection.retainedRowIds
            .map((id) => {
              const task = projection.rows.find(
                (entry) => entry.rowId === id,
              )?.task;
              return task?.workspaceId === record.database.workspaceId &&
                task.databaseId === record.database.id &&
                task.rowId === id
                ? task.title
                : t["com.myoxus.template-list.unavailable"]();
            })
            .join("\n");
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
            void read();
          }
        },
      });
      return saved === true;
    } catch (error) {
      if (isCurrent()) setFailure(error);
      return false;
    } finally {
      writing.current = false;
      if (isCurrent()) setBusy(false);
    }
  };
  const editActions = useRef({
    apply: async (): Promise<boolean> => false,
    discard: () => {},
  });
  editActions.current = {
    // A search query is not a selected prerequisite and cannot be committed.
    apply: () =>
      search.length || !dirty ? Promise.resolve(false) : save(draft),
    discard: () => {
      if (writing.current || busy || !isCurrent() || !capability) return;
      close();
      setSearch("");
      setDraft(capability.retainedRowIds);
      setChosen([]);
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
  if (loading && !capability) return <Loading />;
  // Row lifecycle can change availability; only native diagnostics identify a
  // schema defect. Absence of a diagnosis stays neutral.
  if (
    !readFailed &&
    capability &&
    !capability.available &&
    capability.fieldId == null
  )
    return (
      <Stack>
        {capability.diagnostics.length ? (
          capability.diagnostics.map((reason) => (
            <MyoxusText key={reason} tone="secondary">
              {taskBlockedByReason(t, reason)}
            </MyoxusText>
          ))
        ) : (
          <MyoxusText tone="secondary">
            {t["com.myoxus.template-list.unavailable"]()}
          </MyoxusText>
        )}
      </Stack>
    );
  if (readFailed || !capability || capability.fieldId !== field.id)
    return (
      <Stack>
        <MyoxusText tone="danger">
          {t["com.myoxus.common.operation-failed"]()}
        </MyoxusText>
        <Button onClick={() => void read()}>{t.Retry()}</Button>
      </Stack>
    );
  return (
    <Stack>
      <MultiSelect
        fitViewport
        aria-label={databaseFieldDisplayName(t, record, row, field)}
        data={
          available
            ? data
            : data.filter((option) => draft.includes(option.value))
        }
        // Pills represent endpoints once. Preserve duplicate legacy occurrences
        // in the intent until the user explicitly removes that endpoint.
        value={[...new Set(draft)]}
        onChange={(next) =>
          void save([
            ...draft.filter((id) => next.includes(id)),
            ...next.filter((id) => !draft.includes(id)),
          ])
        }
        clearable
        searchable
        block
        maxValues={
          field.config.relation?.allowMultiple === false
            ? 1
            : (field.config.relation?.maxTargets ?? undefined)
        }
        readOnly={readonly || busy || loading}
        aria-busy={loading}
        searchValue={search}
        onSearchChange={setSearch}
        filter={({ options }) => options}
        dropdownOpened={opened}
        onDropdownClose={close}
        onDropdownOpen={() => {
          if (
            readonly ||
            writing.current ||
            diagnosing.current ||
            !available ||
            !isCurrent()
          )
            return;
          setOptions([]);
          setCursors([null, null]);
          setCandidateFailed(false);
          setCandidateLoading(true);
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
          candidateLoading
            ? t["com.myoxus.database.relation.loading"]()
            : candidateFailed
              ? t["com.myoxus.common.operation-failed"]()
              : t["com.myoxus.database.relation.empty"]()
        }
      />
      {!available && !capability.diagnostics.length ? (
        <MyoxusText tone="secondary">
          {t["com.myoxus.template-list.unavailable"]()}
        </MyoxusText>
      ) : null}
      {!loading
        ? capability.diagnostics.map((reason) => (
            <MyoxusText key={reason} tone="secondary">
              {taskBlockedByReason(t, reason)}
            </MyoxusText>
          ))
        : null}
      {failure ? (
        <MyoxusText tone="danger">
          {taskBlockedByReason(t, taskBlockedByErrorReason(failure))}
        </MyoxusText>
      ) : null}
      {failure || candidateFailed ? (
        <Button
          disabled={readonly || busy || loading}
          onClick={() => {
            if (
              !isCurrent() ||
              readonly ||
              writing.current ||
              diagnosing.current
            )
              return;
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
