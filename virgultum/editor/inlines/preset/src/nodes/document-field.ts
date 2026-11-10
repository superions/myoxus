// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  DocumentFieldReactHostIdentifier,
  MyoxusHostServiceIdentifier,
} from "@virgultum/shared/services";
import {
  DocumentFieldSchema,
  type MyoxusTextAttributes,
} from "@virgultum/shared/types";
import {
  myoxusLabelToneStyles,
  myoxusTextStyles,
} from "@virgultum/shared/styles";
import { SignalWatcher } from "@virgultum/global/lit";
import { ShadowlessElement, type BlockStdScope } from "@virgultum/std";
import type { InlineEditor } from "@virgultum/std/inline";
import { hasFixedTextOwner, type DeltaInsert } from "@virgultum/store";
import { html, nothing } from "lit";
import { property } from "lit/decorators.js";
import { styleMap } from "lit/directives/style-map.js";

// Reordering authored choices may reorder the canonical array, not its answer set.
function sameAnswer(
  left: string | string[] | null,
  right: string | string[] | null,
) {
  if (!Array.isArray(left) || !Array.isArray(right)) return left === right;
  const selected = new Set(left);
  return (
    selected.size === left.length &&
    left.length === right.length &&
    new Set(right).size === right.length &&
    right.every((id) => selected.has(id))
  );
}

/** Live presentation is ephemeral; the hidden native space remains the editor's
 * single selection/undo atom. Captured history uses ordinary text rendering.
 */
export class InlineDocumentField extends SignalWatcher(ShadowlessElement) {
  @property({ attribute: false })
  accessor delta!: DeltaInsert<MyoxusTextAttributes>;

  @property({ attribute: false })
  accessor std!: BlockStdScope;

  @property({ attribute: false })
  accessor editor!: InlineEditor<MyoxusTextAttributes>;

  @property({ attribute: false })
  accessor startOffset = 0;

  private current() {
    // Re-read the bound Y.Text at the write boundary: a popover can outlive
    // a remote edit, an offset change or deletion of its containing block.
    const ownerId =
      this.closest("[data-block-id]")?.getAttribute("data-block-id");
    if (!ownerId || !this.std.store.getModelById(ownerId)) return undefined;
    let offset = 0;
    for (const run of this.editor.yText.toDelta()) {
      const length = typeof run.insert === "string" ? run.insert.length : 1;
      if (
        offset === this.startOffset &&
        run.attributes?.documentField &&
        !run.attributes.documentFieldCaptured
      ) {
        const parsed = DocumentFieldSchema.safeParse(
          run.attributes.documentField,
        );
        if (parsed.success && length === 1 && run.insert === " ")
          return { offset, field: parsed.data, attributes: run.attributes };
      }
      offset += length;
    }
    return undefined;
  }

  override render() {
    const field = DocumentFieldSchema.safeParse(
      this.delta.attributes?.documentField,
    );
    const host = this.std.getOptional(DocumentFieldReactHostIdentifier);
    if (!field.success || !host) {
      return html`<v-text .str=${this.delta.insert}></v-text>`;
    }
    const tone = myoxusLabelToneStyles("info");
    const style = myoxusTextStyles(this.delta.attributes ?? {}, {
      "background-color": tone["background-color"],
    });
    return html`<span hidden aria-hidden="true"
        ><v-text .str=${this.delta.insert}></v-text></span
      ><span contenteditable="false" style=${styleMap(style)}
        >${
          host.renderInline({
            field: field.data,
            readonly: this.std.store.readonly$.value,
            textProtected: hasFixedTextOwner(this.editor.yText),
            updateDefinition: (expected, replacement) => {
              const current = this.current();
              const parsed = DocumentFieldSchema.safeParse(replacement);
              if (
                this.std.store.readonly ||
                this.editor.isReadonly ||
                hasFixedTextOwner(this.editor.yText) ||
                !this.isConnected ||
                !this.std
                  .getOptional(MyoxusHostServiceIdentifier)
                  ?.isTemplateDocument() ||
                !current ||
                !parsed.success ||
                current.field.type !== "input" ||
                parsed.data.type !== "input" ||
                current.field.id !== parsed.data.id ||
                current.field.definition.kind !== parsed.data.definition.kind ||
                !sameAnswer(current.field.value, parsed.data.value) ||
                JSON.stringify(current.field) !==
                  JSON.stringify(DocumentFieldSchema.safeParse(expected).data)
              )
                return false;
              this.std.store.captureSync();
              this.editor.transact(() =>
                this.editor.yText.format(current.offset, 1, {
                  documentField: parsed.data,
                }),
              );
              this.std.store.captureSync();
              return true;
            },
            updateValue: (expected, replacement) => {
              const current = this.current();
              const parsed = DocumentFieldSchema.safeParse(replacement);
              if (
                this.std.store.readonly ||
                (this.editor.isReadonly &&
                  !hasFixedTextOwner(this.editor.yText)) ||
                !this.isConnected ||
                (!hasFixedTextOwner(this.editor.yText) &&
                  this.std
                    .getOptional(MyoxusHostServiceIdentifier)
                    ?.isTemplateDocument()) ||
                !current ||
                !parsed.success ||
                current.field.type !== "input" ||
                parsed.data.type !== "input" ||
                current.field.id !== parsed.data.id ||
                JSON.stringify(current.field.definition) !==
                  JSON.stringify(parsed.data.definition) ||
                JSON.stringify(current.field) !==
                  JSON.stringify(DocumentFieldSchema.safeParse(expected).data)
              )
                return false;
              const range = { index: current.offset + 1, length: 0 };
              this.editor.syncInlineRange(range);
              this.editor.setInlineRange(range);
              this.std.store.captureSync();
              this.editor.transact(() =>
                this.editor.yText.format(current.offset, 1, {
                  documentField: parsed.data,
                }),
              );
              this.std.store.captureSync();
              this.editor.syncInlineRange(range);
              this.editor.setInlineRange(range);
              return true;
            },
            convertToText: (expected, text) => {
              const current = this.current();
              if (
                this.std.store.readonly ||
                this.editor.isReadonly ||
                hasFixedTextOwner(this.editor.yText) ||
                !this.isConnected ||
                !current ||
                JSON.stringify(current.field) !==
                  JSON.stringify(DocumentFieldSchema.safeParse(expected).data)
              )
                return false;
              const {
                documentField: _field,
                documentFieldCaptured: _captured,
                ...marks
              } = current.attributes;
              // The popover may have opened without selecting this occurrence.
              // History must capture its actual owner before deleting the atom.
              const before = { index: current.offset, length: 0 };
              this.editor.syncInlineRange(before);
              this.editor.setInlineRange(before);
              this.std.store.captureSync();
              this.editor.transact(() => {
                this.editor.yText.delete(current.offset, 1);
                if (text) this.editor.yText.insert(current.offset, text, marks);
              });
              this.std.store.captureSync();
              const range = { index: current.offset + text.length, length: 0 };
              // The previous inline range can already equal the desired caret;
              // synchronize explicitly so a dismissed popover cannot retain focus.
              this.editor.syncInlineRange(range);
              this.editor.setInlineRange(range);
              return true;
            },
            focusEditor: (side) => {
              const current = this.current();
              if (current) {
                const range = {
                  index: current.offset + (side === "after" ? 1 : 0),
                  length: 0,
                };
                this.editor.syncInlineRange(range);
                this.editor.setInlineRange(range);
              }
            },
          }) ?? nothing
        }</span
      >`;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "myoxus-inline-document-field": InlineDocumentField;
  }
}
