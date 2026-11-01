// SPDX-License-Identifier: AGPL-3.0-or-later

import { ErrorBoundary } from "@sentry/react";
import { useI18n } from "@myoxus/i18n";
import { FrameworkScope, useLiveData, useService } from "@myoxus/infra";
import { Button, Group, Loading, SettingsNotice } from "@myoxus/ui-facade";
import { DisposableGroup } from "@virgultum/global/disposable";
import type { Store } from "@virgultum/store";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Transaction } from "yjs";

import { VirgultumEditor } from "../../../editor/virgultum/doc-editor";
import { type Doc, DocsService } from "../../doc";
import { type Editor, EditorsService } from "../../editor";
import { createReadonlySnapshotWorkspace } from "../../doc/services/readonly-snapshot-workspace";
import { FeatureFlagService } from "../../feature-flag";
import { GuardService } from "../../permissions";
import { WorkbenchService } from "../../workbench/services/workbench";
import { WorkspaceService, WorkspacesService } from "../../workspace";
import { waitForTemplateOperation } from "../services/template-instantiation-error";
import { captureTemplateSource } from "../services/template-source-capture";
import {
  TemplateDocService,
  TemplateSuggestionSurface,
} from "../services/template-doc";

type PreviewFailure = "denied" | "missing" | "changed" | "failed";
type PreviewState = {
  key: string;
  page?: Store;
  doc?: Doc;
  editor?: Editor;
  failure?: PreviewFailure;
  revision?: Uint8Array;
};

