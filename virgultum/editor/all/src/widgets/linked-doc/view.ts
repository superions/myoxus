// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors

import {
  ViewExtensionProvider,
  type ViewExtensionContext,
} from "@virgultum/core/extensions";
import type { EditorHost } from "@virgultum/core/runtime";
import type { MyoxusInlineEditor } from "@virgultum/core/types";
import { z } from "zod";

import {
  LinkedWidgetConfigExtension,
  MYOXUS_LINKED_DOC_WIDGET,
  type LinkedDocViewExtensionOptions,
  type LinkedMenuGroup,
} from "./picker-config.js";
import { MyoxusLinkedDocWidget, linkedDocWidget } from "./picker-controller.js";

const linkedDocOptionsSchema = z.object({
  triggerKeys: z.optional(z.tuple([z.string()]).rest(z.string())),
  convertTriggerKey: z.boolean().optional(),
  ignoreBlockTypes: z.array(z.string()).optional(),
  ignoreSelector: z.string().optional(),
  getMenus: z.optional(
    z
      .function()
      .input(
        [
          z.string(),
          z.function().output(z.void()),
          z.custom<EditorHost>(),
          z.custom<MyoxusInlineEditor>(),
          z.instanceof(AbortSignal),
          z.string().optional(),
        ],
        z.unknown(),
      )
      .output(
        z.union([
          z.promise(z.array(z.custom<LinkedMenuGroup>())),
          z.array(z.custom<LinkedMenuGroup>()),
        ]),
      ),
  ),
  autoFocusedItemKey: z.optional(
    z
      .function()
      .input(
        [
          z.array(z.custom<LinkedMenuGroup>()),
          z.string(),
          z.string().nullable(),
          z.custom<EditorHost>(),
          z.custom<MyoxusInlineEditor>(),
        ],
        z.unknown(),
      )
      .output(z.string().nullable()),
  ),
  mobile: z
    .object({
      scrollContainer: z.optional(
        z.union([z.string(), z.instanceof(HTMLElement), z.custom<Window>()]),
      ),
      scrollTopOffset: z.optional(
        z.union([z.number(), z.function().output(z.number())]),
      ),
    })
    .optional(),
});

export type { LinkedDocViewExtensionOptions };

export class LinkedDocViewExtension extends ViewExtensionProvider<LinkedDocViewExtensionOptions> {
  override name = "myoxus-linked-doc-widget";

  override schema = linkedDocOptionsSchema;

  override effect() {
    super.effect();
    if (!customElements.get(MYOXUS_LINKED_DOC_WIDGET)) {
      customElements.define(MYOXUS_LINKED_DOC_WIDGET, MyoxusLinkedDocWidget);
    }
  }

  override setup(
    context: ViewExtensionContext,
    options?: LinkedDocViewExtensionOptions,
  ) {
    super.setup(context);
    context.register(linkedDocWidget);
    if (options) {
      context.register(LinkedWidgetConfigExtension(options));
    }
  }
}
