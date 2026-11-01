import type { EdgelessEditor, PageEditor } from "@myoxus/core/editor/editors";
import { EditorSettingService } from "@myoxus/core/modules/editor-setting";
import { FeatureFlagService } from "@myoxus/core/modules/feature-flag";
import { MermaidDiagramsService } from "@myoxus/core/modules/mermaid-diagrams";
import { hasInitializedDiagramContent } from "@myoxus/core/modules/mermaid-diagrams/services/mermaid-diagrams";
import { ServerService } from "@myoxus/core/modules/server";
import { WorkspaceService } from "@myoxus/core/modules/workspace";
import { ViewService } from "@myoxus/core/modules/workbench";
import { useLiveData, useService, useServiceOptional } from "@myoxus/infra";
import { useI18n } from "@myoxus/i18n";
import track from "@myoxus/track";
import { DocumentEditorRoot, EditorLoading, notify } from "@myoxus/ui-facade";
import { requestBpmnEditor } from "@virgultum/block-bpmn";
import {
  insertMermaidBlockCommand,
  insertMermaidEdgelessDiagramCommand,
  prepareMermaidFamilySource,
} from "@virgultum/block-mermaid";
import { appendParagraphCommand } from "@virgultum/editor/blocks/paragraph";
import type { DocTitle } from "@virgultum/editor/fragments/doc-title";
import { DisposableGroup } from "@virgultum/editor/global/disposable";
import { IS_LINUX } from "@virgultum/editor/global/env";
import {
  MermaidBlockModel,
  NoteBlockModel,
  type DocMode,
  type RootBlockModel,
} from "@virgultum/editor/model";
import { Bound } from "@virgultum/editor/global/gfx";
import {
  customImageProxyMiddleware,
  ImageProxyService,
} from "@virgultum/editor/shared/adapters";
import { focusBlockEnd } from "@virgultum/editor/shared/commands";
import { getLastNoteBlock } from "@virgultum/editor/shared/utils";
import {
  BlockSelection,
  type BlockStdScope,
  type EditorHost,
} from "@virgultum/editor/std";
import { GfxControllerIdentifier } from "@virgultum/editor/std/gfx";
import type { Store } from "@virgultum/editor/store";
import {
  type HTMLAttributes,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useId,
  useState,
} from "react";

import { VirgultumDocEditor, VirgultumEdgelessEditor } from "./lit-adaper";

export interface MyoxusEditorContainer extends HTMLElement {
  page: Store;
  doc: Store;
  docTitle: DocTitle;
  host?: EditorHost;
  model: RootBlockModel | null;
  updateComplete: Promise<boolean>;
  mode: DocMode;
  /**
   * B-FIND-02: host root element. `null` until the React
   * `useRef` mounts; consumers must null-check. The legacy
   * shape erased this via `as unknown as HTMLDivElement`,
   * which silently lied when the ref was not yet attached
   * (e.g. during the first render or after a fast unmount).
   * Tightening to `HTMLDivElement | null` is the smallest
   * honest surface.
   */
  origin: HTMLDivElement | null;
  std: BlockStdScope;
}

export interface EditorProps extends HTMLAttributes<HTMLDivElement> {
  page: Store;
  mode: DocMode;
  shared?: boolean;
  readonly?: boolean;
  /** Immutable, isolated content: never attach live-document loading or metadata chrome. */
  snapshot?: boolean;
  /** Render native body content without the surrounding document-page chrome. */
  contentOnly?: boolean;
  // on Editor ready
  onEditorReady?: (editor: MyoxusEditorContainer) => (() => void) | void;
  /** Includes native Lit initialization failures that React boundaries cannot catch. */
  onEditorError?: (error: unknown) => void;
}

