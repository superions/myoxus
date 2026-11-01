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
  DEFAULT_NOTE_HEIGHT,
  DEFAULT_NOTE_WIDTH,
  EmbedSyncedDocModel,
  NoteBlockModel,
  NoteDisplayMode,
  type NoteProps,
  type ParagraphProps,
} from "@virgultum/model";
import { duplicateSelectedModelsCommand } from "@virgultum/shared/commands";
import { REFERENCE_NODE } from "@virgultum/shared/consts";
import type { MyoxusTextAttributes } from "@virgultum/shared/types";
import {
  editorToast,
  getBlockProps,
  matchModels,
} from "@virgultum/shared/utils";

import { BlockFlavourIdentifier, isGfxBlockComponent } from "@virgultum/std";
import { type ExtensionType, Slice, Text } from "@virgultum/store";

import { EmbedSyncedDocBlockComponent } from "../embed-synced-doc-block";
const trackBaseProps = {
  category: "linked doc",
  type: "embed view",
};

const createOnToggleFn =
  (
    ctx: ToolbarContext,
    name: Extract<
      LinkEventType,
      "OpenedViewSelector" | "OpenedCardScaleSelector"
    >,
    control: "switch view" | "switch card scale",
  ) =>
  () => {
    ctx.track(name, { ...trackBaseProps, control });
  };

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
    const block = ctx.getCurrentBlockByType(EmbedSyncedDocBlockComponent);
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
  id: "a.conversions",
  actions: [
    {
      id: "inline",
      label: editorMessage(
        "com.myoxus.editor.toolbar.inline-view",
        "Inline view",
      ),
      run(ctx) {
        const block = ctx.getCurrentBlockByType(EmbedSyncedDocBlockComponent);
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
      run(ctx) {
        const block = ctx.getCurrentBlockByType(EmbedSyncedDocBlockComponent);
        if (isGfxBlockComponent(block)) {
          const editorSetting = ctx.std.getOptional(EditorSettingProvider);
          editorSetting?.set?.(
            "docCanvasPreferView",
            "myoxus:embed-linked-doc",
          );
        }

        block?.convertToCard();

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
  label: editorMessage("com.myoxus.keyboardShortcuts.switch", "Switch view"),
  control(ctx) {
    const model = ctx.getCurrentModelByType(EmbedSyncedDocModel);
    if (!model) return null;

    const actions = this.actions.map((action) => ({ ...action }));
    const onToggle = createOnToggleFn(ctx, "OpenedViewSelector", "switch view");

    return resolveToolbarChoice(actions, ctx, "embed", onToggle);
  },
} as const satisfies ToolbarActionGroup<ToolbarAction>;

const captionAction = {
  id: "d.caption",
  tooltip: editorMessage("com.myoxus.editor.toolbar.caption", "Caption"),
  icon: "CaptionIcon",
  run(ctx) {
    const block = ctx.getCurrentBlockByType(EmbedSyncedDocBlockComponent);
    block?.captionEditor?.show();

    ctx.track("OpenedCaptionEditor", {
      ...trackBaseProps,
      control: "add caption",
    });
  },
} as const satisfies ToolbarAction;

const editAliasAction = {
  id: "b.edit-alias",
  tooltip: editorMessage("Edit", "Edit"),
  icon: "EditIcon",
  run(ctx) {
    const block = ctx.getCurrentBlockByType(EmbedSyncedDocBlockComponent);
    if (!block) return;

    const model = block.model;
    const originalTitle =
      ctx.std.get(DocDisplayMetaProvider).title(model.props.pageId).value ||
      "Untitled";
    const abortController = new AbortController();
    toggleEmbedCardEditModal(
      ctx.host,
      model,
      "embed view",
      { title: originalTitle, description: "" },
      undefined,
      (_std, component, props) => {
        if (!(component instanceof EmbedSyncedDocBlockComponent)) return;
        component.convertToCard(props);
      },
      abortController,
    );

    ctx.track("OpenedAliasPopup", {
      ...trackBaseProps,
      control: "edit",
    });
  },
} as const satisfies ToolbarAction;

const builtinToolbarConfig = {
  actions: [
    openDocActionGroup,
    conversionsActionGroup,
    editAliasAction,
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
            const model = ctx.getCurrentModelByType(EmbedSyncedDocModel);
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
            const model = ctx.getCurrentModelByType(EmbedSyncedDocModel);
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
        const model = ctx.getCurrentModelByType(EmbedSyncedDocModel);
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
    conversionsActionGroup,
    editAliasAction,
    {
      id: "b.insert-to-page",
      label: editorMessage(
        "com.myoxus.editor.toolbar.insert-to-page",
        "Insert to page",
      ),
      tooltip: editorMessage(
        "com.myoxus.editor.toolbar.insert-to-page",
        "Insert to page",
      ),
      icon: "InsertIntoPageIcon",
      run: (ctx) => {
        const model = ctx.getCurrentModelByType(EmbedSyncedDocModel);
        if (!model) return;

        const lastVisibleNote = ctx.store
          .getModelsByFlavour("myoxus:note")
          .findLast(
            (note): note is NoteBlockModel =>
              matchModels(note, [NoteBlockModel]) &&
              note.props.displayMode !== NoteDisplayMode.EdgelessOnly,
          );

        ctx.store.captureSync();
        ctx.chain
          .pipe(duplicateSelectedModelsCommand, {
            selectedModels: [model],
            parentModel: lastVisibleNote,
          })
          .run();

        ctx.track("BlockCreated", {
          page: "whiteboard editor",
          module: "toolbar",
          segment: "toolbar",
          blockType: "myoxus:embed-linked-doc",
          control: "toolbar:general",
          other: "insert to page",
        });
      },
    },
    {
      id: "c.duplicate-as-note",
      label: editorMessage(
        "com.myoxus.editor.toolbar.duplicate-as-note",
        "Duplicate as note",
      ),
      tooltip: editorMessage(
        "com.myoxus.editor.toolbar.duplicate-as-note-editable",
        "Duplicate as note to create an editable copy, the original remains unchanged.",
      ),
      icon: "DuplicateIcon",
      run: (ctx) => {
        const { gfx } = ctx;

        const syncedDocModel = ctx.getCurrentModelByType(EmbedSyncedDocModel);
        if (!syncedDocModel) return;

        const doc = ctx.store.workspace.getDoc(syncedDocModel.props.pageId);
        const sourceStore = doc?.getStore({ readonly: true });
        if (!sourceStore) return;
        const contentModels = sourceStore
          .getModelsByFlavour("myoxus:note")
          .filter(
            (note): note is NoteBlockModel =>
              matchModels(note, [NoteBlockModel]) &&
              note.props.displayMode !== NoteDisplayMode.EdgelessOnly,
          )
          .flatMap((note) => note.children);
        if (contentModels.length === 0) return;

        // This action copies complete Note content, not a partial selection.
        // Selection drafting prunes unselected descendants; the direct slice
        // retains their trees and the source document identity for references.
        const slice = Slice.fromModels(sourceStore, contentModels);

        ctx.store.captureSync();
        ctx.chain
          .pipe(({ std }, next) => {
            (async () => {
              const PADDING = 20;
              const x =
                syncedDocModel.elementBound.x +
                syncedDocModel.elementBound.w +
                PADDING;
              const y = syncedDocModel.elementBound.y;

              const noteId = std.store.addBlock(
                "myoxus:note",
                {
                  xywh: new Bound(
                    x,
                    y,
                    DEFAULT_NOTE_WIDTH,
                    DEFAULT_NOTE_HEIGHT,
                  ).serialize(),
                  index: gfx.layer.generateIndex(),
                  displayMode: NoteDisplayMode.EdgelessOnly,
                } satisfies Partial<NoteProps>,
                ctx.store.root,
              );

              std.store.addBlock(
                "myoxus:paragraph",
                {
                  text: new Text<MyoxusTextAttributes>([
                    {
                      insert: REFERENCE_NODE,
                      attributes: {
                        reference: {
                          type: "LinkedPage",
                          pageId: syncedDocModel.props.pageId,
                        },
                      },
                    },
                  ]),
                } satisfies Partial<ParagraphProps>,
                noteId,
              );

              await std.clipboard.duplicateSlice(slice, std.store, noteId);

              gfx.selection.set({
                elements: [noteId],
                editing: false,
              });
            })().catch(console.error);
            return next();
          })
          .run();

        ctx.track("CanvasElementAdded", {
          page: "whiteboard editor",
          type: "note",
          module: "toolbar",
          segment: "toolbar",
          control: "conversation",
          other: "duplicate as note",
        });
      },
    },
    captionAction,
    {
      id: "e.scale",
      label: editorMessage("com.myoxus.editor.toolbar.scale", "Scale"),
      control(ctx) {
        const model = ctx.getCurrentBlockByType(
          EmbedSyncedDocBlockComponent,
        )?.model;
        if (!model) return null;

        const scale$ = computed(() =>
          Math.round(100 * (model.props.scale$.value ?? 1)),
        );
        const onSelect = (value: number) => {
          const scale = value / 100;

          const oldScale = model.props.scale ?? 1;
          const ratio = scale / oldScale;
          const bounds = Bound.deserialize(model.xywh);
          bounds.h *= ratio;
          bounds.w *= ratio;
          const xywh = bounds.serialize();

          ctx.store.updateBlock(model, { scale, xywh });

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

  when: (ctx) => ctx.getSurfaceModelsByType(EmbedSyncedDocModel).length === 1,
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
      // Surface dispatch derives this registry key from the live Surface
      // flavour; it is not a persisted document-format identifier.
      id: BlockFlavourIdentifier(`myoxus:surface:${name}`),
      config: builtinSurfaceToolbarConfig,
    }),
  ];
};
