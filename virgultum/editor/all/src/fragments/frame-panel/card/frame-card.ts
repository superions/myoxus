import { WithDisposable } from "@virgultum/core/primitives/lit";
import type { FrameBlockModel } from "@virgultum/core/models";
import { EditorChromeHostIdentifier } from "@virgultum/core/services";
import { FrameCardTitle } from "./frame-card-title.js";
import { FramePreview } from "./frame-preview.js";
import { on, once } from "@virgultum/core/utils";
import { type BlockStdScope, ShadowlessElement } from "@virgultum/core/runtime";
import { css, html, nothing } from "lit";
import { property, query } from "lit/decorators.js";
import { styleMap } from "lit/directives/style-map.js";

export type ReorderEvent = CustomEvent<{
  currentNumber: number;
  targetNumber: number;
  realIndex: number;
}>;

export type SelectEvent = CustomEvent<{
  id: string;
  selected: boolean;
  index: number;
  multiselect: boolean;
}>;

export type DragEvent = CustomEvent<{
  clientX: number;
  clientY: number;
  pageX: number;
  pageY: number;
}>;

export type FitViewEvent = CustomEvent<{
  block: FrameBlockModel;
}>;

// Pointer ghosts use viewport coordinates; native cards own all normal chrome.
const styles = css`
  myoxus-frame-card {
    display: block;
  }
  .frame-card-container {
    position: relative;
  }
  .frame-card-container.dragging {
    pointer-events: none;
    transform-origin: 16px 8px;
    position: fixed;
    top: 0;
    left: 0;
    z-index: calc(var(--myoxus-z-index-popover, 0) + 3);
  }
  .frame-card-container.placeholder {
    opacity: 0.5;
  }
`;

export const MYOXUS_FRAME_CARD = "myoxus-frame-card";

export class FrameCard extends WithDisposable(ShadowlessElement) {
  static override styles = styles;

  private _dispatchDragEvent(e: MouseEvent) {
    e.preventDefault();
    if (e.button !== 0) return;

    const { clientX: startX, clientY: startY } = e;
    const disposeDragStart = on(this.ownerDocument, "mousemove", (e) => {
      if (
        Math.abs(startX - e.clientX) < 5 &&
        Math.abs(startY - e.clientY) < 5
      ) {
        return;
      }
      if (this.status !== "selected") {
        this._dispatchSelectEvent(e);
      }

      const event = new CustomEvent("drag", {
        detail: {
          clientX: e.clientX,
          clientY: e.clientY,
          pageX: e.pageX,
          pageY: e.pageY,
        },
      });

      this.dispatchEvent(event);
      disposeDragStart();
    });

    once(this.ownerDocument, "mouseup", () => {
      disposeDragStart();
    });
  }

  private _dispatchFitViewEvent(e: MouseEvent) {
    e.stopPropagation();

    const event = new CustomEvent("fitview", {
      detail: {
        block: this.frame,
      },
    });

    this.dispatchEvent(event);
  }

  private _dispatchSelectEvent(e: MouseEvent) {
    e.stopPropagation();
    const event = new CustomEvent("select", {
      detail: {
        id: this.frame.id,
        selected: this.status !== "selected",
        index: this.cardIndex,
        multiselect: e.shiftKey,
      },
    }) as SelectEvent;

    this.dispatchEvent(event);
  }

  private readonly _title = new FrameCardTitle();
  private readonly _preview = new FramePreview();

  private readonly _mountTitle = (element: HTMLDivElement | null) => {
    if (!element || this.status === "dragging") return;
    this._title.frame = this.frame;
    this._title.cardIndex = this.cardIndex;
    this._title.std = this.std;
    if (this._title.parentElement !== element) element.append(this._title);
  };

  private readonly _mountPreview = (element: HTMLDivElement | null) => {
    if (!element || (this.status === "dragging" && this.stackOrder !== 0))
      return;
    this._preview.frame = this.frame;
    this._preview.std = this.std;
    if (this._preview.parentElement !== element) element.append(this._preview);
  };

  override updated() {
    // React keeps stable DOM refs during selection and reorder updates.
    this._title.frame = this.frame;
    this._title.cardIndex = this.cardIndex;
    this._title.std = this.std;
    this._preview.frame = this.frame;
    this._preview.std = this.std;
  }

  override render() {
    const host = this.std.getOptional(EditorChromeHostIdentifier);
    if (!host) return nothing;
    const { pos, stackOrder, width } = this;
    const geometry = styleMap(
      this.status === "dragging"
        ? {
            transform:
              stackOrder === 0
                ? `translate(${pos.x - 16}px, ${pos.y - 8}px)`
                : `translate(${pos.x - 10}px, ${pos.y - 16}px) scale(0.96)`,
            width: width ? `${width}px` : undefined,
          }
        : {},
    );
    return html`<div
      class="frame-card-container ${this.status}"
      style=${geometry}
    >
      ${host.renderFrameCard({
        selected: this.status === "selected",
        mountTitle: this._mountTitle,
        mountPreview: this._mountPreview,
        select: (event) => this._dispatchSelectEvent(event),
        fit: (event) => this._dispatchFitViewEvent(event),
        drag: (event) => this._dispatchDragEvent(event),
        count: this.draggingCardNumber,
      })}
    </div>`;
  }

  @property({ attribute: false })
  accessor std!: BlockStdScope;

  @property({ attribute: false })
  accessor cardIndex!: number;

  @query(".frame-card-container")
  accessor containerElement!: HTMLElement;

  @property({ attribute: false })
  accessor draggingCardNumber: number | undefined = undefined;

  @property({ attribute: false })
  accessor frame!: FrameBlockModel;

  @property({ attribute: false })
  accessor frameIndex!: string;

  @property({ attribute: false })
  accessor pos!: { x: number; y: number };

  @property({ attribute: false })
  accessor stackOrder!: number;

  @property({ attribute: false })
  accessor status: "selected" | "dragging" | "placeholder" | "none" = "none";

  @property({ attribute: false })
  accessor width: number | undefined = undefined;
}

declare global {
  interface HTMLElementTagNameMap {
    [MYOXUS_FRAME_CARD]: FrameCard;
  }
}
