// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  type StoreExtensionContext,
  StoreExtensionProvider,
  type ViewExtensionContext,
  ViewExtensionProvider,
} from "@virgultum/ext-loader";
import {
  FootnoteDefinitionBlockSchemaExtension,
  type FootnoteDefinitionBlockModel,
} from "@virgultum/model";
import {
  BlockComponent,
  BlockViewExtension,
  FlavourExtension,
} from "@virgultum/std";
import { html } from "lit";
import { FootnoteReactHostIdentifier } from "@virgultum/shared/services";
import {
  canReturnLocalFootnote,
  returnFromLocalFootnote,
  localFootnotePresentation,
  setLocalFootnotePlacement,
} from "@virgultum/shared/commands";
import { SlashMenuConfigExtension } from "@virgultum/widget-slash-menu";
import { footnoteSlashMenuConfig } from "./footnote-slash-menu";
import { literal } from "lit/static-html.js";
import { footnoteDefinitionMarkdownAdapter } from "./adapters/footnote-definition-markdown";
import { footnoteDefinitionPlainTextAdapter } from "./adapters/footnote-definition-plain-text";
import { footnoteDefinitionHtmlAdapter } from "./adapters/footnote-definition-html";

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
export class FootnoteDefinitionStoreExtension extends StoreExtensionProvider {
  override name = "myoxus-footnote-definition";
  override setup(context: StoreExtensionContext) {
    super.setup(context);
    context.register([
      FootnoteDefinitionBlockSchemaExtension,
      footnoteDefinitionMarkdownAdapter,
      footnoteDefinitionHtmlAdapter,
      footnoteDefinitionPlainTextAdapter,
    ]);
  }
}
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
