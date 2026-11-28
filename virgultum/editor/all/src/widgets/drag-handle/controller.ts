// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors

import {
  computed,
  effect,
  type ReadonlySignal,
  signal,
} from "@preact/signals-core";
import { cssVar } from "@myoxus/theme";
import {
  EdgelessCRUDIdentifier,
  EdgelessLegacySlotIdentifier,
} from "@virgultum/canvas-runtime/surface";
import type { RootBlockModel } from "@virgultum/core/models";
import { DisposableGroup } from "@virgultum/core/primitives/disposable";
import { type IVec, Point, Rect } from "@virgultum/core/primitives/gfx";
import {
  BLOCK_ID_ATTR,
  type BlockComponent,
  BlockSelection,
  NativeEditorWidget,
  type PointerEventState,
  SurfaceSelection,
  TextSelection,
  type UIEventHandler,
  WidgetViewExtension,
} from "@virgultum/core/runtime";
import {
  GfxControllerIdentifier,
  type GfxModel,
  type ToolOptionWithType,
} from "@virgultum/core/runtime/gfx";
import { DocModeProvider, PageViewportService } from "@virgultum/core/services";
import {
  captureEventTarget,
  findNoteBlockModel,
  getCurrentNativeRange,
  isInsideEdgelessEditor,
  isInsidePageEditor,
} from "@virgultum/core/utils";
import type { NoteBlockComponent } from "@virgultum/embeds/blocks";

import { DragDropCoordinator } from "./dnd-operations";
import {
  computeBlockAreaRect,
  computeGfxHandleArea,
  findBlockUnderPoint,
  findNoteUnderPoint,
  getFirstLineHeight,
  type GfxHandleArea,
  HANDLE_CONTAINER_PADDING,
  HANDLE_CONTAINER_WIDTH,
  HANDLE_GRABBER_HEIGHT,
  HANDLE_GRABBER_RADIUS,
  HANDLE_GRABBER_WIDTH,
  HANDLE_GRABBER_WIDTH_ACTIVE,
  isPointOutsideNote,
} from "./geometry";
import {
  type DragHandleMode,
  type HoverBounds,
  MYOXUS_DRAG_HANDLE_WIDGET,
} from "./types";

const WIDGET_SHADOW_CSS = `
  .myoxus-drag-handle-widget {
    display: flex;
    position: absolute;
    left: 0;
    top: 0;
    contain: size layout;
  }

  .myoxus-drag-handle-container {
    top: 0;
    left: 0;
    position: absolute;
    display: flex;
    justify-content: center;
    width: ${HANDLE_CONTAINER_WIDTH}px;
    min-height: 12px;
    pointer-events: auto;
    user-select: none;
    box-sizing: border-box;
  }

  .myoxus-drag-handle-container:hover {
    cursor: grab;
  }

  .myoxus-drag-handle-grabber {
    width: ${HANDLE_GRABBER_WIDTH}px;
    height: 100%;
    border-radius: 1px;
    background: var(--myoxus-placeholder-color);
    transition: width 0.25s ease;
  }

  .myoxus-drag-handle-grabber.dots {
    width: 14px;
    height: 26px;
    box-sizing: border-box;
    padding: 5px 2px;
    border-radius: 4px;
    gap: 2px;
    display: flex;
    flex-wrap: wrap;
    background-color: transparent;
    transform: translateX(-100%);
    transition: unset;
  }

  .myoxus-drag-handle-grabber.dots:hover {
    background-color: ${cssVar("hoverColor")};
  }

  .myoxus-drag-handle-grabber.dots > .dot {
    width: 4px;
    height: 4px;
    border-radius: 50%;
    flex: 0 0 4px;
    background-color: ${cssVar("iconSecondary")};
  }

  .myoxus-drag-hover-rect {
    position: absolute;
    top: 0;
    left: 0;
    border-radius: 6px;
    background: var(--myoxus-hover-color);
    pointer-events: none;
    z-index: 2;
  }

  @media print {
    .myoxus-drag-handle-widget {
      display: none;
    }
  }
`;