async function activateCatalogMermaidNote(
  std: BlockStdScope,
  blockId: string,
  signal: AbortSignal,
) {
  const note = std.store.getParent(blockId);
  if (!(note instanceof NoteBlockModel)) return;
  const gfx = std.get(GfxControllerIdentifier);
  // Both selections are required: outer Note editing permits scoped events,
  // while the inner BlockSelection activates the Mermaid family controls.
  gfx.selection.set({
    elements: [note.id],
    editing: true,
  });
  // Opening the GFX scope clears the inner "note" group. Restore that group
  // without replacing the outer selection or introducing a history owner.
  std.selection.setGroup("note", [
    std.selection.create(BlockSelection, { blockId }),
  ]);
  await std.host.updateComplete;
  await std.view.getBlock(note.id)?.updateComplete;
  const block = std.view.getBlock(blockId);
  await block?.updateComplete;
  if (signal.aborted || !std.host.isConnected || std.store.readonly) return;
  const diagram = std.store.getModelById(blockId);
  // The React family body mounts after the Lit block update. Observe its
  // first measured canvas layout, rather than fitting an empty Note shell.
  const workarea =
    block && diagram instanceof MermaidBlockModel && diagram.childIds.length
      ? await new Promise<HTMLElement | null>((resolve) => {
          const finish = (area: HTMLElement | null) => {
            observer.disconnect();
            signal.removeEventListener("abort", cancel);
            resolve(area);
          };
          const cancel = () => finish(null);
          const observer = new ResizeObserver(() => {
            const area = block.querySelector<HTMLElement>(
              "[data-mermaid-page-natural-width]",
            );
            if (area && area.clientWidth > 0) finish(area);
          });
          observer.observe(block);
          signal.addEventListener("abort", cancel, { once: true });
          if (signal.aborted) cancel();
        })
      : null;
  if (signal.aborted || !std.host.isConnected || std.store.readonly) return;
  const naturalWidth = Number(workarea?.dataset.mermaidPageNaturalWidth);
  if (workarea && Number.isFinite(naturalWidth) && naturalWidth > 0) {
    // The existing renderer reports its protected content bounds. Grow only
    // this newly created Note; retain its measured chrome and native resizing.
    const bounds = Bound.deserialize(note.xywh);
    const scale = note.props.edgeless.scale ?? 1;
    const missingWidth = naturalWidth - workarea.clientWidth;
    if (missingWidth > 0) {
      bounds.w += missingWidth * scale;
      std.store.updateBlock(note, { xywh: bounds.serialize() });
      await std.view.getBlock(note.id)?.updateComplete;
    }
  }
  if (!signal.aborted && std.host.isConnected) {
    const bounds = Bound.deserialize(note.xywh);
    const view = std.view.getBlock(note.id);
    // Native Note auto-height writes back after layout. Reveal the measured
    // height now without taking over that model update or future resizing.
    if (view?.offsetHeight)
      bounds.h = view.offsetHeight * (note.props.edgeless.scale ?? 1);
    gfx.fitToScreen({ bounds: [bounds] });
  }
}

