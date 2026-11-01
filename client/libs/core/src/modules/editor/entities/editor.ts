import type { MyoxusEditorContainer } from "@myoxus/core/editor/virgultum/doc-editor";
import { Entity, LiveData } from "@myoxus/infra";
import { effect } from "@preact/signals-core";
import { PresentTool } from "@virgultum/editor/blocks/frame";
import { DefaultTool } from "@virgultum/editor/blocks/surface";
import type { DocTitle } from "@virgultum/editor/fragments/doc-title";
import { findCommentedTexts } from "@virgultum/editor/inlines/comment";
import type { DocMode, ReferenceParams } from "@virgultum/editor/model";
import { HighlightSelection } from "@virgultum/editor/shared/selection";
import {
  DocModeProvider,
  findCommentedBlocks,
  findCommentedElements,
} from "@virgultum/editor/shared/services";
import { GfxControllerIdentifier } from "@virgultum/editor/std/gfx";
import type { InlineEditor } from "@virgultum/std/inline";
import { isEqual, omit } from "lodash-es";
import { skip } from "rxjs";

import { TemplateCheckService } from "../../template-doc/services/template-check";
import { CommentPanelService } from "../../comment/services/comment-panel-service";
import { DocCommentManagerService } from "../../comment/services/doc-comment-manager";
import type { DocService } from "../../doc";
import { parseDocSearchParams } from "../../navigation/utils";
import type { WorkbenchView } from "../../workbench";
import type { WorkspaceService } from "../../workspace";
import { EditorScope } from "../scopes/editor";
import type { EditorSelector } from "../types";

type EditorDocStore = DocService["doc"]["virgultumDoc"];

/**
 * Materialize the canonical canvas container before Edgeless services mount.
 *
 * Older and imported Page documents can legitimately have no surface block.
 * Switching such a document directly to Edgeless used to mount an unusable
 * editor whose root service threw before its first render. Readonly or
 * structurally incomplete documents stay in Page mode instead of failing.
 */
export function ensureEdgelessSurface(doc: EditorDocStore): boolean {
  if (doc.getBlocksByFlavour("myoxus:surface").length > 0) {
    return true;
  }

  const root = doc.root;
  if (!root || doc.readonly) {
    return false;
  }

  doc.addBlock("myoxus:surface", {}, root.id);
  return doc.getBlocksByFlavour("myoxus:surface").length > 0;
}

export class Editor extends Entity {
  readonly scope = this.framework.createScope(EditorScope, {
    editor: this as Editor,
  });

  readonly mode$ = new LiveData<DocMode>("page");
  readonly selector$ = new LiveData<EditorSelector | undefined>(undefined);
  readonly doc = this.docService.doc;
  readonly isSharedMode =
    this.workspaceService.workspace.openOptions.isSharedMode;
  readonly editorContainer$ = new LiveData<MyoxusEditorContainer | null>(null);
  workbenchView: WorkbenchView | null = null;
  private pendingWorkbenchMode: DocMode | null = null;
  scrollPosition: {
    page: number | null;
    edgeless: {
      centerX: number;
      centerY: number;
      zoom: number;
    } | null;
  } = {
    page: null,
    edgeless: null,
  };

  private readonly focusAt$ = LiveData.computed((get) => {
    const selector = get(this.selector$);
    const mode = get(this.mode$);
    let id = selector?.blockIds?.[0];
    let commentId = selector?.commentId;
    let key: "blockIds" | "elementIds" = "blockIds";

    if (mode === "edgeless") {
      const elementId = selector?.elementIds?.[0];
      if (elementId) {
        id = elementId;
        key = "elementIds";
      }
    }

    if (!id && !commentId) return null;

    return {
      id,
      key,
      mode,
      refreshKey: selector?.refreshKey,
      commentId: commentId,
    };
  });

  isPresenting$ = new LiveData<boolean>(false);

  togglePresentation() {
    const gfx = this.editorContainer$.value?.host?.std.get(
      GfxControllerIdentifier,
    );
    if (!gfx) return;
    if (!this.isPresenting$.value) {
      gfx.tool.setTool(PresentTool);
    } else {
      gfx.tool.setTool(DefaultTool);
    }
  }

  setSelector(selector: EditorSelector | undefined) {
    this.selector$.next(selector);
  }

  toggleMode() {
    this.setMode(this.mode$.value === "edgeless" ? "page" : "edgeless");
  }