const WITH_DRAG_HANDLE_CLASS = "with-drag-handle";

/**
 * Unified AGPL drag-handle widget for Edgeless Notes, Edgeless Gfx elements,
 * cross-doc drag payloads, and host-mounted block hover/click/drag paths.
 */
export class MyoxusDragHandleWidget extends NativeEditorWidget<RootBlockModel> {
  readonly dragHandleContainer = this.ownerDocument.createElement("div");
  readonly dragHandleGrabber = this.ownerDocument.createElement("div");
  private readonly hoverRectEl = this.ownerDocument.createElement("div");

  private activeMode: DragHandleMode = null;
  private hoverBounds: HoverBounds | null = null;
  private anchorModelCleanup: DisposableGroup | null = null;
  private markedBlocks: BlockComponent[] = [];

  private pointerDown = false;
  private pointerMoveRafId: number | null = null;
  private lastPointerMoveAt = 0;
  private pendingMoveState: PointerEventState | null = null;
  private lastPointerHitId: string | null = null;
  private lastPointerHitEl: Element | null = null;
  private lastShownBlock: { id: string; el: BlockComponent } | null = null;

  private gfxRafId: number | null = null;
  private gfxSurfaceRafId: number | null = null;
  private pendingGfxArea: GfxHandleArea | null = null;
  private appliedGfxArea: GfxHandleArea | null = null;

  readonly anchorBlockId = signal<string | null>(null);
  readonly scale = signal(1);
  readonly noteScale = signal(1);
  readonly scaleInNote = computed(
    () => this.scale.value * this.noteScale.value,
  );

  readonly anchorBlockComponent = computed<BlockComponent | null>(() => {
    const id = this.anchorBlockId.value;
    return id ? this.std.view.getBlock(id) : null;
  });

  readonly anchorEdgelessElement: ReadonlySignal<GfxModel | null> = computed(
    () => {
      const id = this.anchorBlockId.value;
      if (!id || this.mode === "page") return null;
      return this.std.get(EdgelessCRUDIdentifier).getElementById(id);
    },
  );

  dragging = false;
  isDragHandleHovered = false;
  center: IVec = [0, 0];

  private readonly dndCoordinator = new DragDropCoordinator(this);

  constructor() {
    super();
    const shadow = this.attachShadow({ mode: "open" });
    const style = this.ownerDocument.createElement("style");
    style.textContent = WIDGET_SHADOW_CSS;

    const root = this.ownerDocument.createElement("div");
    root.className = "myoxus-drag-handle-widget";
    this.dragHandleContainer.className = "myoxus-drag-handle-container";
    this.dragHandleGrabber.className = "myoxus-drag-handle-grabber";
    this.hoverRectEl.className = "myoxus-drag-hover-rect";
    this.hoverRectEl.style.display = "none";

    this.dragHandleContainer.append(this.dragHandleGrabber);
    root.append(this.dragHandleContainer, this.hoverRectEl);
    shadow.append(style, root);
  }

  get mode() {
    return this.std.get(DocModeProvider).getEditorMode();
  }

  get activeDragHandle(): DragHandleMode {
    return this.activeMode;
  }

  set activeDragHandle(next: DragHandleMode) {
    if (this.activeMode === next) return;
    this.activeMode = next;
    this.dragHandleGrabber.classList.toggle("dots", next === "gfx");
    this.dragHandleGrabber.replaceChildren();
    if (next === "gfx") {
      for (let i = 0; i < 6; i += 1) {
        const dot = this.ownerDocument.createElement("div");
        dot.className = "dot";
        this.dragHandleGrabber.append(dot);
      }
    }
    this.syncHoverOverlay();
  }

  get dragHoverRect(): HoverBounds | null {
    return this.hoverBounds;
  }

  set dragHoverRect(bounds: HoverBounds | null) {
    this.hoverBounds = bounds;
    this.syncHoverOverlay();
  }

