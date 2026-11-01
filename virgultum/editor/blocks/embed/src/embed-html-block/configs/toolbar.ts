import {
  resolveToolbarChoice,
  ActionPlacement,
  type ToolbarAction,
  type ToolbarActionGroup,
  type ToolbarModuleConfig,
  ToolbarModuleExtension,
  editorMessage,
} from "@virgultum/shared/services";
import { EmbedHtmlModel } from "@virgultum/model";
import { editorToast, getBlockProps } from "@virgultum/shared/utils";

import { BlockFlavourIdentifier } from "@virgultum/std";
import { type ExtensionType, Slice } from "@virgultum/store";

import { EmbedHtmlBlockComponent } from "../embed-html-block";

const trackBaseProps = {
  category: "html",
  type: "card view",
};

const openDocAction = {
  id: "a.open-doc",
  icon: "ExpandFullIcon",
  tooltip: editorMessage(
    "com.myoxus.peek-view-controls.open-doc",
    "Open this doc",
  ),
  run(ctx) {
    const block = ctx.getCurrentBlockByType(EmbedHtmlBlockComponent);
    block?.open();
  },
} as const satisfies ToolbarAction;

const captionAction = {
  id: "c.caption",
  tooltip: editorMessage("com.myoxus.editor.toolbar.caption", "Caption"),
  icon: "CaptionIcon",
  run(ctx) {
    const block = ctx.getCurrentBlockByType(EmbedHtmlBlockComponent);
    block?.captionEditor?.show();

    ctx.track("OpenedCaptionEditor", {
      ...trackBaseProps,
      control: "add caption",
    });
  },
} as const satisfies ToolbarAction;

const builtinToolbarConfig = {
  actions: [
    openDocAction,
    {
      id: "b.style",
      actions: [
        {
          id: "horizontal",
          label: editorMessage(
            "com.myoxus.editor.toolbar.large-horizontal-style",
            "Large horizontal style",
          ),
        },
        {
          id: "list",
          label: editorMessage(
            "com.myoxus.editor.toolbar.small-horizontal-style",
            "Small horizontal style",
          ),
        },
      ],
      label: editorMessage(
        "com.myoxus.editor.toolbar.card-style",
        "Card style",
      ),
      control(ctx) {
        const model = ctx.getCurrentModelByType(EmbedHtmlModel);
        if (!model) return null;

        const actions = this.actions.map<ToolbarAction>((action) => ({
          ...action,
          run: ({ store }) => {
            store.updateBlock(model, { style: action.id });

            ctx.track("SelectedCardStyle", {
              ...trackBaseProps,
              control: "select card style",
              type: action.id,
            });
          },
        }));
        const onToggle = () => {
          ctx.track("OpenedCardStyleSelector", {
            ...trackBaseProps,
            control: "switch card style",
          });
        };

        return resolveToolbarChoice(
          actions,
          ctx,
          model.props.style$.value,
          onToggle,
        );
      },
    } satisfies ToolbarActionGroup<ToolbarAction>,
    captionAction,
    {
      placement: ActionPlacement.More,
      id: "a.clipboard",
      actions: [
        {
          id: "copy",
          label: editorMessage("Copy", "Copy"),
          icon: "CopyIcon",
          run(ctx) {
            const model = ctx.getCurrentModelByType(EmbedHtmlModel);
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
            const model = ctx.getCurrentModelByType(EmbedHtmlModel);
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
      id: "c.delete",
      label: editorMessage("Delete", "Delete"),
      icon: "DeleteIcon",
      variant: "destructive",
      run(ctx) {
        const model = ctx.getCurrentModelByType(EmbedHtmlModel);
        if (!model) return;

        ctx.store.deleteBlock(model);

        // Clears
        ctx.select("note");
        ctx.reset();
      },
    },
  ],

  when: (ctx) => ctx.getSurfaceModelsByType(EmbedHtmlModel).length === 1,
} as const satisfies ToolbarModuleConfig;

const builtinSurfaceToolbarConfig = {
  actions: [
    openDocAction,
    {
      ...captionAction,
      id: "b.caption",
    },
  ],
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
      id: BlockFlavourIdentifier(`affine:surface:${name}`),
      config: builtinSurfaceToolbarConfig,
    }),
  ];
};
