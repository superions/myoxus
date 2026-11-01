import {
  resolveToolbarChoice,
  editorMessage,
  ActionPlacement,
  type ToolbarAction,
  type ToolbarActionGroup,
  type ToolbarContext,
  type ToolbarModuleConfig,
  ToolbarModuleExtension,
} from "@virgultum/shared/services";

import { computed } from "@preact/signals-core";
import { reassociateConnectorsCommand } from "@virgultum/block-surface";
import { Bound } from "@virgultum/global/gfx";
import { BookmarkStyles, EmbedIframeBlockModel } from "@virgultum/model";
import { EMBED_CARD_HEIGHT, EMBED_CARD_WIDTH } from "@virgultum/shared/consts";

import { editorToast, getBlockProps } from "@virgultum/shared/utils";

import { BlockFlavourIdentifier, BlockSelection } from "@virgultum/std";
import {
  type ExtensionType,
  Slice,
  Text,
  toDraftModel,
} from "@virgultum/store";

import * as Y from "yjs";

import {
  convertSelectedBlocksToLinkedDoc,
  getTitleFromSelectedModels,
  notifyDocCreated,
  promptDocTitle,
} from "../../common/render-linked-doc";
import { EmbedIframeBlockComponent } from "../embed-iframe-block";

const trackBaseProps = {
  category: "embed iframe block",
};

const showWhenUrlExists = (ctx: ToolbarContext) => {
  const model = ctx.getCurrentModelByType(EmbedIframeBlockModel);
  if (!model) return false;

  return !!model.props.url;
};

const openLinkAction = (id: string): ToolbarAction => {
  return {
    id,
    when: showWhenUrlExists,
    tooltip: editorMessage("com.myoxus.editor.toolbar.original", "Original"),
    icon: "OpenInNewIcon",
    run(ctx) {
      const component = ctx.getCurrentBlockByType(EmbedIframeBlockComponent);
      component?.open();

      ctx.track("OpenLink", {
        ...trackBaseProps,
        control: "open original link",
      });
    },
  };
};

const captionAction = (id: string): ToolbarAction => {
  return {
    id,
    when: showWhenUrlExists,
    tooltip: editorMessage("com.myoxus.editor.toolbar.caption", "Caption"),
    icon: "CaptionIcon",
    run(ctx) {
      const component = ctx.getCurrentBlockByType(EmbedIframeBlockComponent);
      component?.captionEditor?.show();

      ctx.track("OpenedCaptionEditor", {
        ...trackBaseProps,
        control: "add caption",
      });
    },
  };
};

