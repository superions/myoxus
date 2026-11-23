import type { NoteBlockModel } from "@virgultum/core/models";
import { BlockComponent } from "@virgultum/core/runtime";
import { html, unsafeCSS } from "lit";
import { repeat } from "lit/directives/repeat.js";
import { localFootnotePresentation } from "@virgultum/core/commands";

export const noteBlockCss = `
    .myoxus-note-block-container {
      display: flow-root;
    }
    .myoxus-note-block-container.selected {
      background-color: var(--myoxus-hover-color);
    }
  `;

export function noteDefinitionsInOrder(note: NoteBlockModel) {
  const presentation = localFootnotePresentation(note.store);
  return note.children
    .filter((child) => child.flavour === "myoxus:footnote-definition")
    .sort(
      (a, b) =>
        (presentation.get(a.id)?.order ?? Infinity) -
        (presentation.get(b.id)?.order ?? Infinity),
    );
}

export class NoteBlockComponent extends BlockComponent<NoteBlockModel> {
  static override styles = unsafeCSS(noteBlockCss);

  override connectedCallback() {
    super.connectedCallback();
    this.disposables.add(
      this.store.slots.blockUpdated.subscribe(() => this.requestUpdate()),
    );
  }

  override renderBlock() {
    const definitions = noteDefinitionsInOrder(this.model);
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