  setMode(mode: DocMode): boolean {
    if (mode === "edgeless" && !ensureEdgelessSurface(this.doc.virgultumDoc)) {
      return false;
    }
    this.mode$.next(mode);
    return true;
  }

  /**
   * sync editor params with view query string
   *
   * this function will be called when editor is initialized with in a workbench view
   *
   * this won't be called in shared page.
   */
  bindWorkbenchView(view: WorkbenchView) {
    if (this.workbenchView) {
      throw new Error("already bound");
    }
    this.workbenchView = view;
    const savedScrollPosition = view.getScrollPosition() ?? null;
    if (typeof savedScrollPosition === "number") {
      this.scrollPosition.page = savedScrollPosition;
    } else if (typeof savedScrollPosition === "object") {
      this.scrollPosition.edgeless = savedScrollPosition;
    }

    const routeParams$ = view.queryString$<
      ReferenceParams & { refreshKey?: string }
    >(parseDocSearchParams);
    const viewParams$ = LiveData.computed((get) => {
      const params = get(routeParams$);
      // Cloud metadata may arrive after route binding. An absent URL mode
      // follows that metadata; an explicit mode remains authoritative. Never
      // mutate cached route params by writing a provisional Page default.
      return { ...params, mode: params.mode ?? get(this.doc.primaryMode$) };
    });

    const editorParams$ = LiveData.computed((get) => {
      return {
        mode: get(this.mode$),
        ...get(this.selector$),
      };
    });

    // prevent infinite loop
    let updating = false;

    const unsubscribeViewParams = viewParams$.subscribe((params) => {
      if (updating) return;
      updating = true;
      // when view params changed, sync to editor
      try {
        const editorParams = editorParams$.value;
        if (params.mode !== editorParams.mode) {
          this.pendingWorkbenchMode = this.setMode(params.mode)
            ? null
            : params.mode;
        } else {
          this.pendingWorkbenchMode = null;
        }

        const selector = omit(params, ["mode"]);
        if (!isEqual(selector, omit(editorParams, ["mode"]))) {
          this.setSelector(selector);
        }
      } finally {
        updating = false;
      }
    });

    const unsubscribeEditorParams = editorParams$.subscribe((params) => {
      if (updating) return;
      // A route can request Edgeless before the asynchronously opened document
      // has materialized its root. Keep that route authoritative until the
      // editor container is ready to create or resolve the canonical surface.
      if (this.pendingWorkbenchMode === viewParams$.value.mode) return;
      updating = true;
      try {
        // when editor params changed, sync to view
        if (!isEqual(params, viewParams$.value)) {
          const newQueryString: Record<string, string> = {};

          Object.entries(params).forEach(([k, v]) => {
            newQueryString[k] = Array.isArray(v) ? v.join(",") : v;
          });

          view.updateQueryString(newQueryString, { replace: true });
        }
      } finally {
        updating = false;
      }
    });

    return () => {
      this.workbenchView = null;
      this.pendingWorkbenchMode = null;
      unsubscribeEditorParams.unsubscribe();
      unsubscribeViewParams.unsubscribe();
    };
  }

  handleFocusAt(focusAt: {
    key: "blockIds" | "elementIds";
    mode: DocMode;
    id?: string;
    commentId?: string;
  }) {
    const editorContainer = this.editorContainer$.value;
    if (!editorContainer) return;

    const selection = editorContainer.host?.std.selection;
    const { id, key, mode, commentId } = focusAt;

    let finalId = id;
    let finalKey = key;
    let highlight = true;

    // If we have commentId but no blockId, find the block from the comment
    if (commentId && !id && editorContainer.host?.std) {
      const std = editorContainer.host.std;

      // First try to find inline commented texts
      const inlineCommentedSelections = findCommentedTexts(
        std.store,
        commentId,
      );
      if (inlineCommentedSelections.length > 0) {
        const firstSelection = inlineCommentedSelections[0];
        finalId = firstSelection.from.blockId;
        finalKey = "blockIds";
      } else {
        // Then try to find block comments
        const blockCommentedBlocks = findCommentedBlocks(std.store, commentId);
        if (blockCommentedBlocks.length > 0) {
          finalId = blockCommentedBlocks[0].id;
          finalKey = "blockIds";
        } else {
          const commentedElements = findCommentedElements(std.store, commentId);
          if (commentedElements.length > 0) {
            finalId = commentedElements[0].id;
            finalKey = "elementIds";
          }
        }
      }
      // Workaround: clear selection to avoid comment editor flickering
      selection?.clear();

      // highlight comment
      setTimeout(() => {
        const commentManager = this.framework.get(DocCommentManagerService);
        const commentPanelService = this.framework.get(CommentPanelService);
        const commentEntity = commentManager.get(this.doc.id);
        commentPanelService.openCommentPanel();
        commentEntity.obj.highlightComment(commentId);
        commentEntity.release();
      }, 0);

      // do not highlight block
      highlight = false;
    }

    if (mode === this.mode$.value && finalId) {
      selection?.setGroup("scene", [
        selection?.create(HighlightSelection, {
          mode,
          [finalKey]: [finalId],
          highlight,
        } as const),
      ]);
    }
  }

