// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors

import { computed, effect, signal, untracked } from "@preact/signals-core";
import { DisposableGroup } from "@virgultum/core/primitives/disposable";
import type { ResolvedStateInfo } from "@virgultum/core/resource";
import { EditorChromeHostIdentifier } from "@virgultum/core/services";
import {
  installEditorStyles,
  NativeViewElement,
  type BlockStdScope,
} from "@virgultum/core/runtime";

// Image model defaults are renderer geometry, independent of card chrome.
export const SURFACE_IMAGE_CARD_WIDTH = 220;
export const SURFACE_IMAGE_CARD_HEIGHT = 122;
export const NOTE_IMAGE_CARD_WIDTH = 752;
export const NOTE_IMAGE_CARD_HEIGHT = 78;

// Keep the renderer's existing hit area; Mantine owns the visible card inside it.
const imageFallbackStyles = `
  myoxus-image-fallback-card {
    display: block;
    width: 100%;
    height: 100%;
  }
`;

export class ImageBlockFallbackCard extends NativeViewElement {
  private readonly _std$ = signal<BlockStdScope | null>(null);
  private readonly _state$ = signal<ResolvedStateInfo | null>(null);
  private readonly _inSurface$ = signal(false);
  private _disposables = new DisposableGroup();

  get std() {
    return this._std$.value!;
  }
  set std(value: BlockStdScope) {
    this._std$.value = value;
  }

  get state() {
    return this._state$.value!;
  }
  set state(value: ResolvedStateInfo) {
    this._state$.value = value;
  }

  get inSurface() {
    return this._inSurface$.value;
  }
  set inSurface(value: boolean) {
    this._inSurface$.value = value;
  }

  connectedCallback() {
    installEditorStyles(this, imageFallbackStyles);
    this._disposables.dispose();
    this._disposables = new DisposableGroup();

    const controls$ = computed(() => {
      const state = this._state$.value;
      if (!state) return null;
      return {
        loading: state.loading,
        error: state.error,
        description: state.description ?? "",
        inSurface: this._inSurface$.value,
      };
    });

    this._disposables.add(
      effect(() => {
        const std = this._std$.value;
        const chrome = std?.getOptional(EditorChromeHostIdentifier);
        if (!chrome) {
          return;
        }
        return untracked(() => {
          const host = this.ownerDocument.createElement("div");
          host.style.display = "contents";
          this.replaceChildren(host);
          const unmount = chrome.mountImageFallback(host, controls$);
          return () => {
            unmount();
            host.remove();
          };
        });
      }),
    );
  }

  disconnectedCallback() {
    this._disposables.dispose();
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "myoxus-image-fallback-card": ImageBlockFallbackCard;
  }
}
