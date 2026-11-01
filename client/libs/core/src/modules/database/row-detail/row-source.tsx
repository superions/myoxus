// SPDX-License-Identifier: AGPL-3.0-or-later

import { DocsService } from "@myoxus/core/modules/doc";
import { GuardService } from "@myoxus/core/modules/permissions";
import { WorkspaceService } from "@myoxus/core/modules/workspace";
import { WorkbenchService } from "@myoxus/core/modules/workbench/services/workbench";
import {
  databaseRowSourceQuery,
  DatabaseTaskSourceState,
} from "@myoxus/graphql";
import { useI18n } from "@myoxus/i18n";
import { useFramework } from "@myoxus/infra";
import { Button, Group, Loading, MyoxusText, Stack } from "@myoxus/ui-facade";
import { TextSelection } from "@virgultum/editor/std";
import { localFootnoteInsertionNote } from "@virgultum/editor/shared/commands";
import type { DocMode } from "@virgultum/editor/model";
import { useEffect, useMemo, useRef, useState } from "react";
import useSWR, { SWRConfig } from "swr";
import { useTaskIdentity } from "../tasks/use-workspace-tasks";
import { waitForTaskReferenceOperation } from "../tasks/task-reference-operation";

type Props = {
  workspaceId: string;
  databaseId: string;
  rowId: string;
  onOpenDoc: (key: string) => void;
};

/** Each opening authorizes again; a disposed source title never warms a later
 * dialog after ACL changes. No historical redirect may retarget this SQL source.
 */
export function DatabaseRowSource(props: Props) {
  const owner = useTaskIdentity();
  const cache = useMemo(
    () => new Map(),
    [owner.identity, props.workspaceId, props.databaseId, props.rowId],
  );
  return (
    <SWRConfig
      key={JSON.stringify([
        owner.identity,
        props.workspaceId,
        props.databaseId,
        props.rowId,
      ])}
      value={{ provider: () => cache }}
    >
      <SourceSession {...props} />
    </SWRConfig>
  );
}