  bindEditorContainer(
    editorContainer: MyoxusEditorContainer,
    docTitle?: DocTitle | null,
    scrollViewport?: HTMLElement | null,
  ) {
    if (this.editorContainer$.value) {
      throw new Error("already bound");
    }

    const pendingMode = this.pendingWorkbenchMode;
    if (pendingMode) {
      if (ensureEdgelessSurface(this.doc.virgultumDoc)) {
        // This ready callback still belongs to the Page container rendered
        // before the deferred route mode could be applied. Bind only the
        // replacement Edgeless container so consumers never observe a
        // half-configured editor.
        queueMicrotask(() => {
          if (this.pendingWorkbenchMode !== pendingMode) return;
          this.pendingWorkbenchMode = null;
          this.setMode(pendingMode);
        });
        return () => {};
      }

      // At editor-ready time a failed surface check is terminal (for example a
      // readonly Page-only document), so expose the actual Page mode in the
      // route instead of leaving an impossible Edgeless URL behind.
      this.pendingWorkbenchMode = null;
      this.workbenchView?.updateQueryString(
        { mode: this.mode$.value },
        { replace: true },
      );
    }
    this.editorContainer$.next(editorContainer);
    const unsubs: (() => void)[] = [];

    const gfx = editorContainer.host?.std.get(GfxControllerIdentifier);

    // ----- Scroll Position and Selection -----
    // if we have default scroll position, we should restore it
    if (this.mode$.value === "page" && this.scrollPosition.page !== null) {
      scrollViewport?.scrollTo(0, this.scrollPosition.page);
    } else if (
      this.mode$.value === "edgeless" &&
      this.scrollPosition.edgeless &&
      gfx
    ) {
      gfx.viewport.setViewport(this.scrollPosition.edgeless.zoom, [
        this.scrollPosition.edgeless.centerX,
        this.scrollPosition.edgeless.centerY,
      ]);
    } else {
      // if we don't have default scroll position, we should focus on the title
      const initialFocusAt = this.focusAt$.value;

      if (initialFocusAt === null) {
        const title = docTitle?.querySelector<
          HTMLElement & { inlineEditor: InlineEditor | null }
        >("rich-text");
        // Only focus on the title when it's empty on mobile edition.
        if (BUILD_CONFIG.isMobileEdition) {
          const titleText = this.doc.title$.value;
          if (!titleText?.length) {
            title?.inlineEditor?.focusEnd();
          }
        } else {
          title?.inlineEditor?.focusEnd();
        }
      } else {
        this.handleFocusAt(initialFocusAt);
      }
    }

    // update scroll position when scrollViewport scroll
    const saveScrollPosition = () => {
      if (this.mode$.value === "page" && scrollViewport) {
        this.scrollPosition.page = scrollViewport.scrollTop;
        this.workbenchView?.setScrollPosition(scrollViewport.scrollTop);
      } else if (this.mode$.value === "edgeless" && gfx) {
        const pos = {
          centerX: gfx.viewport.centerX,
          centerY: gfx.viewport.centerY,
          zoom: gfx.viewport.zoom,
        };
        this.scrollPosition.edgeless = pos;
        this.workbenchView?.setScrollPosition(pos);
      }
    };
    scrollViewport?.addEventListener("scroll", saveScrollPosition);
    unsubs.push(() => {
      scrollViewport?.removeEventListener("scroll", saveScrollPosition);
    });
    if (gfx) {
      const subscription =
        gfx.viewport.viewportUpdated.subscribe(saveScrollPosition);
      unsubs.push(subscription.unsubscribe.bind(subscription));
    }

    // update selection when focusAt$ changed
    const subscription = this.focusAt$
      .distinctUntilChanged(
        (a, b) =>
          a?.id === b?.id &&
          a?.key === b?.key &&
          a?.refreshKey === b?.refreshKey,
      )
      .pipe(skip(1))
      .subscribe((anchor) => {
        if (!anchor) return;
        this.handleFocusAt(anchor);
      });
    unsubs.push(subscription.unsubscribe.bind(subscription));

    const checks = this.framework.getOptional(TemplateCheckService);
    if (checks) {
      const subscription = checks.location$.subscribe(async (request) => {
        if (!request || request.result.sourceDocId !== this.doc.id) return;
        if (!request.result.isCurrent()) {
          checks.location$.setValue(null);
          return;
        }
        const { diagnostic } = request;
        // The native renderer can still be completing its Lit update when a
        // Library result opens the source. Never select a stale snapshot range.
        await editorContainer.updateComplete;
        // A retired render must not consume a newer location request.
        if (checks.location$.value !== request) return;
        if (
          !request.result.isCurrent() ||
          !editorContainer.origin?.isConnected
        ) {
          checks.location$.setValue(null);
          return;
        }
        const block =
          diagnostic.kind === "title"
            ? docTitle
            : editorContainer.host?.std.view.getBlock(diagnostic.blockId);
        await block?.updateComplete;
        if (checks.location$.value !== request) return;
        if (!request.result.isCurrent()) {
          checks.location$.setValue(null);
          return;
        }
        const cell =
          diagnostic.kind === "cell"
            ? Array.from(
                block?.querySelectorAll<HTMLElement>(
                  "[data-row-id][data-column-id]",
                ) ?? [],
              ).find(
                (cell) =>
                  cell.dataset.rowId === diagnostic.rowId &&
                  cell.dataset.columnId === diagnostic.columnId,
              )
            : null;
        const richText = (cell ?? block)?.querySelector<
          HTMLElement & { inlineEditor?: InlineEditor }
        >("rich-text");
        const inline = richText?.inlineEditor;
        (cell ?? richText ?? block)?.scrollIntoView({ block: "center" });
        if (inline) {
          await inline.waitForUpdate();
          if (!request.result.isCurrent() || checks.location$.value !== request)
            return;
          const range = { index: diagnostic.start, length: diagnostic.length };
          // Std only projects paragraph/list selection while its DOM editor
          // is active. Focus/sync first, then publish the same native range.
          inline.syncInlineRange(range);
          inline.setInlineRange(range);
        }
        if (checks.location$.value === request) checks.location$.setValue(null);
      });
      unsubs.push(() => subscription.unsubscribe());
    }

    // ----- Presenting -----
    const std = editorContainer.host?.std;
    const editorMode = std?.get(DocModeProvider)?.getEditorMode();
    if (!editorMode || editorMode !== "edgeless" || !gfx) {
      this.isPresenting$.next(false);
    } else {
      this.isPresenting$.next(
        gfx.tool.currentToolName$.peek() === "frameNavigator",
      );

      const disposable = effect(() => {
        this.isPresenting$.next(
          gfx.tool.currentToolName$.value === "frameNavigator",
        );
      });
      unsubs.push(disposable);
    }

    return () => {
      this.editorContainer$.next(null);
      for (const unsub of unsubs) {
        unsub();
      }
    };
  }

  constructor(
    private readonly docService: DocService,
    private readonly workspaceService: WorkspaceService,
  ) {
    super();

    const leaveEdgelessAfterSurfaceRemoval = () => {
      if (
        this.mode$.value !== "edgeless" ||
        this.doc.virgultumDoc.getBlocksByFlavour("myoxus:surface").length > 0
      ) {
        return;
      }

      // Storage applies an exact server restore as a local Yjs transaction.
      // A snapshot captured before its first Edgeless visit has no Surface;
      // preserve those bytes and leave Edgeless instead of creating content.
      this.setMode("page");
    };
    this.doc.yDoc.on("afterTransaction", leaveEdgelessAfterSurfaceRemoval);
    this.disposables.push(() => {
      this.doc.yDoc.off("afterTransaction", leaveEdgelessAfterSurfaceRemoval);
    });
  }
}
