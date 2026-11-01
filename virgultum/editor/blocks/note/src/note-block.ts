import type { NoteBlockModel } from "@virgultum/model";
import { BlockComponent } from "@virgultum/std";
import { css, html } from "lit";
import { repeat } from "lit/directives/repeat.js";
import { localFootnotePresentation } from "@virgultum/shared/commands";

export class NoteBlockComponent extends BlockComponent<NoteBlockModel> {
  static override styles = css`
    .myoxus-note-block-container {
      display: flow-root;
    }
    .myoxus-note-block-container.selected {
      background-color: var(--myoxus-hover-color);
    }
  `;

  override connectedCallback() {
    super.connectedCallback();
    this.disposables.add(
      this.store.slots.blockUpdated.subscribe(() => this.requestUpdate()),
    );
  }

  override renderBlock() {
    const presentation = localFootnotePresentation(this.store);
    const definitions = this.model.children
      .filter((child) => child.flavour === "myoxus:footnote-definition")
      .sort(
        (a, b) =>
          (presentation.get(a.id)?.order ?? Infinity) -
          (presentation.get(b.id)?.order ?? Infinity),
      );
    return html`
      <div class="myoxus-note-block-container">
        <div class="myoxus-block-children-container">
          ${this.renderChildren(this.model, (child) => child.flavour !== "myoxus:footnote-definition")}
          ${repeat(
            definitions,
            (child) => child.id,
            (child) =>
              this.renderChildren(
                this.model,
                (candidate) => candidate.id === child.id,
              ),
          )}
        </div>
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "myoxus-note": NoteBlockComponent;
  }
}