  private get offsetParentEl(): Element {
    return this.dragHandleContainer.parentElement!;
  }

  override connectedCallback(): void {
    super.connectedCallback();
    this.hide(true);

    this.bindPointerAndHandleEvents();
    this.bindKeyboardEvents();
    this.dndCoordinator.attach();

    this.disposables.addFromEvent(this.host, "pointerleave", () => {
      this.hide();
    });

    if (isInsidePageEditor(this.host)) {
      const viewportService = this.std.get(PageViewportService);
      this.disposables.add(viewportService.subscribe(() => this.hide()));
    } else if (isInsideEdgelessEditor(this.host)) {
      this.bindEdgelessEvents();
    }

    this.disposables.add(() => {
      this.cancelPendingFrames();
    });
  }

  override disconnectedCallback(): void {
    this.hide(true);
    this.anchorModelCleanup?.dispose();
    this.anchorModelCleanup = null;
    super.disconnectedCallback();
  }

  hide = (force = false): void => {
    if (this.dragging && !force) return;

    this.markHoveredBlocks([]);
    this.isDragHandleHovered = false;
    this.anchorBlockId.value = null;
    this.dragHoverRect = null;
    this.activeDragHandle = null;

    this.dragHandleContainer.removeAttribute("style");
    this.dragHandleContainer.style.display = "none";
    this.dragHandleGrabber.removeAttribute("style");

    if (force) {
      this.dragging = false;
      this.pointerDown = false;
      this.lastPointerHitId = null;
      this.lastPointerHitEl = null;
      this.lastShownBlock = null;
      this.appliedGfxArea = null;
    }
  };

  getSelectedBlockRefs() {
    const sel = this.std.selection;
    return sel.find(TextSelection)
      ? sel.filter(TextSelection)
      : sel.filter(BlockSelection);
  }

  getSelectedBlockComponents(): BlockComponent[] {
    return this.getSelectedBlockRefs()
      .map((ref) => this.std.view.getBlock(ref.blockId))
      .filter((view): view is BlockComponent => Boolean(view));
  }

  selectBlocks(blocks: BlockComponent[], noteId?: string): void {
    if (blocks.length === 0) return;

    const sel = this.std.selection;
    const nextSelections = blocks.map((block) =>
      sel.create(BlockSelection, { blockId: block.blockId }),
    );

    if (this.mode === "edgeless") {
      const targetNoteId = noteId ?? findNoteBlockModel(blocks[0].model)?.id;
      if (!targetNoteId) return;
      nextSelections.push(
        sel.create(SurfaceSelection, blocks[0].blockId, [targetNoteId], true),
      );
    }

    sel.set(nextSelections);
  }

  private cancelPendingFrames(): void {
    if (this.pointerMoveRafId !== null) {
      cancelAnimationFrame(this.pointerMoveRafId);
      this.pointerMoveRafId = null;
    }
    this.pendingMoveState = null;

    if (this.gfxRafId !== null) {
      cancelAnimationFrame(this.gfxRafId);
      this.gfxRafId = null;
    }
    if (this.gfxSurfaceRafId !== null) {
      cancelAnimationFrame(this.gfxSurfaceRafId);
      this.gfxSurfaceRafId = null;
    }
    this.pendingGfxArea = null;
  }

  private markHoveredBlocks(blocks: BlockComponent[]): void {
    for (const prev of this.markedBlocks) {
      prev.classList.remove(WITH_DRAG_HANDLE_CLASS);
    }
    this.markedBlocks = blocks;
    for (const next of blocks) {
      next.classList.add(WITH_DRAG_HANDLE_CLASS);
    }
  }

  private watchAnchorDeletion(block: BlockComponent): void {
    this.anchorModelCleanup?.dispose();
    const group = new DisposableGroup();
    group.add(block.model.deleted.subscribe(() => this.hide()));
    this.anchorModelCleanup = group;
  }

