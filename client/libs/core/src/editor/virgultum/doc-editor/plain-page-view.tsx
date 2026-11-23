// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Store } from "@virgultum/core/store";
import {
  isMyoxusLabelTone,
  myoxusTextStyles,
} from "@virgultum/core/styles/text";
import type { MyoxusTextAttributes } from "@virgultum/core/types";
import type { ReferenceInfo } from "@virgultum/core/models";
import type { ParagraphBlockModel } from "@virgultum/core/models";
import { calculateCollapsedSiblings } from "@virgultum/core/utils/collapsed";
import { ChevronDownIcon, ChevronRightIcon } from "@myoxus/icons/react";
import { createRelativePositionFromTypeIndex } from "yjs";
import { normalizeUrl, isValidUrl } from "@virgultum/core/utils/url";
import type { LinkAnchor } from "./page-link";
import { resolveLinkToDoc } from "../../../modules/navigation/utils";
import { createPortal } from "react-dom";
import type { PageInlineObject } from "./page-inline-object";
import {
  DocumentEditorRoot,
  DocumentEditorPageViewport,
  DocumentTitleRow,
  DocumentEditorBlankGap,
  PageContentRail,
  IconButton,
} from "@myoxus/ui-facade";
import { useI18n } from "@myoxus/i18n";
import { useLiveData, useService } from "@myoxus/infra";
import {
  lazy,
  Suspense,
  useRef,
  useLayoutEffect,
  useEffect,
  useState,
  useReducer,
  useCallback,
} from "react";
import { EditorSettingService } from "../../../modules/editor-setting";
import { EditorService } from "../../../modules/editor";
import { useWorkbenchSurfaceScrollViewport } from "../../../modules/workbench/view/workbench-surface-scroll";
import { DocsService } from "../../../modules/doc";
import {
  DocumentMetadataProvider,
  DocumentMetadataSummary,
} from "../../../modules/document-metadata";
import { WorkspaceDialogService } from "../../../modules/dialogs";
import { ServerService, UserFeatureService } from "../../../modules/server";
import { useGuard } from "../../../components/guard";
import { DocIconPicker } from "./doc-icon-picker";
import type { PageContent, PageLine } from "./plain-page-model";
import { PageInteraction, type PickerStart } from "./page-interaction";
import {
  type PageBookmark,
  type PageIntent,
  readPageRange,
  resolveBookmark,
  restorePageRange,
} from "./plain-page-input";
import { bindDocumentTitleSync } from "./document-title-sync";
import { StarterBar } from "./starter-bar";
import { PageFormatting } from "./plain-page-formatting";
import "./plain-page.css";

const Directory = lazy(async () => ({
  default: (await import("../../view-extensions/editor-view/document-index"))
    .Directory,
}));
const Equation = lazy(() => import("./page-equation"));
const EventCard = lazy(() => import("./page-event"));
const Attachment = lazy(() => import("./page-attachment"));
const Code = lazy(() => import("./page-code"));
const Callout = lazy(async () => ({
  default: (await import("../../view-extensions/editor-view/callout"))
    .PageCallout,
}));
const Footnote = lazy(() => import("./page-footnote"));
const Bookmark = lazy(() => import("./page-bookmark"));
const PageImage = lazy(() => import("./page-image"));
const DocumentCard = lazy(() => import("./page-document-card"));
const Player = lazy(() => import("./page-provider-player"));
const Forge = lazy(async () => ({
  default: (await import("./page-provider-player")).ForgeCard,
}));
const Html = lazy(async () => ({
  default: (await import("./page-provider-player")).HtmlCard,
}));
const Iframe = lazy(async () => ({
  default: (await import("./page-provider-player")).PageIframe,
}));
const Table = lazy(() => import("./page-table"));
const InlineObject = lazy(() => import("./page-inline-object"));
const LinkMenu = lazy(() => import("./page-link"));
const Picker = lazy(() => import("./page-picker"));
const Annotation = lazy(async () => ({
  default: (await import("../../view-extensions/editor-view/annotation"))
    .AnnotationBlock,
}));
const DatabaseReference = lazy(async () => ({
  default: (
    await import("../../../modules/database/database-block-adapter/server-database-block")
  ).PageDatabaseReference,
}));

