import {
  type ToolbarActionGenerator,
  resolveToolbarChoice,
  ActionPlacement,
  DocDisplayMetaProvider,
  EditorSettingProvider,
  type LinkEventType,
  type OpenDocMode,
  type ToolbarAction,
  type ToolbarActionGroup,
  type ToolbarContext,
  type ToolbarModuleConfig,
  ToolbarModuleExtension,
  editorMessage,
} from "@virgultum/shared/services";
import { computed } from "@preact/signals-core";
import { toggleEmbedCardEditModal } from "@virgultum/components/embed-card-modal";

import { Bound } from "@virgultum/global/gfx";
import {
  type EmbedCardStyle,
  EmbedLinkedDocModel,
  EmbedLinkedDocStyles,
} from "@virgultum/model";
import { EMBED_CARD_HEIGHT, EMBED_CARD_WIDTH } from "@virgultum/shared/consts";
import {
  editorToast,
  getBlockProps,
  referenceToNode,
} from "@virgultum/shared/utils";

import { BlockFlavourIdentifier, isGfxBlockComponent } from "@virgultum/std";
import { type ExtensionType, Slice } from "@virgultum/store";

import { EmbedLinkedDocBlockComponent } from "../embed-linked-doc-block";

const trackBaseProps = {
  category: "linked doc",
  type: "card view",
};

const createOnToggleFn =
  (
    ctx: ToolbarContext,
    name: Extract<
      LinkEventType,
      | "OpenedViewSelector"
      | "OpenedCardStyleSelector"
      | "OpenedCardScaleSelector"
    >,
    control: "switch view" | "switch card style" | "switch card scale",
  ) =>
  () => {
    ctx.track(name, { ...trackBaseProps, control });
  };

const docTitleAction = {
  id: "a.doc-title",
  generate(ctx) {
    const block = ctx.getCurrentBlockByType(EmbedLinkedDocBlockComponent);
    if (!block || !block.model.props.title) return null;
    const title =
      ctx.std.get(DocDisplayMetaProvider).title(block.model.props.pageId)
        .value || "Untitled";
    return {
      label: title,
      showLabel: true,
      icon: "LinkedPageIcon",
      run: (_ctx, _anchor, event) => block.open({ event }),
    };
  },
} as const satisfies ToolbarActionGenerator;

const captionAction = {
  id: "d.caption",
  tooltip: editorMessage("com.myoxus.editor.toolbar.caption", "Caption"),
  icon: "CaptionIcon",
  run(ctx) {
    const block = ctx.getCurrentBlockByType(EmbedLinkedDocBlockComponent);
    block?.captionEditor?.show();

    ctx.track("OpenedCaptionEditor", {
      ...trackBaseProps,
      control: "add caption",
    });
  },
} as const satisfies ToolbarAction;

const editAliasAction = {
  id: "c.edit-alias",
  tooltip: editorMessage("Edit", "Edit"),
  icon: "EditIcon",
  run(ctx) {
    const block = ctx.getCurrentBlockByType(EmbedLinkedDocBlockComponent);
    if (!block) return;

    const model = block.model;
    const originalTitle = block.linkedDoc?.meta?.title || "Untitled";
    const abortController = new AbortController();
    toggleEmbedCardEditModal(
      ctx.host,
      model,
      "card view",
      { title: originalTitle, description: "" },
      undefined,
      (_std, component, props) => {
        if (!(component instanceof EmbedLinkedDocBlockComponent)) return;
        component.store.updateBlock(component.model, props);
        component.requestUpdate();
      },
      abortController,
    );

    ctx.track("OpenedAliasPopup", {
      ...trackBaseProps,
      control: "edit",
    });
  },
} as const satisfies ToolbarAction;

const openDocActions = [
  {
    mode: "open-in-active-view",
    id: "a.open-in-active-view",
    label: editorMessage(
      "com.myoxus.peek-view-controls.open-doc",
      "Open this doc",
    ),
    icon: "ExpandFullIcon",
  },
] as const satisfies (Pick<ToolbarAction, "id" | "label" | "icon"> & {
  mode: OpenDocMode;
})[];

