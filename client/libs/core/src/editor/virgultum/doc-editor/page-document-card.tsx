// SPDX-License-Identifier: AGPL-3.0-or-later
import { usePageCaption } from "./page-caption";
import {
  lazy,
  Suspense,
  useContext,
  useLayoutEffect,
  useMemo,
  useState,
  useRef,
} from "react";
import { createPortal } from "react-dom";
import { effect } from "@preact/signals-core";
import { useI18n } from "@myoxus/i18n";
import { useFramework, useService, useServiceOptional } from "@myoxus/infra";
import { MyoxusText, ReferenceCard } from "@myoxus/ui-facade";
import { LinkIcon } from "@myoxus/icons/react";
import { nanoid } from "nanoid";
import type {
  EmbedLinkedDocModel,
  EmbedSyncedDocModel,
  NoteBlockModel,
} from "@virgultum/core/models";
import { Text, type BlockModel, type Store } from "@virgultum/core/store";
import type { PageContent } from "./plain-page-model";
import { pageTextRun } from "./page-text-run";
import { EMBED_CARD_HEIGHT, EMBED_CARD_WIDTH } from "@virgultum/core/consts";
import { CoreDocEmbedProvider, DocsService } from "../../../modules/doc";
import { WorkspaceService } from "../../../modules/workspace";
import { GuardService } from "../../../modules/permissions";
import { WorkbenchService } from "../../../modules/workbench";
import { PeekViewService } from "../../../modules/peek-view";
import { useNavigateHelper } from "../../../components/hooks/use-navigate-helper";
import { EditorDocumentCard } from "../../view-extensions/editor-view/editor-chrome/document-card";
import { EditorEmbedCardEdit } from "../../view-extensions/editor-view/editor-chrome/embed-card-edit";
import { EditorSelectionToolbar } from "../../view-extensions/editor-view/editor-chrome/selection-toolbar";
import {
  copyOrCutPageBlock,
  deletePageBlock,
  duplicatePageBlock,
  leaveAtomicPageBlock,
  notifyCopied,
  pasteAfterPageBlock,
} from "./page-block-actions";
import { usePageFloatingAnchor } from "./page-floating-anchor";
import { readRasterSurface } from "./raster-surface";
import type { SurfaceBlockModel } from "@virgultum/core/runtime/gfx";
import {
  MAX_SYNCED_DOC_DEPTH,
  projectSyncedDocContent,
  SyncedDocAncestorsContext,
  syncedDocAncestorKey,
} from "./page-synced-doc-preview";
import { PageSnapshot } from "./plain-page-view";
const RasterPreview = lazy(() => import("./canvas-preview"));

type Target = NonNullable<
  ReturnType<CoreDocEmbedProvider["openReference"]>["target"]["value"]
>;
type State = {
  key: string;
  target?: Target;
  page?: Store;
  content?: PageContent | null;
  empty?: boolean;
  title?: string;
  updated?: number;
  lines?: BlockModel[];
  canvas?: SurfaceBlockModel;
  deleted?: boolean;
  error?: boolean;
  loading?: boolean;
  cycle?: boolean;
  revision?: number;
};
function Excerpt({ model }: { model: BlockModel }) {
  const ref = useRef<HTMLSpanElement>(null);
  const text = model.text?.yText;
  useLayoutEffect(() => {
    const el = ref.current;
    if (!text || !el) return;
    const paint = () =>
      el.replaceChildren(
        ...text
          .toDelta()
          .map(
            (run: { insert: string; attributes?: Record<string, unknown> }) =>
              pageTextRun(el.ownerDocument, run.insert, run.attributes ?? {}),
          ),
      );
    paint();
    text.observe(paint);
    return () => text.unobserve(paint);
  }, [text]);
  return (
    <MyoxusText>
      <span ref={ref} />
    </MyoxusText>
  );
}

