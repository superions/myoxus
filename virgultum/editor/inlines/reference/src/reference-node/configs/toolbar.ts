import { notifyLinkedDocSwitchedToEmbed } from "@virgultum/components/notification";
import {
  ActionPlacement,
  DocDisplayMetaProvider,
  type ToolbarAction,
  type ToolbarActionGroup,
  type ToolbarModuleConfig,
  editorMessage,
} from "@virgultum/shared/services";
import {
  cloneReferenceInfoWithoutAliases,
  isInsideBlockByFlavour,
} from "@virgultum/shared/utils";
import { BlockSelection } from "@virgultum/std";

import { MyoxusReference } from "../reference-node";
import { openReferenceEditor } from "../../reference-editor";

const trackBaseProps = {
  segment: "doc",
  page: "doc editor",
  module: "toolbar",
  category: "linked doc",
  type: "inline view",
};

export const builtinInlineReferenceToolbarConfig = {
  actions: [
    {
      id: "a.doc-title",
      generate(ctx) {
        const target = ctx.message$.peek()?.element;
        if (!(target instanceof MyoxusReference)) return null;
        if (!target.referenceInfo.title) return null;
        const title =
          ctx.std.get(DocDisplayMetaProvider).title(target.referenceInfo.pageId)
            .value || "Untitled";
        return {
          label: title,
          showLabel: true,
          icon: "LinkedPageIcon",
          run: () => target.open(),
        };
      },
    },
    {
      id: "b.edit-alias",
      tooltip: editorMessage("Edit", "Edit"),
      icon: "EditIcon",
      run(ctx) {
        const target = ctx.message$.peek()?.element;
        if (!(target instanceof MyoxusReference)) return;

        const { inlineEditor, selfInlineRange } = target;
        if (!inlineEditor || !selfInlineRange) return;

        const abortController = new AbortController();
        openReferenceEditor(
          ctx.std,
          target.docTitle,
          target.referenceInfo,
          inlineEditor,
          selfInlineRange,
          abortController,
        );

        ctx.track("OpenedAliasPopup", {
          ...trackBaseProps,
          control: "edit",
        });
      },
    },
    {
      id: "c.conversions",
      actions: [
        {
          id: "inline",
          label: editorMessage(
            "com.myoxus.editor.toolbar.inline-view",
            "Inline view",
          ),
          disabled: true,
        },
        {
          id: "card",
          label: editorMessage(
            "com.myoxus.editor.toolbar.card-view",
            "Card view",
          ),
          run(ctx) {
            const target = ctx.message$.peek()?.element;
            if (!(target instanceof MyoxusReference)) return;
            if (!target.block) return;

            const {
              block: { model },
              referenceInfo,
              inlineEditor,
              selfInlineRange,
            } = target;
            const { parent } = model;

            if (!inlineEditor || !selfInlineRange || !parent) return;

            // Clears
            ctx.reset();

            const index = parent.children.indexOf(model);

            const blockId = ctx.store.addBlock(
              "myoxus:embed-linked-doc",
              referenceInfo,
              parent,
              index + 1,
            );

            const totalTextLength = inlineEditor.yTextLength;
            const inlineTextLength = selfInlineRange.length;
            if (totalTextLength === inlineTextLength) {
              ctx.store.deleteBlock(model);
            } else {
              inlineEditor.insertText(selfInlineRange, target.docTitle);
            }

            ctx.select("note", [
              ctx.selection.create(BlockSelection, { blockId }),
            ]);

            ctx.track("SelectedView", {
              ...trackBaseProps,
              control: "select view",
              type: "card view",
            });
          },
        },
        {
          id: "embed",
          label: editorMessage(
            "com.myoxus.editor.toolbar.embed-view",
            "Embed view",
          ),
          disabled(ctx) {
            const target = ctx.message$.peek()?.element;
            if (!(target instanceof MyoxusReference)) return true;
            if (!target.block) return true;

            if (
              isInsideBlockByFlavour(
                ctx.store,
                target.block.model,
                "myoxus:edgeless-text",
              )
            )
              return true;

            // nesting is not supported
            if (target.closest("myoxus-embed-synced-doc-block")) return true;

            // same doc
            if (target.referenceInfo.pageId === ctx.store.id) return true;

            // linking to block
            if (target.referenceToNode()) return true;

            return false;
          },
          run(ctx) {
            const target = ctx.message$.peek()?.element;
            if (!(target instanceof MyoxusReference)) return;
            if (!target.block) return;

            const {
              block: { model },
              referenceInfo,
              inlineEditor,
              selfInlineRange,
            } = target;
            const { parent } = model;

            if (!inlineEditor || !selfInlineRange || !parent) return;

            // Clears
            ctx.reset();

            const index = parent.children.indexOf(model);

            const blockId = ctx.store.addBlock(
              "myoxus:embed-synced-doc",
              cloneReferenceInfoWithoutAliases(referenceInfo),
              parent,
              index + 1,
            );

            const totalTextLength = inlineEditor.yTextLength;
            const inlineTextLength = selfInlineRange.length;
            if (totalTextLength === inlineTextLength) {
              ctx.store.deleteBlock(model);
            } else {
              inlineEditor.insertText(selfInlineRange, target.docTitle);
            }

            const hasTitleAlias = Boolean(referenceInfo.title);

            if (hasTitleAlias) {
              notifyLinkedDocSwitchedToEmbed(ctx.std);
            }

            ctx.select("note", [
              ctx.selection.create(BlockSelection, { blockId }),
            ]);

            ctx.track("SelectedView", {
              ...trackBaseProps,
              control: "select view",
              type: "embed view",
            });
          },
        },
      ],
      label: editorMessage(
        "com.myoxus.editor.toolbar.inline-view",
        "Inline view",
      ),
      control(ctx) {
        return {
          type: "menu",
          items: this.actions,
          onOpen: () =>
            ctx.track("OpenedViewSelector", {
              ...trackBaseProps,
              control: "switch view",
            }),
        };
      },

      when(ctx) {
        const target = ctx.message$.peek()?.element;
        if (!(target instanceof MyoxusReference)) return false;
        if (!target.block) return false;

        if (ctx.flags.isNative()) return false;
        if (
          target.block.closest("myoxus-database") ||
          target.block.closest("myoxus-table")
        )
          return false;

        return true;
      },
    } satisfies ToolbarActionGroup<ToolbarAction>,
    {
      placement: ActionPlacement.More,
      id: "c.delete",
      label: editorMessage("Delete", "Delete"),
      icon: "DeleteIcon",
      variant: "destructive",
      run(ctx) {
        const target = ctx.message$.peek()?.element;
        if (!(target instanceof MyoxusReference)) return;

        const { inlineEditor, selfInlineRange } = target;
        if (!inlineEditor || !selfInlineRange) return;

        if (!inlineEditor.isValidInlineRange(selfInlineRange)) return;

        inlineEditor.deleteText(selfInlineRange);
      },
    },
  ],
} as const satisfies ToolbarModuleConfig;
