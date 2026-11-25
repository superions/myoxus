import { computed, signal } from "@preact/signals-core";
import type { FrameBlockModel } from "@virgultum/core/models";
import { DisposableGroup } from "@virgultum/core/primitives/disposable";
import { NativeViewElement } from "@virgultum/core/primitives/env";
import type { BlockStdScope } from "@virgultum/core/runtime";
import {
  type EditorChromeHost,
  EditorChromeHostIdentifier,
  type EditorFrameTitleControls,
} from "@virgultum/core/services";
import type * as Y from "yjs";

import { FrameCardTitleEditor } from "./frame-card-title-editor.js";

export const MYOXUS_FRAME_CARD_TITLE = "myoxus-frame-card-title";

export class FrameCardTitle extends NativeViewElement {
  disposables = new DisposableGroup();

  private readonly _revision$ = signal(0);

  private _cardIndex!: number;
  private _frame!: FrameBlockModel;
  private _std!: BlockStdScope;

  private _mountHost: HTMLDivElement | null = null;
  private _chromeUnmount: (() => void) | null = null;
  private _mountedChrome: EditorChromeHost | null = null;
  private _titleDisposables: DisposableGroup | null = null;

  private titleContainer!: HTMLElement;
  private titleContentElement!: HTMLElement;

  get cardIndex(): number {
    return this._cardIndex;
  }
  set cardIndex(value: number) {
    this._cardIndex = value;
    this._bump();
  }

  get frame(): FrameBlockModel {
    return this._frame;
  }
  set frame(value: FrameBlockModel) {
    const changed = this._frame !== value;
    this._frame = value;
    if (changed && this.isConnected && value) {
      this._setFrameDisposables(value.props.title.yText);
    }
    this._bump();
  }

  get std(): BlockStdScope {
    return this._std;
  }
  set std(value: BlockStdScope) {
    const changed = this._std !== value;
    this._std = value;
    if (changed && this.isConnected) {
      this._bindStd();
    }
    this._bump();
  }

  private _bump() {
    this._revision$.value = this._revision$.peek() + 1;
  }

  private readonly _clearTitleDisposables = () => {
    this._titleDisposables?.dispose();
    this._titleDisposables = null;
  };

  private readonly _mountTitleEditor = (e: MouseEvent) => {
    e.stopPropagation();

    const titleEditor = new FrameCardTitleEditor();
    titleEditor.frameModel = this.frame;
    titleEditor.titleContentElement = this.titleContentElement;
    const left = this.titleContentElement.offsetLeft;
    titleEditor.left = left;
    titleEditor.maxWidth = this.titleContainer.offsetWidth - left;
    this.titleContainer.append(titleEditor);
  };

  private readonly _updateElement = () => {
    this._bump();
  };

  private _setFrameDisposables(title: Y.Text) {
    this._clearTitleDisposables();
    title.observe(this._updateElement);
    this._titleDisposables = new DisposableGroup();
    this._titleDisposables.add({
      dispose: () => {
        title.unobserve(this._updateElement);
      },
    });
  }

  private readonly _controls$ = computed<EditorFrameTitleControls | null>(
    () => {
      void this._revision$.value;
      if (!this._std || !this._frame) return null;
      return {
        index: this._cardIndex,
        title: this._frame.props.title.toString(),
        setContainer: (element) => {
          if (element) this.titleContainer = element;
        },
        setTitle: (element) => {
          if (element) this.titleContentElement = element;
        },
        edit: this._mountTitleEditor,
      };
    },
  );

  private _bindStd() {
    if (!this._std || !this._mountHost) return;
    const chrome = this._std.getOptional(EditorChromeHostIdentifier) ?? null;
    if (this._mountedChrome !== chrome) {
      this._chromeUnmount?.();
      this._chromeUnmount = null;
      this._mountedChrome = chrome;
      if (chrome) {
        this._chromeUnmount = chrome.mountFrameTitle(
          this._mountHost,
          this._controls$,
        );
      }
    }
  }

  connectedCallback() {
    if (this.disposables.disposed) {
      this.disposables = new DisposableGroup();
    }
    if (!this._mountHost) {
      this._mountHost = this.ownerDocument.createElement("div");
      this._mountHost.style.display = "contents";
      this.replaceChildren(this._mountHost);
    }
    if (this._frame) {
      this._setFrameDisposables(this._frame.props.title.yText);
    }
    this._bindStd();
    this._bump();
  }

  disconnectedCallback() {
    this._chromeUnmount?.();
    this._chromeUnmount = null;
    this._mountedChrome = null;
    this._clearTitleDisposables();
    this.disposables.dispose();
  }
}

declare global {
  interface HTMLElementTagNameMap {
    [MYOXUS_FRAME_CARD_TITLE]: FrameCardTitle;
  }
}
