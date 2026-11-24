import type { NoteBlockModel } from "@virgultum/core/models";
import { NativeContainerBlock } from "@virgultum/core/runtime";
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

export class NoteBlockComponent extends NativeContainerBlock<NoteBlockModel> {
  protected readonly blockStyles = noteBlockCss;

  protected mountBody() {
    const note = this.ownerDocument.createElement("div");
    note.className = "myoxus-note-block-container";
    const body = this.ownerDocument.createElement("div");
    body.className = "myoxus-block-children-container";
    note.append(body);
    this.append(note);
    this.disposables.add(
      this.store.slots.blockUpdated.subscribe(() => {
        if (
          this.model.children.some(
            (child) => child.flavour === "myoxus:footnote-definition",
          )
        )
          this.requestUpdate();
      }),
    );
    return body;
  }

  protected override projectedModels() {
    return [
      ...this.model.children.filter(
        (child) => child.flavour !== "myoxus:footnote-definition",
      ),
      ...noteDefinitionsInOrder(this.model),
    ];
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "myoxus-note": NoteBlockComponent;
  }
}
