import { copyTextToClipboard } from "@virgultum/global/utils";
import {
  type ToolbarActionGenerator,
  resolveToolbarChoice,
  ActionPlacement,
  EmbedIframeService,
  EmbedOptionProvider,
  type LinkEventType,
  type ToolbarAction,
  type ToolbarActionGroup,
  type ToolbarContext,
  type ToolbarModuleConfig,
  ToolbarModuleExtension,
  editorMessage,
} from "@virgultum/shared/services";
import { getHostName, normalizeUrl, isValidUrl } from "@virgultum/shared/utils";
import { computed } from "@preact/signals-core";
import {
  canEmbedAsEmbedBlock,
  canEmbedAsIframe,
  EMBED_IFRAME_DEFAULT_HEIGHT_IN_SURFACE,
  EMBED_IFRAME_DEFAULT_WIDTH_IN_SURFACE,
} from "@virgultum/block-embed";
import { reassociateConnectorsCommand } from "@virgultum/block-surface";
import { Bound } from "@virgultum/global/gfx";
import {
  BookmarkBlockModel,
  BookmarkStyles,
  type EmbedCardStyle,
} from "@virgultum/model";
import { EMBED_CARD_HEIGHT, EMBED_CARD_WIDTH } from "@virgultum/shared/consts";

import { editorToast, getBlockProps } from "@virgultum/shared/utils";

import { BlockFlavourIdentifier, BlockSelection } from "@virgultum/std";
import { type ExtensionType, Slice, Text } from "@virgultum/store";

import * as Y from "yjs";

import { BookmarkBlockComponent } from "../bookmark-block";

const trackBaseProps = {
  category: "bookmark",
  type: "card view",
};

const previewAction = {
  id: "a.preview",
  generate(ctx) {
    const model = ctx.getCurrentModelByType(BookmarkBlockModel);
    if (!model) return null;
    const { url } = model.props;

    const normalized = normalizeUrl(url);
    const safeUrl = normalized && isValidUrl(normalized) ? normalized : null;
    return {
      label: getHostName(safeUrl ?? url),
      showLabel: true,
      icon: "LinkIcon",
      disabled: !safeUrl,
      run: () => {
        if (safeUrl) window.open(safeUrl, "_blank", "noopener,noreferrer");
      },
    };
  },
} satisfies ToolbarActionGenerator;

const copyLinkAction = {
  id: "a.copy-link",
  tooltip: editorMessage("com.myoxus.editor.toolbar.copy-link", "Copy link"),
  icon: "CopyIcon",
  async run(ctx) {
    const model = ctx.getCurrentModelByType(BookmarkBlockModel);
    if (!model) return;

    const { url } = model.props;
    if (!(await copyTextToClipboard(url))) return;
    editorToast(
      ctx.host,
      editorMessage("Copied link to clipboard", "Copied link to clipboard"),
    );

    ctx.track("CopiedLink", {
      ...trackBaseProps,
      control: "copy link",
    });
  },
} satisfies ToolbarAction;

const captionAction = {
  id: "d.caption",
  tooltip: editorMessage("com.myoxus.editor.toolbar.caption", "Caption"),
  icon: "CaptionIcon",
  run(ctx) {
    const block = ctx.getCurrentBlockByType(BookmarkBlockComponent);
    block?.captionEditor?.show();

    ctx.track("OpenedCaptionEditor", {
      ...trackBaseProps,
      control: "add caption",
    });
  },
} satisfies ToolbarAction;

const createOnToggleFn =
  (
    ctx: ToolbarContext,
    name: Extract<
      LinkEventType,
      | "OpenedViewSelector"
      | "OpenedCardStyleSelector"
      | "OpenedCardScaleSelector"
    >,
    control: string,
  ) =>
  () => {
    ctx.track(name, {
      ...trackBaseProps,
      control,
    });
  };

