// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors

import {
  correctNumberedListsOrderToPrev,
  ParagraphBlockComponent,
} from "@virgultum/content/blocks";
import { surfaceRefToEmbed } from "@virgultum/core/adapters";
import {
  BLOCK_CHILDREN_CONTAINER_PADDING_LEFT,
  EMBED_CARD_HEIGHT,
  EMBED_CARD_WIDTH,
} from "@virgultum/core/consts";
import {
  AttachmentBlockModel,
  BookmarkBlockModel,
  type ConnectorElementModel,
  DatabaseBlockModel,
  DEFAULT_NOTE_HEIGHT,
  DEFAULT_NOTE_WIDTH,
  type EmbedCardStyle,
  EmbedGithubModel,
  EmbedLinkedDocModel,
  ListBlockModel,
  NoteBlockModel,
  RootBlockModel,
} from "@virgultum/core/models";
import {
  Bound,
  type IVec,
  Point,
  Rect,
  type SerializedXYWH,
} from "@virgultum/core/primitives/gfx";
import {
  type BlockComponent,
  type BlockStdScope,
  type DropPayload,
  isBlockComponent,
} from "@virgultum/core/runtime";
import {
  GfxController,
  GfxControllerIdentifier,
  GfxGroupLikeElementModel,
  type GfxModel,
  GfxPrimitiveElementModel,
  hasSurfaceYmapId,
  isGfxGroupCompatibleModel,
  isPrimitiveModel,
  SurfaceBlockModel,
} from "@virgultum/core/runtime/gfx";
import {
  DndApiExtensionIdentifier,
  DocModeProvider,
  EditorI18nProvider,
  editorMessage,
  resolveEditorMessage,
  TelemetryProvider,
} from "@virgultum/core/services";
import {
  type BlockModel,
  type BlockSnapshot,
  Slice,
  type SliceSnapshot,
  toDraftModel,
  type TransformerMiddleware,
} from "@virgultum/core/store";
import {
  captureEventTarget,
  type DropTarget as DropResult,
  findNoteBlockModel,
  getBlockComponentsExcludeSubtrees,
  getRectByBlockComponent,
  getScrollContainer,
  matchModels,
} from "@virgultum/core/utils";
import { DropIndicator } from "@virgultum/core/view/drop-indicator";

import type { MyoxusDragHandleWidget } from "./controller";
import {
  collectSnapshotIds,
  getParentNoteElement,
  isPointOutsideNote,
  repositionSnapshot,
} from "./geometry";
import type { DragBlockEntity, DragBlockPayload } from "./types";

function createCrossDocIdMiddleware(std: BlockStdScope): TransformerMiddleware {
  return ({ slots }) => {
    let sameDoc = false;
    const sub = slots.beforeImport.subscribe((payload) => {
      if (payload.type === "slice") {
        sameDoc = payload.snapshot.pageId === std.store.id;
      } else if (payload.type === "block" && !sameDoc) {
        payload.snapshot.id = std.workspace.idGenerator();
      }
    });
    return () => sub.unsubscribe();
  };
}

function createNumberedListFixMiddleware(
  std: BlockStdScope,
): TransformerMiddleware {
  return ({ slots }) => {
    const sub = slots.afterImport.subscribe((payload) => {
      if (payload.type !== "block") return;
      const model = payload.model;
      if (
        matchModels(model, [ListBlockModel]) &&
        model.props.type === "numbered"
      ) {
        const next = std.store.getNext(model);
        correctNumberedListsOrderToPrev(std.store, model);
        if (next) correctNumberedListsOrderToPrev(std.store, next);
      }
    });
    return () => sub.unsubscribe();
  };
}

function createCardStyleMiddleware(std: BlockStdScope): TransformerMiddleware {
  return ({ slots }) => {
    const sub = slots.beforeImport.subscribe((payload) => {
      if (payload.type !== "block" || !payload.parent) return;
      const parentModel = std.store.getModelById(payload.parent);
      if (!matchModels(parentModel, [NoteBlockModel])) return;

      const model = std.store.getModelById(payload.snapshot.id);
      if (!model) return;

      if (model instanceof AttachmentBlockModel) {
        std.store.updateBlock(model, { style: "horizontalThin" });
      } else if (
        model instanceof BookmarkBlockModel ||
        model instanceof EmbedGithubModel ||
        model instanceof EmbedLinkedDocModel
      ) {
        std.store.updateBlock(model, { style: "horizontal" });
      }
    });
    return () => sub.unsubscribe();
  };
}

