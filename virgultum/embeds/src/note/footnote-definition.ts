// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  type ViewExtensionContext,
  ViewExtensionProvider,
} from "@virgultum/core/extensions";
import { type FootnoteDefinitionBlockModel } from "@virgultum/core/models";
import {
  BlockComponent,
  BlockViewExtension,
  FlavourExtension,
} from "@virgultum/core/runtime";
import { html } from "lit";
import { FootnoteReactHostIdentifier } from "@virgultum/core/services";
import {
  canReturnLocalFootnote,
  returnFromLocalFootnote,
  localFootnotePresentation,
  setLocalFootnotePlacement,
} from "@virgultum/core/commands";
import { SlashMenuConfigExtension } from "@virgultum/core/slash-menu";
import { footnoteSlashMenuConfig } from "./footnote-slash-menu";
import { literal } from "lit/static-html.js";

export class FootnoteDefinitionBlockComponent extends BlockComponent<FootnoteDefinitionBlockModel> {
  override connectedCallback() {
    super.connectedCallback();
    this.disposables.add(
      this.store.slots.blockUpdated.subscribe(() => this.requestUpdate()),
    );
  }
  override renderBlock() {
    const presentation = localFootnotePresentation(this.store).get(
      this.model.id,
    );
    const host = this.std.getOptional(FootnoteReactHostIdentifier);
    const titleId = `myoxus-note-heading-${this.model.id}`;
    return html`<section aria-labelledby=${titleId}>
      <header contenteditable="false">
        ${
          host?.renderHeader({
            titleId,
            ...presentation,
            readonly: this.store.readonly$.value,
            canReturn: canReturnLocalFootnote(this.std, this.model.id),
            returnToMarker: () => {
              returnFromLocalFootnote(this.std, this.model.id);
            },
            changePlacement: (placement) => {
              setLocalFootnotePlacement(
                this.store,
                this.model.id,
                placement,
                presentation?.placement,
              );
            },
            remove: () => {
              if (
                this.store.readonly ||
                this.store.getModelById(this.model.id) !== this.model
              )
                return;
              this.store.captureSync();
              this.store.deleteBlock(this.model);
              this.store.captureSync();
            },
          }) ?? html`<sup id=${titleId}>${presentation?.number ?? "—"}</sup>`
        }
      </header>
      <div class="myoxus-block-children-container">
        ${this.renderChildren(this.model)}
      </div>
    </section>`;
  }
}
export { FootnoteDefinitionStoreExtension } from "./footnote-definition-store";

export class FootnoteDefinitionViewExtension extends ViewExtensionProvider {
  override name = "myoxus-footnote-definition";
  override effect() {
    super.effect();
    customElements.define(
      "myoxus-footnote-definition",
      FootnoteDefinitionBlockComponent,
    );
  }
  override setup(context: ViewExtensionContext) {
    super.setup(context);
    context.register([
      SlashMenuConfigExtension(
        "myoxus:footnote-definition",
        footnoteSlashMenuConfig,
      ),
      FlavourExtension("myoxus:footnote-definition"),
      BlockViewExtension(
        "myoxus:footnote-definition",
        literal`myoxus-footnote-definition`,
      ),
    ]);
  }
}
