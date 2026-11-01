// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { DocsService } from "@myoxus/core/modules/doc";
import { DocumentMetadataCacheService } from "@myoxus/core/modules/document-metadata/services/document-metadata-cache";
import { MyoxusErrorBoundary } from "@myoxus/core/components/myoxus/myoxus-error-boundary";
import { VirgultumEditor } from "@myoxus/core/editor/virgultum/doc-editor";
import { createReadonlySnapshotWorkspace } from "@myoxus/core/modules/doc/services/readonly-snapshot-workspace";
import { FeatureFlagService } from "@myoxus/core/modules/feature-flag";
import { GuardService } from "@myoxus/core/modules/permissions";
import { FetchService, ServerService } from "@myoxus/core/modules/server";
import {
  WorkspaceService,
  WorkspacesService,
} from "@myoxus/core/modules/workspace";
import { useLiveData, useService } from "@myoxus/infra";
import { useI18n } from "@myoxus/i18n";
import {
  Box,
  Button,
  DetailPageEditorViewport,
  Divider,
  Loading,
  Scrollable,
  SettingsNotice,
  Stack,
  Text,
  Title,
} from "@myoxus/ui-facade";
import type { Store } from "@virgultum/editor/store";
import { useCallback, useEffect, useMemo, useState } from "react";

type ReadingState =
  | { kind: "loading" }
  | { kind: "ready"; page: Store }
  | { kind: "empty" | "unavailable" | "unsupported" | "denied" | "error" };

type OwnedReading = { key: string; state: ReadingState };

/**
 * One opening attempt owns one current-document read and one detached store.
 * No live document, history read or sync writer is attached to the snapshot.
 */
export function useDocReadingPreview(
  docId: string,
  attempt = 0,
): {
  state: ReadingState;
  retry: () => void;
} {
  const workspace = useService(WorkspaceService).workspace;
  const workspaces = useService(WorkspacesService);
  const features = useService(FeatureFlagService);
  const fetch = useService(FetchService).fetch;
  const server = useService(ServerService).server;
  const guard = useService(GuardService);
  const list = useService(DocsService).list;
  const metadata = useService(DocumentMetadataCacheService);
  const index = useLiveData(metadata.watchIndexState());
  const ready = useLiveData(list.isReady$);
  const record = useLiveData(list.doc$(docId));
  const trash = useLiveData(record?.trash$);
  const mode$ = useMemo(() => list.primaryMode$(docId), [list, docId]);
  // DocRecord.primaryMode$ defaults to page before metadata has arrived.
  // Only the confirmed list setting can admit a Page snapshot.
  useLiveData(mode$);
  // A confirmed index row with no explicit mode denotes the persisted Page
  // default. Before that row exists, the record's optimistic Page value is not
  // evidence of mode and must never admit a snapshot.
  const confirmedMode = useCallback(() => {
    if (!ready || !record || index.phase !== "ready") return undefined;
    const row = metadata.getIndexRowByExternalId(docId);
    if (!row) return undefined;
    return list.getPrimaryMode(docId) ?? row.primaryMode ?? "page";
  }, [ready, record, index, metadata, docId, list]);
  const mode = confirmedMode();
  const permission$ = useMemo(
    () => guard.can$("Doc_Read", docId),
    [guard, docId],
  );
  const permission = useLiveData(permission$);
  const account = useLiveData(server.account$);
  const accountId = account?.id;
  const [retryNo, setRetryNo] = useState(0);
  const retry = useCallback(() => setRetryNo((value) => value + 1), []);
  const key = JSON.stringify([
    server.id,
    accountId,
    workspace.id,
    docId,
    attempt,
    retryNo,
  ]);
  const [owned, setOwned] = useState<OwnedReading>();

  const blockedKind: Exclude<ReadingState["kind"], "ready"> | undefined =
    !accountId
      ? "denied"
      : !ready
        ? "loading"
        : !record
          ? "unavailable"
          : trash
            ? "unavailable"
            : permission === false
              ? "denied"
              : mode === "edgeless"
                ? "unsupported"
                : mode !== "page" || permission !== true
                  ? "loading"
                  : undefined;
  const blocked = blockedKind ? { kind: blockedKind } : undefined;

  useEffect(() => {
    if (blockedKind) {
      setOwned(undefined);
      if (accountId && ready && record && permission === undefined) {
        void guard.can("Doc_Read", docId).catch(() => {
          // A failed capability read cannot authorize the snapshot.
          setOwned({ key, state: { kind: "error" } });
        });
      }
      return;
    }

    const abort = new AbortController();
    let current = true;
    let dispose: (() => void) | undefined;
    setOwned({ key, state: { kind: "loading" } });
    void (async () => {
      try {
        const response = await fetch(
          `/api/workspaces/${encodeURIComponent(workspace.id)}/docs/${encodeURIComponent(docId)}`,
          { signal: abort.signal, throwOnHttpError: false },
        );
        if (!current) return;
        if (response.status === 403 || response.status === 404) {
          setOwned({ key, state: { kind: "unavailable" } });
          return;
        }
        if (!response.ok) throw new Error("Document read failed");
        const bytes = new Uint8Array(await response.arrayBuffer());
        if (!current) return;
        // The guard's earlier cached grant is not an authorization for a
        // response that arrived after permission or account changed.
        if (!(await guard.can("Doc_Read", docId)) || !current) {
          if (current) setOwned({ key, state: { kind: "denied" } });
          return;
        }
        if (
          server.account$.value?.id !== accountId ||
          list.doc$(docId).value !== record ||
          record?.trash$.value ||
          confirmedMode() !== "page" ||
          permission$.value !== true
        ) {
          setOwned({ key, state: { kind: "unavailable" } });
          return;
        }
        if (!bytes.byteLength) {
          setOwned({ key, state: { kind: "empty" } });
          return;
        }
        const shell = createReadonlySnapshotWorkspace(
          workspace.id,
          features,
          workspaces.getWorkspaceFlavourProvider(workspace.meta),
        );
        dispose = () => shell.dispose();
        const page = shell.loadSnapshot(docId, bytes);
        if (!current) return;
        setOwned({ key, state: { kind: "ready", page } });
      } catch {
        dispose?.();
        dispose = undefined;
        if (current) setOwned({ key, state: { kind: "error" } });
      }
    })();
    return () => {
      current = false;
      abort.abort();
      dispose?.();
    };
  }, [
    accountId,
    blockedKind,
    confirmedMode,
    docId,
    features,
    fetch,
    guard,
    key,
    index,
    list,
    permission,
    permission$,
    ready,
    record,
    server,
    trash,
    workspace,
    workspaces,
  ]);

  return {
    state:
      blocked?.kind === "loading" &&
      owned?.key === key &&
      owned.state.kind === "error"
        ? owned.state
        : (blocked ?? (owned?.key === key ? owned.state : { kind: "loading" })),
    retry,
  };
}