const VirgultumEditorImpl = ({
  mode,
  page,
  shared,
  readonly,
  snapshot,
  contentOnly,
  onEditorReady,
  onEditorError,
  readingSize,
  ...props
}: EditorProps & {
  readingSize: number | null;
}) => {
  const rootRef = useRef<HTMLDivElement>(null);
  const docRef = useRef<PageEditor>(null);
  const docTitleRef = useRef<DocTitle>(null);
  const edgelessRef = useRef<EdgelessEditor>(null);
  const featureFlags = useService(FeatureFlagService).flags;
  const enableEditorRTL = useLiveData(featureFlags.enable_editor_rtl.$);
  const editorSetting = useService(EditorSettingService).editorSetting;
  const server = useService(ServerService).server;
  const workspace = useService(WorkspaceService).workspace;
  const destinationView = useServiceOptional(ViewService)?.view;
  const t = useI18n();
  const [initializationEpoch, retryInitialization] = useState(0);
  const initializationNoticeId = useId();

  const { enableMiddleClickPaste } = useLiveData(
    editorSetting.settings$.selector((s) => ({
      enableMiddleClickPaste: s.enableMiddleClickPaste,
    })),
  );

  /**
   * Build an explicit `MyoxusEditorContainer` adapter from the
   * underlying Lit editor refs. The legacy implementation
   * returned a `Proxy` that delegated arbitrary property access
   * to the host `HTMLDivElement`, which made the host surface
   * unbounded and the container's exact contract opaque. The
   * B-03 adapter only exposes the fields listed in
   * `MyoxusEditorContainer`; consumers that need a method on
   * the host element should call `rootRef.current` directly
   * (or use a host service in future migrations).
   */
  const myoxusEditorContainer = useMemo<MyoxusEditorContainer>(() => {
    // We only need a structural stand-in here; the consumer
    // (the editor surface) never relies on the container being a
    // real HTMLElement. `Object.assign` must not be used here:
    // it evaluates getters immediately and freezes `std`/`host`
    // as `undefined` before the Lit editor refs are connected.
    const adapter = Object.create(null) as MyoxusEditorContainer;
    Object.defineProperties(adapter, {
      page: { value: page, enumerable: true },
      doc: { value: page, enumerable: true },
      docTitle: {
        enumerable: true,
        get() {
          return docTitleRef.current;
        },
      },
      host: {
        enumerable: true,
        get() {
          return (
            (mode === "page"
              ? docRef.current?.host
              : edgelessRef.current?.host) ?? undefined
          );
        },
      },
      model: {
        enumerable: true,
        get() {
          return page.root as RootBlockModel | null;
        },
      },
      updateComplete: {
        enumerable: true,
        get() {
          return (
            mode === "page"
              ? docRef.current?.updateComplete
              : edgelessRef.current?.updateComplete
          ) as Promise<boolean>;
        },
      },
      mode: { value: mode, enumerable: true },
      origin: {
        enumerable: true,
        get() {
          // The legacy `Proxy` allowed callers to fall back to
          // the host `HTMLDivElement`. The host page consumer
          // (`use-export-page.ts:508`) still needs `origin` for
          // export wiring, so we expose the root ref here
          // without re-introducing the unbounded proxy. The
          // return type is `HTMLDivElement | null` to match
          // `useRef<HTMLDivElement>(null)` honestly; the
          // consumer in `use-export-page.ts:508` already
          // handles `null` paths separately.
          return rootRef.current;
        },
      },
      std: {
        enumerable: true,
        get() {
          return (
            mode === "page" ? docRef.current?.std : edgelessRef.current?.std
          ) as BlockStdScope;
        },
      },
    });
    return adapter;
  }, [mode, page]);

  const handleClickPageModeBlank = useCallback(() => {
    if (shared || readonly || page.readonly) return;
    const std = myoxusEditorContainer.host?.std;
    if (!std) {
      return;
    }
    const note = getLastNoteBlock(page);
    if (note) {
      const lastBlock = note.lastChild();
      if (
        lastBlock &&
        lastBlock.flavour === "myoxus:paragraph" &&
        lastBlock.text?.length === 0
      ) {
        const focusBlock = std.view.getBlock(lastBlock.id) ?? undefined;
        std.command.exec(focusBlockEnd, {
          focusBlock,
          force: true,
        });
        return;
      }
    }

    std.command.exec(appendParagraphCommand);
  }, [myoxusEditorContainer.host?.std, page, readonly, shared]);

  useEffect(() => {
    const editorContainer = rootRef.current;
    if (editorContainer) {
      const handleMiddleClick = (e: MouseEvent) => {
        if (
          e.target instanceof HTMLElement &&
          (e.target.closest("myoxus-reference") ||
            e.target.closest("myoxus-link"))
        ) {
          return;
        }
        if (!enableMiddleClickPaste && IS_LINUX && e.button === 1) {
          e.preventDefault();
        }
      };
      editorContainer.addEventListener("pointerup", handleMiddleClick, {
        capture: true,
      });
      editorContainer.addEventListener("auxclick", handleMiddleClick, {
        capture: true,
      });
      return () => {
        editorContainer?.removeEventListener("pointerup", handleMiddleClick, {
          capture: true,
        });
        editorContainer?.removeEventListener("auxclick", handleMiddleClick, {
          capture: true,
        });
      };
    }
    return;
  }, [enableMiddleClickPaste]);

  const mermaidDiagramsService = useService(MermaidDiagramsService);

  // The 4 host-bound `myoxus-event-block-*` CustomEvent listeners
  // (insert, click, request, delete-requested) were removed in
  // P-VIRG-ARCH-B-02. Their responsibilities now live on the
  // `MyoxusHostService` instance bound to the BlockStdScope via
  // the `MyoxusHostExtension` wired in `lit-adaper.tsx`. See
  // `myoxus-host-adapter.ts` for the implementation.
  // The remaining effect below handles editor mount: image proxy
  // URL wiring, format-specific initial-diagram consumption, and the
  // `onEditorReady` callback.

  useEffect(() => {
    const editor = myoxusEditorContainer;
    // B-03: the `globalThis.currentEditor` debug hook was
    // removed. Consumers that need editor state should
    // receive the `MyoxusEditorContainer` instance via the
    // `onEditorReady` callback, the
    // `useActiveVirgultumEditor()` jotai atom, or the
    // `MyoxusHostService` boundary. There is no implicit
    // global anymore.
    const disposableGroup = new DisposableGroup();
    let canceled = false;
    let initialClaim: symbol | undefined;
    let initializationNotice: string | undefined;
    const initializationAbort = new AbortController();

    // provide image proxy endpoint to virgultum
    const imageProxyUrl = new URL(
      BUILD_CONFIG.imageProxyUrl,
      server.baseUrl,
    ).toString();

    const clipboard = editor.std.clipboard;
    const imageMiddleware = customImageProxyMiddleware(imageProxyUrl);
    clipboard.use(imageMiddleware);
    // Explicit Retry reuses this editor. Do not accumulate per-effect middleware.
    disposableGroup.add(() => clipboard.unuse(imageMiddleware));
    page.get(ImageProxyService).setImageProxyURL(imageProxyUrl);

    editor.updateComplete
      .then(async () => {
        if (canceled) return;
        if (!readonly) {
          await workspace.engine.doc.waitForDocLoaded(
            page.id,
            initializationAbort.signal,
          );
          if (canceled || page.readonly) return;
          const std = editor.std;
          const initialDiagram =
            mermaidDiagramsService.getInitialDiagramForEditor(page.id, page);
          if (initialDiagram && std) {
            initialClaim = initialDiagram.claim;
            try {
              if (initialDiagram.format === "bpmn") {
                // A mount may resume only its retained exact initialization. A
                // missing persisted source never authorizes a new blank diagram.
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
                          onClick: () =>
                            retryInitialization((epoch) => epoch + 1),
                          autoClose: false,
                        },
                      ],
                    },
                    {
                      id: initializationNoticeId,
                      duration: 0,
                      // Persistent feedback must not cover native canvas tools.
                      position: mode === "edgeless" ? "top-center" : undefined,
                    },
                  );
                  // Controlled initialization failure is a typed result, not a
                  // renderer exception or permission to fabricate replacement XML.
                  onEditorError?.(result);
                  return;
                }
                mermaidDiagramsService.completeInitialDiagramForEditor(
                  page.id,
                  initialDiagram.claim,
                );
              } else {
                let insertedBlockId: string | undefined;
                await prepareMermaidFamilySource(initialDiagram.source ?? "");
                // Validation can outlive a mode switch or editor unmount. Only
                // the mounted claimant may consume the initial diagram.
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
                  // Creation origin chooses presentation. Mode changes on an
                  // existing Page never reparent its diagram or remove its Note.
                  const nativePlacement =
                    mode === "edgeless" &&
                    initialDiagram.edgelessPlacement === "native";
                  if (nativePlacement) {
                    const [, result] = std.command.exec(
                      insertMermaidEdgelessDiagramCommand,
                      {
                        source: initialDiagram.source,
                        title: initialDiagram.title,
                        replaceEmptyNoteId: initialDiagram.bootstrapNoteId,
                      },
                    );
                    insertedBlockId = result?.insertedMermaidBlockId;
                    const gfx = std.get(GfxControllerIdentifier);
                    const owner =
                      insertedBlockId && gfx.getElementById(insertedBlockId);
                    if (
                      owner &&
                      "xywh" in owner &&
                      typeof owner.xywh === "string"
                    )
                      gfx.fitToScreen({
                        bounds: [Bound.deserialize(owner.xywh)],
                      });
                  } else {
                    let firstParagraph =
                      page.getBlocksByFlavour("myoxus:paragraph")[0]?.model ??
                      null;
                    if (!firstParagraph) {
                      std.command.exec(appendParagraphCommand);
                      firstParagraph =
                        page.getBlocksByFlavour("myoxus:paragraph")[0]?.model ??
                        null;
                    }
                    if (firstParagraph) {
                      const baseInsertOptions = {
                        removeEmptyLine: true,
                        selectedModels: [firstParagraph],
                      };
                      const [, result] = std.command.exec(
                        insertMermaidBlockCommand,
                        {
                          ...baseInsertOptions,
                          source: initialDiagram.source,
                          title: initialDiagram.title,
                        },
                      );
                      insertedBlockId = result?.insertedMermaidBlockId;
                    }
                  }
                  if (insertedBlockId) {
                    if (mode === "edgeless" && !nativePlacement) {
                      await activateCatalogMermaidNote(
                        std,
                        insertedBlockId,
                        initializationAbort.signal,
                      );
                      if (canceled) return;
                    }
                    mermaidDiagramsService.completeInitialDiagramForEditor(
                      page.id,
                      initialDiagram.claim,
                    );
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
          }
          // Catalog navigation carries a one-use view intent, not a document
          // property. Subscribe only after the destination's loaded block and
          // Lit host are available; a retained failed initialization keeps its
          // existing Retry path instead of opening an empty session.
          if (destinationView && std && !snapshot) {
            const intent = destinationView
              .queryString$<{ editBpmn?: string }>((search) => ({
                editBpmn:
                  new URLSearchParams(search).get("editBpmn") ?? undefined,
              }))
              .subscribe(({ editBpmn }) => {
                if (
                  canceled ||
                  editBpmn !== "1" ||
                  !destinationView.location$.value.pathname.endsWith(
                    `/${page.id}`,
                  )
                )
                  return;
                const blocks = page.getBlocksByFlavour("myoxus:bpmn" as never);
                if (blocks.length !== 1) return;
                destinationView.updateQueryString(
                  { editBpmn: undefined },
                  { replace: true },
                );
                void requestBpmnEditor(std, blocks[0].model.id).catch(() => {
                  if (!canceled)
                    notify.error({
                      title: t["com.myoxus.common.operation-failed"](),
                      actions: [
                        {
                          label: t.Retry(),
                          onClick: () =>
                            void requestBpmnEditor(std, blocks[0].model.id),
                        },
                      ],
                    });
                });
              });
            disposableGroup.add(() => intent.unsubscribe());
          }
        }
        if (onEditorReady && !canceled) {
          const dispose = onEditorReady(editor);
          if (dispose) {
            disposableGroup.add(dispose);
          }
        }
      })
      .catch((error) => {
        if (!canceled) {
          console.error("Error updating editor", error);
          onEditorError?.(error);
        }
      });

    return () => {
      canceled = true;
      initializationAbort.abort();
      if (initialClaim)
        mermaidDiagramsService.releaseInitialDiagramForEditor(
          page.id,
          initialClaim,
        );
      if (initializationNotice) notify.dismiss(initializationNotice);
      disposableGroup.dispose();
    };
  }, [
    myoxusEditorContainer,
    mermaidDiagramsService,
    mode,
    onEditorReady,
    onEditorError,
    page,
    readonly,
    server,
    workspace,
    initializationEpoch,
    initializationNoticeId,
    destinationView,
    snapshot,
    t,
  ]);

  return (
    <DocumentEditorRoot
      {...props}
      data-testid={`editor-${page.id}`}
      dir={enableEditorRTL ? "rtl" : "ltr"}
      mode={mode}
      contentOnly={contentOnly}
      readingSize={readingSize}
      ref={rootRef}
    >
      {mode === "page" ? (
        <VirgultumDocEditor
          shared={shared}
          page={page}
          ref={docRef}
          readonly={readonly}
          snapshot={snapshot}
          contentOnly={contentOnly}
          titleRef={docTitleRef}
          onClickBlank={handleClickPageModeBlank}
        />
      ) : (
        <VirgultumEdgelessEditor
          shared={shared}
          snapshot={snapshot}
          page={page}
          ref={edgelessRef}
        />
      )}
    </DocumentEditorRoot>
  );
};

