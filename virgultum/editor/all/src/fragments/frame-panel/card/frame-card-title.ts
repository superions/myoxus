import { DisposableGroup } from "@virgultum/core/primitives/disposable";
import { WithDisposable } from "@virgultum/core/primitives/lit";
import type { FrameBlockModel } from "@virgultum/core/models";
import { EditorChromeHostIdentifier } from "@virgultum/core/services";
import { type BlockStdScope, ShadowlessElement } from "@virgultum/core/runtime";
import { nothing, type PropertyValues } from "lit";
import { property } from "lit/decorators.js";
import type * as Y from "yjs";

import { FrameCardTitleEditor } from "./frame-card-title-editor.js";

export const MYOXUS_FRAME_CARD_TITLE = "myoxus-frame-card-title";

export class FrameCardTitle extends WithDisposable(ShadowlessElement) {
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

  private _titleDisposables: DisposableGroup | null = null;

  private readonly _updateElement = () => {
    this.requestUpdate();
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

  override connectedCallback() {
    super.connectedCallback();
  }

  override disconnectedCallback() {
    super.disconnectedCallback();
    this._clearTitleDisposables();
  }

  override render() {
    return (
      this.std.getOptional(EditorChromeHostIdentifier)?.renderFrameTitle({
        index: this.cardIndex,
        title: this.frame.props.title.toString(),
        setContainer: (element) => {
          if (element) this.titleContainer = element;
        },
        setTitle: (element) => {
          if (element) this.titleContentElement = element;
        },
        edit: this._mountTitleEditor,
      }) ?? nothing
    );
  }

  override updated(_changedProperties: PropertyValues) {
    if (_changedProperties.has("frame")) {
      this._setFrameDisposables(this.frame.props.title.yText);
    }
  }

  @property({ attribute: false })
  accessor cardIndex!: number;

  @property({ attribute: false })
  accessor frame!: FrameBlockModel;

  @property({ attribute: false })
  accessor std!: BlockStdScope;

  private titleContainer!: HTMLElement;
  private titleContentElement!: HTMLElement;
}

declare global {
  interface HTMLElementTagNameMap {
    [MYOXUS_FRAME_CARD_TITLE]: FrameCardTitle;
  }
}
