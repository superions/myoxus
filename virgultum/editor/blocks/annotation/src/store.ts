// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  type StoreExtensionContext,
  StoreExtensionProvider,
} from "@virgultum/ext-loader";
import { AnnotationBlockSchemaExtension } from "@virgultum/model";
import { annotationMarkdownAdapter } from "./markdown";

export class AnnotationStoreExtension extends StoreExtensionProvider {
  override name = "myoxus-annotation-block";

  override setup(context: StoreExtensionContext) {
    super.setup(context);
    context.register(AnnotationBlockSchemaExtension);
    context.register(annotationMarkdownAdapter);
  }
}