function createGfxFilterMiddleware(
  selectedRootIds: string[],
  std: BlockStdScope,
): TransformerMiddleware {
  const includedIds = new Set<string>();
  const surface = std.store.getBlocksByFlavour("myoxus:surface")[0]?.model as
    SurfaceBlockModel | undefined;
  const gfx = std.get(GfxController);
  const queue = [...selectedRootIds];

  while (queue.length > 0) {
    const id = queue.pop()!;
    if (includedIds.has(id)) continue;
    const item = std.store.getBlock(id)?.model ?? surface?.getElementById(id);
    if (!item) continue;
    includedIds.add(id);
    if (isGfxGroupCompatibleModel(item)) {
      queue.push(...item.childIds);
    }
  }

  return ({ slots, transformerConfigs }) => {
    const beforeSub = slots.beforeExport.subscribe((payload) => {
      if (
        payload.type !== "block" ||
        payload.model.flavour !== "myoxus:surface"
      ) {
        return;
      }
      transformerConfigs.set("selectedElements", includedIds);
      payload.model.children = payload.model.children.filter((child) =>
        includedIds.has(child.id),
      );
    });

    const afterSub = slots.afterExport.subscribe((payload) => {
      if (
        payload.type !== "block" ||
        payload.model.flavour !== "myoxus:surface"
      ) {
        return;
      }
      const elements = (payload.snapshot.props.elements ?? {}) as Record<
        string,
        {
          type: string;
          xywh?: SerializedXYWH;
          source?: { position: IVec; id?: string };
          target?: { position: IVec; id?: string };
        }
      >;

      for (const [elementId, entry] of Object.entries(elements)) {
        if (entry.type !== "connector") continue;
        const connector = gfx.getElementById(
          elementId,
        ) as ConnectorElementModel | null;
        if (!connector) {
          delete elements[elementId];
          continue;
        }
        entry.xywh = connector.xywh;

        for (const endKey of ["source", "target"] as const) {
          const endpoint = entry[endKey];
          if (endpoint?.id && !includedIds.has(endpoint.id)) {
            const targetEl = gfx.getElementById(endpoint.id) as GfxModel | null;
            if (!targetEl) {
              delete elements[elementId];
              break;
            }
            entry[endKey] = {
              position: targetEl.elementBound.getRelativePoint(
                endpoint.position ?? [0.5, 0.5],
              ),
            };
          }
        }
      }
    });

    return () => {
      beforeSub.unsubscribe();
      afterSub.unsubscribe();
    };
  };
}

function renderLightweightPreview(
  std: BlockStdScope,
  snapshot: SliceSnapshot,
  container: HTMLElement,
): { x: number; y: number } {
  const i18n = std.getOptional(EditorI18nProvider) ?? undefined;
  const count = snapshot.content.length;
  const firstFlavour = snapshot.content[0]?.flavour ?? "block";
  const labelMessage =
    firstFlavour === "myoxus:surface"
      ? editorMessage(
          "com.myoxus.editor.surface-ref.content",
          "Edgeless content",
        )
      : firstFlavour === "myoxus:note"
        ? editorMessage("com.myoxus.editor.drag-preview.note", "Note block")
        : firstFlavour === "myoxus:frame"
          ? editorMessage("com.myoxus.editor.drag-preview.frame", "Frame block")
          : firstFlavour === "myoxus:image"
            ? editorMessage(
                "com.myoxus.editor.drag-preview.image",
                "Image block",
              )
            : firstFlavour.startsWith("myoxus:embed-")
              ? editorMessage(
                  "com.myoxus.editor.drag-preview.embed",
                  "Embed block",
                )
              : editorMessage(
                  "com.myoxus.editor.drag-preview.shape",
                  "Edgeless shape",
                );

  const badge = container.ownerDocument.createElement("div");
  Object.assign(badge.style, {
    display: "inline-flex",
    alignItems: "center",
    padding: "6px 12px",
    borderRadius: "8px",
    background: "var(--myoxus-background-overlay-panel-color)",
    color: "var(--myoxus-text-primary-color)",
    border: "1px solid var(--myoxus-border-color)",
    fontFamily: "var(--myoxus-font-family)",
    fontSize: "13px",
    lineHeight: "20px",
    boxShadow: "var(--myoxus-shadow-1)",
    whiteSpace: "nowrap",
  });
  const baseText = resolveEditorMessage(labelMessage, i18n);
  badge.textContent = count > 1 ? `${baseText} (${count})` : baseText;

  container.style.position = "absolute";
  container.append(badge);
  return { x: 12, y: 12 };
}

/**
 * Owns Pragmatic DnD bindings, drop-indicator rendering, and document/canvas
 * mutations for `MyoxusDragHandleWidget`.
 */
export class DragDropCoordinator {
  private dropIndicator: DropIndicator | null = null;
  private readonly dropTargetCleanups = new Map<string, Array<() => void>>();
  private opacityRestorers: Array<() => void> = [];

  constructor(private readonly widget: MyoxusDragHandleWidget) {}

  private get std(): BlockStdScope {
    return this.widget.std;
  }

  private get host() {
    return this.widget.host;
  }

  private get mode() {
    return this.widget.mode;
  }

  private get gfx() {
    return this.std.get(GfxControllerIdentifier);
  }

  attach(): void {
    const { disposables } = this.widget;

    this.widget.handleEvent("pointerDown", (ctx) => {
      const target = captureEventTarget(ctx.get("pointerState").raw.target);
      return target && this.widget.contains(target) ? true : undefined;
    });
    this.widget.handleEvent("dragStart", (ctx) => {
      const target = captureEventTarget(ctx.get("pointerState").raw.target);
      return target && this.widget.contains(target) ? true : undefined;
    });

    const scrollContainer = getScrollContainer(this.host);
    if (scrollContainer && this.mode === "page") {
      disposables.add(
        this.std.dnd.autoScroll<DragBlockEntity>({
          element: scrollContainer,
          canScroll: ({ source }) => source.data?.bsEntity?.type === "blocks",
        }),
      );
    }

    disposables.add(this.bindDraggable(this.widget));
    disposables.add(this.bindMonitor());

    disposables.add(
      this.std.view.viewUpdated.subscribe((payload) => {
        if (payload.type !== "block") return;
        if (payload.method === "add") {
          this.bindDropTarget(payload.view);
        } else if (payload.method === "delete") {
          this.unbindDropTarget(payload.id);
        }
      }),
    );

    this.std.view.views.forEach((view) => this.bindDropTarget(view));

    disposables.add(() => {
      this.cleanupActiveDrag();
      for (const fns of this.dropTargetCleanups.values()) {
        for (const fn of fns) fn();
      }
      this.dropTargetCleanups.clear();
    });
  }

