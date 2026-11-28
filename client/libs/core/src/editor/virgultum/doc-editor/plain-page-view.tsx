// SPDX-License-Identifier: AGPL-3.0-or-later
import type { MyoxusTextAttributes } from "@virgultum/core/types";
import type { Store } from "@virgultum/core/store";
import { VirgultumEditorJournalDocTitleUI } from "./journal-doc-title";
import { documentFieldTextStyles } from "@virgultum/core/styles/text";
import { setInlineStyles } from "@virgultum/core/runtime/inline/attributes";
import { pageTextRun } from "./page-text-run";
import type { ReferenceInfo } from "@virgultum/core/models";
import type { ParagraphBlockModel } from "@virgultum/core/models";
import { calculateCollapsedSiblings } from "@virgultum/core/utils/collapsed";
import { getNumberPrefix } from "@virgultum/core/utils";
import { ChevronDownIcon, ChevronRightIcon } from "@myoxus/icons/react";
import { ServerFeature } from "@myoxus/graphql";
import {
  createAbsolutePositionFromRelativePosition,
  createRelativePositionFromTypeIndex,
} from "yjs";
import { normalizeUrl, isValidUrl } from "@virgultum/core/utils/url";
import type { LinkAnchor } from "./page-link";
import { useDocumentLinkNavigation } from "../../../components/hooks/use-document-link-navigation";
import { CoreDocEmbedProvider } from "../../../modules/doc/services/doc-embed";
import { GuardService } from "../../../modules/permissions";
import { WorkspaceService } from "../../../modules/workspace";
import { resolveLinkToDoc } from "../../../modules/navigation/utils";
import { createPortal } from "react-dom";
import type { PageInlineObject } from "./page-inline-object";
import {
  Checkbox,
  DetailPageEditorViewport,
  DocumentEditorRoot,
  DocumentEditorPageViewport,
  DocumentTitleRow,
  DocumentEditorBlankGap,
  PageContentRail,
  IconButton,
  notify,
} from "@myoxus/ui-facade";
import { useI18n } from "@myoxus/i18n";
import {
  useFramework,
  useLiveData,
  useService,
  useServiceOptional,
} from "@myoxus/infra";
import {
  lazy,
  Suspense,
  useRef,
  useLayoutEffect,
  useEffect,
  useId,
  useMemo,
  useState,
  useReducer,
  useCallback,
} from "react";
import { FeatureFlagService } from "../../../modules/feature-flag";
import { EditorSettingService } from "../../../modules/editor-setting";
import { type Editor, EditorService } from "../../../modules/editor";
import { useWorkbenchSurfaceScrollViewportOptional } from "../../../modules/workbench/view/workbench-surface-scroll";
import { ViewService } from "../../../modules/workbench";
import { DocsService } from "../../../modules/doc";
import { DocCommentManagerService } from "../../../modules/comment/services/doc-comment-manager";
import { BpmnEditorService } from "../../../modules/bpmn-editor/session";
import {
  MermaidDiagramsService,
  hasInitializedDiagramContent,
} from "../../../modules/mermaid-diagrams/services/mermaid-diagrams";
import { TemplateDocService } from "../../../modules/template-doc";
import {
  shouldShowDocumentMetadata,
  DocumentMetadataProvider,
  DocumentMetadataSummary,
} from "../../../modules/document-metadata";
import { WorkspaceDialogService } from "../../../modules/dialogs";
import { ServerService, UserFeatureService } from "../../../modules/server";
import { useGuard } from "../../../components/guard";
import { DefaultEditorI18nService } from "@virgultum/core/services";
import { BlockSelection, TextSelection } from "@virgultum/core/runtime";
import { configureEditorI18n } from "../editor-i18n";
import { DocIconPicker } from "./doc-icon-picker";
import {
  readPageContent,
  type PageContent,
  type PageLine,
} from "./plain-page-model";
import { PageInteraction, type PickerStart } from "./page-interaction";
import {
  readPageRange,
  resolveBookmark,
  restorePageRange,
} from "./plain-page-input";
import {
  bindDiagramDocumentTitleSync,
  bindDocumentTitleSync,
} from "./document-title-sync";
import { StarterBar } from "./starter-bar";
import { PageFormatting } from "./plain-page-formatting";
import { PageRemotePresence } from "./page-remote-presence";
import {
  PageBlockCommentIndicator,
  PageLineAttributesBar,
} from "./page-block-chrome";
import { useTemplateVariablePicker } from "./template-variable-picker";
import { useBuildingBlockPicker } from "../../../modules/template-doc/view/building-block-picker";
import { resolveInsertParent } from "./page-slash-registry";
import "./plain-page.css";

