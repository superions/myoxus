import type { NoteBlockComponent } from "@virgultum/embeds/blocks";
import {
  EdgelessLegacySlotIdentifier,
  isNoteBlock,
} from "@virgultum/canvas-runtime/surface";
import { DisposableGroup } from "@virgultum/core/primitives/disposable";
import {
  deserializeXYWH,
  Point,
  serializeXYWH,
} from "@virgultum/core/primitives/gfx";
import {
  DEFAULT_NOTE_HEIGHT,
  type NoteBlockModel,
} from "@virgultum/core/models";
import { EDGELESS_BLOCK_CHILD_PADDING } from "@virgultum/core/consts";
import {
  EditorChromeHostIdentifier,
  EditorI18nProvider,
  editorMessage,
  resolveEditorMessage,
  TelemetryProvider,
} from "@virgultum/core/services";
import {
  getRectByBlockComponent,
  isControlledKeyboardEvent,
  stopPropagation,
} from "@virgultum/core/utils";
import { WidgetViewExtension } from "@virgultum/core/runtime";
import { GfxControllerIdentifier } from "@virgultum/core/runtime/gfx";
import type { EdgelessSelectedRectWidget } from "../edgeless-selected-rect/native-selection-overlay";
import { nothing, render } from "lit";
import { NativeCanvasWidget } from "../native-canvas-widget";

const DIVIDING_LINE_OFFSET = 4;
const NEW_NOTE_GAP = 40;

const styles = `
  note-slicer {
    display: flex;
  }

  .note-slicer-button {
    position: absolute;
    z-index: var(--myoxus-z-index-popover);
  }

  .note-slicer-dividing-line-container {
    display: flex;
    align-items: center;
    position: absolute;
    left: 0;
    top: 0;
    height: 4px;
    cursor: pointer;
  }

  .note-slicer-dividing-line {
    display: block;
    height: 1px;
    width: 100%;
    z-index: var(--myoxus-z-index-popover);
    background-image: linear-gradient(
      to right,
      var(--myoxus-black-10) 50%,
      transparent 50%
    );
    background-size: 4px 100%;
  }
  .note-slicer-dividing-line-container.active .note-slicer-dividing-line {
    background-image: linear-gradient(
      to right,
      var(--myoxus-black-60) 50%,
      transparent 50%
    );
    animation: slide 0.3s linear infinite;
  }
  @keyframes slide {
    0% {
      background-position: 0 0;
    }
    100% {
      background-position: -4px 0;
    }
  }
`;

export const NOTE_SLICER_WIDGET = "note-slicer";

export class NoteSlicer extends NativeCanvasWidget {
  private readonly content = this.ownerDocument.createElement("div");
  private readonly button = this.ownerDocument.createElement("div");
  private lines: HTMLDivElement[] = [];
  private removeButton?: () => void;
  private _divingLinePositions: Point[] = [];

  private _hidden = false;

  private _noteBlockIds: string[] = [];

  private _noteDisposables: DisposableGroup | null = null;

  get _noteBlock() {
    if (!this.host) return null;
    const noteBlock = this.host.view.getBlock(this._anchorNote?.id ?? "");
    return noteBlock ? (noteBlock as NoteBlockComponent) : null;
  }

  get _zoom() {
    return this.gfx.viewport.zoom;
  }

  get gfx() {
    return this.std.get(GfxControllerIdentifier);
  }

  get selectedRectEle() {
    return this.host.querySelector<EdgelessSelectedRectWidget>(
      "edgeless-selected-rect",
    );
  }

  private _sliceNote() {
    if (!this._anchorNote || !this._noteBlockIds.length) return;
    const doc = this.store;

    const {
      index: originalIndex,
      xywh,
      background,
      displayMode,
    } = this._anchorNote.props;
    const originalNoteIndex = this._anchorNote.parent?.children.findIndex(
      (child) => child === this._anchorNote,
    );
    const { children } = this._anchorNote;
    const {
      collapse: _,
      collapsedHeight: __,
      ...restOfEdgeless
    } = this._anchorNote.props.edgeless;
    const anchorBlockId = this._noteBlockIds[this._activeSlicerIndex];
    if (!anchorBlockId) return;
    const sliceIndex = children.findIndex(
      (block) => block.id === anchorBlockId,
    );
    const resetBlocks = children.slice(sliceIndex + 1);
    const [x, , width] = deserializeXYWH(xywh);
    const sliceVerticalPos =
      this._divingLinePositions[this._activeSlicerIndex].y;
    const newY = this.gfx.viewport.toModelCoord(x, sliceVerticalPos)[1];
    const newNoteId = this.store.addBlock(
      "myoxus:note",
      {
        background,
        displayMode,
        xywh: serializeXYWH(x, newY + NEW_NOTE_GAP, width, DEFAULT_NOTE_HEIGHT),
        index: originalIndex + 1,
        edgeless: restOfEdgeless,
      },
      doc.root?.id,
      originalNoteIndex ? originalNoteIndex + 1 : undefined,
    );

    doc.moveBlocks(resetBlocks, doc.getModelById(newNoteId) as NoteBlockModel);

    this._activeSlicerIndex = 0;
    this.gfx.selection.set({
      elements: [newNoteId],
      editing: false,
    });

    this.std.getOptional(TelemetryProvider)?.track("SplitNote", {
      control: "NoteSlicer",
    });
  }

