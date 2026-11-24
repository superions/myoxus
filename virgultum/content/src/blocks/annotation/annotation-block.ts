// SPDX-License-Identifier: AGPL-3.0-or-later
import { computed, effect, signal } from "@preact/signals-core";
import { NativeContainerBlock } from "@virgultum/core/runtime";
import type { AnnotationBlockModel } from "@virgultum/core/models";
import { selectionFrame } from "../../caption/selection-frame";
import {
  AnnotationReactHostIdentifier,
  type AnnotationBlockHostProps,
} from "./react-host";

export class AnnotationBlockComponent extends NativeContainerBlock<AnnotationBlockModel> {
  protected readonly blockStyles = "";
  private readonly editRequest = signal(0);
  startEditing() {
    if (!this.store.readonly) this.editRequest.value++;
  }
  protected mountBody() {
    this.contentEditable = "false";
    const host = this.std.getOptional(AnnotationReactHostIdentifier);
    this.disposables.add(
      effect(() => {
        this.hidden = !(host?.showAnnotations ?? !this.store.readonly);
      }),
    );
    const anchor = this.ownerDocument.createElement("div");
    this.append(selectionFrame(this, anchor, true));
    if (host?.showAnnotations) {
      const props = computed<AnnotationBlockHostProps>(() => ({
        body: this.model.props.text$.value.deltas$.value
          .map((delta) => delta.insert ?? "")
          .join(""),
        readonly: this.store.readonly,
        editRequest: this.editRequest.value,
        apply: (body, expectedBody) => this.model.applyBody(body, expectedBody),
      }));
      this.disposables.add(host.mountBlock(anchor, props));
    }
    return null;
  }
}
declare global {
  interface HTMLElementTagNameMap {
    "myoxus-annotation": AnnotationBlockComponent;
  }
}