const builtinToolbarConfig = {
  actions: [
    previewAction,
    copyLinkAction,
    {
      id: "b.conversions",
      actions: [
        {
          id: "inline",
          label: editorMessage(
            "com.myoxus.editor.toolbar.inline-view",
            "Inline view",
          ),
          run(ctx) {
            const model = ctx.getCurrentModelByType(BookmarkBlockModel);
            if (!model) return;

            const { title, caption, url } = model.props;
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
          disabled: true,
        },
        {
          id: "embed",
          label: editorMessage(
            "com.myoxus.editor.toolbar.embed-view",
            "Embed view",
          ),
          disabled(ctx) {
            const model = ctx.getCurrentModelByType(BookmarkBlockModel);
            if (!model) return true;

            const url = model.props.url;

            return (
              !canEmbedAsIframe(ctx.std, url) &&
              !canEmbedAsEmbedBlock(ctx.std, url)
            );
          },
          run(ctx) {
            const model = ctx.getCurrentModelByType(BookmarkBlockModel);
            if (!model) return;

            const { caption, url, title, description, style } = model.props;
            const { parent } = model;
            const index = parent?.children.indexOf(model);
            if (!parent) return;

            let blockId: string | undefined;

            // first try to embed as a custom embed block
            if (canEmbedAsEmbedBlock(ctx.std, url)) {
              const options = ctx.std
                .get(EmbedOptionProvider)
                .getEmbedBlockOptions(url);

              if (!options) return;

              const { flavour, styles } = options;

              const newStyle = styles.includes(style)
                ? style
                : styles.find((s) => s !== "vertical" && s !== "cube");

              blockId = ctx.store.addBlock(
                flavour,
                {
                  url,
                  caption,
                  title,
                  description,
                  style: newStyle,
                },
                parent,
                index,
              );
            } else if (canEmbedAsIframe(ctx.std, url)) {
              const embedIframeService = ctx.std.get(EmbedIframeService);
              blockId = embedIframeService.addEmbedIframeBlock(
                { url, caption, title, description },
                parent.id,
                index,
              );
            }

            if (!blockId) return;

            ctx.store.deleteBlock(model);

            // Selects new block
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
        "com.myoxus.keyboardShortcuts.switch",
        "Switch view",
      ),
      control(ctx) {
        const model = ctx.getCurrentModelByType(BookmarkBlockModel);
        if (!model) return null;

        const actions = this.actions.map((action) => ({ ...action }));
        const onToggle = createOnToggleFn(
          ctx,
          "OpenedViewSelector",
          "switch view",
        );

        return resolveToolbarChoice(actions, ctx, "card", onToggle);
      },
    } satisfies ToolbarActionGroup<ToolbarAction>,
    {
      id: "c.style",
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
        const model = ctx.getCurrentModelByType(BookmarkBlockModel);
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
            const model = ctx.getCurrentModelByType(BookmarkBlockModel);
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
            const model = ctx.getCurrentModelByType(BookmarkBlockModel);
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
      id: "b.refresh",
      label: editorMessage("com.myoxus.editor.toolbar.reload", "Reload"),
      icon: "ResetIcon",
      run(ctx) {
        const block = ctx.getCurrentBlockByType(BookmarkBlockComponent);
        block?.refreshData();
      },
    },
    {
      placement: ActionPlacement.More,
      id: "c.delete",
      label: editorMessage("Delete", "Delete"),
      icon: "DeleteIcon",
      variant: "destructive",
      run(ctx) {
        const model = ctx.getCurrentModelByType(BookmarkBlockModel);
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
    previewAction,
    {
      id: "b.conversions",
      actions: [
        {
          id: "card",
          label: editorMessage(
            "com.myoxus.editor.toolbar.card-view",
            "Card view",
          ),
          disabled: true,
        },
        {
          id: "embed",
          label: editorMessage(
            "com.myoxus.editor.toolbar.embed-view",
            "Embed view",
          ),
          run(ctx) {
            const model = ctx.getCurrentModelByType(BookmarkBlockModel);
            if (!model) return;

            const { id: oldId, xywh, parent } = model;
            const { url, caption, title, description } = model.props;

            let newId: string | undefined;

            // first try to embed as a custom embed block
            if (canEmbedAsEmbedBlock(ctx.std, url)) {
              const options = ctx.std
                .get(EmbedOptionProvider)
                .getEmbedBlockOptions(url);

              if (options?.viewType !== "embed") return;

              const { flavour, styles } = options;
              let style: EmbedCardStyle = model.props.style;

              if (!styles.includes(style)) {
                style = styles[0];
              }

              const bound = Bound.deserialize(xywh);
              bound.w = EMBED_CARD_WIDTH[style];
              bound.h = EMBED_CARD_HEIGHT[style];

              newId = ctx.store.addBlock(
                flavour,
                {
                  url,
                  caption,
                  title,
                  description,
                  style,
                  xywh: bound.serialize(),
                },
                parent,
              );
            } else if (canEmbedAsIframe(ctx.std, url)) {
              const embedIframeService = ctx.std.get(EmbedIframeService);
              const config = embedIframeService.getConfig(url);
              if (!config) {
                return;
              }

              const bound = Bound.deserialize(xywh);
              const options = config.options;
              const { widthInSurface, heightInSurface } = options ?? {};
              bound.w = widthInSurface ?? EMBED_IFRAME_DEFAULT_WIDTH_IN_SURFACE;
              bound.h =
                heightInSurface ?? EMBED_IFRAME_DEFAULT_HEIGHT_IN_SURFACE;

              newId = ctx.store.addBlock(
                "myoxus:embed-iframe",
                { url, caption, title, description, xywh: bound.serialize() },
                parent,
              );
            }

            if (!newId) return;

            ctx.command.exec(reassociateConnectorsCommand, { oldId, newId });

            ctx.store.deleteBlock(model);

            // Selects new block
            ctx.gfx.selection.set({ editing: false, elements: [newId] });

            ctx.track("SelectedView", {
              ...trackBaseProps,
              control: "select view",
              type: "embed view",
            });
          },
        },
      ],
      when(ctx) {
        const model = ctx.getCurrentModelByType(BookmarkBlockModel);
        if (!model) return false;
        const { url } = model.props;
        return (
          canEmbedAsIframe(ctx.std, url) || canEmbedAsEmbedBlock(ctx.std, url)
        );
      },
      label: editorMessage(
        "com.myoxus.keyboardShortcuts.switch",
        "Switch view",
      ),
      control(ctx) {
        const model = ctx.getCurrentModelByType(BookmarkBlockModel);
        if (!model) return null;

        const actions = this.actions.map((action) => ({ ...action }));
        const onToggle = createOnToggleFn(
          ctx,
          "OpenedViewSelector",
          "switch view",
        );

        return resolveToolbarChoice(actions, ctx, "card", onToggle);
      },
    } satisfies ToolbarActionGroup<ToolbarAction>,
    {
      id: "b.style",
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
      ).filter((action) => BookmarkStyles.includes(action.id)),
      label: editorMessage(
        "com.myoxus.editor.toolbar.card-style",
        "Card style",
      ),
      control(ctx) {
        const model = ctx.getCurrentModelByType(BookmarkBlockModel);
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
    {
      ...captionAction,
      id: "c.caption",
    },
    {
      id: "d.scale",
      label: editorMessage("com.myoxus.editor.toolbar.scale", "Scale"),
      control(ctx) {
        const model = ctx.getCurrentModelByType(BookmarkBlockModel);
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
          bounds.w = EMBED_CARD_WIDTH[style] * scale;
          bounds.h = EMBED_CARD_HEIGHT[style] * scale;
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

  when: (ctx) => ctx.getSurfaceModelsByType(BookmarkBlockModel).length === 1,
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
