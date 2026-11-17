// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  type StoreExtensionContext,
  StoreExtensionProvider,
} from "@virgultum/core/extensions";
import { FootnoteDefinitionBlockSchemaExtension } from "@virgultum/core/models";

import { footnoteDefinitionMarkdownAdapter } from "./adapters/footnote-definition-markdown";
import { footnoteDefinitionPlainTextAdapter } from "./adapters/footnote-definition-plain-text";
import { footnoteDefinitionHtmlAdapter } from "./adapters/footnote-definition-html";

// Store-only entries must register adapters without evaluating the footnote view.
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