  private syncHoverOverlay(): void {
    const rect = this.hoverBounds;
    // Canvas elements draw their own selection frame; hover rect is block-only.
    if (!rect || this.activeMode !== "block") {
      this.hoverRectEl.style.display = "none";
      return;
    }
    Object.assign(this.hoverRectEl.style, {
      display: "",
      left: `${rect.left}px`,
      top: `${rect.top}px`,
      width: `${rect.width}px`,
      height: `${rect.height}px`,
    });
  }

  private resolveHoveredBlocks(): BlockComponent[] {
    if (this.activeMode !== "block") return [];
    const anchor = this.anchorBlockComponent.peek();
    if (!anchor) return [];

    const refs = this.getSelectedBlockRefs();
    let covered: BlockComponent[] = [];
    if (refs.some((ref) => ref.type === "text")) {
      const range = getCurrentNativeRange();
      if (range && this.std.range) {
        covered = this.std.range.getSelectedBlockComponentsByRange(range, {
          match: (el) => el.model.role === "content",
          mode: "highest",
        });
      }
    } else {
      covered = this.getSelectedBlockComponents();
    }

    return covered.some((b) => b.blockId === anchor.blockId)
      ? covered
      : [anchor];
  }

  private computeCurrentBlockArea(): Rect | null {
    const anchor = this.anchorBlockComponent.peek();
    if (!anchor) return null;
    const covered = this.resolveHoveredBlocks();
    return computeBlockAreaRect(
      anchor,
      covered,
      this.offsetParentEl,
      this.scaleInNote.peek(),
    );
  }

  private canEditNote(note: BlockComponent): boolean {
    if (note.store.id !== this.store.id) return false;
    if (this.mode === "page") return true;
    const gfxSelection = this.std.get(GfxControllerIdentifier).selection;
    return (
      gfxSelection.editing && gfxSelection.selectedIds[0] === note.model.id
    );
  }

  private showBlockHandle(): void {
    const block = this.anchorBlockComponent.peek();
    if (!block) return;

    this.activeDragHandle = "block";
    const areaRect = this.computeCurrentBlockArea();
    if (!areaRect) return;

    this.markHoveredBlocks([block]);

    const scale = this.scale.peek();
    const scaleInNote = this.scaleInNote.peek();
    const firstLineHeight = getFirstLineHeight(block.model);
    const blockStyle = getComputedStyle(block);
    const blockTop =
      block.getBoundingClientRect().top +
      Number.parseInt(blockStyle.paddingTop, 10) * scale -
      this.offsetParentEl.getBoundingClientRect().top;

    const rowPaddingY =
      ((firstLineHeight - HANDLE_GRABBER_HEIGHT) / 2 + 2) * scaleInNote;
    const paddingTop = rowPaddingY + blockTop - areaRect.top;
    const paddingBottom =
      areaRect.height - paddingTop - HANDLE_GRABBER_HEIGHT * scaleInNote;

    const animate = this.lastShownBlock?.id === block.blockId;
    Object.assign(this.dragHandleContainer.style, {
      transition: animate ? "padding 0.25s ease" : "none",
      paddingTop: `${paddingTop}px`,
      paddingBottom: `${paddingBottom}px`,
      width: `${HANDLE_CONTAINER_WIDTH * scaleInNote}px`,
      left: `${areaRect.left}px`,
      top: `${areaRect.top}px`,
      height: `${areaRect.height}px`,
      display: "flex",
    });

    Object.assign(this.dragHandleGrabber.style, {
      width: `${HANDLE_GRABBER_WIDTH * scaleInNote}px`,
      borderRadius: `${HANDLE_GRABBER_RADIUS * scaleInNote}px`,
    });

    this.watchAnchorDeletion(block);
    this.lastShownBlock = { id: block.blockId, el: block };
  }

