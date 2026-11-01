import {
  editorMessage,
  resolveEditorMessage,
  type EditorI18nService,
} from "@virgultum/shared/services";
import { SignalWatcher } from "@virgultum/global/lit";
import { PropTypes, requiredProperties } from "@virgultum/std";
import { css, LitElement } from "lit";
import { property } from "lit/decorators.js";
import { html } from "lit-html";

@requiredProperties({
  title: PropTypes.string,
  open: PropTypes.instanceOf(Function),
})
export class DocTitle extends SignalWatcher(LitElement) {
  static override styles = css`
    editor-icon-button .label {
      min-width: 60px;
      max-width: 140px;
      display: inline-block;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      user-select: none;
      cursor: pointer;
      color: var(--myoxus-link-color);
      font-feature-settings:
        "clig" off,
        "liga" off;
      font-family: var(--myoxus-font-family);
      font-size: var(--myoxus-font-sm);
      font-style: normal;
      font-weight: 400;
      text-decoration: none;
      text-wrap: nowrap;
    }
  `;

  @property({ attribute: false })
  override accessor title!: string;

  @property({ attribute: false })
  accessor open!: (event: MouseEvent) => void;

  @property({ attribute: false })
  accessor i18n: EditorI18nService | undefined;

  override render() {
    const { title, open } = this;

    return html`
      <editor-icon-button
        aria-label=${resolveEditorMessage(editorMessage("com.myoxus.editor.toolbar.document-title", "Document title"), this.i18n)}
        .hover=${false}
        .labelHeight="${"20px"}"
        .tooltip=${title}
        @click=${(event: MouseEvent) => open(event)}
      >
        <span class="label">${title}</span>
      </editor-icon-button>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "myoxus-linked-doc-title": DocTitle;
  }
}
