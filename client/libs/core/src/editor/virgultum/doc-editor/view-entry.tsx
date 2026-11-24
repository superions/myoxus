// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  lazy,
  Suspense,
  useLayoutEffect,
  useReducer,
  useRef,
  useCallback,
  useContext,
  useState,
} from "react";
import { EditorLoading } from "@myoxus/ui-facade";
import { readRasterSurface } from "./raster-surface";
import { useLiveData, useService } from "@myoxus/infra";
import { EditorService } from "../../../modules/editor";
import { useEnableAI } from "../../../components/hooks/myoxus/use-enable-ai";
import type { EditorProps } from "./virgultum-editor";
import { canReadPageSnapshot, readPageContent } from "./plain-page-model";
import { PlainPageView, PageSnapshot } from "./plain-page-view";
import { DesktopPageRendererContext } from "./page-renderer-context";
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
const CanvasReader = lazy(() => import("./canvas-preview"));

function ReadonlyCanvas(props: EditorProps) {
  const { page } = props;
  const [, refresh] = useReducer((n) => n + 1, 0);
  const editor = useService(EditorService).editor,
    selector = useLiveData(editor.selector$);
  const [legacy, setLegacy] = useState(false),
    origin = useRef<HTMLDivElement>(null),
    present = useRef(false);
  useLayoutEffect(() => {
    const awareness = page.awarenessStore.awareness;
    const root = page.slots.rootAdded.subscribe(refresh),
      readonly = page.readonly$.subscribe(refresh);
    page.spaceDoc.on("afterTransaction", refresh);
    awareness.on("change", refresh);
    refresh();
    return () => {
      root.unsubscribe();
      readonly();
      page.spaceDoc.off("afterTransaction", refresh);
      awareness.off("change", refresh);
    };
  }, [page]);
  const surface = readRasterSurface(page);
  const native =
    !!surface &&
    !legacy &&
    page.readonly &&
    !selector?.elementIds?.length &&
    !selector?.blockIds?.length &&
    !selector?.commentId &&
    page.awarenessStore.getStates().size <= 1;
  useLayoutEffect(() => {
    if (native && origin.current)
      return editor.bindCanvasOrigin(
        origin.current,
        () => setLegacy(true),
        () => {
          present.current = true;
          setLegacy(true);
        },
      );
    return;
  }, [editor, native]);
  const ready = useCallback<NonNullable<EditorProps["onEditorReady"]>>(
    (container) => {
      const release = props.onEditorReady?.(container);
      if (present.current) {
        present.current = false;
        editor.togglePresentation();
      }
      return release;
    },
    [editor, props.onEditorReady],
  );
  if (!page.root) return <EditorLoading />;
  if (!native) return <Legacy {...props} onEditorReady={ready} />;
  return (
    <div
      ref={origin}
      className="myoxus-edgeless-viewport"
      data-testid={`editor-${page.id}`}
      style={{ height: "100%" }}
    >
      <CanvasReader
        surface={surface!}
        title={page.meta?.title ?? ""}
        interactive
      />
    </div>
  );
}
const Fields = lazy(async () => ({
  default: (await import("./document-field-presentation"))
    .DocumentFieldPresentationProvider,
}));

function EditablePage(props: EditorProps) {
  const enableAI = useEnableAI();
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
                    transfer.range = bookmark(last.current?.lines ?? [], {
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
  const last = useRef<ReturnType<typeof readPageContent>>(null);
  const needsFields = useRef(false);
  const legacyReady = useCallback<NonNullable<EditorProps["onEditorReady"]>>(
    (editor) => {
      setLegacy(true);
      const dispose = onEditorReady?.(editor);
      const request = pending.current;
      pending.current = null;
      const abort = new AbortController();
      if (
        request &&
        (request.range ||
          request.intent?.kind === "block-paste" ||
          request.intent?.kind === "block-command" ||
          request.intent?.kind === "table-cell")
      )
        void loadLegacy()
          .then(async ({ resumePageIntent }) => {
            if (!abort.signal.aborted)
              await resumePageIntent(
                editor,
                request.range,
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
    const stopReadonly = page.readonly$.subscribe(refresh);
    page.spaceDoc.on("afterTransaction", refresh);
    refresh();
    return () => {
      alive.current = false;
      lease.current?.release();
      lease.current = null;
      sub.unsubscribe();
      stopReadonly();
      page.spaceDoc.off("afterTransaction", refresh);
    };
  }, [page]);
  if (!page.root) return <EditorLoading />;
  const content = owner.current?.isComposing
    ? last.current
    : readPageContent(page);
  if (content) last.current = content;
  if (!content || legacy) {
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
  const view = (
    <PlainPageView
      page={page}
      readonly={Boolean(props.readonly || page.readonly)}
      content={content}
      refresh={refresh}
      controller={owner}
      handoff={transfer}
      enableAI={enableAI}
      className={props.className}
      fullWidth={props["data-full-width-layout"]}
    />
  );
  // Keep the provider when the final field is converted back to text so the
  // conversion's restored caret stays in the same mounted Page.
  needsFields.current ||= content.lines.some((l) =>
    l.text
      .toDelta()
      .some(
        (d: { attributes?: Record<string, unknown> }) =>
          d.attributes?.documentField,
      ),
  );
  return needsFields.current ? (
    <Suspense fallback={<EditorLoading />}>
      <Fields page={page}>{view}</Fields>
    </Suspense>
  ) : (
    view
  );
}

function SnapshotPage(props: EditorProps) {
  // This store is immutable and fully materialized by the history/reading owner.
  const content = readPageContent(props.page);
  if (!content || !canReadPageSnapshot(content)) return <Legacy {...props} />;
  return (
    <PageSnapshot
      page={props.page}
      content={content}
      className={props.className}
      fullWidth={props["data-full-width-layout"]}
    />
  );
}

export function VirgultumEditor(props: EditorProps) {
  const desktopPage = useContext(DesktopPageRendererContext);
  return (
    <Suspense fallback={<EditorLoading />}>
      {(BUILD_CONFIG.isWeb || desktopPage) &&
      props.mode === "page" &&
      props.snapshot &&
      props.readonly &&
      props.page.readonly &&
      !props.onEditorReady &&
      !props.contentOnly &&
      !props.shared ? (
        <SnapshotPage {...props} />
      ) : (BUILD_CONFIG.isWeb || desktopPage) &&
        props.mode === "page" &&
        !props.shared &&
        !props.snapshot &&
        !props.contentOnly &&
        props.plainPage ? (
        <EditablePage key={props.page.id} {...props} />
      ) : (BUILD_CONFIG.isWeb || desktopPage) &&
        props.mode === "edgeless" &&
        props.plainPage &&
        props.readonly &&
        !props.snapshot &&
        !props.contentOnly &&
        !props.shared ? (
        <ReadonlyCanvas key={props.page.id} {...props} />
      ) : (
        <Legacy {...props} />
      )}
    </Suspense>
  );
}