function headingStyle(
  heading: NonNullable<PageLine["heading"]>,
): import("react").CSSProperties {
  const slot = heading === "h6" ? "h5" : heading;
  return {
    fontFamily: `var(--myoxus-typography-${slot}-family)`,
    fontSize: `calc(var(--myoxus-font-h-${heading[1]}) * var(--myoxus-document-reading-scale,1))`,
    fontWeight: `var(--myoxus-typography-${slot}-weight)`,
    fontStyle: `var(--myoxus-typography-${slot}-font-style)`,
    lineHeight: `var(--myoxus-typography-${slot}-line-height)`,
    letterSpacing: `var(--myoxus-typography-${slot}-letter-spacing)`,
    textDecoration: `var(--myoxus-typography-${slot}-decoration)`,
    textTransform:
      `var(--myoxus-typography-${slot}-text-transform)` as import("react").CSSProperties["textTransform"],
  };
}
function TextField({
  line,
  title,
  readonly,
  composing,
  linkMenu,
  comment,
}: {
  line: PageLine;
  title?: string;
  readonly: boolean;
  composing: () => boolean;
  linkMenu?: (value: LinkAnchor, open?: number) => void;
  comment?: (intent: Extract<PageIntent, { kind: "comment-thread" }>) => void;
}) {
  const ref = useRef<HTMLSpanElement>(null);
  const previous = useRef<string>(undefined);
  const [objects, setObjects] = useState<
    { el: HTMLElement; object: PageInlineObject; key: string }[]
  >([]);
  useLayoutEffect(() => {
    const field = ref.current!;
    const paint = () => {
      if (composing()) return;
      const runs = line.text.toDelta() as {
        insert: string;
        attributes?: Record<string, unknown>;
      }[];
      const key = JSON.stringify(runs);
      if (previous.current === key) return;
      previous.current = key;
      const fragment = document.createDocumentFragment();
      const next: typeof objects = [];
      let offset = 0;
      for (let i = 0; i < runs.length; i++) {
        const { insert, attributes: a = {} } = runs[i];
        const start = offset;
        offset += insert.length;
        if (
          a.reference ||
          a.documentField ||
          a.annotation ||
          a.footnote ||
          a.mention ||
          typeof a.latex === "string"
        ) {
          const position = createRelativePositionFromTypeIndex(
            line.text,
            start,
            0,
          );
          const key = JSON.stringify(position);
          const el =
            objects.find((o) => o.key === key)?.el ??
            document.createElement("span");
          let object: PageInlineObject;
          if (a.documentField)
            object = {
              kind: "field",
              value:
                a.documentField as import("@virgultum/core/types").DocumentField,
              start: position,
            };
          else if (typeof a.latex === "string")
            object = { kind: "latex", source: a.latex, start: position };
          else if (a.mention)
            object = {
              kind: "mention",
              member: (a.mention as { member: string }).member,
            };
          else if (a.footnote) {
            const value =
              a.footnote as import("@virgultum/core/models").FootNote;
            object =
              value.definitionId === undefined
                ? { kind: "citation", value, start: position }
                : {
                    kind: "footnote",
                    id: value.definitionId,
                    start: position,
                  };
          } else if (a.reference)
            object = {
              kind: "reference",
              reference: a.reference as ReferenceInfo,
            };
          else {
            const id = (a.annotation as { id: string }).id;
            let body = insert;
            while (
              (
                runs[i + 1]?.attributes?.annotation as
                  { id: string } | undefined
              )?.id === id
            ) {
              body += runs[++i].insert;
              offset += runs[i].insert.length;
            }
            object = { kind: "annotation", id, body, start: position };
          }
          el.contentEditable = "false";
          el.dataset.pageInlineLength = String(offset - start);
          el.dataset.pageInline = object.kind;
          next.push({ el, object, key });
          fragment.append(el);
          continue;
        }
        let node: Node = document.createTextNode(insert);
        for (const [mark, tag] of Object.entries({
          bold: "strong",
          italic: "em",
          underline: "u",
          strike: "s",
          code: "code",
        })) {
          if (a[mark]) {
            const el = document.createElement(tag);
            el.append(node);
            node = el;
          }
        }
        if (
          a.color ||
          a.background ||
          a.code ||
          isMyoxusLabelTone(a.labelTone)
        ) {
          const el = document.createElement("span");
          for (const [key, value] of Object.entries(
            myoxusTextStyles(a as MyoxusTextAttributes),
          )) {
            if (value != null) el.style.setProperty(key, String(value));
          }
          if (isMyoxusLabelTone(a.labelTone))
            el.dataset.myoxusLabelTone = a.labelTone;
          el.append(node);
          node = el;
        }
        if (typeof a.link === "string") {
          const url = normalizeUrl(a.link);
          if (url && isValidUrl(url)) {
            const anchor = document.createElement("a");
            anchor.dataset.pageLink = "";
            anchor.href = url;
            anchor.target = "_blank";
            anchor.rel = "noopener noreferrer";
            anchor.append(node);
            node = anchor;
            const range = {
              anchor: {
                id: line.model.id,
                position: createRelativePositionFromTypeIndex(
                  line.text,
                  start,
                  0,
                ),
              },
              focus: {
                id: line.model.id,
                position: createRelativePositionFromTypeIndex(
                  line.text,
                  offset,
                  -1,
                ),
              },
            };
            const info: LinkAnchor = {
              el: anchor,
              line,
              text: insert,
              url: a.link,
              range,
            };
            anchor.onpointerenter = () => linkMenu?.(info);
            anchor.onfocus = () => linkMenu?.(info);
            anchor.onclick = anchor.onauxclick = (e) => {
              if (!document.getSelection()?.isCollapsed || e.button > 1) return;
              e.preventDefault();
              linkMenu?.(info, e.button);
            };
          }
        }
        const thread = Object.keys(a).find(
          (k) => k.startsWith("comment-") && a[k] === true,
        );
        if (thread && comment) {
          const el = document.createElement("span"),
            id = thread.slice(8),
            point = createRelativePositionFromTypeIndex(line.text, start, 0);
          el.dataset.pageComment = id;
          el.onclick = () => {
            if (document.getSelection()?.isCollapsed)
              comment({
                kind: "comment-thread",
                block: line.model.id,
                id,
                point,
              });
          };
          el.append(node);
          node = el;
        }
        fragment.append(node);
      }
      if (!runs.length && !title) fragment.append(document.createElement("br"));
      field.replaceChildren(fragment);
      if (next.length || objects.length) setObjects(next);
    };
    const force = () => {
      previous.current = undefined;
      paint();
    };
    paint();
    field.addEventListener("page-refresh-text", force);
    return () => field.removeEventListener("page-refresh-text", force);
  });
  return (
    <>
      <span
        ref={ref}
        data-page-text={line.model.id}
        data-block-id={line.model.id}
        data-page-title={title ? true : undefined}
        data-placeholder={title}
        aria-label={title}
        contentEditable={title ? !readonly : undefined}
        suppressContentEditableWarning
      />
      {objects.map(({ el, object, key }) =>
        createPortal(
          <Suspense fallback={null}>
            <InlineObject
              field={ref.current!}
              object={object}
              line={line}
              readonly={readonly}
            />
          </Suspense>,
          el,
          key,
        ),
      )}
    </>
  );
}

