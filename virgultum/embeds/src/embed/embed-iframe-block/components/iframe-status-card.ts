// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors

import { computed, signal } from "@preact/signals-core";
import { DisposableGroup } from "@virgultum/core/primitives/disposable";
import type { EmbedIframeBlockModel } from "@virgultum/core/models";
import {
  EditorChromeHostIdentifier,
  type EditorIframeStatusCardControls,
} from "@virgultum/core/services";
import {
  installEditorStyles,
  NativeViewElement,
  type BlockStdScope,
} from "@virgultum/core/runtime";
import { openIframeLinkEditor } from "./iframe-link-session";
import { retryIframe } from "./embed-iframe-error-card";

const statusCardStyles = `
  myoxus-embed-iframe-status-card {
    display: block;
    width: 100%;
    height: 100%;
  }
`;

export class IframeStatusCard extends NativeViewElement {
  private disposables = new DisposableGroup();
  private editAbort: AbortController | null = null;

  private readonly _status$ = signal<"idle" | "loading" | "error">("idle");
  private readonly _error$ = signal<Error | null>(null);
  private readonly _inSurface$ = signal(false);
  private readonly _selected$ = signal(false);

  std!: BlockStdScope;
  model!: EmbedIframeBlockModel;
  onRetry!: () => Promise<boolean>;

  get status() {
    return this._status$.value;
  }
  set status(value: "idle" | "loading" | "error") {
    this._status$.value = value;
  }

  get error() {
    return this._error$.value;
  }
  set error(value: Error | null) {
    this._error$.value = value;
  }

  get inSurface() {
    return this._inSurface$.value;
  }
  set inSurface(value: boolean) {
    this._inSurface$.value = value;
  }

  get selected() {
    return this._selected$.value;
  }
  set selected(value: boolean) {
    this._selected$.value = value;
  }

  connectedCallback() {
    this.disposables = new DisposableGroup();
    installEditorStyles(this, statusCardStyles);
    const chrome = this.std?.getOptional(EditorChromeHostIdentifier);
    if (!chrome) return;
    const host = this.ownerDocument.createElement("div");
    host.style.display = "contents";
    this.replaceChildren(host);
    const state = computed<EditorIframeStatusCardControls>(() => ({
      status: this._status$.value,
      message: this._error$.value?.message ?? "",
      inSurface: this._inSurface$.value,
      selected: this._selected$.value,
      readonly: this.model.store.readonly$.value,
      edit: (anchor) => {
        if (this.model.store.readonly) return;
        this.editAbort?.abort();
        this.editAbort = new AbortController();
        openIframeLinkEditor(
          this.std,
          this.model,
          anchor,
          this.editAbort,
          this._inSurface$.peek(),
          true,
        );
      },
      retry: () => retryIframe(this.std, this.onRetry),
    }));
    const unmount = chrome.mountIframeStatusCard(host, state);
    this.disposables.add(() => {
      unmount();
      host.remove();
    });
  }

  disconnectedCallback() {
    this.disposables.dispose();
    this.editAbort?.abort();
  }
}
