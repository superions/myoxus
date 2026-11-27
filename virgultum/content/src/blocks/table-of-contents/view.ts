// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  ViewExtensionProvider,
  type ViewExtensionContext,
} from "@virgultum/core/extensions";
import {
  defaultTableOfContentsProps,
  type TableOfContentsBlockModel,
} from "@virgultum/core/models";
import { TableOfContentsHost, editorMessage } from "@virgultum/core/services";
import {
  BlockViewExtension,
  FlavourExtension,
  NativeContainerBlock,
} from "@virgultum/core/runtime";
import { SlashMenuConfigExtension } from "@virgultum/core/slash-menu";

class TableOfContentsBlockComponent extends NativeContainerBlock<TableOfContentsBlockModel> {
  protected readonly blockStyles = "";
  protected mountBody() {
    const anchor = this.ownerDocument.createElement("div");
    anchor.contentEditable = "false";
    this.append(anchor);
    const release = this.std
      .getOptional(TableOfContentsHost)
      ?.mount(anchor, this.model, (blockId) => {
        const target = this.std.view.getBlock(blockId);
        target?.scrollIntoView({ behavior: "smooth", block: "center" });
      });
    if (release) this.disposables.add(release);
    return null;
  }
}

export class TableOfContentsViewExtension extends ViewExtensionProvider {
  override name = "myoxus-table-of-contents";
  override effect() {
    super.effect();
    if (!customElements.get("myoxus-table-of-contents")) {
      customElements.define(
        "myoxus-table-of-contents",
        TableOfContentsBlockComponent,
      );
    }
  }
  override setup(context: ViewExtensionContext) {
    super.setup(context);
    context.register([
      FlavourExtension("myoxus:table-of-contents"),
      BlockViewExtension(
        "myoxus:table-of-contents",
        "myoxus-table-of-contents",
      ),
      SlashMenuConfigExtension("myoxus:table-of-contents", {
        items: [
          {
            id: "block-table-of-contents-insert",
            label: editorMessage(
              "com.myoxus.wiki.toc.title",
              "Table of contents",
            ),
            description: editorMessage(
              "com.myoxus.wiki.toc.description",
              "Insert a live table of contents for this document.",
            ),
            icon: "TocIcon",
            group: {
              id: "content-media",
              label: editorMessage(
                "com.myoxus.editor.group.content-media",
                "Content & Media",
              ),
              order: 4,
              itemOrder: 12,
            },
            searchAlias: [
              "wiki",
              "toc",
              "contents",
              "table of contents",
              "Inhaltsverzeichnis",
              "Gliederung",
            ],
            when: ({ std }) => !std.store.readonly,
            action: ({ std, model }) => {
              const parent = std.store.getParent(model);
              if (!parent || std.store.readonly) return;
              std.store.captureSync();
              std.store.addBlock(
                "myoxus:table-of-contents",
                defaultTableOfContentsProps(),
                parent,
                parent.children.indexOf(model) + 1,
              );
              std.store.captureSync();
            },
          },
        ],
      }),
    ]);
  }
}