export const VirgultumEditor = (props: EditorProps) => {
  const [isLoading, setIsLoading] = useState(true);
  const [longerLoading, setLongerLoading] = useState(false);
  // oxlint-disable-next-line react-hooks-js/purity
  const [loadStartTime] = useState(Date.now());
  const workspaceService = useService(WorkspaceService);

  const editorSetting = useService(EditorSettingService).editorSetting;
  const readingSize = useLiveData(
    editorSetting.settings$.selector((s) => s.fontSize),
  );

  useEffect(() => {
    if (props.page.root) {
      setIsLoading(false);
      return;
    }

    const disposable = props.page.slots.rootAdded.subscribe(() => {
      disposable.unsubscribe();
      setIsLoading(false);
      setLongerLoading(false);
    });
    return () => {
      disposable.unsubscribe();
    };
  }, [loadStartTime, props.page]);

  useEffect(() => {
    const timer = setTimeout(() => {
      if (isLoading) {
        setLongerLoading(true);
      }
    }, 20 * 1000);
    const reportErrorTimer = setTimeout(() => {
      if (isLoading) {
        track.doc.$.$.loadDoc({
          workspaceId: props.page.workspace.id,
          docId: props.page.id,
          time: Date.now() - loadStartTime,
          success: false,
        });
      }
    }, 60 * 1000);
    return () => {
      clearTimeout(timer);
      clearTimeout(reportErrorTimer);
    };
  }, [isLoading, loadStartTime, props.page]);

  useEffect(() => {
    if (props.snapshot) return;
    workspaceService.workspace.engine.doc
      .waitForDocLoaded(props.page.id)
      .then(() => {
        track.doc.$.$.loadDoc({
          workspaceId: props.page.workspace.id,
          docId: props.page.id,
          time: Date.now() - loadStartTime,
          success: true,
        });
      })
      .catch(() => {
        track.doc.$.$.loadDoc({
          workspaceId: props.page.workspace.id,
          docId: props.page.id,
          time: Date.now() - loadStartTime,
          success: false,
        });
      });
  }, [loadStartTime, props.page, props.snapshot, workspaceService]);

  return isLoading ? (
    <EditorLoading longerLoading={longerLoading} />
  ) : (
    <VirgultumEditorImpl
      key={props.page.id}
      {...props}
      readingSize={readingSize}
    />
  );
};
