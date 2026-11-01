import { copyTextToClipboard } from "@virgultum/global/utils";
import {
  ActionPlacement,
  EmbedIframeService,
  EmbedOptionProvider,
  type ToolbarAction,
  type ToolbarActionGroup,
  type ToolbarModuleConfig,
  editorMessage,
} from "@virgultum/shared/services";
import { editorToast } from "@virgultum/shared/utils";
import { BlockSelection } from "@virgultum/std";

import { openLinkEditor } from "../../link-editor";
import { MyoxusLink } from "../myoxus-link";

const trackBaseProps = {
  segment: "doc",
  page: "doc editor",
  module: "toolbar",
  category: "link",
  type: "inline view",
};

export const builtinInlineLinkToolbarConfig = {
  actions: [
    {
      id: "a.preview",
      generate(ctx) {
        const target = ctx.message$.peek()?.element;
        if (!(target instanceof MyoxusLink)) return null;
        const value = target.link;
        if (!value) return null;
        return {
          label: value,
          showLabel: true,
          icon: "LinkIcon",
          run: () => {
            window.open(value, "_blank", "noopener,noreferrer");
          },
        };
      },
    },
    {
      id: "b.copy-link-and-edit",
      actions: [
        {
          id: "copy-link",
          tooltip: editorMessage(
            "com.myoxus.editor.toolbar.copy-link",
            "Copy link",
          ),
          icon: "CopyIcon",
          async run(ctx) {
            const target = ctx.message$.peek()?.element;
            if (!(target instanceof MyoxusLink)) return;

            const { link } = target;

            if (!link) return;

            // Clears
            ctx.reset();

            if (!(await copyTextToClipboard(link))) return;
            editorToast(
              ctx.host,
              editorMessage(
                "Copied link to clipboard",
                "Copied link to clipboard",
              ),
            );

            ctx.track("CopiedLink", {
              ...trackBaseProps,
              control: "copy link",
            });
          },
        },
        {
          id: "edit",
          tooltip: editorMessage(
            "com.myoxus.editor.toolbar.edit-description",
            "Edit Description",
          ),
          icon: "EditIcon",
          run(ctx) {
            const target = ctx.message$.peek()?.element;
            if (!(target instanceof MyoxusLink)) return;

            const { inlineEditor, selfInlineRange } = target;

            if (!inlineEditor || !selfInlineRange) return;

            const abortController = new AbortController();
            openLinkEditor(
              ctx.std,
              "edit",
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
      ],
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
            if (!(target instanceof MyoxusLink)) return;
            if (!target.block) return;

            const url = target.link;
            if (!url) return;

            const {
              block: { model },
              inlineEditor,
              selfInlineRange,
            } = target;
            const { parent } = model;

            if (!inlineEditor || !selfInlineRange || !parent) return;

            // Clears
            ctx.reset();

            const title = inlineEditor.yTextString.slice(
              selfInlineRange.index,
              selfInlineRange.index + selfInlineRange.length,
            );

            const options = ctx.std
              .get(EmbedOptionProvider)
              .getEmbedBlockOptions(url);
            const flavour =
              options?.viewType === "card"
                ? options.flavour
                : "myoxus:bookmark";
            const index = parent.children.indexOf(model);
            const props = {
              url,
              title: title === url ? "" : title,
            };

            const blockId = ctx.store.addBlock(
              flavour,
              props,
              parent,
              index + 1,
            );

            const totalTextLength = inlineEditor.yTextLength;
            const inlineTextLength = selfInlineRange.length;
            if (totalTextLength === inlineTextLength) {
              ctx.store.deleteBlock(model);
            } else {
              inlineEditor.formatText(selfInlineRange, { link: null });
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
          when(ctx) {
            const target = ctx.message$.peek()?.element;
            if (!(target instanceof MyoxusLink)) return false;
            if (!target.block) return false;

            const url = target.link;
            if (!url) return false;

            const {
              block: { model },
              inlineEditor,
              selfInlineRange,
            } = target;
            const { parent } = model;

            if (!inlineEditor || !selfInlineRange || !parent) return false;

            // check if the url can be embedded as iframe block
            const embedIframeService = ctx.std.get(EmbedIframeService);
            const canEmbedAsIframe = embedIframeService.canEmbed(url);

            const options = ctx.std
              .get(EmbedOptionProvider)
              .getEmbedBlockOptions(url);
            return canEmbedAsIframe || options?.viewType === "embed";
          },
          run(ctx) {
            const target = ctx.message$.peek()?.element;
            if (!(target instanceof MyoxusLink)) return;
            if (!target.block) return;

            const url = target.link;
            if (!url) return;

            const {
              block: { model },
              inlineEditor,
              selfInlineRange,
            } = target;
            const { parent } = model;

            if (!inlineEditor || !selfInlineRange || !parent) return;

            // Clears
            ctx.reset();

            const index = parent.children.indexOf(model);
            const props = { url };
            let blockId: string | undefined;

            const embedIframeService = ctx.std.get(EmbedIframeService);
            const embedOptions = ctx.std
              .get(EmbedOptionProvider)
              .getEmbedBlockOptions(url);

            if (embedOptions?.viewType === "embed") {
              const flavour = embedOptions.flavour;
              blockId = ctx.store.addBlock(flavour, props, parent, index + 1);
            } else if (embedIframeService.canEmbed(url)) {
              blockId = embedIframeService.addEmbedIframeBlock(
                props,
                parent.id,
                index + 1,
              );
            }

            if (!blockId) return;

            const totalTextLength = inlineEditor.yTextLength;
            const inlineTextLength = selfInlineRange.length;
            if (totalTextLength === inlineTextLength) {
              ctx.store.deleteBlock(model);
            } else {
              inlineEditor.formatText(selfInlineRange, { link: null });
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
        if (!(target instanceof MyoxusLink)) return false;
        if (!target.block) return false;

        if (ctx.flags.isNative()) return false;
        if (
          target.block.closest("myoxus-database") ||
          target.block.closest("myoxus-table")
        )
          return false;

        if (!target.link.startsWith("http")) return false;

        const { model } = target.block;
        const parent = model.parent;
        if (!parent) return false;

        const schema = ctx.store.schema;
        const bookmarkSchema = schema.flavourSchemaMap.get("myoxus:bookmark");
        if (!bookmarkSchema) return false;

        const parentSchema = schema.flavourSchemaMap.get(parent.flavour);
        if (!parentSchema) return false;

        try {
          schema.validateSchema(bookmarkSchema, parentSchema);
        } catch {
          return false;
        }

        return true;
      },
    } satisfies ToolbarActionGroup<ToolbarAction>,
    {
      placement: ActionPlacement.More,
      id: "b.remove-link",
      label: editorMessage(
        "com.myoxus.database.rich-text.unlink",
        "Remove link",
      ),
      icon: "UnlinkIcon",
      run(ctx) {
        const target = ctx.message$.peek()?.element;
        if (!(target instanceof MyoxusLink)) return;

        const { inlineEditor, selfInlineRange } = target;
        if (!inlineEditor || !selfInlineRange) return;

        if (!inlineEditor.isValidInlineRange(selfInlineRange)) return;

        inlineEditor.formatText(selfInlineRange, { link: null });
      },
    },
    {
      placement: ActionPlacement.More,
      id: "c.delete",
      label: editorMessage("Delete", "Delete"),
      icon: "DeleteIcon",
      variant: "destructive",
      run(ctx) {
        const target = ctx.message$.peek()?.element;
        if (!(target instanceof MyoxusLink)) return;

        const { inlineEditor, selfInlineRange } = target;
        if (!inlineEditor || !selfInlineRange) return;

        if (!inlineEditor.isValidInlineRange(selfInlineRange)) return;

        inlineEditor.deleteText(selfInlineRange);
      },
    },
  ],
} as const satisfies ToolbarModuleConfig;
