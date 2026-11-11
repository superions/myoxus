// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors

import type { ResolvedStateInfo } from "@virgultum/components/resource";
import { EditorChromeHostIdentifier } from "@virgultum/shared/services";
import { ShadowlessElement, type BlockStdScope } from "@virgultum/std";
import { css, nothing } from "lit";
import { property } from "lit/decorators.js";

// Image model defaults are renderer geometry, independent of card chrome.
export const SURFACE_IMAGE_CARD_WIDTH = 220;
export const SURFACE_IMAGE_CARD_HEIGHT = 122;
export const NOTE_IMAGE_CARD_WIDTH = 752;
export const NOTE_IMAGE_CARD_HEIGHT = 78;

export class ImageBlockFallbackCard extends ShadowlessElement {
  // Keep the renderer's existing hit area; Mantine owns the visible card inside it.
  static override styles = css`
    myoxus-image-fallback-card {
      display: block;
      width: 100%;
      height: 100%;
    }
  `;
  override render() {
    return (
      this.std.getOptional(EditorChromeHostIdentifier)?.renderImageFallback({
        loading: this.state.loading,
        error: this.state.error,
        description: this.state.description ?? "",
        inSurface: this.inSurface,
      }) ?? nothing
    );
  }
  @property({ attribute: false }) accessor std!: BlockStdScope;
  @property({ attribute: false }) accessor state!: ResolvedStateInfo;
  @property({ attribute: false }) accessor inSurface = false;
}

declare global {
  interface HTMLElementTagNameMap {
    "myoxus-image-fallback-card": ImageBlockFallbackCard;
  }
}