const Directory = lazy(async () => ({
  default: (await import("../../view-extensions/editor-view/document-index"))
    .Directory,
}));
const TableOfContents = lazy(async () => ({
  default: (await import("../../view-extensions/editor-view/table-of-contents"))
    .TableOfContentsBlock,
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
const Mermaid = lazy(() => import("./page-mermaid"));
const Bpmn = lazy(() => import("./page-bpmn"));
const InlineObject = lazy(() => import("./page-inline-object"));
const LinkMenu = lazy(() => import("./page-link"));
const Picker = lazy(() => import("./page-picker"));
const PageSlash = lazy(() => import("./page-slash"));
const Annotation = lazy(async () => ({
  default: (await import("../../view-extensions/editor-view/annotation"))
    .AnnotationBlock,
}));
const DatabaseReference = lazy(async () => ({
  default: (
    await import("../../../modules/database/database-block-adapter/server-database-block")
  ).PageDatabaseReference,
}));

const BULLET_GLYPHS = ["•", "◦", "▪"] as const;

function listNestingDepth(model: PageLine["model"]): number {
  let depth = 0;
  let parent = model.store.getParent(model);
  while (parent?.flavour === "myoxus:list") {
    depth++;
    parent = model.store.getParent(parent);
  }
  return depth;
}

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
  snapshotTitle,
  onContextMenu,
}: {
  line: PageLine;
  title?: string;
  snapshotTitle?: boolean;
  readonly: boolean;
  composing: () => boolean;
  linkMenu?: (value: LinkAnchor, open?: number) => void;
  comment?: (id: string) => void;
  onContextMenu?: (event: import("react").MouseEvent<HTMLSpanElement>) => void;
}) {
  const ref = useRef<HTMLSpanElement>(null);
  const previous = useRef<string>(undefined);
  const [objects, setObjects] = useState<
    { el: HTMLElement; object: PageInlineObject; key: string }[]
  >([]);
  const objectsRef = useRef(objects);
  objectsRef.current = objects;
  const callbacksRef = useRef({ composing, linkMenu, comment });
  callbacksRef.current = { composing, linkMenu, comment };
  const hasComment = Boolean(comment);
  const hasLinkMenu = Boolean(linkMenu);
  useLayoutEffect(() => {
    const field = ref.current!;
    const paint = () => {
      if (callbacksRef.current.composing()) return;
      const runs = line.text.toDelta() as {
        insert: string;
        attributes?: MyoxusTextAttributes;
      }[];
      const key = JSON.stringify([hasComment, hasLinkMenu, runs]);
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
            objectsRef.current.find((o) => o.key === key)?.el ??
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
          setInlineStyles(
            el,
            a.documentField ? documentFieldTextStyles(a) : {},
          );
          el.contentEditable = "false";
          el.dataset.pageInlineLength = String(offset - start);
          el.dataset.pageInline = object.kind;
          next.push({ el, object, key });
          fragment.append(el);
          continue;
        }
        let node = pageTextRun(field.ownerDocument, insert, a);
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
            anchor.onpointerenter = () => callbacksRef.current.linkMenu?.(info);
            anchor.onfocus = () => callbacksRef.current.linkMenu?.(info);
            anchor.onclick = anchor.onauxclick = (e) => {
              if (!document.getSelection()?.isCollapsed || e.button > 1) return;
              const openLinkMenu = callbacksRef.current.linkMenu;
              if (!openLinkMenu) return;
              e.preventDefault();
              openLinkMenu(info, e.button);
            };
          }
        }
        const thread = Object.entries(a).find(
          ([key, value]) => key.startsWith("comment-") && value === true,
        )?.[0];
        if (thread && hasComment) {
          const el = document.createElement("span"),
            id = thread.slice(8),
            point = createRelativePositionFromTypeIndex(line.text, start, 0);
          el.dataset.pageComment = id;
          el.onclick = () => {
            const text = line.model.store.getModelById(line.model.id)?.text;
            const at = createAbsolutePositionFromRelativePosition(
              point,
              line.model.store.spaceDoc,
            );
            if (
              document.getSelection()?.isCollapsed &&
              text &&
              at?.type === text.yText &&
              text.sliceToDelta(at.index, at.index + 1)[0]?.attributes?.[
                thread
              ] === true
            )
              callbacksRef.current.comment?.(id);
          };
          el.append(node);
          node = el;
        }
        fragment.append(node);
      }
      if (!runs.length && !title) fragment.append(document.createElement("br"));
      field.replaceChildren(fragment);
      if (next.length || objectsRef.current.length) setObjects(next);
    };
    const force = () => {
      previous.current = undefined;
      paint();
    };
    paint();
    line.text.observe(paint);
    field.addEventListener("page-refresh-text", force);
    return () => {
      line.text.unobserve(paint);
      field.removeEventListener("page-refresh-text", force);
    };
  }, [line.text, line.model, title, hasComment, hasLinkMenu]);
  return (
    <>
      <span
        ref={ref}
        data-page-text={line.model.id}
        data-block-id={line.model.id}
        data-page-title={
          title ? (snapshotTitle ? "snapshot" : true) : undefined
        }
        data-placeholder={title}
        aria-label={title}
        contentEditable={title ? !readonly : undefined}
        onContextMenu={onContextMenu}
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

type PageViewProps = {
  page: Store;
  content: PageContent;
  readonly: boolean;
  refresh: () => void;
  controller: { current: PageInteraction | null };
  enableAI: boolean;
  shared?: boolean;
  className?: string;
  fullWidth?: string;
  contentOnly?: boolean;
  journalDate?: string;
  onEditorError?: (error: unknown) => void;
};

export function VirgultumPageEditor(props: PageViewProps) {
  const editor = useServiceOptional(EditorService)?.editor;
  const viewport = useWorkbenchSurfaceScrollViewportOptional();
  const { page, readonly, shared, onEditorError } = props;
  const title = props.content.lines[0];
  const docs = useService(DocsService);
  const workspace = useService(WorkspaceService).workspace;
  const workspaceDialogService = useServiceOptional(WorkspaceDialogService);
  const server = useService(ServerService).server;
  const userFeatureService = useServiceOptional(UserFeatureService);
  const mermaidDiagramsService = useServiceOptional(MermaidDiagramsService);
  const bpmnEditorService = useServiceOptional(BpmnEditorService);
  const docCommentManager = useServiceOptional(DocCommentManagerService);
  const destinationView = useServiceOptional(ViewService)?.view;
  const t = useI18n();
  const [initializationEpoch, retryInitialization] = useState(0);
  const initializationNoticeId = useId();
  const openCommentThread = useCallback(
    (id: string) => editor?.openCommentThread(id),
    [editor],
  );
  const serverConfig = useLiveData(server.config$);
  const canComment =
    !shared &&
    workspace.flavour !== "local" &&
    serverConfig.features.includes(ServerFeature.Comment);
  const isMyoxusAdmin = useLiveData(userFeatureService?.userFeature.isAdmin$);
  const canConfigureWorkspaceDocumentSettings = useGuard(
    "Workspace_Settings_Update",
  );
  const onConfigureWorkspaceDocumentSettings = useCallback(() => {
    if (!workspaceDialogService) return;
    workspaceDialogService.open("workspace-settings", {
      activeTab: "workspace:documents",
    });
  }, [workspaceDialogService]);
  const onOpenGlobalDocumentPolicy = useCallback(() => {
    window.open(
      new URL(
        "/adminfrontend/documents?tab=metadata",
        server.baseUrl,
      ).toString(),
      "_blank",
      "noopener,noreferrer",
    );
  }, [server.baseUrl]);
  const rtl = useLiveData(
    useService(FeatureFlagService).flags.enable_editor_rtl.$,
  );

  useEffect(() => {
    userFeatureService?.userFeature.revalidate();
  }, [userFeatureService]);

  useEffect(
    () =>
      readonly || shared
        ? undefined
        : bindDocumentTitleSync(page.id, title.text, docs, (e) =>
            console.error("Title update failed", e),
          ),
    [page, readonly, shared, title.text, docs],
  );

  // Preserve dedicated Mermaid/BPMN initial diagram bootstrap and editBpmn=1
  // catalog navigation intent directly on Store without a native EditorHost.
  useEffect(() => {
    if (readonly || shared || !mermaidDiagramsService) return;
    let canceled = false;
    let initialClaim: symbol | undefined;
    let initializationNotice: string | undefined;
    const abort = new AbortController();

    void (async () => {
      try {
        await workspace.engine.doc.waitForDocLoaded(page.id, abort.signal);
        if (canceled || page.readonly) return;
        const initialDiagram =
          mermaidDiagramsService.getInitialDiagramForEditor(page.id, page);
        if (!initialDiagram) return;
        initialClaim = initialDiagram.claim;
        try {
          if (initialDiagram.format === "bpmn") {
            const result = mermaidDiagramsService.initializeBpmnForEditor(
              page.id,
              page,
            );
            if (result.status !== "initialized") {
              initializationNotice = notify.error(
                {
                  title: t["com.myoxus.common.operation-failed"](),
                  message:
                    result.status === "collision"
                      ? t["com.myoxus.diagrams.initialization.collision"]()
                      : t[
                          "com.myoxus.diagrams.initialization.source-missing"
                        ](),
                  actions: [
                    {
                      label: t.Retry(),
                      onClick: () => retryInitialization((epoch) => epoch + 1),
                      autoClose: false,
                    },
                  ],
                },
                { id: initializationNoticeId, duration: 0 },
              );
              onEditorError?.(result);
              return;
            }
            mermaidDiagramsService.completeInitialDiagramForEditor(
              page.id,
              initialDiagram.claim,
            );
          } else {
            const {
              createMermaidBlockInsertProps,
              prepareMermaidFamilySource,
            } = await import("@virgultum/block-mermaid");
            await prepareMermaidFamilySource(initialDiagram.source ?? "");
            if (
              canceled ||
              page.readonly ||
              !mermaidDiagramsService.isInitialDiagramClaimCurrent(
                page.id,
                initialDiagram.claim,
              )
            ) {
              return;
            }
            if (hasInitializedDiagramContent(page)) {
              mermaidDiagramsService.completeInitialDiagramForEditor(
                page.id,
                initialDiagram.claim,
              );
            } else {
              const firstParagraph =
                page.getBlocksByFlavour("myoxus:paragraph")[0]?.model ?? null;
              const target = firstParagraph
                ? resolveInsertParent(page, firstParagraph, "myoxus:mermaid")
                : null;
              const fallbackNote =
                page.getBlocksByFlavour("myoxus:note")[0]?.model ?? null;
              const parent = target?.parent ?? fallbackNote;
              if (parent) {
                let insertedId: string | undefined;
                const { flavour: _flavour, ...mermaidProps } =
                  createMermaidBlockInsertProps({
                    source: initialDiagram.source ?? "",
                    title: initialDiagram.title,
                  });
                page.captureSync();
                page.transact(() => {
                  insertedId = page.addBlock(
                    "myoxus:mermaid",
                    mermaidProps,
                    parent,
                    target ? target.index + 1 : parent.children.length,
                  );
                  if (
                    firstParagraph &&
                    target?.anchor === firstParagraph &&
                    firstParagraph.text?.length === 0 &&
                    firstParagraph.children.length === 0
                  ) {
                    page.deleteBlock(firstParagraph);
                  }
                });
                page.captureSync();
                if (insertedId) {
                  mermaidDiagramsService.completeInitialDiagramForEditor(
                    page.id,
                    initialDiagram.claim,
                  );
                }
              }
            }
          }
        } finally {
          mermaidDiagramsService.releaseInitialDiagramForEditor(
            page.id,
            initialDiagram.claim,
          );
          initialClaim = undefined;
        }
      } catch (error) {
        if (!canceled && !abort.signal.aborted) {
          console.error("Failed to initialize Page diagram", error);
          onEditorError?.(error);
        }
      }
    })();

    return () => {
      canceled = true;
      abort.abort();
      if (initialClaim) {
        mermaidDiagramsService.releaseInitialDiagramForEditor(
          page.id,
          initialClaim,
        );
      }
      if (initializationNotice) notify.dismiss(initializationNotice);
    };
  }, [
    initializationEpoch,
    initializationNoticeId,
    mermaidDiagramsService,
    onEditorError,
    page,
    readonly,
    shared,
    t,
    workspace,
  ]);

  // Honor one-use catalog `editBpmn=1` intent directly via BpmnEditorService.
  useEffect(() => {
    if (readonly || shared || !destinationView || !bpmnEditorService) return;
    let canceled = false;
    const sub = destinationView
      .queryString$<{ editBpmn?: string }>((search) => ({
        editBpmn: new URLSearchParams(search).get("editBpmn") ?? undefined,
      }))
      .subscribe(({ editBpmn }) => {
        if (
          canceled ||
          editBpmn !== "1" ||
          !destinationView.location$.value.pathname.endsWith(`/${page.id}`)
        )
          return;
        const blocks = page.getBlocksByFlavour("myoxus:bpmn" as never);
        if (blocks.length !== 1) return;
        const block = blocks[0]
          .model as import("@virgultum/core/models").BpmnBlockModel;
        destinationView.updateQueryString(
          { editBpmn: undefined },
          { replace: true },
        );
        const openSession = () => {
          void bpmnEditorService
            .open(
              {
                workspaceId: workspace.id,
                docId: page.id,
                blockId: block.id,
                editorHostId: `page-${page.id}`,
              },
              page.readonly,
              destinationView,
            )
            .catch(() => {
              if (!canceled)
                notify.error({
                  title: t["com.myoxus.common.operation-failed"](),
                  actions: [
                    {
                      label: t.Retry(),
                      onClick: openSession,
                    },
                  ],
                });
            });
        };
        openSession();
      });
    return () => {
      canceled = true;
      sub.unsubscribe();
    };
  }, [
    bpmnEditorService,
    destinationView,
    page,
    readonly,
    shared,
    t,
    workspace.id,
  ]);

  // Store-backed comment thread lifecycle (add/resolve/delete marks on Y.Text & blocks).
  useEffect(() => {
    if (!canComment || !docCommentManager) return;
    const ref = docCommentManager.get(page);
    const entity = ref.obj;
    const stopAdded = entity.onCommentAdded((id, selections) => {
      if (page.readonly) return;
      const attrKey = `comment-${id}`;
      page.captureSync();
      page.transact(() => {
        for (const selection of selections) {
          if (selection instanceof TextSelection) {
            const firstModel = page.getModelById(selection.from.blockId);
            if (!firstModel?.text) continue;
            if (!selection.to) {
              firstModel.text.yText.format(
                selection.from.index,
                selection.from.length,
                { [attrKey]: true },
              );
            } else {
              firstModel.text.yText.format(
                selection.from.index,
                selection.from.length,
                { [attrKey]: true },
              );
              const pageLines = readPageContent(page)?.lines ?? [];
              const fromIdx = pageLines.findIndex(
                (l) => l.model.id === selection.from.blockId,
              );
              const toIdx = pageLines.findIndex(
                (l) => l.model.id === selection.to!.blockId,
              );
              if (fromIdx >= 0 && toIdx >= 0 && Math.abs(toIdx - fromIdx) > 1) {
                const start = Math.min(fromIdx, toIdx) + 1;
                const end = Math.max(fromIdx, toIdx);
                for (let idx = start; idx < end; idx++) {
                  const mid = pageLines[idx];
                  if (mid.kind !== "title" && mid.text.length > 0) {
                    mid.text.format(0, mid.text.length, { [attrKey]: true });
                  }
                }
              }
              const lastModel = page.getModelById(selection.to.blockId);
              if (lastModel?.text && selection.to.length > 0) {
                lastModel.text.yText.format(
                  selection.to.index,
                  selection.to.length,
                  { [attrKey]: true },
                );
              }
            }
          } else if (selection instanceof BlockSelection) {
            const model = page.getModelById(selection.blockId);
            if (model && "comments" in model.props) {
              const existing =
                (model.props as { comments?: Record<string, boolean> })
                  .comments ?? {};
              page.updateBlock(model, {
                comments: { ...existing, [id]: true },
              });
            }
          }
        }
      });
      page.captureSync();
    });
    const clearComment = (id: string) => {
      if (page.readonly) return;
      const attrKey = `comment-${id}`;
      page.transact(() => {
        for (const block of Object.values(page.blocks.peek())) {
          const model = block.model;
          if (model.text) {
            let pos = 0;
            for (const op of model.text.toDelta()) {
              const len = typeof op.insert === "string" ? op.insert.length : 1;
              if (op.attributes && attrKey in op.attributes) {
                model.text.yText.format(pos, len, { [attrKey]: null });
              }
              pos += len;
            }
          }
          if (
            "comments" in model.props &&
            model.props.comments &&
            typeof model.props.comments === "object" &&
            id in (model.props.comments as Record<string, boolean>)
          ) {
            const next = {
              ...(model.props.comments as Record<string, boolean>),
            };
            delete next[id];
            page.updateBlock(model, { comments: next });
          }
        }
      });
    };
    const stopDeleted = entity.onCommentDeleted(clearComment);
    const stopResolved = entity.onCommentResolved(clearComment);
    return () => {
      stopAdded();
      stopDeleted();
      stopResolved();
      ref.release();
    };
  }, [canComment, docCommentManager, page]);

  return (
    <PageView
      {...props}
      editor={editor}
      viewport={viewport}
      dir={rtl ? "rtl" : "ltr"}
      openThread={canComment ? openCommentThread : undefined}
      metadata={
        shouldShowDocumentMetadata({
          shared,
          isJournal: !!props.journalDate,
          workspaceFlavour: workspace.flavour,
        }) && (
          <DocumentMetadataProvider
            docId={page.id}
            readonly={readonly}
            canOpenGlobalPolicy={Boolean(isMyoxusAdmin)}
            canConfigureWorkspaceDefaults={
              canConfigureWorkspaceDocumentSettings
            }
            onConfigureWorkspaceDefaults={onConfigureWorkspaceDocumentSettings}
            onOpenGlobalPolicy={onOpenGlobalDocumentPolicy}
          >
            <DocumentMetadataSummary />
          </DocumentMetadataProvider>
        )
      }
    />
  );
}

export const PlainPageView = VirgultumPageEditor;

const notComposing = () => false;
// The detached text reader has no writable commands and does not bind PageInteraction.
const noSnapshotCommand = () => {};
export function SnapshotTitle({ line }: { line: PageLine }) {
  const t = useI18n();
  return (
    <TextField
      title={t.Title()}
      line={line}
      composing={notComposing}
      snapshotTitle
      readonly
    />
  );
}

function readTableCell(model: PageLine["model"], text: PageLine["text"]) {
  return (
    <TextField
      readonly
      composing={notComposing}
      line={{ kind: "text", model, text, depth: 0, ordinal: 0, checked: false }}
    />
  );
}

export function PageSnapshot({
  page,
  content,
  className,
  fullWidth,
  contentOnly,
  embedded,
}: Pick<
  PageViewProps,
  "page" | "content" | "className" | "fullWidth" | "contentOnly"
> & {
  embedded?: boolean;
}) {
  const rtl = useLiveData(
    useService(FeatureFlagService).flags.enable_editor_rtl.$,
  );
  const controller = useRef<PageInteraction | null>(null);
  return (
    <PageView
      page={page}
      content={content}
      className={className}
      fullWidth={fullWidth}
      contentOnly={contentOnly || embedded}
      embedded={embedded}
      controller={controller}
      dir={rtl ? "rtl" : "ltr"}
      readonly
      enableAI={false}
      refresh={noSnapshotCommand}
    />
  );
}

function PageView({
  page,
  content,
  readonly,
  refresh,
  controller,
  enableAI,
  className,
  fullWidth,
  contentOnly,
  embedded,
  journalDate,
  editor,
  viewport,
  openThread,
  metadata,
  dir,
}: PageViewProps & {
  embedded?: boolean;
  openThread?: (id: string) => void;
  metadata?: import("react").ReactNode;
  dir?: "ltr" | "rtl";
  editor?: Editor;
  viewport?: ReturnType<typeof useWorkbenchSurfaceScrollViewportOptional>;
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
  // A journal date is document chrome and can never be a text selection endpoint.
  if (journalDate) hiddenIds.add(lines[0].model.id);
  const visibleLines = hiddenIds.size
    ? lines.filter((l) => !hiddenIds.has(l.model.id))
    : lines;
  const [link, setLink] = useState<LinkAnchor | null>(null);
  const t = useI18n();
  const settings = useLiveData(
    useService(EditorSettingService).editorSetting.settings$,
  );
  const root = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const selector = useLiveData(editor?.selector$);
  useLayoutEffect(() => {
    if (!editor) return;
    return editor.bindPageOrigin(
      root.current!,
      viewport?.current ?? null,
      () => controller.current?.selectedBlocks() ?? [],
    );
  }, [editor, controller, viewport]);
  const props = useRef({ lines: visibleLines, readonly });
  useLayoutEffect(() => {
    props.current = { lines: visibleLines, readonly };
  });
  const framework = useFramework();
  const templateList = useServiceOptional(TemplateDocService)?.list;
  const { openTemplateVariablePicker, templateVariablePicker } =
    useTemplateVariablePicker();
  const {
    openBuildingBlockPicker,
    insertNamedBuildingBlock,
    buildingBlockPicker,
  } = useBuildingBlockPicker();
  const editorI18n = useMemo(
    () => new DefaultEditorI18nService(configureEditorI18n()),
    [],
  );
  const [selection, setSelection] = useState<DOMRect | null>(null);
  const [selectionLinkOpen, setSelectionLinkOpen] = useState(false);
  const [picker, setPicker] = useState<PickerStart | null>(null);
  const dismissPicker = useCallback(() => setPicker(null), []);
  const [slash, setSlash] = useState<PickerStart | null>(null);
  const dismissSlash = useCallback(() => setSlash(null), []);
  const [epoch, repaint] = useReducer((n) => n + 1, 0);
  useLayoutEffect(() => {
    if (!editor && (readonly || contentOnly || embedded)) return;
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
      setPicker,
      editor?.framework ?? framework,
      setSlash,
      {
        openInlineLink: () => {
          const sel = document.getSelection();
          const rect = sel?.rangeCount
            ? sel.getRangeAt(0).getBoundingClientRect()
            : el.getBoundingClientRect();
          setSelection(rect);
          setSelectionLinkOpen(true);
        },
        openTemplateVariable: (anchor) => {
          const isTemplate = Boolean(templateList?.isTemplate$(page.id).value);
          openTemplateVariablePicker({
            i18n: editorI18n,
            templateSource: isTemplate,
            canWrite: () => !props.current.readonly && !page.readonly,
            insert: (token) => {
              controller.current?.insertTemplateToken(token, anchor);
              repaint();
            },
            insertField: (field) => {
              controller.current?.insertDocumentField(field, anchor);
              repaint();
            },
            onClose: () => controller.current?.restore(),
          });
        },
      },
    );
    controller.current = owner;
    if (editor?.pageSelection) {
      const saved = resolveBookmark(page, editor.pageSelection);
      if (saved) restorePageRange(el, saved);
      editor.pageSelection = null;
    } else if (
      !props.current.readonly &&
      !editor?.selector$.value?.blockIds?.length &&
      (editor?.scrollPosition.page ?? null) === null
    ) {
      if (journalDate) {
        const bodyLines = props.current.lines.slice(1);
        const lastLine = bodyLines.at(-1);
        if (lastLine) {
          const end = { id: lastLine.model.id, offset: lastLine.text.length };
          el.querySelector<HTMLElement>("[data-page-body]")?.focus({
            preventScroll: true,
          });
          restorePageRange(el, { anchor: end, focus: end });
        }
      } else {
        const title = props.current.lines[0];
        const end = { id: title.model.id, offset: title.text.length };
        restorePageRange(el, { anchor: end, focus: end });
      }
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
        setSelectionLinkOpen(false);
        setSelection(sel.getRangeAt(0).getBoundingClientRect());
      } else if (
        !document.activeElement?.closest(
          '[role="toolbar"],[role="menu"],[role="dialog"]',
        )
      ) {
        setSelectionLinkOpen(false);
        setSelection(null);
      }
    };
    document.addEventListener("selectionchange", onSelection);
    return () => {
      if (editor) editor.pageSelection = owner.selection ?? null;
      controller.current = null;
      owner.dispose();
      document.removeEventListener("selectionchange", onSelection);
    };
  }, [
    page,
    editor,
    controller,
    refresh,
    journalDate,
    readonly,
    contentOnly,
    embedded,
    framework,
    templateList,
    openTemplateVariablePicker,
    editorI18n,
  ]);
  useLayoutEffect(
    () => controller.current?.afterRender(),
    [controller, lines, epoch],
  );
  const [title] = lines;
  useEffect(() => {
    if (selector?.commentId && openThread) {
      const anchor = root.current?.querySelector(
        `[data-page-comment="${CSS.escape(selector.commentId)}"]`,
      );
      if (anchor) {
        anchor.scrollIntoView({ block: "center" });
        openThread(selector.commentId);
        return;
      }
      openThread(selector.commentId);
      return;
    }
    const id = selector?.blockIds?.[0];
    if (id) {
      root.current
        ?.querySelector(`[data-block-id="${CSS.escape(id)}"]`)
        ?.scrollIntoView({ block: "center" });
    }
  }, [selector, openThread]);
  const composing = () => !!controller.current?.isComposing;
  const docs = useService(DocsService);
  useEffect(() => {
    if (!editor || readonly) return;
    return bindDiagramDocumentTitleSync(page, docs);
  }, [docs, editor, page, readonly]);
  const guard = useService(GuardService);
  const workspace = useService(WorkspaceService).workspace;
  const server = useService(ServerService).server;
  const navigate = useDocumentLinkNavigation();
  const openDocLink = (url: string, button: number) => {
    const link = resolveLinkToDoc(url, server.baseUrl);
    if (!link) return false;
    const { docId: pageId, workspaceId, ...params } = link;
    navigate(
      {
        pageId,
        workspaceId,
        params,
        openMode: button === 1 ? "open-in-new-tab" : "open-in-active-view",
      },
      workspace.id,
      (id) => {
        const provider = new CoreDocEmbedProvider(guard, docs, workspace);
        const target = provider.inWorkspace(id);
        if (!target) {
          provider.dispose();
          return;
        }
        return { ...target, dispose: () => provider.dispose() };
      },
    );
    return true;
  };
  const openLink = (info: LinkAnchor, button?: number) => {
    if (button === undefined) {
      setLink(info);
      return;
    }
    const url = normalizeUrl(info.url);
    if (!openDocLink(url, button))
      window.open(url, "_blank", "noopener,noreferrer");
  };
  const bodyStage = (
    <div data-page-body-stage="">
      <div
        ref={bodyRef}
        data-page-body=""
        contentEditable={!readonly}
        suppressContentEditableWarning
      >
        {body.map(function renderItem(line): import("react").ReactNode {
          if (hiddenIds.has(line.model.id)) return null;
          const blockComments =
            "comments" in line.model.props
              ? (line.model.props.comments as
                  Record<string, boolean> | undefined)
              : undefined;
          const withBlockComment = (node: import("react").ReactNode) =>
            blockComments &&
            Object.values(blockComments).some((active) => active === true) ? (
              <div key={line.model.id} data-page-block-comment-host="">
                {node}
                <PageBlockCommentIndicator
                  comments={blockComments}
                  openThread={openThread}
                />
              </div>
            ) : (
              node
            );
          return line.kind === "callout" ? (
            <Suspense key={line.model.id} fallback={null}>
              <Callout model={line.model} readonly={readonly || page.readonly}>
                {line.children.map(renderItem)}
              </Callout>
            </Suspense>
          ) : line.kind === "code" ? (
            withBlockComment(
              <Suspense key={line.model.id} fallback={null}>
                <Code
                  enableComment={!!openThread}
                  enableAI={enableAI}
                  model={line.model}
                  readonly={readonly || page.readonly}
                />
              </Suspense>,
            )
          ) : line.kind === "footnote" ? (
            <Suspense key={line.model.id} fallback={null}>
              <Footnote
                model={line.model}
                readonly={readonly || page.readonly}
              />
            </Suspense>
          ) : line.kind === "iframe" ? (
            <Suspense key={line.model.id} fallback={null}>
              <Iframe model={line.model} readonly={readonly || page.readonly} />
            </Suspense>
          ) : line.kind === "document" ? (
            <Suspense key={line.model.id} fallback={null}>
              <DocumentCard
                model={line.model}
                readonly={readonly || page.readonly}
              />
            </Suspense>
          ) : line.kind === "forge" ? (
            <Suspense key={line.model.id} fallback={null}>
              <Forge model={line.model} readonly={readonly || page.readonly} />
            </Suspense>
          ) : line.kind === "html" ? (
            <Suspense key={line.model.id} fallback={null}>
              <Html model={line.model} readonly={readonly || page.readonly} />
            </Suspense>
          ) : line.kind === "player" ? (
            <Suspense key={line.model.id} fallback={null}>
              <Player model={line.model} readonly={readonly || page.readonly} />
            </Suspense>
          ) : line.kind === "image" ? (
            withBlockComment(
              <Suspense key={line.model.id} fallback={null}>
                <PageImage
                  model={line.model}
                  readonly={readonly || page.readonly}
                />
              </Suspense>,
            )
          ) : line.kind === "bookmark" ? (
            withBlockComment(
              <Suspense key={line.model.id} fallback={null}>
                <Bookmark
                  model={line.model}
                  readonly={readonly || page.readonly}
                />
              </Suspense>,
            )
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
            withBlockComment(
              <Suspense key={line.model.id} fallback={null}>
                <Table
                  detached={!editor}
                  readCell={!editor ? readTableCell : undefined}
                  model={line.model}
                  readonly={readonly || page.readonly}
                  onOpenLink={openDocLink}
                />
              </Suspense>,
            )
          ) : line.kind === "mermaid" ? (
            withBlockComment(
              <Suspense key={line.model.id} fallback={null}>
                <Mermaid
                  model={line.model}
                  readonly={readonly || page.readonly}
                />
              </Suspense>,
            )
          ) : line.kind === "bpmn" ? (
            withBlockComment(
              <Suspense key={line.model.id} fallback={null}>
                <Bpmn model={line.model} readonly={readonly || page.readonly} />
              </Suspense>,
            )
          ) : line.kind === "attachment" ? (
            withBlockComment(
              <Suspense key={line.model.id} fallback={null}>
                <Attachment
                  model={line.model}
                  readonly={readonly || page.readonly}
                />
              </Suspense>,
            )
          ) : line.kind === "event" ? (
            <Suspense key={line.model.id} fallback={null}>
              <EventCard
                model={line.model}
                readonly={readonly || page.readonly}
              />
            </Suspense>
          ) : line.kind === "database" ? (
            line.model.props.serverDatabaseId?.trim() ? (
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
            ) : null
          ) : line.kind === "equation" ? (
            withBlockComment(
              <Suspense key={line.model.id} fallback={null}>
                <Equation
                  model={line.model}
                  readonly={readonly || page.readonly}
                />
              </Suspense>,
            )
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
          ) : line.kind === "toc" ? (
            <div
              key={line.model.id}
              data-page-toc={line.model.id}
              data-block-id={line.model.id}
              tabIndex={-1}
              contentEditable={false}
            >
              <Suspense fallback={null}>
                <TableOfContents
                  model={line.model}
                  readonly={readonly || page.readonly}
                  embedded={embedded}
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
              data-callout-text={
                line.model.flavour === "myoxus:callout" || undefined
              }
              data-list-kind={
                line.kind === "bulleted" ||
                line.kind === "numbered" ||
                line.kind === "todo"
                  ? line.kind
                  : undefined
              }
              data-list-checked={
                line.kind === "todo" && line.checked ? "true" : undefined
              }
              role={line.heading ? "heading" : undefined}
              aria-level={line.heading ? Number(line.heading[1]) : undefined}
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
                marginInlineStart: `calc(${line.depth} * var(--mantine-spacing-xl))`,
              }}
            >
              {expandable.has(line.model.id) && (
                <span data-disclosure="" contentEditable={false}>
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
              {(line.kind === "bulleted" ||
                line.kind === "numbered" ||
                line.kind === "todo") && (
                <span data-list-marker={line.kind} contentEditable={false}>
                  {line.kind === "numbered" ? (
                    getNumberPrefix(line.ordinal, listNestingDepth(line.model))
                  ) : line.kind === "todo" ? (
                    <Checkbox
                      size="sm"
                      checked={Boolean(line.checked)}
                      disabled={readonly}
                      aria-label={t["com.myoxus.editor.slash.todo-list"]()}
                      onChange={(_event, checked) => {
                        if (!readonly && !page.readonly) {
                          page.captureSync();
                          page.updateBlock(line.model, { checked });
                          page.captureSync();
                        }
                      }}
                    />
                  ) : (
                    BULLET_GLYPHS[listNestingDepth(line.model) % 3]
                  )}
                </span>
              )}
              <TextField
                linkMenu={openLink}
                comment={openThread}
                line={line}
                readonly={readonly || line.textProtection === "fixed"}
                composing={composing}
              />
              <PageLineAttributesBar
                model={line.model}
                textProtection={line.textProtection}
                repeat={line.repeat}
                comments={line.comments}
                readonly={readonly || page.readonly}
                openThread={openThread}
              />
            </div>
          );
        })}
      </div>
      {editor && (
        <PageRemotePresence
          page={page}
          bodyRef={bodyRef}
          readonly={readonly || page.readonly}
          lines={lines}
          epoch={epoch}
        />
      )}
    </div>
  );
  if (embedded) {
    return (
      <div
        ref={root}
        dir={dir}
        data-document-id={page.id}
        data-page-embedded-preview={page.id}
        data-page-renderer="snapshot"
      >
        {bodyStage}
      </div>
    );
  }
  const Viewport = contentOnly
    ? DetailPageEditorViewport
    : DocumentEditorPageViewport;
  return (
    <DocumentEditorRoot
      ref={root}
      mode="page"
      readingSize={settings.fontSize}
      className={className}
      data-full-width-layout={fullWidth}
      dir={dir}
      data-testid={`editor-${page.id}`}
      data-document-id={page.id}
      contentOnly={contentOnly}
      data-page-renderer={editor ? "native" : "snapshot"}
    >
      <Viewport
        {...(contentOnly && { editorMode: "page", pageModeContentBox: true })}
      >
        {!contentOnly && journalDate && (
          <VirgultumEditorJournalDocTitleUI date={journalDate} />
        )}
        {!contentOnly && !journalDate && (
          <DocumentTitleRow data-testid="doc-title-row">
            {editor && <DocIconPicker docId={page.id} readonly={readonly} />}
            <TextField
              line={title}
              snapshotTitle={!editor}
              title={t.Title()}
              readonly={readonly}
              composing={composing}
              onContextMenu={(event) => {
                if (readonly || page.readonly) return;
                if (!templateList?.isTemplate$(page.id).value) return;
                event.preventDefault();
                const range = root.current ? readPageRange(root.current) : null;
                const anchor =
                  range &&
                  range.anchor.id === title.model.id &&
                  range.focus.id === title.model.id
                    ? {
                        blockId: title.model.id,
                        from: Math.min(range.anchor.offset, range.focus.offset),
                        to: Math.max(range.anchor.offset, range.focus.offset),
                      }
                    : {
                        blockId: title.model.id,
                        from: title.text.length,
                        to: title.text.length,
                      };
                openTemplateVariablePicker({
                  i18n: editorI18n,
                  templateSource: true,
                  canWrite: () => !props.current.readonly && !page.readonly,
                  insert: (token) => {
                    controller.current?.insertTemplateToken(token, anchor);
                    repaint();
                  },
                  onClose: () => controller.current?.restore(),
                });
              }}
            />
          </DocumentTitleRow>
        )}
        {metadata}
        <PageContentRail width="editor">{bodyStage}</PageContentRail>
        {!contentOnly && (
          <DocumentEditorBlankGap
            data-testid="page-editor-blank"
            onClick={() => controller.current?.focusPageEnd()}
          />
        )}
        {!readonly && !journalDate && <StarterBar doc={page} />}
        {link && (
          <Suspense fallback={null}>
            <LinkMenu
              key={JSON.stringify(link.range)}
              anchor={link}
              readonly={readonly || page.readonly}
              dismiss={() => setLink(null)}
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
        {slash && !readonly && controller.current && root.current && (
          <Suspense fallback={null}>
            <PageSlash
              owner={controller.current}
              page={page}
              start={slash}
              root={root.current}
              enableAI={enableAI}
              openBuildingBlockPicker={openBuildingBlockPicker}
              insertNamedBuildingBlock={insertNamedBuildingBlock}
              close={dismissSlash}
            />
          </Suspense>
        )}
        {!readonly && selection && controller.current && (
          <PageFormatting
            key={selectionLinkOpen ? "link" : "bar"}
            page={page}
            controller={controller.current}
            rect={selection}
            dismiss={() => {
              setSelectionLinkOpen(false);
              setSelection(null);
            }}
            changed={repaint}
            enableAI={enableAI}
            canComment={Boolean(openThread)}
            initialLinkOpen={selectionLinkOpen}
          />
        )}
        {templateVariablePicker}
        {buildingBlockPicker}
      </Viewport>
    </DocumentEditorRoot>
  );
}
