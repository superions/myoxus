// SPDX-License-Identifier: AGPL-3.0-or-later

import { createOperationUuid } from "../../../utils/uuid";
import type {
  DialogComponentProps,
  WORKSPACE_DIALOG_SCHEMA,
} from "@myoxus/core/modules/dialogs";
import { TaskCoverageNotice } from "./managed-feedback";

import { useRegionalPreferences } from "@myoxus/core/components/hooks/myoxus/use-user-preferences";
import {
  databaseTaskReferencesQuery,
  DatabaseTaskLifecycle,
  DatabaseTaskReferenceState,
  DatabaseTaskScope,
} from "@myoxus/graphql";
import { useI18n } from "@myoxus/i18n";
import {
  Button,
  EmptyState,
  FormFieldset,
  FormSelect,
  Group,
  Loading,
  Modal,
  Notice,
  SearchInput,
  Stack,
} from "@myoxus/ui-facade";
import { useEffect, useMemo, useRef, useState } from "react";
import { SWRConfig } from "swr";
import { TaskReferenceSummary } from "../database-block-adapter/task-row-reference";
import type {
  TaskReferenceInsertionState,
  TaskReferenceTarget,
} from "./task-reference-insertion";
import { waitForTaskReferenceOperation } from "./task-reference-operation";
import {
  useTaskIdentity,
  useTaskDestinations,
  useWorkspaceTasks,
} from "./use-workspace-tasks";

type InsertProps = DialogComponentProps<
  WORKSPACE_DIALOG_SCHEMA["task-reference-insert"]
>;
type Props =
  | (InsertProps & { mode?: "insert" })
  | (Pick<InsertProps, "openingOwnerIdentity" | "close" | "returnFocusRef"> & {
      mode: "select";
      title: string;
      onSelectTask: (target: TaskReferenceTarget) => void;
    });