export default function PageDocumentCard({
  model,
  readonly,
}: {
  model: EmbedLinkedDocModel | EmbedSyncedDocModel;
  readonly: boolean;
}) {
  const caption = usePageCaption(model, readonly);
  const t = useI18n(),
    framework = useFramework(),
    guard = useService(GuardService),
    docs = useService(DocsService),
    workspace = useService(WorkspaceService).workspace;
  const workbench = useServiceOptional(WorkbenchService)?.workbench,
    peek = useServiceOptional(PeekViewService)?.peekView,
    { jumpToPageBlock } = useNavigateHelper();
  const ancestors = useContext(SyncedDocAncestorsContext);
  const { pageId, workspaceId, params, title, description, style } =
      model.props,
    cardStyle = style === "citation" ? "horizontal" : style,
    synced = model.flavour === "myoxus:embed-synced-doc";
  const key = JSON.stringify([workspaceId, pageId, params, style]);
  const [result, setResult] = useState<State>(),
    [retry, setRetry] = useState(0),
    [preview, setPreview] = useState<HTMLDivElement | null>(null);
  const active = useRef<Target | null>(null);
  useLayoutEffect(() => {
    const provider = new CoreDocEmbedProvider(guard, docs, workspace),
      binding = provider.openReference(workspaceId, pageId);
    const stop = effect(() => {
      const target = binding.target.value;
      const allowed = target?.access.readable(target.docId).value;
      active.current = null;
      if (!target || allowed !== true) {
        setResult({
          key,
          loading: target === undefined || (!!target && allowed === undefined),
          error: target === null || allowed === false,
        });
        return;
      }
      const currentTitle = target.access.referenceTitleSignal?.(
        target.docId,
      )?.value;
      const mode =
        params?.mode ?? target.access.primaryMode?.(target.docId)?.value;
      const attempt = new AbortController(),
        signal = AbortSignal.any([attempt.signal, AbortSignal.timeout(30000)]);
      let release: (() => void) | undefined;
      let paintRevision = 0;
      const live = () =>
        !attempt.signal.aborted &&
        binding.target.peek() === target &&
        target.access.readable(target.docId).peek() === true;
      setResult({ key, loading: true });
      void target.access
        .waitForLoaded(target.docId, signal)
        .then(() => {
          if (!live()) return;
          const doc = target.collection.getDoc(target.docId);
          if (!doc) {
            setResult({ key, error: true });
            return;
          }
          // A private readonly projection must not dispose or change permissions
          // on the live Store used by an open editor of the referenced document.
          const options = { id: nanoid(), readonly: true },
            page = doc.getStore(options);
          const paint = () => {
            if (!live()) return;
            active.current = null;
            if (page.meta?.trash || !page.root) {
              setResult({
                key,
                deleted: !!page.meta?.trash,
                error: !page.root,
              });
              return;
            }
            active.current = target;
            const targetKey = syncedDocAncestorKey(
              target.collection.id,
              target.docId,
            );
            const cycle =
              (target.collection.id === workspace.id &&
                target.docId === model.store.id) ||
              ancestors.has(targetKey) ||
              ancestors.size >= MAX_SYNCED_DOC_DEPTH;
            const updated = page.meta?.updatedDate ?? page.meta?.createDate;
            const rev = ++paintRevision;

            if (synced) {
              if (cycle) {
                setResult({
                  key,
                  target,
                  title: currentTitle,
                  updated,
                  cycle: true,
                  revision: rev,
                });
                return;
              }
              const hasSelection = !!(
                params?.blockIds?.length ||
                params?.elementIds?.length ||
                params?.blockSelection !== undefined
              );
              const canvas =
                !hasSelection &&
                mode === "edgeless" &&
                target.collection.id === workspace.id
                  ? readRasterSurface(page)
                  : undefined;
              if (canvas) {
                setResult({
                  key,
                  target,
                  page,
                  title: currentTitle,
                  updated,
                  canvas,
                  revision: rev,
                });
                return;
              }
              const projection = projectSyncedDocContent(page, params, mode);
              if (projection.status === "error") {
                setResult({
                  key,
                  target,
                  title: currentTitle,
                  updated,
                  error: true,
                  revision: rev,
                });
                return;
              }
              setResult({
                key,
                target,
                page,
                content: projection.content,
                lines: projection.fallbackLines,
                empty: projection.empty,
                title: currentTitle,
                updated,
                revision: rev,
              });
              return;
            }

            const compact = ["list", "cube", "horizontalThin"].includes(
              cardStyle,
            );
            const nodes = page.root.children
              .filter(
                (m) =>
                  m.flavour === "myoxus:note" &&
                  !(m as NoteBlockModel).props.hidden &&
                  (m as NoteBlockModel).props.displayMode !== "edgeless",
              )
              .flatMap((n) => n.children);
            const selected = !!(
              params?.blockIds?.length || params?.elementIds?.length
            );
            const candidates = nodes.filter(
              (m) =>
                ["myoxus:paragraph", "myoxus:list"].includes(m.flavour) &&
                !!m.text?.length,
            );
            const needed =
              cycle || compact || !!description || selected
                ? []
                : cardStyle === "horizontal"
                  ? candidates.slice(0, 1)
                  : candidates.slice(
                      0,
                      Math.floor(EMBED_CARD_HEIGHT[cardStyle] / 20),
                    );
            setResult({
              key,
              target,
              title: currentTitle,
              updated,
              lines: needed,
              cycle,
              revision: rev,
            });
          };
          release = () => {
            page.spaceDoc.off("afterTransaction", paint);
            page.dispose();
            doc.removeStore(options);
          };
          page.load();
          page.spaceDoc.on("afterTransaction", paint);
          paint();
        })
        .catch(() => {
          if (live()) setResult({ key, error: true });
        });
      return () => {
        attempt.abort();
        active.current = null;
        release?.();
      };
    });
    return () => {
      stop();
      binding.dispose();
      provider.dispose();
    };
  }, [
    model,
    workspace,
    docs,
    guard,
    key,
    retry,
    description,
    synced,
    ancestors,
  ]);
  const state = result?.key === key ? result : undefined;
  const nextAncestors = useMemo(() => {
    const next = new Set(ancestors);
    next.add(syncedDocAncestorKey(workspace.id, model.store.id));
    if (state?.target) {
      next.add(
        syncedDocAncestorKey(state.target.collection.id, state.target.docId),
      );
    }
    return next;
  }, [ancestors, workspace.id, model.store.id, state?.target]);
  const open = (event: React.MouseEvent, center: boolean) => {
    const tr = active.current;
    if (!tr || !tr.access.readable(tr.docId).peek()) return;
    if (tr.collection.id !== workspace.id) {
      void jumpToPageBlock(
        tr.collection.id,
        tr.docId,
        params?.mode,
        params?.blockIds,
        params?.elementIds,
      );
      return;
    }
    if (center) {
      if (peek) {
        void peek
          .open({ docRef: { docId: tr.docId }, ...params })
          .catch(console.error);
      }
      return;
    }
    workbench?.openDoc(
      { docId: tr.docId, ...params },
      {
        at: event.altKey && BUILD_CONFIG.isElectron ? "beside" : "new-tab",
        show: true,
      },
    );
  };
  const label = state?.target ? title || state.title || t.Untitled() : "",
    loading = !state || !!state.loading;
  const stamp = state?.updated ? new Date(state.updated) : null,
    updated =
      stamp &&
      (style === "cube"
        ? stamp.toLocaleTimeString(t.language)
        : stamp.toLocaleString(t.language));
  const cardRef = useRef<HTMLDivElement>(null);
  const [selected, setSelected] = useState(false);
  const [editing, setEditing] = useState(false);
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const [floating, setFloating] = useState<HTMLElement | null>(null);
  const writable = () =>
    !readonly &&
    !model.store.readonly &&
    model.store.getModelById(model.id) === model;
  usePageFloatingAnchor({
    active: selected || editing,
    reference: cardRef.current,
    anchor,
    floating,
    onDismiss: () => {
      setSelected(false);
      setEditing(false);
    },
  });
  const switchDocView = (nextKind: "inline" | "linked" | "synced") => {
    if (!writable()) return;
    const store = model.store;
    const parent = store.getParent(model);
    if (!parent) return;
    const index = parent.children.indexOf(model);
    if (index < 0) return;
    const workspaceId = (model.props as { workspaceId?: string }).workspaceId;
    if (nextKind === "inline") {
      const refText = new Text();
      refText.insert(" ", 0, {
        reference: {
          type: synced ? "Subpage" : "LinkedPage",
          pageId: model.props.pageId,
          ...(workspaceId ? { workspaceId } : {}),
          params: model.props.params,
        },
      });
      store.captureSync();
      store.transact(() => {
        store.addBlock("myoxus:paragraph", { text: refText }, parent, index);
        store.deleteBlock(model);
      });
      store.captureSync();
      setSelected(false);
      return;
    }
    const targetFlavour =
      nextKind === "synced"
        ? "myoxus:embed-synced-doc"
        : "myoxus:embed-linked-doc";
    if (model.flavour === targetFlavour) return;
    store.captureSync();
    store.transact(() => {
      store.addBlock(
        targetFlavour,
        {
          pageId: model.props.pageId,
          ...(workspaceId ? { workspaceId } : {}),
          params: model.props.params,
          caption: model.props.caption,
        },
        parent,
        index,
      );
      store.deleteBlock(model);
    });
    store.captureSync();
    setSelected(false);
  };
  const select = (e: React.MouseEvent) => {
    if (!synced && (e.ctrlKey || e.metaKey || e.button === 1)) {
      open(e, false);
      return;
    }
    if (!readonly && !model.store.readonly) {
      setSelected(true);
      cardRef.current?.focus({ preventScroll: true });
    }
  };
  const toolbarState = {
    open: selected && !editing && !readonly,
    key: model.id,
    placement: "top" as const,
    primary: [
      {
        id: "open",
        label: label || t.Untitled(),
        icon: "LinkedPageIcon" as const,
        showLabel: true,
        disabled: !state?.target,
        run: (_el: HTMLElement, e: MouseEvent) =>
          open(e as unknown as React.MouseEvent, false),
      },
      {
        id: "peek",
        label: t["com.myoxus.peek-view-controls.open-doc-in-center-peek"](),
        icon: "CenterPeekIcon" as const,
        disabled: !state?.target,
        run: (_el: HTMLElement, e: MouseEvent) =>
          open(e as unknown as React.MouseEvent, true),
      },
      ...(!synced
        ? [
            {
              id: "edit",
              label: t["com.myoxus.editor.toolbar.edit-description"](),
              icon: "EditIcon" as const,
              disabled: false,
              run: () => setEditing(true),
            },
          ]
        : []),
      {
        id: "switch-view",
        label: t["com.myoxus.keyboardShortcuts.switch"](),
        icon: "LinkIcon" as const,
        disabled: false,
        control: {
          type: "choice" as const,
          value: synced ? "synced" : "linked",
          options: [
            {
              value: "inline",
              label: t["com.myoxus.editor.toolbar.inline-view"](),
            },
            {
              value: "linked",
              label: t["com.myoxus.editor.toolbar.card-view"](),
            },
            {
              value: "synced",
              label: t["com.myoxus.editor.toolbar.embed-view"](),
            },
          ],
          change: (value: string) => {
            if (value === "inline" || value === "linked" || value === "synced")
              switchDocView(value);
          },
        },
      },
      {
        id: "caption",
        label: t["com.myoxus.editor.toolbar.caption"](),
        icon: "CaptionIcon" as const,
        disabled: false,
        run: caption.show,
      },
    ],
    more: [
      {
        id: "reload",
        label: t["com.myoxus.editor.toolbar.reload"](),
        icon: "ResetIcon" as const,
        disabled: false,
        run: () => setRetry((n) => n + 1),
      },
      {
        id: "copy",
        label: t["Copy"](),
        icon: "CopyIcon" as const,
        disabled: false,
        run: () => {
          const abort = new AbortController();
          void copyOrCutPageBlock(model, "copy", framework, abort.signal)
            .then(() => notifyCopied(t["Copied to clipboard"]()))
            .catch(console.error);
          setSelected(false);
        },
      },
      {
        id: "duplicate",
        label: t["com.myoxus.editor.keyboard.duplicate"](),
        icon: "DuplicateIcon" as const,
        disabled: false,
        run: () => {
          duplicatePageBlock(model);
          setSelected(false);
        },
      },
      {
        id: "delete",
        label: t["Delete"](),
        icon: "DeleteIcon" as const,
        variant: "destructive" as const,
        disabled: false,
        run: () => {
          deletePageBlock(model);
          setSelected(false);
        },
      },
    ],
  };
  return (
    <div
      ref={cardRef}
      data-block-id={model.id}
      data-page-doc-card={model.flavour}
      contentEditable={false}
      tabIndex={-1}
      onClick={select}
      onAuxClick={(e) => {
        if (e.button === 1 && !synced) open(e, false);
      }}
      onDoubleClick={(e) => {
        if (!synced) open(e, true);
      }}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          setSelected(false);
          setEditing(false);
          return;
        }
        if (e.target !== cardRef.current || !writable()) return;
        if (
          ["Delete", "Backspace", "Enter", "ArrowDown", "ArrowUp"].includes(
            e.key,
          )
        ) {
          e.preventDefault();
          leaveAtomicPageBlock(
            cardRef.current.closest<HTMLElement>("[data-page-renderer]"),
            model,
            e.key === "ArrowUp" || e.key === "Backspace" ? -1 : 1,
            e.key === "Delete" || e.key === "Backspace",
            e.key === "Enter",
          );
        }
      }}
      onCopy={(e) => {
        if (document.activeElement !== cardRef.current) return;
        e.preventDefault();
        const abort = new AbortController();
        void copyOrCutPageBlock(model, "copy", framework, abort.signal).catch(
          console.error,
        );
      }}
      onCut={(e) => {
        if (document.activeElement !== cardRef.current || !writable()) return;
        e.preventDefault();
        const abort = new AbortController();
        void copyOrCutPageBlock(model, "cut", framework, abort.signal).catch(
          console.error,
        );
      }}
      onPaste={(e) => {
        if (document.activeElement !== cardRef.current || !writable()) return;
        e.preventDefault();
        void pasteAfterPageBlock(model, e.clipboardData).catch(console.error);
      }}
    >
      {state?.canvas ? (
        <Suspense fallback={null}>
          <RasterPreview surface={state.canvas} title={label} />
        </Suspense>
      ) : synced &&
        state?.target &&
        !state.error &&
        !state.deleted &&
        !state.cycle ? (
        <SyncedDocAncestorsContext.Provider value={nextAncestors}>
          <ReferenceCard
            size="preview"
            orientation="vertical"
            title={label}
            icon={<LinkIcon />}
            preview={
              state.empty ? (
                t["com.myoxus.editor.embed.synced-empty-hint"]()
              ) : state.content && state.page ? (
                <PageSnapshot
                  page={state.page}
                  content={state.content}
                  embedded
                />
              ) : state.lines?.some((entry) => entry.text?.length) ? (
                state.lines.map((entry) => (
                  <Excerpt key={entry.id} model={entry} />
                ))
              ) : (
                t["com.myoxus.editor.embed.synced-empty-hint"]()
              )
            }
          />
        </SyncedDocAncestorsContext.Provider>
      ) : (
        <EditorDocumentCard
          controls={{
            title: label,
            selected: false,
            inSurface: false,
            kind: synced ? "synced" : "linked",
            variant: synced ? "horizontal" : cardStyle,
            description: state?.target ? (description ?? "") : "",
            deleted: state?.deleted,
            updated,
            loading,
            error: !!state?.error,
            unavailable: !state?.target,
            empty: !state?.lines?.length,
            nodeReference: !!(
              params?.blockIds?.length || params?.elementIds?.length
            ),
            height: EMBED_CARD_HEIGHT[cardStyle],
            width: EMBED_CARD_WIDTH[cardStyle],
            mountPreview: setPreview,
            reload: () => setRetry((n) => n + 1),
          }}
        />
      )}
      {preview && state?.target && !synced && state.lines?.length
        ? createPortal(
            state.lines.map((model) => (
              <Excerpt key={model.id} model={model} />
            )),
            preview,
          )
        : null}
      {caption.field}
      {selected && !editing && !readonly ? (
        <EditorSelectionToolbar
          controls={{
            getSnapshot: () => toolbarState,
            subscribe: () => () => {},
            setAnchor,
            setFloating,
            activate: () => cardRef.current?.focus({ preventScroll: true }),
            dismiss: () => setSelected(false),
          }}
        />
      ) : null}
      {editing && !synced && !readonly ? (
        <EditorEmbedCardEdit
          controls={{
            mode: "linked",
            internal: true,
            title: title ?? "",
            description: description ?? "",
            canReset: Boolean(title || description),
            reset: () => {
              if (writable()) {
                model.store.captureSync();
                model.store.updateBlock(model, {
                  title: null,
                  description: null,
                });
                model.store.captureSync();
              }
              setEditing(false);
            },
            setAnchor,
            confirm: (nextTitle, nextDescription) => {
              if (writable()) {
                model.store.captureSync();
                model.store.updateBlock(model, {
                  title: nextTitle.trim() || null,
                  description: nextDescription.trim() || null,
                });
                model.store.captureSync();
              }
              setEditing(false);
            },
            close: () => setEditing(false),
          }}
        />
      ) : null}
    </div>
  );
}