const openDocActionGroup = {
  placement: ActionPlacement.Start,
  id: "A.open-doc",
  generate(ctx) {
    const block = ctx.getCurrentBlockByType(EmbedLinkedDocBlockComponent);
    if (!block) return null;
    return {
      label: editorMessage("com.myoxus.editor.toolbar.open-doc", "Open doc"),
      icon: "OpenInNewIcon",
      control: {
        type: "menu",
        items: openDocActions.map((action) => ({
          ...action,
          disabled: block.model.props.pageId === ctx.store.id,
          run: () => block.open({ openMode: action.mode }),
        })),
      },
    };
  },
} as const satisfies ToolbarActionGenerator;

const conversionsActionGroup = {
  id: "b.conversions",
  actions: [
    {
      id: "inline",
      label: editorMessage(
        "com.myoxus.editor.toolbar.inline-view",
        "Inline view",
      ),
      run(ctx) {
        const block = ctx.getCurrentBlockByType(EmbedLinkedDocBlockComponent);
        block?.convertToInline();

        // Clears
        ctx.select("note");
        ctx.reset();

        ctx.track("SelectedView", {
          ...trackBaseProps,
          control: "select view",
          type: "inline view",
        });
      },
      when: (ctx) => !ctx.hasSelectedSurfaceModels,
    },
    {
      id: "card",
      label: editorMessage("com.myoxus.editor.toolbar.card-view", "Card view"),
      disabled: true,
    },
    {
      id: "embed",
      label: editorMessage(
        "com.myoxus.editor.toolbar.embed-view",
        "Embed view",
      ),
      disabled(ctx) {
        const block = ctx.getCurrentBlockByType(EmbedLinkedDocBlockComponent);
        if (!block) return true;

        if (block.closest("myoxus-embed-synced-doc-block")) return true;

        const model = block.model;

        // same doc
        if (model.props.pageId === ctx.store.id) return true;

        // linking to block
        if (referenceToNode(model.props)) return true;

        return false;
      },
      run(ctx) {
        const block = ctx.getCurrentBlockByType(EmbedLinkedDocBlockComponent);

        if (isGfxBlockComponent(block)) {
          const editorSetting = ctx.std.getOptional(EditorSettingProvider);
          editorSetting?.set?.(
            "docCanvasPreferView",
            "myoxus:embed-synced-doc",
          );
        }

        block?.convertToEmbed();

        ctx.track("SelectedView", {
          ...trackBaseProps,
          control: "select view",
          type: "embed view",
        });
      },
    },
  ],
  label: editorMessage("com.myoxus.keyboardShortcuts.switch", "Switch view"),
  control(ctx) {
    const model = ctx.getCurrentModelByType(EmbedLinkedDocModel);
    if (!model) return null;

    const actions = this.actions.map((action) => ({ ...action }));
    const onToggle = createOnToggleFn(ctx, "OpenedViewSelector", "switch view");

    return resolveToolbarChoice(actions, ctx, "card", onToggle);
  },
} as const satisfies ToolbarActionGroup<ToolbarAction>;

