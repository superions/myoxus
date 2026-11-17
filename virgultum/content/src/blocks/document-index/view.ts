// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  ViewExtensionProvider,
  type ViewExtensionContext,
} from "@virgultum/core/extensions";
import {
  defaultDocumentIndexProps,
  type DocumentIndexBlockModel,
} from "@virgultum/core/models";
import {
  DocumentIndexHost,
  MyoxusHostServiceIdentifier,
  editorMessage,
  mountInlinePopup,
} from "@virgultum/core/services";
import {
  BlockComponent,
  BlockViewExtension,
  FlavourExtension,
} from "@virgultum/core/runtime";
import { SlashMenuConfigExtension } from "@virgultum/core/slash-menu";
import { html, nothing } from "lit";
import { literal } from "lit/static-html.js";
class DocumentIndexBlockComponent extends BlockComponent<DocumentIndexBlockModel> {
  override renderBlock() {
    const host = this.std.getOptional(DocumentIndexHost);
    return html`<div contenteditable="false">
      ${host?.render(this.model, this.std) ?? nothing}
    </div>`;
  }
}
export class DocumentIndexViewExtension extends ViewExtensionProvider {
  override name = "myoxus-document-index";
  override effect() {
    super.effect();
    if (!customElements.get("myoxus-document-index"))
      customElements.define(
        "myoxus-document-index",
        DocumentIndexBlockComponent,
      );
  }
  override setup(context: ViewExtensionContext) {
    super.setup(context);
    context.register([
      FlavourExtension("myoxus:document-index"),
      BlockViewExtension(
        "myoxus:document-index",
        literal`myoxus-document-index`,
      ),
      SlashMenuConfigExtension("myoxus:document-index", {
        items: [
          {
            id: "block-page-report-insert",
            label: editorMessage("com.myoxus.wiki.report.title", "Page report"),
            icon: "TableIcon",
            group: {
              id: "content-media",
              label: editorMessage(
                "com.myoxus.editor.group.content-media",
                "Content & Media",
              ),
              order: 4,
              itemOrder: 11,
            },
            searchAlias: [
              "wiki",
              "report",
              "Seitenbericht",
              "Metadatenbericht",
            ],
            when: ({ std }) =>
              !std.store.readonly &&
              Boolean(
                std.getOptional(MyoxusHostServiceIdentifier)
                  ?.insertNamedBuildingBlock,
              ),
            action: ({ std }) =>
              std
                .getOptional(MyoxusHostServiceIdentifier)
                ?.insertNamedBuildingBlock?.(std, "block-page-report"),
          },
          {
            id: "block-document-index-insert",
            label: editorMessage(
              "com.myoxus.wiki.directory.title",
              "Page directory",
            ),
            description: editorMessage(
              "com.myoxus.wiki.directory.description",
              "Insert a dynamic list of pages.",
            ),
            icon: "BulletedListIcon",
            group: {
              id: "content-media",
              label: editorMessage(
                "com.myoxus.editor.group.content-media",
                "Content & Media",
              ),
              order: 4,
              itemOrder: 10,
            },
            searchAlias: [
              "wiki",
              "directory",
              "index",
              "Seitenverzeichnis",
              "Register",
            ],
            action: ({ std, model }) => {
              const host = std.getOptional(DocumentIndexHost);
              const parent = std.store.getParent(model);
              if (!host || !parent || std.store.readonly) return;
              const abort = new AbortController();
              mountInlinePopup(
                std,
                () => std.host,
                ({ close }) =>
                  host.configure(
                    defaultDocumentIndexProps(),
                    (value) => {
                      if (
                        std.store.readonly ||
                        !std.store.getBlock(parent.id)
                      ) {
                        close();
                        return;
                      }
                      std.store.captureSync();
                      std.store.addBlock(
                        "myoxus:document-index",
                        value,
                        parent,
                        parent.children.indexOf(model) + 1,
                      );
                      std.store.captureSync();
                      close();
                    },
                    close,
                    std.store.id,
                  ),
                abort,
                () => std.host.focus(),
              );
            },
          },
        ],
      }),
    ]);
  }
}
