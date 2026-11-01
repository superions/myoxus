// SPDX-License-Identifier: AGPL-3.0-or-later
import { CaptionedBlockComponent } from "@virgultum/components/caption";
import type { AnnotationBlockModel } from "@virgultum/model";
import { nothing } from "lit";
import { state } from "lit/decorators.js";
import { AnnotationReactHostIdentifier } from "./react-host";

export class AnnotationBlockComponent extends CaptionedBlockComponent<AnnotationBlockModel> {
  @state()
  private accessor editRequest = 0;
  override accessor useZeroWidth = true;

  override connectedCallback() {
    super.connectedCallback();
    this.contentEditable = "false";
  }

  startEditing() {
    if (!this.store.readonly) this.editRequest++;
  }

  override renderBlock() {
    const host = this.std.getOptional(AnnotationReactHostIdentifier);
    const show = host?.showAnnotations ?? !this.store.readonly;
    this.hidden = !show;
    if (!show || !host) return nothing;
    // Observe canonical Yjs text, not a UI-owned persisted body.
    return host.renderBlock({
      body: this.model.props.text.deltas$.value
        .map((delta) => delta.insert ?? "")
        .join(""),
      readonly: this.store.readonly$.value,
      editRequest: this.editRequest,
      apply: (body, expectedBody) => {
        if (
          this.store.readonly ||
          this.store.getModelById(this.model.id) !== this.model
        )
          return false;
        const text = this.model.props.text;
        if (text.toString() !== expectedBody) return false;
        if (text.toString() === body) return true;
        this.store.captureSync();
        text.replace(0, text.length, body, {});
        this.store.captureSync();
        return true;
      },
    });
  }
}
declare global {
  interface HTMLElementTagNameMap {
    "myoxus-annotation": AnnotationBlockComponent;
  }
}