  private processPointerMove(state: PointerEventState): void {
    if (this.pointerDown) return;
    if (this.store.readonly || this.dragging || !this.isConnected) {
      this.hide();
      return;
    }
    if (this.activeMode === "gfx") return;

    const targetEl = captureEventTarget(state.raw.target);
    if (!targetEl) {
      this.lastPointerHitId = null;
      this.lastPointerHitEl = null;
      return;
    }
    if (targetEl.closest(".myoxus-drag-handle-container")) return;
    if (!this.block) return;

    const hitEl = targetEl.closest(`[${BLOCK_ID_ATTR}]`);
    const hitId = hitEl?.getAttribute(BLOCK_ID_ATTR) ?? null;
    if (
      hitId &&
      this.activeMode === "block" &&
      hitId === this.lastPointerHitId &&
      hitEl === this.lastPointerHitEl &&
      this.anchorBlockId.peek() === hitId
    ) {
      return;
    }
    this.lastPointerHitId = hitId;
    this.lastPointerHitEl = hitEl;

    const point = new Point(state.raw.x, state.raw.y);
    const note = findNoteUnderPoint(
      this.host,
      this.block,
      point,
    ) as NoteBlockComponent | null;
    this.noteScale.value =
      this.mode === "page" ? 1 : (note?.model.props.edgeless.scale ?? 1);

    if (
      note &&
      this.canEditNote(note) &&
      !isPointOutsideNote(this.host, note, point, this.scaleInNote.peek())
    ) {
      const closestBlock = findBlockUnderPoint(this.host, this.block, point);
      if (!closestBlock) {
        this.lastPointerHitId = null;
        this.anchorBlockId.value = null;
        return;
      }
      const blockId = closestBlock.getAttribute(BLOCK_ID_ATTR);
      if (!blockId) return;

      this.anchorBlockId.value = blockId;
      if (
        closestBlock.closest(".myoxus-database-block-table") ||
        this.store.readonly
      ) {
        this.hide();
        return;
      }

      if (
        !this.isDragHandleHovered &&
        (this.activeMode !== "block" || this.lastShownBlock?.id !== blockId)
      ) {
        this.showBlockHandle();
      }
      return;
    }

    if (this.activeMode) this.hide();
  }