  private createTransformer(selectedGfxIds?: string[]) {
    const middlewares: TransformerMiddleware[] = [
      createCrossDocIdMiddleware(this.std),
      createNumberedListFixMiddleware(this.std),
      surfaceRefToEmbed(this.std),
      createCardStyleMiddleware(this.std),
    ];
    if (selectedGfxIds) {
      middlewares.push(createGfxFilterMiddleware(selectedGfxIds, this.std));
    }
    return this.std.store.getTransformer(middlewares);
  }

  private exportSnapshot(
    blocks: Array<BlockComponent | BlockModel>,
    selectedGfxIds?: string[],
  ): SliceSnapshot | undefined {
    const slice = Slice.fromModels(
      this.std.store,
      blocks.map((item) =>
        toDraftModel(isBlockComponent(item) ? item.model : item),
      ),
    );
    return this.createTransformer(selectedGfxIds).sliceToSnapshot(slice);
  }

  private async importSnapshot(
    snapshot: SliceSnapshot,
    parentId?: string,
    index?: number,
  ) {
    try {
      const first = snapshot.content.length === 1 ? snapshot.content[0] : null;
      if (
        first?.flavour === "myoxus:embed-linked-doc" &&
        !this.std.store.hasBlock(first.id)
      ) {
        const mode =
          this.std.getOptional(DocModeProvider)?.getEditorMode() ?? "page";
        this.std.getOptional(TelemetryProvider)?.track("LinkedDocCreated", {
          control: `drop on ${mode}`,
          module: "drag and drop",
          type: "doc",
          other: "new doc",
        });
      }
      return await this.createTransformer().snapshotToSlice(
        snapshot,
        this.std.store,
        parentId,
        index,
      );
    } catch {
      return null;
    }
  }

  private buildDraggedSnapshot(): {
    fromMode: "block" | "gfx";
    snapshot: SliceSnapshot | undefined;
  } {
    if (this.widget.activeDragHandle === "gfx") {
      return {
        fromMode: "gfx",
        snapshot: this.buildGfxSnapshot(),
      };
    }
    return {
      fromMode: "block",
      snapshot: this.buildBlockSnapshot(),
    };
  }

  private buildGfxSnapshot(): SliceSnapshot | undefined {
    const selectedId = this.widget.anchorBlockId.peek();
    if (!selectedId) return undefined;
    const selected = this.gfx.getElementById(selectedId);
    if (!selected) return undefined;

    const allIds: string[] = [];
    const visit = (el: GfxModel) => {
      allIds.push(el.id);
      if (isGfxGroupCompatibleModel(el)) {
        for (const child of el.childElements) visit(child);
      }
    };
    visit(selected as GfxModel);

    let includeSurface = false;
    const topBlocks: BlockModel[] = [];
    const surfaceChildren: BlockModel[] = [];
    for (const id of allIds) {
      const model = this.gfx.getElementById(id);
      if (!model) continue;
      if (model instanceof GfxPrimitiveElementModel) {
        if (!includeSurface && this.gfx.surface) {
          includeSurface = true;
          topBlocks.push(this.gfx.surface);
        }
      } else {
        const parent = this.std.store.getParent(model);
        if (matchModels(parent, [SurfaceBlockModel])) {
          surfaceChildren.push(model);
        } else {
          topBlocks.push(model);
        }
      }
    }

    const exportBlocks = includeSurface
      ? topBlocks
      : topBlocks.concat(surfaceChildren);
    return this.exportSnapshot(exportBlocks, [selectedId]);
  }

  private buildBlockSnapshot(): SliceSnapshot | undefined {
    const anchorBlock = this.widget.anchorBlockComponent.peek();
    if (!anchorBlock) return undefined;

    let selections = this.widget.getSelectedBlockRefs();
    if (selections.some((s) => s.type === "text")) {
      const nativeSel = document.getSelection();
      if (nativeSel && nativeSel.rangeCount > 0 && this.std.range) {
        const blocks = this.std.range.getSelectedBlockComponentsByRange(
          nativeSel.getRangeAt(0),
          {
            match: (el) => el.model.role === "content",
            mode: "highest",
          },
        );
        this.widget.selectBlocks(blocks);
        selections = this.widget.getSelectedBlockRefs();
      }
    }

    const anchorId = this.widget.anchorBlockId.peek();
    if (
      selections.length === 0 ||
      !selections.some((sel) => sel.blockId === anchorId)
    ) {
      this.widget.selectBlocks([anchorBlock]);
    }

    const seenCollapsed = new Set<BlockComponent>();
    const expanded: BlockComponent[] = [];
    for (const block of this.widget.getSelectedBlockComponents()) {
      if (seenCollapsed.has(block)) continue;
      expanded.push(block);
      if (
        block instanceof ParagraphBlockComponent &&
        block.model.props.type.startsWith("h") &&
        block.model.props.collapsed
      ) {
        for (const sibling of block.collapsedSiblings) {
          const siblingView = this.host.view.getBlock(sibling.id);
          if (siblingView) {
            seenCollapsed.add(siblingView);
            expanded.push(siblingView);
          }
        }
      }
    }

    const topLevel = getBlockComponentsExcludeSubtrees(
      expanded,
    ) as BlockComponent[];
    return this.exportSnapshot(topLevel);
  }