export function PlainPageView({
  page,
  content,
  readonly,
  refresh,
  controller,
  handoff,
  enableAI,
  className,
  fullWidth,
}: {
  page: Store;
  content: PageContent;
  readonly: boolean;
  refresh: () => void;
  controller: { current: PageInteraction | null };
  handoff: (range: PageBookmark | null, intent?: PageIntent) => void;
  enableAI: boolean;
  className?: string;
  fullWidth?: string;
}) {
  const { lines, body } = content;
  const [localFolds, setLocalFolds] = useState(
    new Map<string, { base: boolean; closed: boolean }>(),
  );
  const isFolded = (line: PageLine) => {
    const base = Boolean((line.model as ParagraphBlockModel).props.collapsed),
      override = (readonly || page.readonly) && localFolds.get(line.model.id);
    return override && override.base === base ? override.closed : base;
  };
  const hiddenIds = new Set<string>(),
    expandable = new Set<string>();
  for (const line of lines) {
    if (
      (!line.heading && line.model.flavour !== "myoxus:list") ||
      hiddenIds.has(line.model.id)
    )
      continue;
    const following = line.heading
      ? calculateCollapsedSiblings(line.model as ParagraphBlockModel)
      : [];
    if (following.length || line.model.children.length)
      expandable.add(line.model.id);
    if (isFolded(line)) {
      const hide = (model: PageLine["model"]) => {
        hiddenIds.add(model.id);
        model.children.forEach(hide);
      };
      following.forEach(hide);
      line.model.children.forEach(hide);
    }
  }
  const visibleLines = hiddenIds.size
    ? lines.filter((l) => !hiddenIds.has(l.model.id))
    : lines;
  const [link, setLink] = useState<LinkAnchor | null>(null);
  const t = useI18n(),
    docs = useService(DocsService);
  const settings = useLiveData(
    useService(EditorSettingService).editorSetting.settings$,
  );
  const dialogs = useService(WorkspaceDialogService),
    server = useService(ServerService).server;
  const admin = useLiveData(
      useService(UserFeatureService).userFeature.isAdmin$,
    ),
    configure = useGuard("Workspace_Settings_Update");
  const root = useRef<HTMLDivElement>(null);
  const editor = useService(EditorService).editor,
    viewport = useWorkbenchSurfaceScrollViewport();
  const selector = useLiveData(editor.selector$);
  useLayoutEffect(
    () =>
      editor.bindPageOrigin(
        root.current!,
        viewport.current,
        () => controller.current?.relinquish(),
        () => controller.current?.selectedBlocks() ?? [],
      ),
    [editor, controller, viewport],
  );
  const props = useRef({ lines: visibleLines, readonly });
  useLayoutEffect(() => {
    props.current = { lines: visibleLines, readonly };
  });
  const [selection, setSelection] = useState<DOMRect | null>(null);
  const [picker, setPicker] = useState<PickerStart | null>(null);
  const dismissPicker = useCallback(() => setPicker(null), []);
  const [epoch, repaint] = useReducer((n) => n + 1, 0);
  useLayoutEffect(() => {
    const el = root.current!;
    const owner = new PageInteraction(
      page,
      el,
      () => {
        const hidden = el.querySelectorAll<HTMLElement>(
          "[data-callout-body][hidden] [data-page-text]",
        );
        if (!hidden.length) return props.current.lines;
        const ids = new Set(Array.from(hidden, (f) => f.dataset.pageText));
        return props.current.lines.filter((l) => !ids.has(l.model.id));
      },
      () => !props.current.readonly,
      refresh,
      handoff,
      setPicker,
    );
    controller.current = owner;
    if (editor.pageSelection) {
      const saved = resolveBookmark(page, editor.pageSelection);
      if (saved) restorePageRange(el, saved);
      editor.pageSelection = null;
    } else if (
      !props.current.readonly &&
      !editor.selector$.value?.blockIds?.length &&
      editor.scrollPosition.page === null
    ) {
      const title = props.current.lines[0];
      const end = { id: title.model.id, offset: title.text.length };
      restorePageRange(el, { anchor: end, focus: end });
    }
    const onSelection = () => {
      const range = readPageRange(el),
        sel = document.getSelection();
      if (
        range &&
        sel?.rangeCount &&
        !sel.isCollapsed &&
        !props.current.readonly
      ) {
        setSelection(sel.getRangeAt(0).getBoundingClientRect());
      } else if (
        !document.activeElement?.closest('[role="toolbar"],[role="menu"]')
      )
        setSelection(null);
    };
    document.addEventListener("selectionchange", onSelection);
    return () => {
      editor.pageSelection = owner.selection ?? null;
      controller.current = null;
      owner.dispose();
      document.removeEventListener("selectionchange", onSelection);
    };
  }, [page, editor, controller, handoff, refresh]);
  useLayoutEffect(
    () => controller.current?.afterRender(),
    [controller, lines, epoch],
  );
  const [title] = lines;
  useEffect(() => {
    if (selector?.commentId || selector?.elementIds?.length) {
      controller.current?.relinquish();
      return;
    }
    const id = selector?.blockIds?.[0];
    if (id) {
      root.current
        ?.querySelector(`[data-block-id="${CSS.escape(id)}"]`)
        ?.scrollIntoView({ block: "center" });
    }
  }, [selector, controller]);
  useEffect(
    () =>
      readonly
        ? undefined
        : bindDocumentTitleSync(page.id, title.text, docs, (e) =>
            console.error("Title update failed", e),
          ),
    [page, readonly, title.text, docs],
  );
  const composing = () => !!controller.current?.isComposing;
  const openLink = (info: LinkAnchor, button?: number) => {
    if (button === undefined) {
      setLink(info);
      return;
    }
    const url = normalizeUrl(info.url);
    if (resolveLinkToDoc(url, server.baseUrl))
      handoff(info.range, {
        kind: "link-command",
        action: "open",
        button,
        url: info.url,
      });
    else window.open(url, "_blank", "noopener,noreferrer");
  };
  return (
    <DocumentEditorRoot
      ref={root}
      mode="page"
      readingSize={settings.fontSize}
      className={className}
      data-full-width-layout={fullWidth}
      data-testid={`editor-${page.id}`}
      data-page-renderer="native"
    >
      <DocumentEditorPageViewport>
        <DocumentTitleRow data-testid="doc-title-row">
          <DocIconPicker docId={page.id} readonly={readonly} />
          <TextField
            line={title}
            title={t.Title()}
            readonly={readonly}
            composing={composing}
          />
        </DocumentTitleRow>
        <DocumentMetadataProvider
          docId={page.id}
          readonly={readonly}
          canOpenGlobalPolicy={Boolean(admin)}
          canConfigureWorkspaceDefaults={configure}
          onConfigureWorkspaceDefaults={() =>
            dialogs.open("workspace-settings", {
              activeTab: "workspace:documents",
            })
          }
          onOpenGlobalPolicy={() =>
            window.open(
              new URL("/adminfrontend/documents?tab=metadata", server.baseUrl),
              "_blank",
              "noopener,noreferrer",
            )
          }
        >
          <DocumentMetadataSummary />
        </DocumentMetadataProvider>
        <PageContentRail width="editor">
          <div
            data-page-body=""
            contentEditable={!readonly}
            suppressContentEditableWarning
          >
            {body.map(function renderItem(line): import("react").ReactNode {
              if (hiddenIds.has(line.model.id)) return null;
              return line.kind === "callout" ? (
                <Suspense key={line.model.id} fallback={null}>
                  <Callout
                    model={line.model}
                    readonly={readonly || page.readonly}
                  >
                    {line.children.map(renderItem)}
                  </Callout>
                </Suspense>
              ) : line.kind === "code" ? (
                <Suspense key={line.model.id} fallback={null}>
                  <Code
                    model={line.model}
                    readonly={readonly || page.readonly}
                    handoff={(intent) => handoff(null, intent)}
                  />
                </Suspense>
              ) : line.kind === "footnote" ? (
                <Suspense key={line.model.id} fallback={null}>
                  <Footnote
                    model={line.model}
                    readonly={readonly || page.readonly}
                  />
                </Suspense>
              ) : line.kind === "iframe" ? (
                <Suspense key={line.model.id} fallback={null}>
                  <Iframe
                    model={line.model}
                    readonly={readonly || page.readonly}
                    handoff={(intent) => handoff(null, intent)}
                  />
                </Suspense>
              ) : line.kind === "document" ? (
                <Suspense key={line.model.id} fallback={null}>
                  <DocumentCard
                    model={line.model}
                    readonly={readonly || page.readonly}
                    handoff={handoff}
                  />
                </Suspense>
              ) : line.kind === "forge" ? (
                <Suspense key={line.model.id} fallback={null}>
                  <Forge
                    model={line.model}
                    readonly={readonly || page.readonly}
                    handoff={(intent) => handoff(null, intent)}
                  />
                </Suspense>
              ) : line.kind === "html" ? (
                <Suspense key={line.model.id} fallback={null}>
                  <Html
                    model={line.model}
                    readonly={readonly || page.readonly}
                    handoff={(intent) => handoff(null, intent)}
                  />
                </Suspense>
              ) : line.kind === "player" ? (
                <Suspense key={line.model.id} fallback={null}>
                  <Player
                    model={line.model}
                    readonly={readonly || page.readonly}
                    handoff={(intent) => handoff(null, intent)}
                  />
                </Suspense>
              ) : line.kind === "image" ? (
                <Suspense key={line.model.id} fallback={null}>
                  <PageImage
                    model={line.model}
                    readonly={readonly || page.readonly}
                    handoff={(intent) => handoff(null, intent)}
                  />
                </Suspense>
              ) : line.kind === "bookmark" ? (
                <Suspense key={line.model.id} fallback={null}>
                  <Bookmark
                    model={line.model}
                    readonly={readonly || page.readonly}
                    handoff={(intent) => handoff(null, intent)}
                  />
                </Suspense>
              ) : line.kind === "annotation" ? (
                <div
                  key={line.model.id}
                  data-page-annotation={line.model.id}
                  data-block-id={line.model.id}
                  contentEditable={false}
                  tabIndex={-1}
                >
                  <Suspense fallback={null}>
                    <Annotation
                      body={line.model.props.text.toString()}
                      readonly={readonly || page.readonly}
                      editRequest={0}
                      apply={(value, expected) =>
                        !readonly && line.model.applyBody(value, expected)
                      }
                    />
                  </Suspense>
                </div>
              ) : line.kind === "table" ? (
                <Suspense key={line.model.id} fallback={null}>
                  <Table
                    model={line.model}
                    readonly={readonly || page.readonly}
                    handoff={(intent) => handoff(null, intent)}
                  />
                </Suspense>
              ) : line.kind === "attachment" ? (
                <Suspense key={line.model.id} fallback={null}>
                  <Attachment
                    model={line.model}
                    readonly={readonly || page.readonly}
                    handoff={(intent) => handoff(null, intent)}
                  />
                </Suspense>
              ) : line.kind === "event" ? (
                <Suspense key={line.model.id} fallback={null}>
                  <EventCard
                    model={line.model}
                    readonly={readonly || page.readonly}
                  />
                </Suspense>
              ) : line.kind === "database" ? (
                <div
                  key={line.model.id}
                  data-server-database-reference={
                    line.model.props.serverDatabaseId
                  }
                  data-block-id={line.model.id}
                  tabIndex={-1}
                  contentEditable={false}
                >
                  <Suspense fallback={null}>
                    <DatabaseReference
                      model={line.model}
                      readonly={readonly || page.readonly}
                    />
                  </Suspense>
                </div>
              ) : line.kind === "equation" ? (
                <Suspense key={line.model.id} fallback={null}>
                  <Equation
                    model={line.model}
                    readonly={readonly || page.readonly}
                  />
                </Suspense>
              ) : line.kind === "directory" ? (
                <div
                  key={line.model.id}
                  data-page-directory={line.model.id}
                  data-block-id={line.model.id}
                  tabIndex={-1}
                  contentEditable={false}
                >
                  <Suspense fallback={null}>
                    <Directory
                      model={line.model}
                      readonly={readonly || page.readonly}
                    />
                  </Suspense>
                </div>
              ) : line.kind === "divider" ? (
                <div
                  key={line.model.id}
                  data-page-divider={line.model.id}
                  data-block-id={line.model.id}
                  contentEditable={false}
                  tabIndex={-1}
                  style={{
                    paddingInlineStart: `calc(${line.depth} * var(--mantine-spacing-xl) + var(--mantine-spacing-xs))`,
                  }}
                  onClick={(e) => e.currentTarget.focus()}
                >
                  <hr />
                </div>
              ) : (
                <div
                  className="plain-page-line"
                  role={line.heading ? "heading" : undefined}
                  aria-level={
                    line.heading ? Number(line.heading[1]) : undefined
                  }
                  data-heading={line.heading}
                  data-paragraph-role={
                    line.eyebrow
                      ? "eyebrow"
                      : line.kind === "quote"
                        ? "quote"
                        : undefined
                  }
                  key={line.model.id}
                  style={{
                    textAlign: line.alignment,
                    ...(line.heading ? headingStyle(line.heading) : {}),
                    paddingInlineStart: `calc(${line.depth} * var(--mantine-spacing-xl))`,
                  }}
                >
                  {expandable.has(line.model.id) && (
                    <span
                      data-disclosure=""
                      data-block-id={line.model.id}
                      contentEditable={false}
                    >
                      <IconButton
                        aria-expanded={!isFolded(line)}
                        aria-label={isFolded(line) ? t.Expand() : t.Collapse()}
                        icon={
                          isFolded(line) ? (
                            <ChevronRightIcon />
                          ) : (
                            <ChevronDownIcon />
                          )
                        }
                        onClick={() => {
                          const model = line.model as ParagraphBlockModel,
                            base = !!model.props.collapsed;
                          if (page.getModelById(model.id) !== model) return;
                          if (readonly || page.readonly)
                            setLocalFolds((prev) =>
                              new Map(prev).set(model.id, {
                                base,
                                closed: !isFolded(line),
                              }),
                            );
                          else {
                            page.captureSync();
                            page.updateBlock(model, { collapsed: !base });
                            page.captureSync();
                          }
                        }}
                      />
                    </span>
                  )}
                  {["bulleted", "numbered", "todo"].includes(line.kind) && (
                    <span contentEditable={false}>
                      {line.kind === "numbered" ? (
                        `${line.ordinal}.`
                      ) : line.kind === "todo" ? (
                        <input
                          type="checkbox"
                          checked={line.checked}
                          disabled={readonly}
                          onChange={() => {
                            if (!readonly && !page.readonly)
                              page.updateBlock(line.model, {
                                checked: !line.checked,
                              });
                          }}
                        />
                      ) : (
                        "•"
                      )}{" "}
                    </span>
                  )}
                  <TextField
                    linkMenu={openLink}
                    comment={(intent) => handoff(null, intent)}
                    line={line}
                    readonly={readonly}
                    composing={composing}
                  />
                </div>
              );
            })}
          </div>
        </PageContentRail>
        <DocumentEditorBlankGap
          data-testid="page-editor-blank"
          onClick={() => {
            if (!readonly) {
              const last = body.at(-1)!;
              if (!("text" in last)) {
                root.current
                  ?.querySelector<HTMLElement>(
                    `[data-block-id="${CSS.escape(last.model.id)}"]`,
                  )
                  ?.focus();
                return;
              }
              const point = { id: last.model.id, offset: last.text.length };
              restorePageRange(root.current!, { anchor: point, focus: point });
            }
          }}
        />
        {!readonly && <StarterBar doc={page} />}
        {link && (
          <Suspense fallback={null}>
            <LinkMenu
              key={JSON.stringify(link.range)}
              anchor={link}
              readonly={readonly || page.readonly}
              dismiss={() => setLink(null)}
              handoff={handoff}
            />
          </Suspense>
        )}
        {picker && !readonly && controller.current && root.current && (
          <Suspense fallback={null}>
            <Picker
              owner={controller.current}
              start={picker}
              root={root.current}
              close={dismissPicker}
            />
          </Suspense>
        )}
        {!readonly && selection && controller.current && (
          <PageFormatting
            controller={controller.current}
            rect={selection}
            dismiss={() => setSelection(null)}
            changed={repaint}
            enableAI={enableAI}
          />
        )}
      </DocumentEditorPageViewport>
    </DocumentEditorRoot>
  );
}
