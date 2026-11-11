// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors

import { SignalWatcher, WithDisposable } from "@virgultum/global/lit";
import type { EmbedIframeBlockModel } from "@virgultum/model";
import { EditorChromeHostIdentifier } from "@virgultum/shared/services";
import { ShadowlessElement, type BlockStdScope } from "@virgultum/std";
import { css, nothing } from "lit";
import { property } from "lit/decorators.js";
import { openIframeLinkEditor } from "./iframe-link-session";
import { retryIframe } from "./embed-iframe-error-card";

export class IframeStatusCard extends SignalWatcher(
  WithDisposable(ShadowlessElement),
) {
  // The host spans the editor hit area; native cards own their content-sized Page chrome.
  static override styles = css`
    myoxus-embed-iframe-status-card {
      display: block;
      width: 100%;
      height: 100%;
    }
  `;
  private editAbort: AbortController | null = null;
  override disconnectedCallback() {
    super.disconnectedCallback();
    this.editAbort?.abort();
  }
  override render() {
    return (
      this.std.getOptional(EditorChromeHostIdentifier)?.renderIframeStatusCard({
        status: this.status,
        message: this.error?.message ?? "",
        inSurface: this.inSurface,
        selected: this.selected,
        readonly: this.model.store.readonly,
        edit: (anchor) => {
          if (this.model.store.readonly) return;
          this.editAbort?.abort();
          this.editAbort = new AbortController();
          openIframeLinkEditor(
            this.std,
            this.model,
            anchor,
            this.editAbort,
            this.inSurface,
            true,
          );
        },
        retry: () => retryIframe(this.std, this.onRetry),
      }) ?? nothing
    );
  }
  @property({ attribute: false }) accessor std!: BlockStdScope;
  @property({ attribute: false }) accessor model!: EmbedIframeBlockModel;
  @property({ attribute: false }) accessor status:
    "idle" | "loading" | "error" = "idle";
  @property({ attribute: false }) accessor error: Error | null = null;
  @property({ attribute: false }) accessor inSurface = false;
  @property({ attribute: false }) accessor selected = false;
  @property({ attribute: false }) accessor onRetry!: () => Promise<boolean>;
}