  private dimDraggedElements(snapshot: SliceSnapshot): void {
    const restorers: Array<() => void> = [];
    const walk = (block: BlockSnapshot) => {
      if (block.flavour === "myoxus:surface") {
        for (const child of block.children ?? []) walk(child);
        const elements = (block.props.elements ?? {}) as Record<
          string,
          unknown
        >;
        for (const id of Object.keys(elements)) {
          const el = this.gfx.getElementById(
            id,
          ) as GfxPrimitiveElementModel | null;
          if (!el) continue;
          const prev = el.opacity;
          el.opacity = 0.7;
          restorers.push(() => {
            el.opacity = prev;
          });
        }
        return;
      }
      const view = this.std.view.getBlock(block.id);
      if (!view) return;
      const prev = view.style.opacity;
      view.style.opacity = "0.7";
      restorers.push(() => {
        if (prev) view.style.opacity = prev;
        else view.style.removeProperty("opacity");
      });
    };
    for (const root of snapshot.content) walk(root);
    this.opacityRestorers = restorers;
  }

  private ensureDropIndicator(): DropIndicator {
    if (!this.dropIndicator) {
      let ancestor: HTMLElement | null = this.widget;
      const body = this.widget.ownerDocument.body;
      while (ancestor && ancestor.parentElement !== body) {
        ancestor = ancestor.parentElement;
      }
      const zIndex = ancestor
        ? (Number.parseInt(getComputedStyle(ancestor).zIndex, 10) || 1) + 1
        : 2;
      const indicator = new DropIndicator();
      indicator.zIndex = zIndex;
      body.append(indicator);
      this.dropIndicator = indicator;
    }
    return this.dropIndicator;
  }

  private clearDropIndicator(): void {
    if (this.dropIndicator) {
      this.dropIndicator.remove();
      this.dropIndicator = null;
    }
  }

  private cleanupActiveDrag(): void {
    this.clearDropIndicator();
    this.widget.hide(true);
    this.std.selection.setGroup("gfx", []);
    for (const restore of this.opacityRestorers) restore();
    this.opacityRestorers = [];
  }

  private findNoteDirectChild(model: BlockModel): BlockModel | null {
    let cursor: BlockModel | null = model;
    while (cursor) {
      const parent = this.std.store.getParent(cursor);
      if (parent && matchModels(parent, [NoteBlockModel])) return cursor;
      cursor = parent;
    }
    return null;
  }

  private computeDropResult(
    dropBlock: BlockComponent,
    dragPayload: DragBlockPayload,
    dropPayload: DropPayload,
  ): DropResult | null {
    const dropModel = dropBlock.model;
    const snapshot = dragPayload?.bsEntity?.snapshot;
    if (
      !snapshot ||
      snapshot.content.length === 0 ||
      !dragPayload?.from ||
      matchModels(dropModel, [DatabaseBlockModel])
    ) {
      return null;
    }

    const schema = this.std.store.schema;
    const edge = dropPayload.edge;
    const scale = this.widget.scale.peek();

    if (edge === "right" && matchModels(dropModel, [ListBlockModel])) {
      const domRect = getRectByBlockComponent(dropBlock);
      if (
        snapshot.content.every((block) =>
          schema.safeValidate(block.flavour, "myoxus:list"),
        )
      ) {
        return {
          placement: "in",
          rect: Rect.fromLWTH(
            domRect.left + BLOCK_CHILDREN_CONTAINER_PADDING_LEFT,
            domRect.width - BLOCK_CHILDREN_CONTAINER_PADDING_LEFT,
            domRect.top + domRect.height,
            3 * scale,
          ),
          modelState: { model: dropModel, rect: domRect, element: dropBlock },
        };
      }
      const fallback = this.findNoteDirectChild(dropModel);
      if (!fallback) return null;
      const fallbackView = this.std.view.getBlock(fallback.id);
      if (!fallbackView) return null;
      const rect = fallbackView.getBoundingClientRect();
      return {
        placement: "after",
        rect: Rect.fromLWTH(
          rect.left,
          rect.width,
          rect.top + rect.height,
          3 * scale,
        ),
        modelState: { model: fallback, rect, element: fallbackView },
      };
    }

    const isNote = matchModels(dropModel, [NoteBlockModel]);
    const placement =
      isNote && schema.safeValidate(snapshot.content[0].flavour, "myoxus:note")
        ? "in"
        : edge === "top"
          ? "before"
          : "after";
    const domRect = getRectByBlockComponent(dropBlock);
    const y =
      placement === "after"
        ? domRect.top + domRect.height
        : domRect.top - 3 * scale;
    return {
      placement,
      rect: Rect.fromLWTH(domRect.left, domRect.width, y, 3 * scale),
      modelState: { model: dropModel, rect: domRect, element: dropBlock },
    };
  }