export const builtinToolbarConfig = {
  actions: [
    openLinkAction("a.open-link"),
    {
      id: "c.conversions",
      when: showWhenUrlExists,
      actions: [
        {
          id: "inline",
          label: editorMessage(
            "com.myoxus.editor.toolbar.inline-view",
            "Inline view",
          ),
          run(ctx) {
            const model = ctx.getCurrentModelByType(EmbedIframeBlockModel);
            if (!model) return;

            const { title, caption, url } = model.props;
            if (!url) return;

            const { parent } = model;
            const index = parent?.children.indexOf(model);

            const yText = new Y.Text();
            const insert = title || caption || url;
            yText.insert(0, insert);
            yText.format(0, insert.length, { link: url });

            const text = new Text(yText);

            ctx.store.addBlock("myoxus:paragraph", { text }, parent, index);

            ctx.store.deleteBlock(model);

            // Clears
            ctx.reset();
            ctx.select("note");

            ctx.track("SelectedView", {
              ...trackBaseProps,
              control: "select view",
              type: "inline view",
            });
          },
        },
        {
          id: "card",
          label: editorMessage(
            "com.myoxus.editor.toolbar.card-view",
            "Card view",
          ),
          run(ctx) {
            const model = ctx.getCurrentModelByType(EmbedIframeBlockModel);
            if (!model) return;

            const { url, caption } = model.props;
            if (!url) return;

            const { parent } = model;
            const index = parent?.children.indexOf(model);

            const flavour = "myoxus:bookmark";
            const style =
              BookmarkStyles.find((s) => s !== "vertical" && s !== "cube") ??
              BookmarkStyles[1];

            const blockId = ctx.store.addBlock(
              flavour,
              { url, caption, style },
              parent,
              index,
            );

            ctx.store.deleteBlock(model);

            // Selects new block
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
          disabled: true,
        },
      ],
      label: editorMessage(
        "com.myoxus.keyboardShortcuts.switch",
        "Switch view",
      ),
      control(ctx) {
        const model = ctx.getCurrentModelByType(EmbedIframeBlockModel);
        if (!model) return null;

        const actions = this.actions.map((action) => ({ ...action }));
        const toggle = () => {
          ctx.track("OpenedViewSelector", {
            ...trackBaseProps,
            control: "switch view",
          });
        };

        return resolveToolbarChoice(actions, ctx, "embed", toggle);
      },
    } satisfies ToolbarActionGroup<ToolbarAction>,
    captionAction("d.caption"),
    {
      id: "e.convert-to-linked-doc",
      tooltip: editorMessage(
        "com.myoxus.editor.toolbar.create-linked-doc",
        "Create Linked Doc",
      ),
      icon: "LinkedPageIcon",
      run(ctx) {
        const model = ctx.getCurrentModelByType(EmbedIframeBlockModel);
        if (!model) return;

        const { store, std, selection, track } = ctx;
        selection.clear();

        const draftedModels = [model].map(toDraftModel);
        const autofill = getTitleFromSelectedModels(draftedModels);
        promptDocTitle(std, autofill)
          .then(async (title) => {
            if (title === null) return;
            await convertSelectedBlocksToLinkedDoc(
              std,
              store,
              draftedModels,
              title,
            );
            notifyDocCreated(std);

            track("DocCreated", {
              segment: "doc",
              page: "doc editor",
              module: "toolbar",
              control: "create linked doc",
              type: "embed-linked-doc",
            });

            track("LinkedDocCreated", {
              segment: "doc",
              page: "doc editor",
              module: "toolbar",
              control: "create linked doc",
              type: "embed-linked-doc",
            });
          })
          .catch(console.error);
      },
    },
    {
      placement: ActionPlacement.More,
      id: "a.clipboard",
      actions: [
        {
          id: "copy",
          label: editorMessage("Copy", "Copy"),
          icon: "CopyIcon",
          run(ctx) {
            const model = ctx.getCurrentModelByType(EmbedIframeBlockModel);
            if (!model) return;

            const slice = Slice.fromModels(ctx.store, [model]);
            ctx.clipboard
              .copySlice(slice)
              .then(() =>
                editorToast(
                  ctx.host,
                  editorMessage("Copied to clipboard", "Copied to clipboard"),
                ),
              )
              .catch(console.error);

            ctx.track("CopiedLink", {
              ...trackBaseProps,
              control: "copy link",
            });
          },
        },
        {
          id: "duplicate",
          label: editorMessage(
            "com.myoxus.editor.keyboard.duplicate",
            "Duplicate",
          ),
          icon: "DuplicateIcon",
          run(ctx) {
            const model = ctx.getCurrentModelByType(EmbedIframeBlockModel);
            if (!model) return;

            const { flavour, parent } = model;
            const props = getBlockProps(model);
            const index = parent?.children.indexOf(model);

            ctx.store.addBlock(flavour, props, parent, index);
          },
        },
      ],
    },
    {
      placement: ActionPlacement.More,
      id: "b.reload",
      label: editorMessage("com.myoxus.editor.toolbar.reload", "Reload"),
      icon: "ResetIcon",
      run(ctx) {
        const component = ctx.getCurrentBlockByType(EmbedIframeBlockComponent);
        component
          ?.refreshData()
          .then((success) => {
            ctx.track("ReloadLink", {
              type: "embed iframe block",
              page: "doc editor",
              segment: "doc",
              module: "toolbar",
              control: "reload link",
              result: success ? "success" : "failure",
            });
          })
          .catch(console.error);
      },
    },
    {
      placement: ActionPlacement.More,
      id: "c.delete",
      label: editorMessage("Delete", "Delete"),
      icon: "DeleteIcon",
      variant: "destructive",
      run(ctx) {
        const model = ctx.getCurrentModelByType(EmbedIframeBlockModel);
        if (!model) return;

        ctx.store.deleteBlock(model);

        // Clears
        ctx.select("note");
        ctx.reset();
      },
    },
  ],
} as const satisfies ToolbarModuleConfig;

export const builtinSurfaceToolbarConfig = {
  actions: [
    openLinkAction("a.open-link"),
    {
      id: "c.conversions",
      when: showWhenUrlExists,
      actions: [
        {
          id: "card",
          label: editorMessage(
            "com.myoxus.editor.toolbar.card-view",
            "Card view",
          ),
          run(ctx) {
            const model = ctx.getCurrentModelByType(EmbedIframeBlockModel);
            if (!model) return;

            const { id: oldId, xywh, parent } = model;
            const { url, caption } = model.props;

            if (!url) return;

            const style =
              BookmarkStyles.find((s) => s !== "vertical" && s !== "cube") ??
              BookmarkStyles[1];
            let flavour = "myoxus:bookmark";

            const bounds = Bound.deserialize(xywh);
            bounds.w = EMBED_CARD_WIDTH[style];
            bounds.h = EMBED_CARD_HEIGHT[style];

            const newId = ctx.store.addBlock(
              flavour,
              { url, caption, style, xywh: bounds.serialize() },
              parent,
            );

            ctx.command.exec(reassociateConnectorsCommand, { oldId, newId });

            ctx.store.deleteBlock(model);

            // Selects new block
            ctx.gfx.selection.set({ editing: false, elements: [newId] });

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
          disabled: true,
        },
      ],
      label: editorMessage(
        "com.myoxus.keyboardShortcuts.switch",
        "Switch view",
      ),
      control(ctx) {
        const model = ctx.getCurrentModelByType(EmbedIframeBlockModel);
        if (!model) return null;

        const actions = this.actions.map((action) => ({ ...action }));
        const onToggle = () => {
          ctx.track("OpenedViewSelector", {
            ...trackBaseProps,
            control: "switch view",
          });
        };

        return resolveToolbarChoice(actions, ctx, "embed", onToggle);
      },
    } satisfies ToolbarActionGroup<ToolbarAction>,
    captionAction("d.caption"),
    {
      id: "e.scale",
      label: editorMessage("com.myoxus.editor.toolbar.scale", "Scale"),
      control(ctx) {
        const model = ctx.getCurrentModelByType(EmbedIframeBlockModel);
        if (!model) return null;

        const scale$ = computed(() => {
          const scale = model.props.scale$.value ?? 1;
          return Math.round(100 * scale);
        });
        const onSelect = (value: number) => {
          const scale = value / 100;

          const bounds = Bound.deserialize(model.xywh);
          const oldScale = model.props.scale ?? 1;
          const ratio = scale / oldScale;
          bounds.w *= ratio;
          bounds.h *= ratio;
          const xywh = bounds.serialize();

          ctx.store.updateBlock(model, () => {
            model.xywh = xywh;
            model.props.scale = scale;
          });

          ctx.track("SelectedCardScale", {
            ...trackBaseProps,
            control: "select card scale",
          });
        };
        const onToggle = () => {
          ctx.track("OpenedCardScaleSelector", {
            ...trackBaseProps,
            control: "switch card scale",
          });
        };

        return {
          type: "number",
          value: scale$.value,
          min: 0,
          max: 400,
          suffix: "%",
          onOpen: onToggle,
          change(value) {
            if (typeof value === "number") onSelect(value);
          },
        };
      },
    },
  ],
  when: (ctx) => ctx.getSurfaceModelsByType(EmbedIframeBlockModel).length > 0,
} as const satisfies ToolbarModuleConfig;

export const createBuiltinToolbarConfigExtension = (
  flavour: string,
): ExtensionType[] => {
  const name = flavour.split(":").pop();

  return [
    ToolbarModuleExtension({
      id: BlockFlavourIdentifier(flavour),
      config: builtinToolbarConfig,
    }),
    ToolbarModuleExtension({
      id: BlockFlavourIdentifier(`myoxus:surface:${name}`),
      config: builtinSurfaceToolbarConfig,
    }),
  ];
};
