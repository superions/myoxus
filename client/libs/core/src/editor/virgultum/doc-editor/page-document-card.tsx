// SPDX-License-Identifier: AGPL-3.0-or-later
import { usePageCaption } from "./page-caption";
import {
  lazy,
  Suspense,
  useEffect,
  useLayoutEffect,
  useState,
  useRef,
} from "react";
import { createPortal } from "react-dom";
import { effect } from "@preact/signals-core";
import { useI18n } from "@myoxus/i18n";
import { useService } from "@myoxus/infra";
import { MyoxusText, ReferenceCard } from "@myoxus/ui-facade";
import { LinkIcon } from "@myoxus/icons/react";
import { nanoid } from "nanoid";
import type {
  EmbedLinkedDocModel,
  EmbedSyncedDocModel,
  NoteBlockModel,
} from "@virgultum/core/models";
import type { BlockModel } from "@virgultum/core/store";
import { supportedText } from "./plain-page-model";
import { pageTextRun } from "./page-text-run";
import { EMBED_CARD_HEIGHT, EMBED_CARD_WIDTH } from "@virgultum/core/consts";
import { CoreDocEmbedProvider, DocsService } from "../../../modules/doc";
import { WorkspaceService } from "../../../modules/workspace";
import { GuardService } from "../../../modules/permissions";
import { WorkbenchService } from "../../../modules/workbench";
import { PeekViewService } from "../../../modules/peek-view";
import { useNavigateHelper } from "../../../components/hooks/use-navigate-helper";
import { EditorDocumentCard } from "../../view-extensions/editor-view/editor-chrome/document-card";
import type { PageBookmark, PageIntent } from "./plain-page-input";
import { readRasterSurface } from "./raster-surface";
import type { SurfaceBlockModel } from "@virgultum/core/runtime/gfx";
const RasterPreview = lazy(() => import("./canvas-preview"));

type Target = NonNullable<
  ReturnType<CoreDocEmbedProvider["openReference"]>["target"]["value"]
>;
type State = {
  key: string;
  target?: Target;
  title?: string;
  updated?: number;
  lines?: BlockModel[];
  canvas?: SurfaceBlockModel;
  deleted?: boolean;
  error?: boolean;
  loading?: boolean;
  specialist?: boolean;
  cycle?: boolean;
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
  handoff,
}: {
  model: EmbedLinkedDocModel | EmbedSyncedDocModel;
  readonly: boolean;
  handoff: (r: PageBookmark | null, i?: PageIntent) => void;
}) {
  const caption = usePageCaption(model, readonly);
  const t = useI18n(),
    guard = useService(GuardService),
    docs = useService(DocsService),
    workspace = useService(WorkspaceService).workspace;
  const workbench = useService(WorkbenchService).workbench,
    peek = useService(PeekViewService).peekView,
    { jumpToPageBlock } = useNavigateHelper();
  const { pageId, workspaceId, params, title, description, style } =
      model.props,
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
            const compact = ["list", "cube", "horizontalThin"].includes(style);
            const cycle =
              target.collection.id === workspace.id &&
              target.docId === model.store.id;
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
            const eligibleText = (m: BlockModel) =>
              m.flavour === "myoxus:paragraph" &&
              (m.props as { type?: string }).type === "text" &&
              !m.children.length &&
              !!m.text &&
              supportedText(m.text.yText, false);
            const candidates = synced
              ? nodes
              : nodes.filter(
                  (m) =>
                    (m.flavour === "myoxus:image" && style === "vertical") ||
                    (["myoxus:paragraph", "myoxus:list"].includes(m.flavour) &&
                      !!m.text?.length),
                );
            const needed =
              cycle || (!synced && (compact || !!description || selected))
                ? []
                : style === "horizontal"
                  ? candidates.slice(0, 1)
                  : synced
                    ? candidates
                    : candidates.slice(
                        0,
                        Math.floor(EMBED_CARD_HEIGHT[style] / 20),
                      );
            // A raster-only viewport cannot represent a Note, frame, specialist
            // diagram or selected subset. Hand the entire preview to its owner.
            const canvas =
              synced &&
              !selected &&
              mode === "edgeless" &&
              target.collection.id === workspace.id
                ? readRasterSurface(page)
                : undefined;
            const specialist =
              !cycle &&
              !canvas &&
              ((synced && (selected || mode === "edgeless" || !mode)) ||
                needed.some((m) => !eligibleText(m)));
            setResult({
              key,
              target,
              title: currentTitle,
              updated: page.meta?.updatedDate ?? page.meta?.createDate,
              lines: specialist ? [] : needed,
              specialist,
              canvas,
              cycle,
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
  }, [model, workspace, docs, guard, key, retry, description, synced]);
  const state = result?.key === key ? result : undefined;
  useEffect(() => {
    if (state?.specialist && active.current === state.target) handoff(null);
  }, [state, handoff]);
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
      void peek
        .open({ docRef: { docId: tr.docId }, ...params })
        .catch(console.error);
      return;
    }
    workbench.openDoc(
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
  const select = (e: React.MouseEvent) => {
    if (!synced && (e.ctrlKey || e.metaKey || e.button === 1)) {
      open(e, false);
      return;
    }
    if (!readonly && !model.store.readonly)
      handoff(null, {
        kind: "block-command",
        id: model.id,
        flavour: model.flavour,
      });
  };
  return (
    <div
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
    >
      {state?.canvas ? (
        <Suspense fallback={null}>
          <RasterPreview surface={state.canvas} title={label} />
        </Suspense>
      ) : synced && state?.target && !state.specialist && !state.cycle ? (
        <ReferenceCard
          size="preview"
          orientation="vertical"
          title={label}
          icon={<LinkIcon />}
          preview={
            state.lines?.some((model) => model.text?.length)
              ? state.lines.map((model) => (
                  <Excerpt key={model.id} model={model} />
                ))
              : t["com.myoxus.editor.embed.synced-empty-hint"]()
          }
        />
      ) : (
        <EditorDocumentCard
          controls={{
            title: label,
            selected: false,
            inSurface: false,
            kind: synced ? "synced" : "linked",
            variant: synced ? "horizontal" : style,
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
            height: EMBED_CARD_HEIGHT[style],
            width: EMBED_CARD_WIDTH[style],
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
    </div>
  );
}