function SourceSession({ workspaceId, databaseId, rowId, onOpenDoc }: Props) {
  const t = useI18n();
  const framework = useFramework();
  const owner = useTaskIdentity();
  const { server, account, identity, availability } = owner;
  const lifetime = useRef(new AbortController());
  const alive = useRef(true);
  const [opening, setOpening] = useState(false);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      // StrictMode replays this same mounted scope synchronously. Defer only
      // transport disposal; the actor/navigation fence closes immediately.
      queueMicrotask(() => {
        if (!alive.current) lifetime.current.abort();
      });
    };
  }, []);
  const current = () =>
    alive.current &&
    server &&
    owner.workspace.id === workspaceId &&
    JSON.stringify([
      server.id,
      server.baseUrl,
      server.account$.value?.id,
      workspaceId,
    ]) === identity;
  const read = useSWR(
    server &&
      account &&
      availability.status === "available" &&
      owner.workspace.id === workspaceId
      ? ["database-row-source", identity, workspaceId, databaseId, rowId]
      : null,
    async () => {
      const signal = AbortSignal.any([
        lifetime.current.signal,
        AbortSignal.timeout(10_000),
      ]);
      const unavailable = {
        state: "unavailable" as const,
        source: null,
        blockIds: [] as string[],
        mode: "page" as DocMode,
      };
      const response = await waitForTaskReferenceOperation(
        server!.gql({
          query: databaseRowSourceQuery,
          variables: { workspaceId, databaseId, rowId },
          context: { signal },
        }),
        signal,
      );
      if (!current()) return unavailable;
      const source = response.workspace?.databaseRow?.row.source;
      if (!source) return { ...unavailable, state: "absent" as const };
      if (
        source.state !== DatabaseTaskSourceState.Available ||
        source.sourceWorkspaceId !== workspaceId ||
        !source.documentId ||
        !source.externalId
      )
        return unavailable;
      const guard = framework.get(GuardService);
      if (
        !(await waitForTaskReferenceOperation(
          guard.can("Doc_Read", source.externalId),
          signal,
        )) ||
        !current()
      )
        return unavailable;
      const ref = framework.get(DocsService).open(source.externalId);
      if (!ref) return unavailable;
      try {
        await waitForTaskReferenceOperation(
          ref.doc.waitForSyncReady(signal),
          signal,
        );
        await waitForTaskReferenceOperation(
          framework
            .get(WorkspaceService)
            .workspace.engine.doc.waitForSynced(source.externalId, signal),
          signal,
        );
        if (
          !current() ||
          ref.doc.trash$.value ||
          !(await waitForTaskReferenceOperation(
            guard.can("Doc_Read", source.externalId),
            signal,
          )) ||
          !current()
        )
          return unavailable;
        // Sync may outlive a document move or external-key replacement. Recheck
        // the immutable SQL binding before exposing the synchronized fragment.
        const latest = await waitForTaskReferenceOperation(
          server!.gql({
            query: databaseRowSourceQuery,
            variables: { workspaceId, databaseId, rowId },
            context: { signal },
          }),
          signal,
        );
        const canonical = latest.workspace?.databaseRow?.row.source;
        if (
          !current() ||
          canonical?.state !== DatabaseTaskSourceState.Available ||
          canonical.sourceWorkspaceId !== workspaceId ||
          canonical.documentId !== source.documentId ||
          canonical.externalId !== source.externalId
        )
          return unavailable;
        const store = ref.doc.virgultumDoc;
        let mode: DocMode = ref.doc.primaryMode$.value ?? "page";
        let blockIds = source.blockId ? [source.blockId] : [];
        let missing = false;
        let noteId: string | undefined;
        if (source.selectionAnchor) {
          try {
            const anchor = JSON.parse(source.selectionAnchor);
            const selection = TextSelection.fromJSON(anchor);
            // Context extends native TextSelection JSON; malformed context never
            // becomes a guessed fragment or another workspace's navigation.
            if (
              anchor.captureMode !== undefined ||
              anchor.noteId !== undefined
            ) {
              if (
                (anchor.captureMode !== "page" &&
                  anchor.captureMode !== "edgeless") ||
                typeof anchor.noteId !== "string" ||
                !anchor.noteId
              )
                missing = true;
              else {
                mode = anchor.captureMode;
                noteId = anchor.noteId;
              }
            }
            blockIds = [
              ...new Set([
                ...blockIds,
                selection.from.blockId,
                ...(selection.to ? [selection.to.blockId] : []),
              ]),
            ];
            for (const point of [selection.from, selection.to]) {
              if (!point) continue;
              const model = store.getBlock(point.blockId)?.model;
              if (
                !model?.text ||
                point.index < 0 ||
                point.length < 0 ||
                point.index + point.length > model.text.length
              )
                missing = true;
            }
          } catch {
            missing = true;
          }
        }
        if (
          blockIds.some((id) => {
            const model = store.getBlock(id)?.model;
            return (
              !model ||
              (noteId &&
                localFootnoteInsertionNote(store, model)?.id !== noteId)
            );
          })
        )
          missing = true;
        return {
          source: canonical,
          mode,
          blockIds: missing ? [] : blockIds,
          state: missing ? ("missing" as const) : ("available" as const),
        };
      } finally {
        ref.release();
      }
    },
    {
      suspense: false,
      keepPreviousData: false,
      suppressErrorNotification: true,
      revalidateOnFocus: true,
      revalidateOnReconnect: true,
    },
  );
  const data = current() && !read.error ? read.data : undefined;
  if (!read.error && !read.isLoading && data?.state === "absent") return null;
  const available =
    data?.source && (data.state === "available" || data.state === "missing");
  const open = async () => {
    if (opening) return;
    setOpening(true);
    try {
      // A click performs current SQL/Doc access readback before any navigation.
      const fresh = await read.mutate();
      if (
        !current() ||
        !fresh?.source ||
        !fresh.source.externalId ||
        (fresh.state !== "available" && fresh.state !== "missing")
      )
        return;
      if (fresh.blockIds.length)
        framework.get(WorkbenchService).workbench.openDoc({
          docId: fresh.source.externalId,
          mode: fresh.mode,
          blockIds: fresh.blockIds,
        });
      else onOpenDoc(fresh.source.externalId);
    } catch {
      /* SWR owns the visible unavailable state. */
    } finally {
      if (alive.current) setOpening(false);
    }
  };
  return (
    <Group>
      {read.isLoading || !available ? (
        <MyoxusText tone="secondary">
          {t["com.myoxus.database.tasks.capture-source"]()}
        </MyoxusText>
      ) : null}
      {read.isLoading ? (
        <Loading />
      ) : available ? (
        <Stack>
          {data?.state === "missing" ? (
            <MyoxusText tone="secondary">
              {t["com.myoxus.database.tasks.source-fragment-missing"]()}
            </MyoxusText>
          ) : null}
          <Button variant="link" disabled={opening} onClick={() => void open()}>
            {t["com.myoxus.database.tasks.capture-source"]()}
            {data?.source?.title ? ` · ${data.source.title}` : null}
          </Button>
        </Stack>
      ) : (
        <MyoxusText tone="secondary">
          {t["com.myoxus.template-list.unavailable"]()}
        </MyoxusText>
      )}
    </Group>
  );
}