  private updateDropIndicator(
    point: Point,
    dragPayload: DragBlockPayload,
    dropPayload: DropPayload,
    dropBlock: BlockComponent,
  ): void {
    const indicator = this.ensureDropIndicator();
    const noteEl = getParentNoteElement(dropBlock);
    if (
      !noteEl ||
      isPointOutsideNote(this.host, noteEl, point, this.widget.scale.peek())
    ) {
      indicator.rect = null;
      return;
    }

    const result = this.computeDropResult(dropBlock, dragPayload, dropPayload);
    if (!result?.rect) {
      indicator.rect = null;
      return;
    }
    const { left, top, width, height } = result.rect;
    indicator.rect = Rect.fromLWTH(left, width, top, height);
  }

  private isUnderNote(model: BlockModel): boolean {
    let parent = this.std.store.getParent(model);
    while (parent) {
      if (matchModels(parent, [NoteBlockModel])) return true;
      parent = this.std.store.getParent(parent);
    }
    return false;
  }

  private bindDraggable(element: HTMLElement): () => void {
    return this.std.dnd.draggable<DragBlockEntity>({
      element,
      canDrag: () => Boolean(this.widget.anchorBlockId.peek()),
      onDragStart: () => {
        this.widget.dragging = true;
      },
      onDrop: () => {
        this.cleanupActiveDrag();
      },
      setDragPreview: ({ source, container, setOffset }) => {
        const entity = source.data?.bsEntity;
        if (!entity?.modelIds.length || !entity.snapshot) return;
        const offset = renderLightweightPreview(
          this.std,
          entity.snapshot,
          container,
        );
        setOffset(offset);
      },
      setDragData: () => {
        const { fromMode, snapshot } = this.buildDraggedSnapshot();
        if (snapshot) this.dimDraggedElements(snapshot);
        return {
          type: "blocks",
          fromMode,
          modelIds: snapshot ? collectSnapshotIds(snapshot) : [],
          snapshot,
        };
      },
    });
  }

  private unbindDropTarget(blockId: string): void {
    const fns = this.dropTargetCleanups.get(blockId);
    if (!fns) return;
    for (const fn of fns) fn();
    this.dropTargetCleanups.delete(blockId);
  }

  private bindDropTarget(view: BlockComponent): void {
    const model = view.model;
    const isNote = matchModels(model, [NoteBlockModel]);
    const underNote = this.isUnderNote(model);

    if (
      matchModels(model, [SurfaceBlockModel]) ||
      (this.mode === "page" && model.role === "root") ||
      (this.mode === "edgeless" &&
        !isNote &&
        model.role !== "root" &&
        !underNote)
    ) {
      return;
    }

    this.unbindDropTarget(model.id);
    const cleanups: Array<() => void> = [
      this.std.dnd.dropTarget<DragBlockEntity, { modelId: string }>({
        element: view,
        getIsSticky: () => this.mode === "page" || underNote,
        canDrop: ({ source }) => {
          const entity = source.data.bsEntity;
          if (entity?.type !== "blocks") return false;
          return (
            source.data.from?.docId !== this.widget.store.id ||
            entity.modelIds.every((id) => id !== model.id)
          );
        },
        onDragEnter: () => {
          if (isNote && "hideMask" in view) {
            (view as BlockComponent & { hideMask: boolean }).hideMask = true;
          }
        },
        onDragLeave: () => {
          if (isNote && "hideMask" in view) {
            (view as BlockComponent & { hideMask: boolean }).hideMask = false;
          }
        },
        onDrop: () => {
          if (isNote && "hideMask" in view) {
            (view as BlockComponent & { hideMask: boolean }).hideMask = false;
          }
        },
        setDropData: () => ({ modelId: model.id }),
      }),
    ];

    if (matchModels(model, [AttachmentBlockModel, BookmarkBlockModel])) {
      cleanups.push(this.bindDraggable(view));
    }

    this.dropTargetCleanups.set(model.id, cleanups);
  }

  private bindMonitor(): () => void {
    return this.std.dnd.monitor<DragBlockEntity>({
      canMonitor: ({ source }) => {
        const entity = source.data?.bsEntity;
        return entity?.type === "blocks" && Boolean(entity.snapshot);
      },
      onDropTargetChange: () => {
        this.clearDropIndicator();
      },
      onDrag: ({ location, source }) => {
        const target = location.current.dropTargets[0];
        if (!target) return;
        const dropBlock = target.element as BlockComponent;
        if (dropBlock?.std !== this.std) return;
        const point = new Point(
          location.current.input.clientX,
          location.current.input.clientY,
        );
        this.updateDropIndicator(point, source.data, target.data, dropBlock);
      },
      onDrop: ({ location, source }) => {
        this.clearDropIndicator();
        const target = location.current.dropTargets[0];
        if (!target) return;
        const dropBlock = target.element as BlockComponent;
        if (dropBlock?.std !== this.std) return;

        const point = new Point(
          location.current.input.clientX,
          location.current.input.clientY,
        );
        this.std.store.captureSync();
        if (this.mode === "edgeless") {
          this.handleEdgelessDrop(dropBlock, source.data, target.data, point);
        } else {
          this.handleNoteDrop(dropBlock, source.data, target.data);
        }
      },
    });
  }

