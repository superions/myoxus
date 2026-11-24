import { WithDisposable } from "@virgultum/core/primitives/lit";
import { type CommentId, type CommentProvider } from "@virgultum/core/services";
import { unsafeCSSVar } from "@virgultum/core/theme";
import {
  PropTypes,
  requiredProperties,
  ShadowlessElement,
} from "@virgultum/core/runtime";
import { css, type PropertyValues } from "lit";
import { property, state } from "lit/decorators.js";
import { html } from "lit-html";
import { isEqual } from "lodash-es";

@requiredProperties({
  commentIds: PropTypes.arrayOf((id) => typeof id === "string"),
})
export class InlineComment extends WithDisposable(ShadowlessElement) {
  static override styles = css`
    inline-comment {
      display: inline;
    }

    inline-comment.unresolved {
      background-color: ${unsafeCSSVar("backgroundProcessingColor")};
      border-bottom: 2px solid ${unsafeCSSVar("primaryColor")};
    }

    inline-comment.highlighted {
      background-color: ${unsafeCSSVar("backgroundProcessingColor")};
    }
  `;

  @property({
    attribute: false,
    hasChanged: (newVal: string[], oldVal: string[]) =>
      !isEqual(newVal, oldVal),
  })
  accessor commentIds!: string[];

  @property({ attribute: false })
  accessor unresolved = false;

  private _index: number = 0;

  provider?: CommentProvider;

  @state()
  accessor highlighted = false;

  private readonly _handleClick = () => {
    if (this.unresolved) {
      this.provider?.highlightComment(this.commentIds[this._index]);
      this._index = (this._index + 1) % this.commentIds.length;
    }
  };

  private readonly _handleHighlight = (id: CommentId | null) => {
    if (this.highlighted) {
      if (!id || !this.commentIds.includes(id)) {
        this.highlighted = false;
      }
    } else {
      if (id && this.commentIds.includes(id)) {
        this.highlighted = true;
      }
    }
  };

  override connectedCallback() {
    super.connectedCallback();
    const provider = this.provider;
    if (provider) {
      this.disposables.addFromEvent(this, "click", this._handleClick);
      this.disposables.add(
        provider.onCommentHighlighted(this._handleHighlight),
      );
    }
  }

  override willUpdate(_changedProperties: PropertyValues<this>) {
    if (_changedProperties.has("highlighted")) {
      if (this.highlighted) {
        this.classList.add("highlighted");
      } else {
        this.classList.remove("highlighted");
      }
    }
    if (_changedProperties.has("unresolved")) {
      if (this.unresolved) {
        this.classList.add("unresolved");
      } else {
        this.classList.remove("unresolved");
      }
    }
  }

  override render() {
    return html`<slot></slot>`;
  }
}
