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
import { readPageContent } from "./plain-page-model";
import { VirgultumPageEditor, PageSnapshot } from "./plain-page-view";
import { DesktopPageRendererContext } from "./page-renderer-context";
import type { PageInteraction } from "./page-interaction";

let canvasSession:
  typeof import("./virgultum-editor").VirgultumEditor | undefined;
const loadCanvasSession = async () =>
  (canvasSession ??= (await import("./virgultum-editor")).VirgultumEditor);
const RegisteredCanvasEditor = lazy(async () => ({
  default: await loadCanvasSession(),
}));
const CanvasReader = lazy(() => import("./canvas-preview"));

function CanvasSnapshot(props: EditorProps) {
  const surface = readRasterSurface(props.page);
  return surface ? (
    <CanvasReader
      mode="snapshot"
      surface={surface}
      title={props.page.meta?.title ?? ""}
    />
  ) : (
    <RegisteredCanvasEditor {...props} />
  );
}

function ReadonlyCanvas(props: EditorProps) {
  const { page } = props;
  const [, refresh] = useReducer((n) => n + 1, 0);
  const editor = useService(EditorService).editor,
    selector = useLiveData(editor.selector$);
  const [interactive, setInteractive] = useState(false),
    origin = useRef<HTMLDivElement>(null),
    present = useRef(false);
  useLayoutEffect(() => {
    const root = page.slots.rootAdded.subscribe(refresh),
      readonly = page.readonly$.subscribe(refresh);
    page.spaceDoc.on("afterTransaction", refresh);
    refresh();
    return () => {
      root.unsubscribe();
      readonly();
      page.spaceDoc.off("afterTransaction", refresh);
    };
  }, [page]);
  const surface = readRasterSurface(page);
  const targetId = selector?.elementIds?.[0] || selector?.blockIds?.[0];
  const native =
    !!surface &&
    !interactive &&
    page.readonly &&
    (!targetId || !!surface.getElementById(targetId)) &&
    !selector?.commentId;
  useLayoutEffect(() => {
    if (native && origin.current)
      return editor.bindCanvasOrigin(origin.current, () => {
        present.current = true;
        setInteractive(true);
      });
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
  // The outer document route applies its readonly permission to this Store after mount.
  if (!page.root || !page.readonly) return <EditorLoading />;
  if (!native)
    return <RegisteredCanvasEditor {...props} onEditorReady={ready} />;
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
        mode="document"
        targetId={targetId}
        refreshKey={selector?.refreshKey}
      />
    </div>
  );
}

const Fields = lazy(async () => ({
  default: (await import("./document-field-presentation"))
    .DocumentFieldPresentationProvider,
}));

function hasDocumentFields(
  content: NonNullable<ReturnType<typeof readPageContent>>,
) {
  return (
    content.lines.some((l) =>
      l.text
        .toDelta()
        .some(
          (d: { attributes?: Record<string, unknown> }) =>
            d.attributes?.documentField,
        ),
    ) ||
    content.order.some(
      (item) =>
        !("text" in item) &&
        item.kind === "table" &&
        Object.values(item.model.props.cells).some((cell) =>
          cell.text
            ?.toDelta()
            .some(
              (d: { attributes?: Record<string, unknown> }) =>
                d.attributes?.documentField,
            ),
        ),
    )
  );
}

function EditablePage(props: EditorProps) {
  const enableAI = useEnableAI();
  const { page } = props;
  const [, refresh] = useReducer((n) => n + 1, 0);
  const owner = useRef<PageInteraction | null>(null);
  const last = useRef<ReturnType<typeof readPageContent>>(null);
  const needsFields = useRef(false);

  useLayoutEffect(() => {
    const sub = page.slots.rootAdded.subscribe(refresh);
    const stopReadonly = page.readonly$.subscribe(refresh);
    page.spaceDoc.on("afterTransaction", refresh);
    refresh();
    return () => {
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
  if (!content) return <EditorLoading />;

  const view = (
    <VirgultumPageEditor
      page={page}
      readonly={Boolean(props.readonly || page.readonly || props.shared)}
      shared={props.shared}
      content={content}
      refresh={refresh}
      journalDate={props.journalDate}
      controller={owner}
      enableAI={enableAI}
      className={props.className}
      fullWidth={props["data-full-width-layout"]}
      onEditorError={props.onEditorError}
    />
  );
  // Keep the provider when the final field is converted back to text so the
  // conversion's restored caret stays in the same mounted Page.
  needsFields.current ||= hasDocumentFields(content);
  return needsFields.current ? (
    <Suspense fallback={<EditorLoading />}>
      <Fields page={page}>{view}</Fields>
    </Suspense>
  ) : (
    view
  );
}

const SourceFields = lazy(async () => ({
  default: (await import("./document-field-presentation"))
    .DocumentFieldSourcePreviewProvider,
}));

function ReadonlyPage(props: EditorProps) {
  const { page, snapshot } = props;
  const [, refresh] = useReducer((revision) => revision + 1, 0);
  // An overview introduction follows its source. History and template snapshots
  // are detached, immutable views and need no live-document subscriptions.
  useLayoutEffect(() => {
    if (snapshot) return;
    const sub = page.slots.rootAdded.subscribe(refresh);
    page.spaceDoc.on("afterTransaction", refresh);
    refresh();
    return () => {
      sub.unsubscribe();
      page.spaceDoc.off("afterTransaction", refresh);
    };
  }, [page, snapshot]);
  if (!page.root) return <EditorLoading />;
  const sourceFields = !!(snapshot && props.templateSourcePreview);
  const content = readPageContent(
    page,
    sourceFields ? "source-fields" : "snapshot",
  );
  if (!content) return <EditorLoading />;
  const view = (
    <PageSnapshot
      page={props.page}
      content={content}
      className={props.className}
      fullWidth={props["data-full-width-layout"]}
      contentOnly={props.contentOnly}
    />
  );
  if (sourceFields) return <SourceFields>{view}</SourceFields>;
  if (hasDocumentFields(content)) {
    return (
      <Suspense fallback={<EditorLoading />}>
        <Fields page={page}>{view}</Fields>
      </Suspense>
    );
  }
  return view;
}

export function VirgultumEditor(props: EditorProps) {
  const desktopPage = useContext(DesktopPageRendererContext);
  return (
    <Suspense fallback={<EditorLoading />}>
      {props.mode === "page" ? (
        props.snapshot || props.contentOnly ? (
          <ReadonlyPage {...props} />
        ) : (
          <EditablePage key={props.page.id} {...props} />
        )
      ) : (BUILD_CONFIG.isWeb || desktopPage) &&
        props.snapshot &&
        props.readonly &&
        props.page.readonly &&
        !props.onEditorReady ? (
        <CanvasSnapshot {...props} />
      ) : (BUILD_CONFIG.isWeb || desktopPage) &&
        props.readonly &&
        !props.snapshot &&
        !props.contentOnly &&
        !props.shared &&
        !props.journalDate ? (
        <ReadonlyCanvas key={props.page.id} {...props} />
      ) : (
        <RegisteredCanvasEditor {...props} />
      )}
    </Suspense>
  );
}
