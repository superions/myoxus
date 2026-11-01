import { consume } from "@lit/context";
import { SignalWatcher, WithDisposable } from "@virgultum/global/lit";
import { NoteBlockModel } from "@virgultum/model";
import {
  type BlockStdScope,
  PropTypes,
  requiredProperties,
  ShadowlessElement,
  stdContext,
} from "@virgultum/std";
import { html } from "lit";
import { property } from "lit/decorators.js";

import { NoteConfigExtension } from "../config";
import * as styles from "./edgeless-page-block-title.styles";

@requiredProperties({
  note: PropTypes.instanceOf(NoteBlockModel),
})
export class EdgelessPageBlockTitle extends SignalWatcher(
  WithDisposable(ShadowlessElement),
) {
  override render() {
    if (!this.note.isPageBlock()) return;

    const title = this.std
      .getOptional(NoteConfigExtension.identifier)
      ?.pageBlockTitle({
        note: this.note,
        std: this.std,
      });

    return html`<div class=${styles.pageBlockTitle}>${title}</div>`;
  }

  @consume({ context: stdContext })
  accessor std!: BlockStdScope;

  @property({ attribute: false })
  accessor note!: NoteBlockModel;
}
declare global {
  interface HTMLElementTagNameMap {
    "edgeless-page-block-title": EdgelessPageBlockTitle;
  }
}
