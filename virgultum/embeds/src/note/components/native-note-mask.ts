// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors

import type { NoteBlockModel } from "@virgultum/core/models";
import type { EditorHost } from "@virgultum/core/runtime";
import { GfxControllerIdentifier } from "@virgultum/core/runtime/gfx";

import { ACTIVE_NOTE_EXTRA_PADDING } from "../note-edgeless-block.styles";
import { frameTitleAtPoint, trackCanvasNoteBounds } from "./edgeless-note-mask";

interface NoteMaskState {
  host: EditorHost;
  model: NoteBlockModel;
  editing: boolean;
  disabled: boolean;
  radius: number;
}

export class EdgelessNoteMask extends HTMLElement {
  private readonly mask = this.ownerDocument.createElement("div");
  private current?: NoteMaskState;
  private stopTracking?: () => void;

  set state(next: NoteMaskState) {
    const previous = this.current;
    this.current = next;
    const extra = next.editing ? ACTIVE_NOTE_EXTRA_PADDING : 0;
    Object.assign(this.mask.style, {
      inset: `${-extra}px`,
      pointerEvents: next.editing || next.disabled ? "none" : "auto",
      borderRadius: `${next.radius}px`,
    });
    if (this.isConnected && previous?.model !== next.model) this.trackBounds();
  }

  connectedCallback() {
    this.mask.className = "myoxus-note-mask";
    Object.assign(this.mask.style, { position: "absolute", zIndex: "1" });
    this.mask.addEventListener("pointerdown", this.selectFrameTitle);
    this.mask.addEventListener("click", this.selectFrameTitle);
    this.append(this.mask);
    this.trackBounds();
  }

  disconnectedCallback() {
    this.stopTracking?.();
    this.stopTracking = undefined;
    this.mask.removeEventListener("pointerdown", this.selectFrameTitle);
    this.mask.removeEventListener("click", this.selectFrameTitle);
  }

  private trackBounds() {
    this.stopTracking?.();
    const model = this.current?.model;
    this.stopTracking = model
      ? trackCanvasNoteBounds(this.mask, model, () => !!this.current?.editing)
      : undefined;
  }

  private readonly selectFrameTitle = (event: MouseEvent) => {
    if (!this.current) return;
    const { host } = this.current;
    const frameId = frameTitleAtPoint(host, event)?.dataset.id;
    if (!frameId) return;

    // The frame title may be under the Note's interaction mask.
    event.preventDefault();
    event.stopImmediatePropagation();
    host.std
      .get(GfxControllerIdentifier)
      .selection.set({ elements: [frameId] });
  };
}

declare global {
  interface HTMLElementTagNameMap {
    "edgeless-note-mask": EdgelessNoteMask;
  }
}