/** One selected source, rendered natively without document identity or live writers. */
export function BuildingBlockPreview({
  sourceDocId,
  sourceRevisionId,
  onReady,
}: {
  sourceDocId: string;
  sourceRevisionId?: string | null;
  onReady?: (revision: Uint8Array | null) => void;
}) {
  const t = useI18n();
  const docs = useService(DocsService);
  const templates = useService(TemplateDocService);
  const guard = useService(GuardService);
  const featureFlags = useService(FeatureFlagService);
  const workspace = useService(WorkspaceService).workspace;
  const workspaces = useService(WorkspacesService);
  const workbench = useService(WorkbenchService).workbench;
  const read$ = useMemo(() => guard.can$("Workspace_Read"), [guard]);
  const canRead = useLiveData(read$);
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<PreviewState>();
  const key = JSON.stringify([
    workspace.id,
    sourceDocId,
    sourceRevisionId,
    attempt,
  ]);
  const lifetime = useRef<{ key: string; group: DisposableGroup } | null>(null);
  const retry = useCallback(() => setAttempt((value) => value + 1), []);

  useEffect(() => {
    const group = new DisposableGroup();
    const abort = new AbortController();
    const signal = AbortSignal.any([abort.signal, AbortSignal.timeout(30_000)]);
    group.add(() => abort.abort());
    lifetime.current = { key, group };
    const fail = (failure: PreviewFailure) => {
      if (group.disposed) return;
      group.dispose();
      setState({ key, failure });
    };
    void (async () => {
      try {
        const sourceItem = await waitForTemplateOperation<
          | {
              templateDocId: string | null;
              category: string | null;
              available: boolean;
              sourceRevisionId?: string | null;
            }
          | null
          | undefined
        >(
          workspace.flavour === "local"
            ? templates
                .loadTemplateSuggestions({
                  surface: TemplateSuggestionSurface.BuildingBlock,
                  locale: t.language,
                })
                .then((inventory) =>
                  inventory.items.find(
                    (item) => item.templateDocId === sourceDocId,
                  ),
                )
            : templates.lookupTemplateSource(sourceDocId, t.language),
          signal,
        );
        if (
          sourceItem?.templateDocId !== sourceDocId ||
          sourceItem.category !== "building-blocks" ||
          !sourceItem.available
        ) {
          fail("missing");
          return;
        }
        if (
          sourceRevisionId !== undefined &&
          sourceItem.sourceRevisionId !== sourceRevisionId
        ) {
          fail("changed");
          return;
        }
        const record = docs.list.doc$(sourceDocId).value;
        // Source hydration must also be readonly; an editable host can persist
        // missing schema defaults before the isolated snapshot is captured.
        const ref =
          record && !record.trash$.value
            ? docs.open(sourceDocId, { readonly: true })
            : null;
        if (!ref) {
          fail("missing");
          return;
        }
        let editor: Editor | undefined;
        group.add(() => {
          editor?.scope.dispose();
          editor?.dispose();
          ref.release();
        });
        await waitForTemplateOperation(
          ref.doc.waitForSyncReady(signal),
          signal,
        );
        // A local cache miss can finish loading before the remote leaf arrives.
        // Capture only after the existing sync owner has applied nonempty data.
        await waitForTemplateOperation(
          workspace.engine.doc.waitForDocReady(sourceDocId, signal),
          signal,
        );
        signal.throwIfAborted();
        using transformer = ref.doc.virgultumDoc.getTransformer();
        const source = captureTemplateSource(ref, transformer);
        const snapshot = createReadonlySnapshotWorkspace(
          workspace.id,
          featureFlags,
          workspaces.getWorkspaceFlavourProvider(workspace.meta),
        );
        group.add(snapshot);
        const page = snapshot.loadSnapshot(sourceDocId, source.revision);
        // The isolated Store still renders through the native Doc/Editor
        // extension chain; the Library itself supplies neither scope.
        editor = ref.doc.scope.get(EditorsService).createEditor();
        const changed = (transaction: Transaction) => {
          if (transaction.changed.size) fail("changed");
        };
        ref.doc.yDoc.on("afterTransaction", changed);
        group.add(() => ref.doc.yDoc.off("afterTransaction", changed));
        group.add(
          ref.doc.trash$.subscribe((trash) => {
            if (trash) fail("missing");
          }),
        );
        group.add(
          read$.subscribe((allowed) => {
            if (allowed === false) fail("denied");
          }),
        );
        if (!group.disposed)
          setState({
            key,
            page,
            doc: ref.doc,
            editor,
            revision: source.revision,
          });
      } catch {
        fail("failed");
      }
    })();
    return () => group.dispose();
  }, [
    docs,
    featureFlags,
    guard,
    key,
    read$,
    sourceDocId,
    sourceRevisionId,
    templates,
    t.language,
    workspace,
    workspaces,
  ]);

  const rendererFailed = useCallback(() => {
    if (lifetime.current?.key !== key || lifetime.current.group.disposed)
      return;
    lifetime.current.group.dispose();
    setState({ key, failure: "failed" });
  }, [key]);

  // Hide the previous selection before its effect cleanup, including access loss.
  const current = state?.key === key ? state : undefined;
  const failure = canRead === false ? "denied" : current?.failure;
  useEffect(() => {
    onReady?.(!failure && current?.page ? (current.revision ?? null) : null);
  }, [onReady, failure, current?.page, current?.revision]);
  if (failure) {
    const messages: Record<PreviewFailure, string> = {
      denied: t["com.myoxus.templates.library.readiness.access-denied"](),
      missing: t["com.myoxus.templates.library.readiness.source-missing"](),
      changed: t["com.myoxus.templates.preview.changed"](),
      failed: t["com.myoxus.templates.preview.failed"](),
    };
    return (
      <SettingsNotice tone={failure === "failed" ? "error" : "info"}>
        {messages[failure]}
        <Group>
          <Button onClick={retry}>{t["Retry"]()}</Button>
          {canRead && failure !== "missing" ? (
            <Button
              onClick={() => workbench.openDoc(sourceDocId, { at: "active" })}
            >
              {t["com.myoxus.templates.preview.open-source"]()}
            </Button>
          ) : null}
        </Group>
      </SettingsNotice>
    );
  }
  if (!current?.page || !current.doc || !current.editor) return <Loading />;
  return (
    <ErrorBoundary key={key} onError={rendererFailed}>
      <FrameworkScope scope={current.doc.scope}>
        <FrameworkScope scope={current.editor.scope}>
          <VirgultumEditor
            mode="page"
            page={current.page}
            readonly
            snapshot
            contentOnly
            onEditorError={rendererFailed}
          />
        </FrameworkScope>
      </FrameworkScope>
    </ErrorBoundary>
  );
}
