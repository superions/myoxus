// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  lazy,
  Suspense,
  useLayoutEffect,
  useReducer,
  useRef,
  useCallback,
  useState,
} from "react";
import { EditorLoading } from "@myoxus/ui-facade";
import type { EditorProps } from "./virgultum-editor";
import { plainPageLines } from "./plain-page-model";
import { PlainPageView } from "./plain-page-view";
import type { PageInteraction } from "./page-interaction";
import {
  bookmark,
  resolveBookmark,
  type PageBookmark,
  type PageIntent,
} from "./plain-page-input";
import { holdPageText } from "./page-input-lease";
import type { EditorSlashControls } from "@virgultum/core/services";
import { EditorSlashMenu } from "../../view-extensions/editor-view/editor-chrome/slash-menu";
let receiver: typeof import("./legacy-entry") | undefined;
const loadLegacy = async () => (receiver ??= await import("./legacy-entry"));
const Legacy = lazy(loadLegacy);

function WebPage(props: EditorProps) {
  const { page, readonly, onEditorReady, onEditorError } = props;
  const [, refresh] = useReducer((n) => n + 1, 0);
  const owner = useRef<PageInteraction | null>(null);
  const pending = useRef<{
    range: PageBookmark | null;
    intent?: PageIntent;
  } | null>(null);
  const [legacy, setLegacy] = useState(false);
  const [slash, setSlash] = useState<EditorSlashControls | null>(null);
  const alive = useRef(false);
  const lease = useRef<ReturnType<typeof holdPageText> | null>(null);
  const transfer = useCallback(
    (range: PageBookmark | null, intent?: PageIntent) => {
      pending.current = { range, intent };
      if (range && intent?.kind !== "slash")
        lease.current ??= holdPageText(page.id);
      // Keep accepting native input while the receiver's chunk loads. Its
      // slash query starts at the original trigger, not the later caret.
      void loadLegacy()
        .then(() => {
          if (!alive.current) return;
          if (intent?.kind === "slash")
            pending.current = {
              range: owner.current?.selection ?? range,
              intent,
            };
          if (range)
            lease.current ??= holdPageText(
              page.id,
              intent?.kind === "slash"
                ? (text) => {
                    const transfer = pending.current;
                    const r =
                      transfer?.range && resolveBookmark(page, transfer.range);
                    const model = r && page.getModelById(r.focus.id);
                    if (
                      !transfer ||
                      !r ||
                      !model?.text ||
                      page.readonly ||
                      readonly ||
                      page.hasFixedText(model) ||
                      r.focus.id !== r.anchor.id ||
                      r.focus.offset !== r.anchor.offset
                    )
                      return false;
                    const at = r.focus.offset;
                    page.transact(() => model.text!.yText.insert(at, text));
                    const end = { id: model.id, offset: at + text.length };
                    transfer.range = bookmark(last.current ?? [], {
                      anchor: end,
                      focus: end,
                    });
                    return true;
                  }
                : undefined,
            );
          setLegacy(true);
        })
        .catch((error) => {
          lease.current?.release();
          lease.current = null;
          (onEditorError ?? console.error)(error);
        });
    },
    [onEditorError, readonly, page],
  );
  const last = useRef<ReturnType<typeof plainPageLines>>(null);
  const legacyReady = useCallback<NonNullable<EditorProps["onEditorReady"]>>(
    (editor) => {
      setLegacy(true);
      const dispose = onEditorReady?.(editor);
      const request = pending.current;
      pending.current = null;
      const abort = new AbortController();
      if (request?.range)
        void loadLegacy()
          .then(async ({ resumePageIntent }) => {
            if (!abort.signal.aborted)
              await resumePageIntent(
                editor,
                request.range!,
                request.intent,
                abort.signal,
                () => lease.current?.release() ?? "",
                setSlash,
              );
          })
          .catch(onEditorError ?? console.error);
      return () => {
        abort.abort();
        dispose?.();
      };
    },
    [onEditorReady, onEditorError],
  );
  useLayoutEffect(() => {
    alive.current = true;
    const sub = page.slots.rootAdded.subscribe(refresh);
    page.spaceDoc.on("afterTransaction", refresh);
    refresh();
    return () => {
      alive.current = false;
      lease.current?.release();
      lease.current = null;
      sub.unsubscribe();
      page.spaceDoc.off("afterTransaction", refresh);
    };
  }, [page]);
  if (!page.root) return <EditorLoading />;
  const lines = owner.current?.isComposing
    ? last.current
    : plainPageLines(page);
  if (lines) last.current = lines;
  if (!lines || legacy) {
    if (owner.current && !pending.current)
      pending.current = { range: owner.current.selection ?? null };
    // Keep this session (and its pending input) mounted while a first
    // legacy-only document or a newly unsupported peer block suspends.
    const ReceivingEditor = receiver?.default ?? Legacy;
    return (
      <Suspense fallback={<EditorLoading />}>
        <ReceivingEditor {...props} onEditorReady={legacyReady} />
        {slash && <EditorSlashMenu controls={slash} />}
      </Suspense>
    );
  }
  return (
    <PlainPageView
      page={page}
      readonly={Boolean(props.readonly)}
      lines={lines}
      refresh={refresh}
      controller={owner}
      handoff={transfer}
      className={props.className}
      fullWidth={props["data-full-width-layout"]}
    />
  );
}

export function VirgultumEditor(props: EditorProps) {
  return (
    <Suspense fallback={<EditorLoading />}>
      {BUILD_CONFIG.isWeb &&
      props.mode === "page" &&
      !props.shared &&
      !props.snapshot &&
      !props.contentOnly &&
      props.plainPage ? (
        <WebPage key={props.page.id} {...props} />
      ) : (
        <Legacy {...props} />
      )}
    </Suspense>
  );
}