  private bindPointerAndHandleEvents(): void {
    this.handleEvent("pointerDown", () => {
      this.pointerDown = true;
    });
    this.handleEvent("pointerUp", () => {
      this.pointerDown = false;
    });

    this.handleEvent("pointerMove", (ctx) => {
      const state = ctx.get("pointerState");
      const now = performance.now();
      if (
        now - this.lastPointerMoveAt >= 16 &&
        this.pointerMoveRafId === null
      ) {
        this.lastPointerMoveAt = now;
        this.processPointerMove(state);
        return;
      }
      this.pendingMoveState = state;
      if (this.pointerMoveRafId !== null) return;
      this.pointerMoveRafId = requestAnimationFrame(() => {
        this.pointerMoveRafId = null;
        this.lastPointerMoveAt = performance.now();
        const next = this.pendingMoveState;
        this.pendingMoveState = null;
        if (next) this.processPointerMove(next);
      });
    });

    this.handleEvent("pointerOut", (ctx) => {
      const raw = ctx.get("pointerState").raw;
      raw.preventDefault();
      const target = captureEventTarget(raw.target);
      if (!target) return;
      const related = captureEventTarget(raw.relatedTarget);
      if (
        target.classList.contains("myoxus-page-viewport") &&
        !related?.closest(".myoxus-page-viewport") &&
        !related?.closest(MYOXUS_DRAG_HANDLE_WIDGET)
      ) {
        this.hide();
      }
    });

    this.handleEvent("click", (ctx) => {
      if (this.activeMode !== "block") return;
      const target = captureEventTarget(ctx.get("pointerState").raw.target);
      if (!target?.closest(MYOXUS_DRAG_HANDLE_WIDGET)) return;

      const anchorId = this.anchorBlockId.peek();
      if (!anchorId) return;

      const selectedRefs = this.getSelectedBlockRefs();
      const hasText = selectedRefs.some((s) => s.type === "text");
      if (
        selectedRefs.length > 0 &&
        !hasText &&
        selectedRefs[0].blockId === anchorId
      ) {
        this.std.selection.clear(["block"]);
        this.dragHoverRect = null;
        this.showBlockHandle();
        return;
      }

      const block = this.anchorBlockComponent.peek();
      if (!block) return;
      if (selectedRefs.length > 1) this.showBlockHandle();
      this.selectBlocks([block]);
    });

    const container = this.dragHandleContainer;
    this.disposables.addFromEvent(container, "pointerenter", () => {
      if (this.activeMode === "block" && this.anchorBlockId.peek()) {
        const padding = HANDLE_CONTAINER_PADDING * this.scale.peek();
        const scaleInNote = this.scaleInNote.peek();
        Object.assign(container.style, {
          paddingTop: `${padding}px`,
          paddingBottom: `${padding}px`,
          transition: "padding 0.25s ease",
        });
        Object.assign(this.dragHandleGrabber.style, {
          width: `${HANDLE_GRABBER_WIDTH_ACTIVE * scaleInNote}px`,
          borderRadius: `${HANDLE_GRABBER_RADIUS * scaleInNote}px`,
        });
        this.isDragHandleHovered = true;
      } else if (this.activeMode === "gfx") {
        this.isDragHandleHovered = true;
      }
    });

    this.disposables.addFromEvent(container, "pointerdown", () => {
      if (this.activeMode !== "block" || !this.anchorBlockId.peek()) return;
      this.dragHoverRect = this.computeCurrentBlockArea();
    });

    this.disposables.addFromEvent(container, "pointerup", () => {
      if (this.activeMode === "block") this.dragHoverRect = null;
    });

    this.disposables.addFromEvent(container, "pointerleave", () => {
      this.isDragHandleHovered = false;
      this.dragHoverRect = null;
      if (this.activeMode === "gfx" || this.dragging) return;
      this.showBlockHandle();
    });
  }

  private bindKeyboardEvents(): void {
    const swallowDuringDrag: UIEventHandler = (ctx) => {
      if (!this.dragging) return;
      const event = ctx.get("defaultState").event as KeyboardEvent;
      event.preventDefault();
      event.stopPropagation();
    };
    this.handleEvent("beforeInput", () => this.hide());
    this.handleEvent("keyDown", swallowDuringDrag, { global: true });
    this.handleEvent("keyUp", swallowDuringDrag, { global: true });
  }

  private isSameGfxArea(
    a: GfxHandleArea | null,
    b: GfxHandleArea | null,
  ): boolean {
    if (!a || !b) return false;
    return (
      a.left === b.left &&
      a.top === b.top &&
      a.right === b.right &&
      a.bottom === b.bottom &&
      a.width === b.width &&
      a.height === b.height
    );
  }

  private currentGfxArea(): GfxHandleArea | null {
    const el = this.anchorEdgelessElement.peek();
    if (!el) return null;
    const gfx = this.std.get(GfxControllerIdentifier);
    return computeGfxHandleArea(gfx, el, this.scale.peek());
  }

  private scheduleGfxHandle(explicitArea?: GfxHandleArea | null): void {
    const area = explicitArea ?? this.currentGfxArea();
    this.pendingGfxArea = area;
    if (!area) return;
    if (
      this.activeMode === "gfx" &&
      this.gfxRafId === null &&
      this.isSameGfxArea(this.appliedGfxArea, area)
    ) {
      return;
    }
    if (this.gfxRafId !== null) return;

    this.gfxRafId = requestAnimationFrame(() => {
      this.gfxRafId = null;
      if (!this.anchorBlockId.peek()) return;
      const next = this.pendingGfxArea ?? this.currentGfxArea();
      this.pendingGfxArea = null;
      if (!next) return;
      if (
        this.activeMode === "gfx" &&
        this.isSameGfxArea(this.appliedGfxArea, next)
      ) {
        return;
      }

      Object.assign(this.dragHandleContainer.style, {
        transition: "none",
        paddingTop: "0px",
        paddingBottom: "0px",
        left: `${next.left}px`,
        top: `${next.top}px`,
        display: "flex",
      });

      const anchorBlock = this.anchorBlockComponent.peek();
      if (anchorBlock) this.watchAnchorDeletion(anchorBlock);

      this.activeDragHandle = "gfx";
      this.appliedGfxArea = { ...next };
    });
  }