  private handleEdgelessDrop(
    dropBlock: BlockComponent,
    dragPayload: DragBlockPayload,
    dropPayload: DropPayload,
    point: Point,
  ): void {
    if (!matchModels(dropBlock.model, [RootBlockModel])) {
      this.handleNoteDrop(dropBlock, dragPayload, dropPayload);
      return;
    }

    const snapshot = dragPayload.bsEntity?.snapshot;
    if (!snapshot || !this.gfx.surface) return;

    if (dragPayload.bsEntity?.fromMode === "gfx") {
      if (dragPayload.from?.docId === this.widget.store.id) return;
      this.mergeGfxSnapshot(snapshot, point).catch(console.error);
      return;
    }

    this.dropBlocksOntoCanvas(snapshot, point);
    this.std.selection.clear(["block"]);
  }

  private handleNoteDrop(
    dropBlock: BlockComponent,
    dragPayload: DragBlockPayload,
    dropPayload: DropPayload,
  ): void {
    const result = this.computeDropResult(dropBlock, dragPayload, dropPayload);
    const snapshot = dragPayload.bsEntity?.snapshot;
    if (!result || !snapshot || snapshot.content.length === 0) return;

    const store = this.std.store;
    const schema = store.schema;
    const targetModel = result.modelState.model;
    const parent =
      result.placement === "in" ? targetModel : store.getParent(targetModel);
    if (!parent) return;

    const insertIndex =
      result.placement === "in"
        ? 0
        : parent.children.indexOf(targetModel) +
          (result.placement === "before" ? 0 : 1);

    const sameDoc = dragPayload.from?.docId === this.widget.store.id;
    const lastSnapshot = snapshot.content.at(-1);
    if (
      sameDoc &&
      ((result.placement === "after" &&
        parent.children[insertIndex]?.id === snapshot.content[0].id) ||
        (result.placement === "before" &&
          lastSnapshot &&
          parent.children[insertIndex - 1]?.id === lastSnapshot.id))
    ) {
      return;
    }

    // Unwrap Note-on-Note drops while honoring fixed-text protection.
    if (
      matchModels(parent, [NoteBlockModel]) &&
      snapshot.content.every((b) => b.flavour === "myoxus:note")
    ) {
      const remaining = snapshot.content.filter(
        (b) => !sameDoc || b.id !== parent.id,
      );
      if (remaining.length > 0) {
        this.unwrapNoteDrop(
          { ...snapshot, content: remaining },
          parent.id,
          insertIndex,
        );
      }
      return;
    }

    if (
      snapshot.content.every((b) =>
        schema.safeValidate(b.flavour, parent.flavour),
      )
    ) {
      this.importSnapshot(snapshot, parent.id, insertIndex).catch(
        console.error,
      );
      return;
    }

    if (
      dragPayload.bsEntity?.fromMode === "gfx" &&
      matchModels(parent, [NoteBlockModel])
    ) {
      this.dropGfxIntoNote(snapshot, sameDoc, parent.id, insertIndex);
    }
  }

  private unwrapNoteDrop(
    snapshot: SliceSnapshot,
    parentId: string,
    index: number,
  ): void {
    const [noteSnapshot] = snapshot.content;
    if (!noteSnapshot) return;
    if (
      this.std.store.readonly ||
      this.std.store.hasFixedText(noteSnapshot.id)
    ) {
      return;
    }
    this.createTransformer()
      .snapshotToSlice(
        { ...snapshot, content: noteSnapshot.children },
        this.std.store,
        parentId,
        index,
      )
      .then(() => {
        const original = this.std.store.getBlock(noteSnapshot.id)?.model;
        if (original) this.std.store.deleteBlock(original);
      })
      .catch(console.error);
  }

  private dropGfxIntoNote(
    snapshot: SliceSnapshot,
    sameDoc: boolean,
    parentId: string,
    index: number,
  ): void {
    const store = this.std.store;
    const insertRefOrLink = (
      largest: { id: string; flavour: string } | null,
    ) => {
      if (largest) {
        store.addBlock(
          "myoxus:surface-ref",
          {
            reference: largest.id,
            pageId: store.id,
            workspaceId: store.workspace.id,
            refFlavour: largest.flavour,
          },
          parentId,
          index,
        );
      } else {
        store.addBlock(
          "myoxus:embed-linked-doc",
          { pageId: store.doc.id },
          parentId,
          index,
        );
      }
    };

    if (sameDoc) {
      let largest: { area: number; id: string; flavour: string } | null = null;
      const visit = (block: BlockSnapshot) => {
        if (block.flavour === "myoxus:surface") {
          const elements = (block.props.elements ?? {}) as Record<
            string,
            { id: string; xywh?: SerializedXYWH; type: string }
          >;
          for (const elem of Object.values(elements)) {
            if (!elem.xywh) continue;
            const bound = Bound.deserialize(elem.xywh);
            const area = bound.w * bound.h;
            if (!largest || area > largest.area) {
              largest = { area, id: elem.id, flavour: elem.type };
            }
          }
          for (const child of block.children ?? []) visit(child);
        } else if (block.props.xywh) {
          const bound = Bound.deserialize(block.props.xywh as SerializedXYWH);
          const area = bound.w * bound.h;
          if (!largest || area > largest.area) {
            largest = { area, id: block.id, flavour: block.flavour };
          }
        }
      };
      for (const root of snapshot.content) visit(root);
      insertRefOrLink(largest);
      return;
    }

    this.mergeGfxSnapshot(snapshot)
      .then((idRemap) => {
        let largest: { area: number; id: string; flavour: string } | null =
          null;
        for (const newId of idRemap.values()) {
          const el = this.gfx.getElementById(newId) as GfxModel | null;
          if (!el?.elementBound) continue;
          const area = el.elementBound.w * el.elementBound.h;
          if (!largest || area > largest.area) {
            largest = {
              area,
              id: newId,
              flavour: isPrimitiveModel(el) ? el.type : el.flavour,
            };
          }
        }
        insertRefOrLink(largest);
      })
      .catch(console.error);
  }