const builtinToolbarConfig = {
  actions: [
    docTitleAction,
    conversionsActionGroup,
    editAliasAction,
    {
      id: "c.style",
      actions: (
        [
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
        ] as const
      ).filter((action) => EmbedLinkedDocStyles.includes(action.id)),
      label: editorMessage(
        "com.myoxus.editor.toolbar.card-style",
        "Card style",
      ),
      control(ctx) {
        const model = ctx.getCurrentModelByType(EmbedLinkedDocModel);
        if (!model) return null;

        const actions = this.actions.map((action) => ({
          ...action,
          run: ({ store }) => {
            store.updateBlock(model, { style: action.id });

            ctx.track("SelectedCardStyle", {
              ...trackBaseProps,
              control: "select card style",
              type: action.id,
            });
          },
        })) satisfies ToolbarAction[];
        const onToggle = createOnToggleFn(
          ctx,
          "OpenedCardStyleSelector",
          "switch card style",
        );

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
            const model = ctx.getCurrentModelByType(EmbedLinkedDocModel);
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
            const model = ctx.getCurrentModelByType(EmbedLinkedDocModel);
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
        const model = ctx.getCurrentModelByType(EmbedLinkedDocModel);
        if (!model) return;

        ctx.store.deleteBlock(model);

        // Clears
        ctx.select("note");
        ctx.reset();
      },
    },
  ],
} as const satisfies ToolbarModuleConfig;

const builtinSurfaceToolbarConfig = {
  actions: [
    openDocActionGroup,
    docTitleAction,
    conversionsActionGroup,
    editAliasAction,
    {
      id: "c.style",
      actions: (
        [
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
          {
            id: "vertical",
            label: editorMessage(
              "com.myoxus.editor.toolbar.large-vertical-style",
              "Large vertical style",
            ),
          },
          {
            id: "cube",
            label: editorMessage(
              "com.myoxus.editor.toolbar.small-vertical-style",
              "Small vertical style",
            ),
          },
        ] as const
      ).filter((action) => EmbedLinkedDocStyles.includes(action.id)),
      label: editorMessage(
        "com.myoxus.editor.toolbar.card-style",
        "Card style",
      ),
      control(ctx) {
        const model = ctx.getCurrentModelByType(EmbedLinkedDocModel);
        if (!model) return null;

        const actions = this.actions.map((action) => ({
          ...action,
          run: ({ store }) => {
            const style = action.id as EmbedCardStyle;
            const bounds = Bound.deserialize(model.xywh);
            bounds.w = EMBED_CARD_WIDTH[style];
            bounds.h = EMBED_CARD_HEIGHT[style];
            const xywh = bounds.serialize();

            store.updateBlock(model, { style, xywh });

            ctx.track("SelectedCardStyle", {
              ...trackBaseProps,
              control: "select card style",
              type: style,
            });
          },
        })) satisfies ToolbarAction[];
        const style$ = model.props.style$;
        const onToggle = createOnToggleFn(
          ctx,
          "OpenedCardStyleSelector",
          "switch card style",
        );

        return resolveToolbarChoice(actions, ctx, style$.value, onToggle);
      },
    } satisfies ToolbarActionGroup<ToolbarAction>,
    captionAction,
    {
      id: "e.scale",
      label: editorMessage("com.myoxus.editor.toolbar.scale", "Scale"),
      control(ctx) {
        const model = ctx.getCurrentBlockByType(
          EmbedLinkedDocBlockComponent,
        )?.model;
        if (!model) return null;

        const scale$ = computed(() => {
          const {
            xywh$: { value: xywh },
          } = model;
          const {
            style$: { value: style },
          } = model.props;
          const bounds = Bound.deserialize(xywh);
          const height = EMBED_CARD_HEIGHT[style];
          return Math.round(100 * (bounds.h / height));
        });
        const onSelect = (value: number) => {
          const scale = value / 100;

          const bounds = Bound.deserialize(model.xywh);
          const style = model.props.style;
          bounds.h = EMBED_CARD_HEIGHT[style] * scale;
          bounds.w = EMBED_CARD_WIDTH[style] * scale;
          const xywh = bounds.serialize();

          ctx.store.updateBlock(model, { xywh });

          ctx.track("SelectedCardScale", {
            ...trackBaseProps,
            control: "select card scale",
          });
        };
        const onToggle = createOnToggleFn(
          ctx,
          "OpenedCardScaleSelector",
          "switch card scale",
        );

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

  when: (ctx) => ctx.getSurfaceModelsByType(EmbedLinkedDocModel).length === 1,
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
