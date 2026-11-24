// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  AnnotationReactHostIdentifier,
  type AnnotationInlineHostProps,
} from "../../../blocks/annotation/react-host";
import { getAnnotationRanges } from "@virgultum/core/models";
import { computed } from "@preact/signals-core";
import { InlineObject } from "./inline-object";

/** Actions resolve the canonical Yjs annotation at its current offset. */
export class InlineAnnotation extends InlineObject {
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

  protected mountObject(anchor: HTMLElement) {
    const host = this.std.getOptional(AnnotationReactHostIdentifier);
    if (host?.showAnnotations && host.mountInline) {
      const props = computed<AnnotationInlineHostProps | undefined>(() => {
        const range = this.current();
        if (!range) return undefined;
        return {
          id: range.id,
          body: range.body,
          readonly: this.std.store.readonly,
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
        };
      });
      return host.mountInline(anchor, props);
    }
    return undefined;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "myoxus-inline-annotation": InlineAnnotation;
  }
}
