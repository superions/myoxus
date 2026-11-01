import { almostEqual, Bound } from "@virgultum/global/gfx";
import { SignalWatcher, WithDisposable } from "@virgultum/global/lit";
import type { NoteBlockModel } from "@virgultum/model";
import { type EditorHost, ShadowlessElement } from "@virgultum/std";
import { GfxControllerIdentifier } from "@virgultum/std/gfx";
import { html } from "lit";
import { property } from "lit/decorators.js";
import { styleMap } from "lit/directives/style-map.js";

import { ACTIVE_NOTE_EXTRA_PADDING } from "../note-edgeless-block.styles";

export class EdgelessNoteMask extends SignalWatcher(
  WithDisposable(ShadowlessElement),
) {
  private _findFrameTitleAtPoint(event: MouseEvent) {
    const titleAtPoint = (
      title: HTMLElement | null | undefined,
    ): HTMLElement | null => {
      if (!title) return null;
      const rect = title.getBoundingClientRect();
      const containsPoint =
        event.clientX >= rect.left &&
        event.clientX <= rect.right &&
        event.clientY >= rect.top &&
        event.clientY <= rect.bottom;
      return containsPoint ? title : null;
    };

    for (const element of document.querySelectorAll<HTMLElement>(
      "myoxus-frame-title",
    )) {
      const title = titleAtPoint(element);
      if (title) return title;
    }

    for (const widget of document.querySelectorAll<HTMLElement>(
      "myoxus-frame-title-widget",
    )) {
      const title =
        titleAtPoint(
          widget.shadowRoot?.querySelector<HTMLElement>("myoxus-frame-title"),
        ) ?? titleAtPoint(widget);
      if (title) return title;
    }

    return null;
  }

  private _selectCoveredFrameTitle(event: MouseEvent) {
    const frameId = this._findFrameTitleAtPoint(event)?.dataset.id;
    if (!frameId) return false;

    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();
    this.host.std.get(GfxControllerIdentifier).selection.set({
      elements: [frameId],
    });
    return true;
  }

  protected override firstUpdated() {
    const maskDOM = this.renderRoot!.querySelector(".myoxus-note-mask");
    let frame = 0;
    let measuredHeight = 0;
    const updateHeight = () => {
      frame = 0;
      if (
        !this.isConnected ||
        this.model.store.readonly ||
        this.model.props.edgeless.collapse
      )
        return;
      const bound = Bound.deserialize(this.model.xywh);
      const scale = this.model.props.edgeless.scale ?? 1;
      const height = measuredHeight * scale;
      if (!height || almostEqual(bound.h, height)) return;
      // GFX hit testing uses model bounds, not the rendered Note height.
      // Keep both aligned before serializing so lower content stays editable.
      bound.h = height;
      this.model.stash("xywh");
      this.model.xywh = bound.serialize();
      this.model.pop("xywh");
    };
    const observer = new ResizeObserver((entries) => {
      const entry = entries.at(-1);
      if (!entry) return;
      // The mask grows around an editing note. Its interaction-only padding
      // must not enter persisted geometry or focus/mode changes resize content.
      const extra = this.editing ? 2 * ACTIVE_NOTE_EXTRA_PADDING : 0;
      measuredHeight = Math.max(0, entry.contentRect.height - extra);
      // Updating the observed Note's geometry during delivery feeds its own
      // ancestor layout back into ResizeObserver. Coalesce the latest measure
      // into the next frame and recheck live readonly/collapse state there.
      if (!frame) frame = requestAnimationFrame(updateHeight);
    });

    observer.observe(maskDOM!);

    this._disposables.add(() => {
      observer.disconnect();
      cancelAnimationFrame(frame);
    });
  }

  override render() {
    const extra = this.editing ? ACTIVE_NOTE_EXTRA_PADDING : 0;
    return html`
      <div
        class="myoxus-note-mask"
        @pointerdown=${this._selectCoveredFrameTitle}
        @click=${this._selectCoveredFrameTitle}
        style=${styleMap({
          position: "absolute",
          top: `${-extra}px`,
          left: `${-extra}px`,
          bottom: `${-extra}px`,
          right: `${-extra}px`,
          zIndex: "1",
          pointerEvents: this.editing || this.disableMask ? "none" : "auto",
          borderRadius: `${
            this.model.props.edgeless.style.borderRadius * this.zoom
          }px`,
        })}
      ></div>
    `;
  }

  @property({ attribute: false })
  accessor disableMask!: boolean;

  @property({ attribute: false })
  accessor editing!: boolean;

  @property({ attribute: false })
  accessor host!: EditorHost;

  @property({ attribute: false })
  accessor model!: NoteBlockModel;

  @property({ attribute: false })
  accessor zoom!: number;
}

declare global {
  interface HTMLElementTagNameMap {
    "edgeless-note-mask": EdgelessNoteMask;
  }
}