  private dropBlocksOntoCanvas(
    snapshot: SliceSnapshot,
    clientPoint: Point,
  ): void {
    const store = this.std.store;
    const schema = store.schema;
    const modelPoint = Point.from(
      this.gfx.viewport.toModelCoordFromClientCoord([
        clientPoint.x,
        clientPoint.y,
      ]),
    );

    const surfaceBlocks: BlockSnapshot[] = [];
    const pageBlocks: BlockSnapshot[] = [];
    const noteOnlyBlocks: BlockSnapshot[] = [];

    for (const block of snapshot.content) {
      if (schema.safeValidate(block.flavour, "myoxus:surface")) {
        surfaceBlocks.push(block);
      } else if (schema.safeValidate(block.flavour, "myoxus:page")) {
        pageBlocks.push(block);
      } else {
        noteOnlyBlocks.push(block);
      }
    }

    if (noteOnlyBlocks.length === 0) {
      const syncCardProps = (
        content: BlockSnapshot[],
        parentId: string,
        isSurfaceParent: boolean,
      ) => {
        const subSnapshot = { ...snapshot, content };
        repositionSnapshot(this.std, subSnapshot, modelPoint, true);
        this.importSnapshot(subSnapshot, parentId)
          .then((slice) => {
            slice?.content.forEach((block, idx) => {
              const sourceBlock = content[idx];
              if (!sourceBlock) return;
              if (isSurfaceParent && block.id !== sourceBlock.id) return;
              if (block.flavour === "myoxus:embed-iframe") {
                store.updateBlock(block.id, { xywh: sourceBlock.props.xywh });
              } else if (
                block.flavour === "myoxus:attachment" ||
                block.flavour.startsWith("myoxus:embed-") ||
                (isSurfaceParent &&
                  (block.flavour === "myoxus:image" ||
                    block.flavour === "myoxus:bookmark"))
              ) {
                store.updateBlock(block.id, {
                  xywh: sourceBlock.props.xywh,
                  style: sourceBlock.props.style,
                });
              }
            });
          })
          .catch(console.error);
      };

      if (surfaceBlocks.length > 0 && this.gfx.surface) {
        syncCardProps(surfaceBlocks, this.gfx.surface.id, true);
      }
      if (pageBlocks.length > 0 && store.root) {
        syncCardProps(pageBlocks, store.root.id, false);
      }
      return;
    }

    const noteContent = snapshot.content.filter((block) =>
      schema.safeValidate(block.flavour, "myoxus:note"),
    );
    const dndApi = this.std.getOptional(DndApiExtensionIdentifier);
    if (
      dndApi &&
      this.gfx.surface &&
      snapshot.pageId !== store.doc.id &&
      store.workspace.docs.has(snapshot.pageId)
    ) {
      const style: EmbedCardStyle = "vertical";
      const linkedSnapshot = dndApi.fromEntity({
        docId: snapshot.pageId,
        props: {
          blockIds: noteContent.map((b) => b.id),
          style,
          xywh: new Bound(
            modelPoint.x,
            modelPoint.y,
            EMBED_CARD_WIDTH[style],
            EMBED_CARD_HEIGHT[style],
          ).serialize(),
        },
      });
      if (linkedSnapshot) {
        this.importSnapshot(linkedSnapshot, this.gfx.surface.id).catch(
          console.error,
        );
      }
      return;
    }

    const firstId = snapshot.content[0]?.id;
    const sourceModel = firstId ? store.getModelById(firstId) : null;
    const sourceNote = sourceModel ? findNoteBlockModel(sourceModel) : null;
    const noteXywh = new Bound(
      modelPoint.x,
      modelPoint.y,
      DEFAULT_NOTE_WIDTH,
      DEFAULT_NOTE_HEIGHT,
    ).serialize();

    const newNoteId = sourceNote
      ? store.addSiblingBlocks(
          sourceNote,
          [{ flavour: "myoxus:note", xywh: noteXywh }],
          sourceNote.children[0]?.id === firstId ? "before" : "after",
        )[0]
      : store.addBlock("myoxus:note", { xywh: noteXywh }, store.root!);

    this.importSnapshot({ ...snapshot, content: noteContent }, newNoteId)
      .then(() => {
        this.std.getOptional(TelemetryProvider)?.track("CanvasElementAdded", {
          page: "whiteboard editor",
          module: "canvas",
          segment: "whiteboard",
          control: "canvas:drop",
          type: "note",
          other: "split-from-note",
        });
      })
      .catch(console.error);
  }

