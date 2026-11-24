// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  type ViewExtensionContext,
  ViewExtensionProvider,
} from "@virgultum/core/extensions";
import { type FootnoteDefinitionBlockModel } from "@virgultum/core/models";
import {
  NativeContainerBlock,
  BlockViewExtension,
  FlavourExtension,
} from "@virgultum/core/runtime";
import { computed, effect, signal } from "@preact/signals-core";
import {
  FootnoteReactHostIdentifier,
  type FootnoteHeaderHostProps,
} from "@virgultum/core/services";
import {
  canReturnLocalFootnote,
  returnFromLocalFootnote,
  localFootnotePresentation,
  setLocalFootnotePlacement,
} from "@virgultum/core/commands";
import { SlashMenuConfigExtension } from "@virgultum/core/slash-menu";
import { footnoteSlashMenuConfig } from "./footnote-slash-menu";

export class FootnoteDefinitionBlockComponent extends NativeContainerBlock<FootnoteDefinitionBlockModel> {
  protected readonly blockStyles = "";
  private readonly headerRevision = signal(0);
  override requestUpdate() {
    super.requestUpdate();
    this.headerRevision.value++;
  }
  protected mountBody() {
    const doc = this.ownerDocument;
    const section = doc.createElement("section"),
      header = doc.createElement("header"),
      body = doc.createElement("div");
    const titleId = `myoxus-note-heading-${this.model.id}`;
    section.setAttribute("aria-labelledby", titleId);
    header.contentEditable = "false";
    body.className = "myoxus-block-children-container";
    section.append(header, body);
    this.replaceChildren(section);
    this.disposables.add(
      this.store.slots.blockUpdated.subscribe(
        () => this.headerRevision.value++,
      ),
    );
    const state = computed<FootnoteHeaderHostProps>(() => {
      void this.headerRevision.value;
      const presentation = localFootnotePresentation(this.store).get(
        this.model.id,
      );
      return {
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
      };
    });
    const host = this.std.getOptional(FootnoteReactHostIdentifier);
    if (host) this.disposables.add(host.mountHeader(header, state));
    else {
      const number = doc.createElement("sup");
      number.id = titleId;
      header.append(number);
      this.disposables.add(
        effect(() => {
          number.textContent = String(state.value.number ?? "—");
        }),
      );
    }
    return body;
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
        "myoxus-footnote-definition",
      ),
    ]);
  }
}
