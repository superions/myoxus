// SPDX-License-Identifier: AGPL-3.0-or-later

import { ErrorBoundary } from "@sentry/react";
import { VirgultumEditor } from "@myoxus/core/editor/virgultum/doc-editor";
import { type Doc, DocsService } from "@myoxus/core/modules/doc";
import { type Editor, EditorsService } from "@myoxus/core/modules/editor";
import { GuardService } from "@myoxus/core/modules/permissions";
import { useI18n } from "@myoxus/i18n";
import { FrameworkScope, useLiveData, useService } from "@myoxus/infra";
import { Button, Loading, SettingsNotice } from "@myoxus/ui-facade";
import { DisposableGroup } from "@virgultum/editor/global/disposable";
import type { Store } from "@virgultum/editor/store";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

/** A mounted reading view over the real leaf. Its readonly Store owns no Y.Doc,
 * persistence or shared permission state; disposal releases only this host.
 */
export function WorkspaceIntroduction({ docId }: { docId: string }) {
  const t = useI18n();
  const docs = useService(DocsService);
  const guard = useService(GuardService);
  const read$ = useMemo(() => guard.can$("Doc_Read", docId), [guard, docId]);
  const canRead = useLiveData(read$);
  const [attempt, setAttempt] = useState(0);
  const key = `${docId}:${attempt}`;
  const [state, setState] = useState<{
    key: string;
    view?: { page: Store; doc: Doc; editor: Editor };
    failed?: boolean;
  }>();
  const lifetime = useRef<{ key: string; group: DisposableGroup } | null>(null);
  const retry = useCallback(() => setAttempt((value) => value + 1), []);

  useEffect(() => {
    const group = new DisposableGroup();
    const abort = new AbortController();
    const signal = AbortSignal.any([abort.signal, AbortSignal.timeout(30_000)]);
    group.add(() => abort.abort());
    lifetime.current = { key, group };
    const fail = () => {
      if (group.disposed) return;
      group.dispose();
      setState({ key, failed: true });
    };
    void (async () => {
      try {
        if (!(await guard.can("Doc_Read", docId)))
          throw new Error("Introduction read denied");
        signal.throwIfAborted();
        const reference = docs.open(docId, { readonly: true });
        if (!reference || reference.doc.trash$.value) {
          reference?.release();
          throw new Error("Introduction source is unavailable");
        }
        let editor: Editor | undefined;
        group.add(() => {
          editor?.scope.dispose();
          editor?.dispose();
          reference.release();
        });
        await reference.doc.waitForSyncReady(signal);
        if (!(await guard.can("Doc_Read", docId)))
          throw new Error("Introduction read denied");
        signal.throwIfAborted();
        const page = reference.doc.virgultumDoc;
        if (!page.root) throw new Error("Introduction has no native root");
        // Reuse the native Doc/Editor service chain without binding its commands,
        // mode or selection to the overview Workbench view.
        editor = reference.doc.scope.get(EditorsService).createEditor();
        group.add(
          read$.subscribe((value) => {
            if (value === false) fail();
          }),
        );
        if (!group.disposed)
          setState({ key, view: { page, doc: reference.doc, editor } });
      } catch {
        fail();
      }
    })();
    return () => group.dispose();
  }, [docs, guard, docId, key, read$]);

  const rendererFailed = useCallback(() => {
    if (lifetime.current?.key !== key || lifetime.current.group.disposed)
      return;
    lifetime.current.group.dispose();
    setState({ key, failed: true });
  }, [key]);
  const current = state?.key === key ? state : undefined;
  if (canRead === false || current?.failed) {
    return (
      <SettingsNotice>
        {t["com.myoxus.workspace-overview.introduction.unavailable"]()}
        <Button onClick={retry}>{t["Retry"]()}</Button>
      </SettingsNotice>
    );
  }
  if (!current?.view) return <Loading />;
  return (
    <ErrorBoundary key={key} onError={rendererFailed}>
      <FrameworkScope scope={current.view.doc.scope}>
        <FrameworkScope scope={current.view.editor.scope}>
          <VirgultumEditor
            page={current.view.page}
            mode="page"
            readonly
            shared
            contentOnly
            onEditorError={rendererFailed}
          />
        </FrameworkScope>
      </FrameworkScope>
    </ErrorBoundary>
  );
}