  private syncGfxSelection(): void {
    if (!this.isConnected) return;
    if (this.store.readonly || this.mode === "page") {
      this.hide();
      return;
    }
    const { selection } = this.std.get(GfxControllerIdentifier);
    if (selection.editing || selection.selectedElements.length !== 1) {
      this.hide();
      return;
    }
    this.anchorBlockId.value = selection.selectedElements[0].id;
    this.scheduleGfxHandle();
  }

  private bindEdgelessEvents(): void {
    const gfx = this.std.get(GfxControllerIdentifier);
    const { viewport, selection, tool, surface } = gfx;
    const slots = this.std.get(EdgelessLegacySlotIdentifier);

    this.disposables.add(
      viewport.viewportUpdated.subscribe(({ zoom, center }) => {
        if (this.scale.peek() !== zoom) this.scale.value = zoom;
        if (this.center[0] !== center[0] || this.center[1] !== center[1]) {
          this.center = [...center];
        }
        if (this.activeMode === "gfx") {
          this.scheduleGfxHandle(this.currentGfxArea());
        } else if (this.activeMode) {
          this.hide();
        }
      }),
    );

    this.disposables.add(
      selection.slots.updated.subscribe(() => this.syncGfxSelection()),
    );
    this.disposables.add(
      slots.readonlyUpdated.subscribe(() => this.syncGfxSelection()),
    );
    this.disposables.add(slots.elementResizeStart.subscribe(() => this.hide()));
    this.disposables.add(
      slots.elementResizeEnd.subscribe(() => this.syncGfxSelection()),
    );

    this.disposables.add(
      effect(() => {
        const option: ToolOptionWithType | null = tool.currentToolOption$.value;
        if (!option) return;
        if (option.toolType?.toolName === "default") {
          this.syncGfxSelection();
        } else {
          this.hide();
        }
      }),
    );

    const scheduleSurfaceRefresh = () => {
      if (this.gfxSurfaceRafId !== null) return;
      this.gfxSurfaceRafId = requestAnimationFrame(() => {
        this.gfxSurfaceRafId = null;
        if (this.activeMode === "gfx") this.scheduleGfxHandle();
      });
    };

    this.disposables.add(
      this.std.store.slots.blockUpdated.subscribe((payload) => {
        if (
          this.activeMode !== "gfx" ||
          payload.id !== this.anchorBlockId.peek()
        ) {
          return;
        }
        if (payload.type === "delete") this.hide();
        else if (payload.type === "update") scheduleSurfaceRefresh();
      }),
    );

    if (surface) {
      this.disposables.add(
        surface.elementUpdated.subscribe(({ id }) => {
          if (this.activeMode === "gfx" && id === this.anchorBlockId.peek()) {
            scheduleSurfaceRefresh();
          }
        }),
      );
    }
  }
}

export const dragHandleWidget = WidgetViewExtension(
  "myoxus:page",
  MYOXUS_DRAG_HANDLE_WIDGET,
  MYOXUS_DRAG_HANDLE_WIDGET,
);

export function registerDragHandleWidget(): void {
  if (!customElements.get(MYOXUS_DRAG_HANDLE_WIDGET)) {
    customElements.define(MYOXUS_DRAG_HANDLE_WIDGET, MyoxusDragHandleWidget);
  }
}

declare global {
  interface HTMLElementTagNameMap {
    [MYOXUS_DRAG_HANDLE_WIDGET]: MyoxusDragHandleWidget;
  }
}
