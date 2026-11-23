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
  type RootBlockModel,
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
import { WidgetComponent, WidgetViewExtension } from "@virgultum/core/runtime";
import { GfxControllerIdentifier } from "@virgultum/core/runtime/gfx";
import type { EdgelessSelectedRectWidget } from "../edgeless-selected-rect/native-selection-overlay";
import {
  css,
  html,
  nothing,
  render,
  type PropertyValues,
  type TemplateResult,
} from "lit";
import { state } from "lit/decorators.js";
import { classMap } from "lit/directives/class-map.js";
import { styleMap } from "lit/directives/style-map.js";
import { literal, unsafeStatic } from "lit/static-html.js";

const DIVIDING_LINE_OFFSET = 4;
const NEW_NOTE_GAP = 40;

const styles = css`
  :host {
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

export class NoteSlicer extends WidgetComponent<RootBlockModel> {
  static override styles = styles;

  private _button: TemplateResult | typeof nothing = nothing;

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
    this._activeSlicerIndex = index;
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

    if (
      !this.gfx.selection.editing &&
      selectedElements.length === 1 &&
      isNoteBlock(selectedElements[0])
    ) {
      this._anchorNote = selectedElements[0];
    } else {
      this._anchorNote = null;
    }
  }

  override connectedCallback(): void {
    super.connectedCallback();

    const { disposables, std, gfx } = this;

    this._updateDivingLineAndBlockIds();

    const slots = std.get(EdgelessLegacySlotIdentifier);

    disposables.add(
      slots.elementResizeStart.subscribe(() => {
        this._isResizing = true;
      }),
    );

    disposables.add(
      slots.elementResizeEnd.subscribe(() => {
        this._isResizing = false;
      }),
    );

    disposables.add(
      std.event.add("pointerMove", (ctx) => {
        if (this._hidden) this._hidden = false;

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

        if (this.selectedRectEle) {
          this.selectedRectEle.autoCompleteOff = false;
        }
      }),
    );

    disposables.add(
      slots.toggleNoteSlicer.subscribe(() => {
        this._enableNoteSlicer = !this._enableNoteSlicer;

        if (this.selectedRectEle && this._enableNoteSlicer) {
          this.selectedRectEle.autoCompleteOff = true;
        }
      }),
    );
  }

  override disconnectedCallback(): void {
    super.disconnectedCallback();
    this.disposables.dispose();
    this._noteDisposables?.dispose();
    this._noteDisposables = null;
    render(nothing, this);
  }

  override firstUpdated() {
    if (!this.block?.service) return;
    this.disposables.add(
      this.block.service.uiEventDispatcher.add("wheel", () => {
        this._hidden = true;
        this.requestUpdate();
      }),
    );
  }

  override render() {
    this._button = nothing;
    if (
      this.store.readonly ||
      this._hidden ||
      this._isResizing ||
      !this._anchorNote ||
      !this._enableNoteSlicer
    ) {
      return nothing;
    }

    this._updateDivingLineAndBlockIds();

    const noteBlock = this._noteBlock;
    if (!noteBlock || !this._divingLinePositions.length) return nothing;

    const rect = getRectByBlockComponent(noteBlock);
    const width = rect.width - 2 * EDGELESS_BLOCK_CHILD_PADDING * this._zoom;
    const buttonPosition = this._divingLinePositions[this._activeSlicerIndex];

    this._button = this.std.get(EditorChromeHostIdentifier).renderCanvasTool({
      action: {
        id: "note-slicer-split",
        icon: "ScissorsIcon",
        label: resolveEditorMessage(
          editorMessage("com.myoxus.editor.toolbar.slicer", "Slicer"),
          this.std.getOptional(EditorI18nProvider) ?? undefined,
        ),
        disabled: false,
        run: () => this._sliceNote(),
      },
    });

    // Native pointer and activation-key defaults must run before Canvas dispatch.
    const stopActivationKey = (event: KeyboardEvent) => {
      if (isControlledKeyboardEvent(event) || event.shiftKey) return;
      if (event.key === " " || event.key === "Enter") event.stopPropagation();
    };
    return html`<div
      @pointerdown=${stopPropagation}
      @pointerup=${stopPropagation}
    >
      <div
        class="note-slicer-button"
        @keydown=${stopActivationKey}
        @keyup=${stopActivationKey}
        style=${styleMap({
          left: `${buttonPosition.x - 66 * this._zoom}px`,
          top: `${buttonPosition.y}px`,
          transform: "translateY(-50%)",
        })}
      >
        <slot></slot>
      </div>
      ${this._divingLinePositions.map((pos, idx) => {
        const dividingLineClasses = classMap({
          "note-slicer-dividing-line-container": true,
          active: idx === this._activeSlicerIndex,
        });
        return html`<div
          class=${dividingLineClasses}
          @click=${this._sliceNote}
          style=${styleMap({
            left: `${pos.x}px`,
            top: `${pos.y}px`,
            width: `${width}px`,
          })}
        >
          <span class="note-slicer-dividing-line"></span>
        </div>`;
      })}
    </div> `;
  }

  protected override updated(_changedProperties: PropertyValues) {
    super.updated(_changedProperties);
    // Slot the control into the shadow anchor so shared Mantine CSS can reach it.
    render(this._button, this);
    if (_changedProperties.has("anchorNote")) {
      this._noteDisposables?.dispose();
      this._noteDisposables = null;
      if (this._anchorNote) {
        this._noteDisposables = new DisposableGroup();
        this._noteDisposables.add(
          this._anchorNote.propsUpdated.subscribe(({ key }) => {
            if (key === "children" || key === "xywh") {
              this.requestUpdate();
            }
          }),
        );
      }
    }
  }

  @state()
  private accessor _activeSlicerIndex = 0;

  @state()
  private accessor _anchorNote: NoteBlockModel | null = null;

  @state()
  private accessor _enableNoteSlicer = false;

  @state()
  private accessor _isResizing = false;
}

export const noteSlicerWidget = WidgetViewExtension(
  "myoxus:page",
  NOTE_SLICER_WIDGET,
  literal`${unsafeStatic(NOTE_SLICER_WIDGET)}`,
);