  private async mergeGfxSnapshot(
    snapshot: SliceSnapshot,
    clientPoint?: Point,
  ): Promise<Map<string, string>> {
    const modelPoint = clientPoint
      ? Point.from(
          this.gfx.viewport.toModelCoordFromClientCoord([
            clientPoint.x,
            clientPoint.y,
          ]),
        )
      : (() => {
          const bound = this.gfx.elementsBound;
          return new Point(bound.x + bound.w, bound.y + bound.h / 2);
        })();

    repositionSnapshot(this.std, snapshot, modelPoint);

    const surface = this.gfx.surface!;
    const root = this.std.store.root!;
    const schema = this.std.store.schema;
    const deps = new Map<string, Set<string>>([["root", new Set()]]);
    const idRemap = new Map<string, string>();

    type RawSurfaceElement = {
      type: string;
      xywh?: SerializedXYWH;
      children?: { json: Record<string, unknown> };
      source?: { position: IVec; id?: string };
      target?: { position: IVec; id?: string };
      [key: string]: unknown;
    };

    let elemMap: Record<string, RawSurfaceElement> = {};
    const blockMap = new Map<
      string,
      { underSurface: boolean; snapshot: BlockSnapshot }
    >();

    const addDep = (ownerId: string, childId: string) => {
      let set = deps.get(ownerId);
      if (!set) {
        set = new Set();
        deps.set(ownerId, set);
      }
      set.add(childId);
      deps.get("root")!.delete(childId);
    };

    const ensureRoot = (id: string) => {
      for (const set of deps.values()) {
        if (set.has(id)) return;
      }
      deps.get("root")!.add(id);
    };

    const isGroupElem = (type: string) =>
      Object.isPrototypeOf.call(
        GfxGroupLikeElementModel.prototype,
        surface.getConstructor(type).prototype,
      );

    const isGroupBlock = (flavour: string) => {
      const proto = schema.get(flavour)?.model.toModel?.();
      return Boolean(proto && isGfxGroupCompatibleModel(proto));
    };

    const collectDeps = (block: BlockSnapshot) => {
      if (block.flavour === "myoxus:surface") {
        elemMap = (block.props.elements as typeof elemMap) ?? {};
        for (const [elemId, elem] of Object.entries(elemMap)) {
          ensureRoot(elemId);
          if (isGroupElem(elem.type)) {
            for (const childId of Object.keys(elem.children?.json ?? {})) {
              addDep(elemId, childId);
            }
          } else if (elem.type === "connector") {
            if (elem.source?.id) addDep(elemId, elem.source.id);
            if (elem.target?.id) addDep(elemId, elem.target.id);
          }
        }
        for (const child of block.children ?? []) collectDeps(child);
        return;
      }

      blockMap.set(block.id, {
        underSurface: schema.safeValidate(block.flavour, "myoxus:surface"),
        snapshot: block,
      });
      ensureRoot(block.id);
      if (isGroupBlock(block.flavour)) {
        const childMap = (block.props.childElementIds ?? {}) as Record<
          string,
          unknown
        >;
        for (const childId of Object.keys(childMap)) {
          addDep(block.id, childId);
        }
      }
    };

    for (const item of snapshot.content) collectDeps(item);

    const visited = new Set<string>();
    const insertInOrder = async (id: string) => {
      if (visited.has(id)) return;
      visited.add(id);

      for (const depId of deps.get(id) ?? []) {
        await insertInOrder(depId);
      }

      const blockEntry = blockMap.get(id);
      if (blockEntry) {
        const { underSurface, snapshot: blockSnap } = blockEntry;
        if (
          isGroupBlock(blockSnap.flavour) &&
          blockSnap.props.childElementIds
        ) {
          const childMap = blockSnap.props.childElementIds as Record<
            string,
            unknown
          >;
          for (const oldChildId of Object.keys(childMap)) {
            const remapped = idRemap.get(oldChildId);
            if (remapped) {
              childMap[remapped] = childMap[oldChildId];
            }
            delete childMap[oldChildId];
          }
        }
        const inserted = await this.importSnapshot(
          { ...snapshot, content: [blockSnap] },
          underSurface ? surface.id : root.id,
        );
        if (inserted?.content[0]) {
          idRemap.set(id, inserted.content[0].id);
        }
        return;
      }

      const elem = elemMap[id];
      if (!elem) return;

      for (const value of Object.values(elem)) {
        if (value instanceof Object && hasSurfaceYmapId(value)) {
          const json = Reflect.get(value, "json") as Record<string, unknown>;
          for (const oldChildId of Object.keys(json)) {
            const remapped = idRemap.get(oldChildId);
            if (remapped) {
              json[remapped] = structuredClone(json[oldChildId]);
            }
            delete json[oldChildId];
          }
        }
      }

      if (elem.type === "connector") {
        for (const endKey of ["source", "target"] as const) {
          const endpoint = elem[endKey];
          if (endpoint?.id) {
            const remapped = idRemap.get(endpoint.id);
            if (remapped) endpoint.id = remapped;
            else delete endpoint.id;
          }
        }
      }

      const newId = surface.addElement(elem);
      const created = surface.getElementById(newId);
      if (created) {
        for (const [key, value] of Object.entries(elem)) {
          if (key.startsWith("mermaid")) created.yMap.set(key, value);
        }
      }
      idRemap.set(id, newId);
    };

    for (const rootId of deps.get("root") ?? []) {
      await insertInOrder(rootId);
    }
    return idRemap;
  }
}
