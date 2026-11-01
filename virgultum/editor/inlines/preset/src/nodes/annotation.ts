// SPDX-License-Identifier: AGPL-3.0-or-later
import { AnnotationReactHostIdentifier } from "@virgultum/block-annotation";
import { getAnnotationRanges } from "@virgultum/model";
import type { MyoxusTextAttributes } from "@virgultum/shared/types";
import { ShadowlessElement, type BlockStdScope } from "@virgultum/std";
import { SignalWatcher } from "@virgultum/global/lit";
import type { InlineEditor } from "@virgultum/std/inline";
import type { DeltaInsert } from "@virgultum/store";
import { html, nothing } from "lit";
import { property } from "lit/decorators.js";

/** A projection of the current attributed text, never a second persisted body. */
export class InlineAnnotation extends SignalWatcher(ShadowlessElement) {
  @property({ attribute: false })
  accessor delta!: DeltaInsert<MyoxusTextAttributes>;
  @property({ attribute: false })
  accessor editor!: InlineEditor<MyoxusTextAttributes>;
  @property({ attribute: false }) accessor std!: BlockStdScope;
  @property({ attribute: false }) accessor startOffset = 0;

  private current() {
    // Resolve on every action: Yjs edits can move or remove a range while a draft is open.
    const ownerId =
      this.closest("[data-block-id]")?.getAttribute("data-block-id");
    if (!ownerId || !this.std.store.getModelById(ownerId)) return undefined;
    return getAnnotationRanges(this.editor.yText.toDelta()).find(
      (range) =>
        range.id === this.delta.attributes?.annotation?.id &&
        range.index === this.startOffset,
    );
  }

  override render() {
    const host = this.std.getOptional(AnnotationReactHostIdentifier);
    const range = this.current();
    const readonly = this.std.store.readonly$.value;
    const shown = !!host?.showAnnotations;
    return html`<span hidden aria-hidden="true"
        ><v-text .str=${this.delta.insert}></v-text></span
      >${
        shown && range && host?.renderInline
          ? host.renderInline({
              id: range.id,
              body: range.body,
              readonly,
              apply: (body, expectedBody) => {
                const current = this.current();
                if (
                  this.std.store.readonly ||
                  !this.isConnected ||
                  !current ||
                  current.body !== expectedBody
                )
                  return false;
                if (body === expectedBody) return true;
                this.std.store.captureSync();
                this.editor.transact(() => {
                  this.editor.yText.delete(current.index, current.length);
                  if (body)
                    this.editor.yText.insert(current.index, body, {
                      annotation: { id: current.id },
                    });
                });
                this.std.store.captureSync();
                if (!body) this.editor.focusIndex(current.index);
                return true;
              },
              remove: (expectedBody) => {
                const current = this.current();
                if (
                  this.std.store.readonly ||
                  !this.isConnected ||
                  !current ||
                  current.body !== expectedBody
                )
                  return false;
                this.std.store.captureSync();
                this.editor.deleteText({
                  index: current.index,
                  length: current.length,
                });
                this.std.store.captureSync();
                this.editor.focusIndex(current.index);
                return true;
              },
              focusEditor: (side) => {
                const current = this.current();
                if (current)
                  this.editor.focusIndex(
                    current.index + (side === "after" ? current.length : 0),
                  );
              },
            })
          : nothing
      }`;
  }
}
declare global {
  interface HTMLElementTagNameMap {
    "myoxus-inline-annotation": InlineAnnotation;
  }
}