/** Reader chrome and native Page rendering share the existing peek frame. */
export function DocReadingPreview({
  docId,
  attempt,
}: {
  docId: string;
  attempt: number;
}) {
  const t = useI18n();
  const list = useService(DocsService).list;
  const record = useLiveData(list.doc$(docId));
  const title = useLiveData(record?.title$);
  const { state, retry } = useDocReadingPreview(docId, attempt);
  return (
    <Stack gap={0} h="100%" data-myoxus-ui-role="document-reading-preview">
      <Box p="md">
        <Title order={4}>{title}</Title>
        <Text c="dimmed">
          {t["com.myoxus.common.reading-preview-status"]()}
        </Text>
      </Box>
      <Divider />
      {state.kind === "ready" ? (
        <MyoxusErrorBoundary key={state.page.id}>
          <Scrollable.Root
            flex="1 1 0"
            minHeight={0}
            data-myoxus-ui-role="document-reading-scroll"
          >
            <Scrollable.Viewport
              fill
              scrollbars="y"
              data-myoxus-ui-role="document-reading-viewport"
            >
              <DetailPageEditorViewport editorMode="page" pageModeContentBox>
                <VirgultumEditor
                  mode="page"
                  page={state.page}
                  readonly
                  snapshot
                />
              </DetailPageEditorViewport>
            </Scrollable.Viewport>
            <Scrollable.Scrollbar />
          </Scrollable.Root>
        </MyoxusErrorBoundary>
      ) : state.kind === "loading" ? (
        <Loading />
      ) : state.kind === "error" ? (
        <SettingsNotice tone="error">
          {t["com.myoxus.common.reading-preview-error"]()}
          <Button onClick={retry}>{t["Retry"]()}</Button>
        </SettingsNotice>
      ) : (
        <SettingsNotice>
          {state.kind === "empty"
            ? t["com.myoxus.selectPage.empty"]()
            : state.kind === "unsupported"
              ? t["com.myoxus.common.reading-preview-page-only"]()
              : t["com.myoxus.common.preview-unavailable"]()}
        </SettingsNotice>
      )}
    </Stack>
  );
}
