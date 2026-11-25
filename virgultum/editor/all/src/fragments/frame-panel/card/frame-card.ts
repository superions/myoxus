import { computed, signal } from "@preact/signals-core";
import type { FrameBlockModel } from "@virgultum/core/models";
import { DisposableGroup } from "@virgultum/core/primitives/disposable";
import { NativeViewElement } from "@virgultum/core/primitives/env";
import type { BlockStdScope } from "@virgultum/core/runtime";
import {
  type EditorChromeHost,
  EditorChromeHostIdentifier,
  type EditorFrameCardControls,
} from "@virgultum/core/services";
import { on, once } from "@virgultum/core/utils";

import { FrameCardTitle } from "./frame-card-title.js";
import { FramePreview } from "./frame-preview.js";

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
const STYLE_ID = "myoxus-frame-card-styles";
const STYLES = `
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

function ensureStyles(doc: Document) {
  if (!doc.head || doc.getElementById(STYLE_ID)) return;
  const style = doc.createElement("style");
  style.id = STYLE_ID;
  style.textContent = STYLES;
  doc.head.append(style);
}

export const MYOXUS_FRAME_CARD = "myoxus-frame-card";

export class FrameCard extends NativeViewElement {
  disposables = new DisposableGroup();

  private readonly _revision$ = signal(0);

  private _std!: BlockStdScope;
  private _cardIndex!: number;
  private _draggingCardNumber: number | undefined = undefined;
  private _frame!: FrameBlockModel;
  private _frameIndex!: string;
  private _pos!: { x: number; y: number };
  private _stackOrder!: number;
  private _status: "selected" | "dragging" | "placeholder" | "none" = "none";
  private _width: number | undefined = undefined;

  private readonly _title = new FrameCardTitle();
  private readonly _preview = new FramePreview();

  containerElement!: HTMLElement;
  private _chromeUnmount: (() => void) | null = null;
  private _mountedChrome: EditorChromeHost | null = null;

  get std(): BlockStdScope {
    return this._std;
  }
  set std(value: BlockStdScope) {
    const changed = this._std !== value;
    this._std = value;
    this._syncChildren();
    if (changed && this.isConnected) {
      this._bindStd();
    }
    this._bump();
  }

  get cardIndex(): number {
    return this._cardIndex;
  }
  set cardIndex(value: number) {
    this._cardIndex = value;
    this._syncChildren();
    this._bump();
  }

  get draggingCardNumber(): number | undefined {
    return this._draggingCardNumber;
  }
  set draggingCardNumber(value: number | undefined) {
    this._draggingCardNumber = value;
    this._bump();
  }

  get frame(): FrameBlockModel {
    return this._frame;
  }
  set frame(value: FrameBlockModel) {
    this._frame = value;
    this._syncChildren();
    this._bump();
  }

  get frameIndex(): string {
    return this._frameIndex;
  }
  set frameIndex(value: string) {
    this._frameIndex = value;
    this._bump();
  }

  get pos(): { x: number; y: number } {
    return this._pos;
  }
  set pos(value: { x: number; y: number }) {
    this._pos = value;
    this._syncContainerStyle();
  }

  get stackOrder(): number {
    return this._stackOrder;
  }
  set stackOrder(value: number) {
    this._stackOrder = value;
    this._syncContainerStyle();
    this._bump();
  }

  get status(): "selected" | "dragging" | "placeholder" | "none" {
    return this._status;
  }
  set status(value: "selected" | "dragging" | "placeholder" | "none") {
    this._status = value;
    this._syncContainerStyle();
    this._bump();
  }

  get width(): number | undefined {
    return this._width;
  }
  set width(value: number | undefined) {
    this._width = value;
    this._syncContainerStyle();
  }

  private _bump() {
    this._revision$.value = this._revision$.peek() + 1;
  }

  private _syncChildren() {
    // React keeps stable DOM refs during selection and reorder updates.
    this._title.frame = this._frame;
    this._title.cardIndex = this._cardIndex;
    this._title.std = this._std;
    this._preview.frame = this._frame;
    this._preview.std = this._std;
  }

  private _syncContainerStyle() {
    if (!this.containerElement) return;
    this.containerElement.className = `frame-card-container ${this._status}`;
    if (this._status === "dragging" && this._pos) {
      this.containerElement.style.transform =
        this._stackOrder === 0
          ? `translate(${this._pos.x - 16}px, ${this._pos.y - 8}px)`
          : `translate(${this._pos.x - 10}px, ${this._pos.y - 16}px) scale(0.96)`;
      this.containerElement.style.width = this._width ? `${this._width}px` : "";
    } else {
      this.containerElement.style.transform = "";
      this.containerElement.style.width = "";
    }
  }

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

  private readonly _controls$ = computed<EditorFrameCardControls | null>(() => {
    void this._revision$.value;
    if (!this._std || !this._frame) return null;
    return {
      selected: this._status === "selected",
      mountTitle: this._mountTitle,
      mountPreview: this._mountPreview,
      select: (event) => this._dispatchSelectEvent(event),
      fit: (event) => this._dispatchFitViewEvent(event),
      drag: (event) => this._dispatchDragEvent(event),
      count: this._draggingCardNumber,
    };
  });

  private _bindStd() {
    if (!this._std || !this.containerElement) return;
    const chrome = this._std.getOptional(EditorChromeHostIdentifier) ?? null;
    if (this._mountedChrome !== chrome) {
      this._chromeUnmount?.();
      this._chromeUnmount = null;
      this._mountedChrome = chrome;
      if (chrome) {
        this._chromeUnmount = chrome.mountFrameCard(
          this.containerElement,
          this._controls$,
        );
      }
    }
  }

  connectedCallback() {
    if (this.disposables.disposed) {
      this.disposables = new DisposableGroup();
    }
    ensureStyles(this.ownerDocument);
    if (!this.containerElement) {
      this.containerElement = this.ownerDocument.createElement("div");
      this.replaceChildren(this.containerElement);
    }
    this._syncContainerStyle();
    this._syncChildren();
    this._bindStd();
    this._bump();
  }

  disconnectedCallback() {
    this._chromeUnmount?.();
    this._chromeUnmount = null;
    this._mountedChrome = null;
    this.disposables.dispose();
  }
}

declare global {
  interface HTMLElementTagNameMap {
    [MYOXUS_FRAME_CARD]: FrameCard;
  }
}