  private _updateActiveSlicerIndex(pos: Point) {
    const { _divingLinePositions } = this;
    const curY = pos.y + DIVIDING_LINE_OFFSET * this._zoom;
    let index = -1;
    for (let i = 0; i < _divingLinePositions.length; i++) {
      const currentY = _divingLinePositions[i].y;
      const previousY = i > 0 ? _divingLinePositions[i - 1].y : 0;
      const midY = (currentY + previousY) / 2;
      if (curY < midY) {
        break;
      }
      index++;
    }

    if (index < 0) index = 0;
    if (index !== this._activeSlicerIndex) {
      this._activeSlicerIndex = index;
      this.requestUpdate();
    }
  }

  private _updateDivingLineAndBlockIds() {
    if (!this._anchorNote || !this._noteBlock) {
      this._divingLinePositions = [];
      this._noteBlockIds = [];
      return;
    }

    const divingLinePositions: Point[] = [];
    const noteBlockIds: string[] = [];
    const noteRect = this._noteBlock.getBoundingClientRect();
    const noteTop = noteRect.top;
    const noteBottom = noteRect.bottom;

    for (let i = 0; i < this._anchorNote.children.length - 1; i++) {
      const child = this._anchorNote.children[i];
      const rect = this.host.view.getBlock(child.id)?.getBoundingClientRect();

      if (rect && rect.bottom > noteTop && rect.bottom < noteBottom) {
        const x = rect.x - (this.gfx.viewport.left ?? 0);
        const y =
          rect.bottom +
          DIVIDING_LINE_OFFSET * this._zoom -
          (this.gfx.viewport.top ?? 0);
        divingLinePositions.push(new Point(x, y));
        noteBlockIds.push(child.id);
      }
    }

    this._divingLinePositions = divingLinePositions;
    this._noteBlockIds = noteBlockIds;
  }

  private _updateSlicedNote() {
    const { selectedElements } = this.gfx.selection;

    const next =
      !this.gfx.selection.editing &&
      selectedElements.length === 1 &&
      isNoteBlock(selectedElements[0])
        ? selectedElements[0]
        : null;
    if (next === this._anchorNote) return;
    this._anchorNote = next;
    this._noteDisposables?.dispose();
    this._noteDisposables = next ? new DisposableGroup() : null;
    if (next)
      this._noteDisposables?.add(
        next.propsUpdated.subscribe(({ key }) => {
          if (key === "children" || key === "xywh") this.requestUpdate();
        }),
      );
  }