export function TaskReferencePicker(props: Props) {
  const owner = useTaskIdentity();
  const { close } = props;
  const queryCache = useMemo(
    () => (owner.identity ? new Map() : null),
    [owner.identity],
  );
  const valid = owner.identity === props.openingOwnerIdentity;
  useEffect(() => {
    if (!valid) close();
  }, [valid, close]);
  return valid && owner.server && owner.account && queryCache ? (
    <SWRConfig key={owner.identity} value={{ provider: () => queryCache }}>
      <PickerSession key={owner.identity} {...props} />
    </SWRConfig>
  ) : null;
}
function PickerSession(props: Props) {
  const { openingOwnerIdentity, close, returnFocusRef } = props;
  const t = useI18n();
  const owner = useTaskIdentity();
  const timeZone = useRegionalPreferences().timezone;
  const [search, setSearch] = useState("");
  const [projectId, setProjectId] = useState("");
  const [lifecycle, setLifecycle] = useState(DatabaseTaskLifecycle.Open);
  const [after, setAfter] = useState<string>();
  const [attempt, setAttempt] = useState<{
    id: string;
    target: TaskReferenceTarget;
  }>();
  const [state, setState] = useState<
    TaskReferenceInsertionState | "idle" | "pending"
  >("idle");
  const alive = useRef(true);
  const pendingRead = useRef<AbortController | undefined>(undefined);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      pendingRead.current?.abort();
    };
  }, []);
  const projects = useTaskDestinations();
  const read = useWorkspaceTasks(
    {
      scope: DatabaseTaskScope.All,
      lifecycle,
      search,
      timeZone,
      projectIds: projectId ? [projectId] : undefined,
    },
    25,
    after,
  );
  const insert = async (target: TaskReferenceTarget, retryId?: string) => {
    if (state === "pending" || pendingRead.current || !owner.server) return;
    let selected: { id: string; target: TaskReferenceTarget };
    let controller: AbortController;
    let signal: AbortSignal;
    try {
      selected = {
        target: { ...target },
        id: retryId ?? createOperationUuid(),
      };
      controller = new AbortController();
      signal = AbortSignal.any([
        controller.signal,
        AbortSignal.timeout(10_000),
      ]);
    } catch {
      // No attempt is admitted until its identity and bounded read are ready.
      if (alive.current) setState("failed");
      return;
    }
    setAttempt(selected);
    setState("pending");
    pendingRead.current = controller;
    try {
      const response = await waitForTaskReferenceOperation(
        owner.server.gql({
          query: databaseTaskReferencesQuery,
          variables: {
            workspaceId: owner.workspace.id,
            targets: [selected.target],
          },
          context: { signal },
        }),
        signal,
      );
      if (!alive.current) return;
      const projection = response.workspace?.databaseTaskReferences[0];
      if (
        JSON.stringify([
          owner.server.id,
          owner.server.baseUrl,
          owner.server.account$.value?.id,
          owner.workspace.id,
        ]) !== openingOwnerIdentity
      ) {
        setState("failed");
        return;
      }
      if (
        projection?.state !== DatabaseTaskReferenceState.Available ||
        !projection.task ||
        projection.workspaceId !== selected.target.workspaceId ||
        projection.rowId !== selected.target.rowId ||
        projection.task.workspaceId !== selected.target.workspaceId ||
        projection.task.rowId !== selected.target.rowId ||
        projection.databaseId !== projection.task.databaseId
      ) {
        setState("failed");
        return;
      }
      // Selection shares current native reference admission, without editor writes.
      if (props.mode === "select") {
        props.onSelectTask({
          ...selected.target,
          databaseId: projection.task.databaseId,
        });
        close();
        return;
      }
      const result = await props.onInsertReference(
        selected.id,
        { ...selected.target, databaseId: projection.task.databaseId },
        props.source,
      );
      if (alive.current) setState(result);
    } catch {
      if (alive.current) setState("uncertain");
    } finally {
      if (pendingRead.current === controller) pendingRead.current = undefined;
    }
  };
  const locked = state === "pending" || Boolean(attempt);
  return (
    <Modal
      open
      title={
        props.mode === "select"
          ? props.title
          : t["com.myoxus.database.tasks.insert-existing"]()
      }
      onOpenChange={(open) => {
        if (!open && state !== "pending") close();
      }}
      persistent={state === "pending"}
      returnFocusRef={returnFocusRef}
      scrollable
    >
      <Stack>
        {state === "failed" || state === "uncertain" || state === "readonly" ? (
          <Notice tone="warning">
            {props.mode === "select"
              ? t["com.myoxus.database.row_detail.unavailable"]()
              : t["com.myoxus.database.tasks.reference-insert-failed"]()}
            {attempt && state !== "readonly" ? (
              <Button
                type="button"
                onClick={() => void insert(attempt.target, attempt.id)}
              >
                {t.Retry()}
              </Button>
            ) : null}
          </Notice>
        ) : null}
        <FormFieldset variant="unstyled" disabled={locked}>
          <Stack>
            <SearchInput
              label={t["com.myoxus.database.tasks.search"]()}
              value={search}
              onChange={(value) => {
                setSearch(value);
                setAfter(undefined);
              }}
            />
            <FormSelect
              label={t["com.myoxus.database.tasks.destination"]()}
              clearable
              value={projectId || null}
              onChange={(value) => {
                setProjectId(value);
                setAfter(undefined);
              }}
              onClear={() => {
                setProjectId("");
                setAfter(undefined);
              }}
              data={projects.readyDestinations.map((project) => ({
                value: project.id,
                label: project.workspaceTasks
                  ? t["com.myoxus.database.tasks.workspace-tasks"]()
                  : project.title,
              }))}
            />
            <FormSelect
              label={t["com.myoxus.database.tasks.lifecycle"]()}
              value={lifecycle}
              onChange={(value) => {
                setLifecycle(
                  value === DatabaseTaskLifecycle.Closed
                    ? DatabaseTaskLifecycle.Closed
                    : DatabaseTaskLifecycle.Open,
                );
                setAfter(undefined);
              }}
              data={[
                {
                  value: DatabaseTaskLifecycle.Open,
                  label: t["com.myoxus.database.tasks.open"](),
                },
                {
                  value: DatabaseTaskLifecycle.Closed,
                  label: t["com.myoxus.database.tasks.closed"](),
                },
              ]}
            />
            {read.isLoading ? (
              <Loading />
            ) : read.error ? (
              <Notice tone="error">
                <Button type="button" onClick={() => void read.mutate()}>
                  {t.Retry()}
                </Button>
              </Notice>
            ) : !read.page?.rows.length ? (
              <EmptyState title={t["com.myoxus.database.tasks.no-matches"]()} />
            ) : (
              read.page.rows.map((task) => (
                <TaskReferenceSummary
                  key={task.rowId}
                  task={task}
                  onOpen={() =>
                    void insert({
                      workspaceId: task.workspaceId,
                      databaseId: task.databaseId,
                      rowId: task.rowId,
                    })
                  }
                />
              ))
            )}
            {read.page ? (
              <TaskCoverageNotice
                coverageComplete={read.page.coverageComplete}
                unavailableProjects={read.page.unavailableProjects}
              />
            ) : null}
            {read.page?.nextCursor ? (
              <Button
                type="button"
                onClick={() => setAfter(read.page!.nextCursor!)}
              >
                {t["com.myoxus.database.load-more"]()}
              </Button>
            ) : null}
          </Stack>
        </FormFieldset>
        {state === "pending" ? <Loading /> : null}
        {state === "inserted" ? (
          <Notice tone="success">
            {t["com.myoxus.database.tasks.reference-inserted"]()}
          </Notice>
        ) : null}
        <Group justify="end">
          <Button
            type="button"
            variant="secondary"
            disabled={state === "pending"}
            onClick={() => close()}
          >
            {t["com.myoxus.peek-view-controls.close"]()}
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}
