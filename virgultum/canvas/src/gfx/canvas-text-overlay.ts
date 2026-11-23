// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors

import type { RichText } from "@virgultum/content/rich-text";
import { DisposableGroup } from "@virgultum/core/primitives/disposable";
import type { BlockStdScope } from "@virgultum/core/runtime";
import { RANGE_SYNC_EXCLUDE_ATTR } from "@virgultum/core/runtime/inline";

/** Canvas owns the mount and geometry. The rich-text input stays mounted across repaints. */
export abstract class CanvasTextOverlay extends HTMLElement {
  std!: BlockStdScope;
  richText!: RichText;
  protected disposables = new DisposableGroup();
  private paint?: Promise<void>;

  get updateComplete() {
    return (this.paint ?? Promise.resolve()).then(() =>
      this.richText?.isConnected ? this.richText.updateComplete : true,
    );
  }

  connectedCallback() {
    this.disposables = new DisposableGroup();
    this.setAttribute(RANGE_SYNC_EXCLUDE_ATTR, "true");
    this.richText = this.ownerDocument.createElement("rich-text") as RichText;
    this.richText.enableFormat = false;
    this.mountOverlay();
    if (!this.isConnected) return;
    this.paintOverlay();
    this.beginEditing();
  }

  disconnectedCallback() {
    this.disposables.dispose();
    this.paint = undefined;
    this.replaceChildren();
  }

  protected requestUpdate() {
    if (!this.isConnected || this.paint) return;
    const lifetime = this.disposables;
    this.paint = Promise.resolve().then(() => {
      if (this.disposables !== lifetime || !this.isConnected) return;
      this.paint = undefined;
      this.paintOverlay();
    });
  }

  protected overlayStyle(css: string) {
    const style = this.ownerDocument.createElement("style");
    style.textContent = css;
    return style;
  }

  protected abstract mountOverlay(): void;
  protected abstract paintOverlay(): void;
  protected abstract beginEditing(): void;
}

/** Empty editors reserve label space while their editable node keeps focus. */
export function updateOverlayPlaceholder(
  input: RichText,
  placeholder: HTMLSpanElement,
  empty: boolean,
  padding: string,
) {
  Object.assign(input.style, {
    position: empty ? "absolute" : "",
    left: empty ? "0" : "",
    top: empty ? "0" : "",
    padding: empty ? padding : "",
  });
  if (empty) input.after(placeholder);
  else placeholder.remove();
}