  override connectedCallback(): void {
    super.connectedCallback();

    const { disposables, std, gfx } = this;

    const style = this.ownerDocument.createElement("style");
    style.textContent = styles;
    this.button.className = "note-slicer-button";
    this.content.append(this.button);
    this.append(style, this.content);
    disposables.addFromEvent(this.content, "pointerdown", stopPropagation);
    disposables.addFromEvent(this.content, "pointerup", stopPropagation);
    // Keep the native Facade button's activation separate from Canvas shortcuts.
    const stopActivationKey = (event: KeyboardEvent) => {
      if (isControlledKeyboardEvent(event) || event.shiftKey) return;
      if (event.key === " " || event.key === "Enter") event.stopPropagation();
    };
    disposables.addFromEvent(this.button, "keydown", stopActivationKey);
    disposables.addFromEvent(this.button, "keyup", stopActivationKey);
    disposables.add(this.store.readonly$.subscribe(() => this.requestUpdate()));
    disposables.add(
      this.block.service.uiEventDispatcher.add("wheel", () => {
        this._hidden = true;
        this.requestUpdate();
      }),
    );

    const slots = std.get(EdgelessLegacySlotIdentifier);

    disposables.add(
      slots.elementResizeStart.subscribe(() => {
        this._isResizing = true;
        this.requestUpdate();
      }),
    );

    disposables.add(
      slots.elementResizeEnd.subscribe(() => {
        this._isResizing = false;
        this.requestUpdate();
      }),
    );

    disposables.add(
      std.event.add("pointerMove", (ctx) => {
        if (this._hidden) {
          this._hidden = false;
          this.requestUpdate();
        }

        const state = ctx.get("pointerState");
        const pos = new Point(state.x, state.y);
        this._updateActiveSlicerIndex(pos);
      }),
    );

    disposables.add(
      gfx.viewport.viewportUpdated.subscribe(() => {
        this._hidden = true;
        this.requestUpdate();
      }),
    );

    disposables.add(
      gfx.selection.slots.updated.subscribe(() => {
        this._enableNoteSlicer = false;
        this._updateSlicedNote();
        this.requestUpdate();

        if (this.selectedRectEle) {
          this.selectedRectEle.autoCompleteOff = false;
        }
      }),
    );

    disposables.add(
      slots.toggleNoteSlicer.subscribe(() => {
        this._enableNoteSlicer = !this._enableNoteSlicer;
        this.requestUpdate();

        if (this.selectedRectEle && this._enableNoteSlicer) {
          this.selectedRectEle.autoCompleteOff = true;
        }
      }),
    );
  }

  override disconnectedCallback() {
    this._noteDisposables?.dispose();
    this._noteDisposables = null;
    this._anchorNote = null;
    this.hideSlicer();
    super.disconnectedCallback();
  }

  private hideSlicer() {
    this.removeButton?.();
    this.removeButton = undefined;
    for (const line of this.lines) line.remove();
    this.lines = [];
    this.button.remove();
  }

  protected paint() {
    if (
      this.store.readonly ||
      this._hidden ||
      this._isResizing ||
      !this._anchorNote ||
      !this._enableNoteSlicer
    ) {
      this.hideSlicer();
      return;
    }

    this._updateDivingLineAndBlockIds();
    const note = this._noteBlock;
    if (!note || !this._divingLinePositions.length) {
      this.hideSlicer();
      return;
    }
    const rect = getRectByBlockComponent(note);
    const width = rect.width - 2 * EDGELESS_BLOCK_CHILD_PADDING * this._zoom;
    this._activeSlicerIndex = Math.min(
      this._activeSlicerIndex,
      this._divingLinePositions.length - 1,
    );
    const position = this._divingLinePositions[this._activeSlicerIndex];

    if (!this.button.parentElement) this.content.prepend(this.button);
    if (!this.removeButton) {
      const controls = {
        action: {
          id: "note-slicer-split",
          icon: "ScissorsIcon" as const,
          label: resolveEditorMessage(
            editorMessage("com.myoxus.editor.toolbar.slicer", "Slicer"),
            this.std.getOptional(EditorI18nProvider) ?? undefined,
          ),
          disabled: false,
          run: () => this._sliceNote(),
        },
      };
      const chrome = this.std.get(EditorChromeHostIdentifier);
      this.removeButton = chrome.mountCanvasTool?.(this.button, controls);
      if (!this.removeButton) {
        render(chrome.renderCanvasTool(controls), this.button);
        this.removeButton = () => render(nothing, this.button);
      }
    }
    Object.assign(this.button.style, {
      left: `${position.x - 66 * this._zoom}px`,
      top: `${position.y}px`,
      transform: "translateY(-50%)",
    });

    while (this.lines.length > this._divingLinePositions.length)
      this.lines.pop()?.remove();
    this._divingLinePositions.forEach((point, index) => {
      let line = this.lines[index];
      if (!line) {
        line = this.ownerDocument.createElement("div");
        line.className = "note-slicer-dividing-line-container";
        line.onclick = () => this._sliceNote();
        const rule = this.ownerDocument.createElement("span");
        rule.className = "note-slicer-dividing-line";
        line.append(rule);
        this.content.append(line);
        this.lines.push(line);
      }
      line.classList.toggle("active", index === this._activeSlicerIndex);
      Object.assign(line.style, {
        left: `${point.x}px`,
        top: `${point.y}px`,
        width: `${width}px`,
      });
    });
  }

  private _activeSlicerIndex = 0;
  private _anchorNote: NoteBlockModel | null = null;
  private _enableNoteSlicer = false;
  private _isResizing = false;
}

export const noteSlicerWidget = WidgetViewExtension(
  "myoxus:page",
  NOTE_SLICER_WIDGET,
  NOTE_SLICER_WIDGET,
);
