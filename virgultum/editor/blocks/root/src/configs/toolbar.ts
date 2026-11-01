import {
  convertSelectedBlocksToLinkedDoc,
  getTitleFromSelectedModels,
  notifyDocCreated,
  promptDocTitle,
} from "@virgultum/block-embed";
import { updateBlockAlign, updateBlockType } from "@virgultum/block-note";
import type { HighlightType } from "@virgultum/components/highlight-dropdown-menu";
import {
  popMenu,
  popupTargetFromElement,
  templateRepeatMenuOptions,
  templateRepeatLabel,
  templateVariableLabel,
} from "@virgultum/components/context-menu";
import {
  deleteTextCommand,
  formatBlockCommand,
  formatNativeCommand,
  formatTextCommand,
  getTextAttributeState,
  isFormatSupported,
  textFormatConfigs,
} from "@virgultum/inline-preset";
import {
  EmbedLinkedDocBlockSchema,
  EmbedSyncedDocBlockSchema,
  ParagraphBlockModel,
  type TextAlign,
} from "@virgultum/model";
import {
  focusTextModel,
  getInlineEditorByModel,
  textAlignConfigs,
  textConversionConfigs,
} from "@virgultum/rich-text";
import {
  copySelectedModelsCommand,
  deleteSelectedModelsCommand,
  draftSelectedModelsCommand,
  duplicateSelectedModelsCommand,
  getBlockSelectionsCommand,
  getImageSelectionsCommand,
  getSelectedBlocksCommand,
  getSelectedModelsCommand,
  getTextSelectionCommand,
} from "@virgultum/shared/commands";
import { isMyoxusLabelTone } from "@virgultum/shared/styles";
import type {
  MyoxusLabelTone,
  MyoxusTextAttributes,
} from "@virgultum/shared/types";
import {
  ActionPlacement,
  blockCommentToolbarButton,
  EditorI18nProvider,
  MyoxusHostServiceIdentifier,
  resolveEditorMessage,
  editorMessage,
  resolveLegacyEditorText,
  type ToolbarAction,
  type ToolbarActionGenerator,
  type ToolbarActionGroup,
  type ToolbarModuleConfig,
} from "@virgultum/shared/services";
import { editorToast, getMostCommonValue } from "@virgultum/shared/utils";

import { BlockSelection, BlockViewIdentifier } from "@virgultum/std";
import { toDraftModel } from "@virgultum/store";

const labelToneMessages = {
  neutral: editorMessage("com.myoxus.editor.label-tone.neutral", "Neutral"),
  info: editorMessage("com.myoxus.editor.label-tone.info", "Info"),
  positive: editorMessage("com.myoxus.editor.label-tone.positive", "Positive"),
  warning: editorMessage("com.myoxus.editor.label-tone.warning", "Warning"),
  danger: editorMessage("com.myoxus.editor.label-tone.danger", "Danger"),
  accent: editorMessage("com.myoxus.editor.label-tone.accent", "Accent"),
} as const satisfies Record<MyoxusLabelTone, ReturnType<typeof editorMessage>>;

const labelTones = Object.keys(labelToneMessages) as MyoxusLabelTone[];

const conversionsActionGroup = {
  id: "a.conversions",
  when: ({ chain }) => isFormatSupported(chain).run()[0],
  generate({ chain, std }) {
    const i18n = std.getOptional(EditorI18nProvider) ?? undefined;
    const text = (value: string) =>
      resolveLegacyEditorText(value, i18n) ?? value;
    const [ok, { selectedModels = [] }] = chain
      .tryAll((chain) => [
        chain.pipe(getTextSelectionCommand),
        chain.pipe(getBlockSelectionsCommand),
      ])
      .pipe(getSelectedModelsCommand, { types: ["text", "block"] })
      .run();

    // only support model with text
    // TODO(@fundon): displays only in a single paragraph, `length === 1`.
    const allowed =
      ok && selectedModels.filter((model) => model.text).length > 0;
    if (!allowed) return null;

    const model = selectedModels[0];
    const conversion =
      textConversionConfigs.find(
        ({ flavour, type }) =>
          flavour === model.flavour &&
          (type ? "type" in model.props && type === model.props.type : true),
      ) ?? textConversionConfigs[0];
    const update = (flavour: string, type?: string) => {
      chain
        .pipe(updateBlockType, {
          flavour,
          ...(type && { props: { type } }),
        })
        .run();
    };

    return {
      label: text("Conversions"),
      icon: conversion.iconName,
      control: {
        type: "menu",
        items: [
          ...textConversionConfigs
            .filter((c) => c.flavour !== "myoxus:divider")
            .map(({ flavour, type, name, iconName }) => ({
              id: name,
              label: text(name),
              icon: iconName,
              active: conversion.name === name,
              run: () => update(flavour, type),
            })),
          eyebrowAction,
        ],
      },
    };
  },
} as const satisfies ToolbarActionGenerator;

const alignActionGroup = {
  id: "b.align",
  when: ({ chain }) => isFormatSupported(chain).run()[0],
  generate({ chain, std }) {
    const i18n = std.getOptional(EditorI18nProvider) ?? undefined;
    const text = (value: string) =>
      resolveLegacyEditorText(value, i18n) ?? value;
    const [ok, { selectedModels = [] }] = chain
      .tryAll((chain) => [
        chain.pipe(getTextSelectionCommand),
        chain.pipe(getBlockSelectionsCommand),
      ])
      .pipe(getSelectedModelsCommand, { types: ["text", "block"] })
      .run();
    if (!ok) return null;

    const alignment =
      textAlignConfigs.find(
        ({ textAlign }) =>
          textAlign ===
          getMostCommonValue(
            selectedModels.map(
              ({ props }) => props as { textAlign?: TextAlign },
            ),
            "textAlign",
          ),
      ) ?? textAlignConfigs[0];
    const update = (textAlign: TextAlign) => {
      chain.pipe(updateBlockAlign, { textAlign }).run();
    };

    return {
      label: text("Align"),
      icon: alignment.iconName,
      control: {
        type: "choice",
        presentation: "icons",
        value: alignment.textAlign,
        options: textAlignConfigs.map(({ textAlign, name, iconName }) => ({
          value: textAlign,
          label: text(name),
          icon: iconName,
        })),
        change: (value) => update(value as TextAlign),
      },
    };
  },
} as const satisfies ToolbarActionGenerator;

const inlineTextActionGroup = {
  id: "b.inline-text",
  when: ({ chain }) => isFormatSupported(chain).run()[0],
  actions: textFormatConfigs.map(
    ({ id, name, action, activeWhen, iconName }, score) => {
      return {
        id,
        icon: iconName,
        score,
        tooltip: name,
        run: ({ host }) => action(host),
        active: ({ host }) => activeWhen(host),
      };
    },
  ),
} as const satisfies ToolbarActionGroup;

const highlightActionGroup = {
  id: "c.highlight",
  when: ({ chain }) => isFormatSupported(chain).run()[0],
  actions: (["color", "background"] as const).map((key, score) => ({
    id: key,
    score,
    icon: key === "color" ? "TextColorIcon" : "HighLightLinearIcon",
    label:
      key === "color"
        ? editorMessage("com.myoxus.editor.toolbar.text-color", "Text color")
        : editorMessage(
            "com.myoxus.editor.toolbar.text-marker",
            "Text highlight",
          ),
    control({ chain }) {
      const update = (styles: HighlightType) => {
        const payload = { styles };
        chain
          .try((chain) => [
            chain
              .pipe(getTextSelectionCommand)
              .pipe(formatTextCommand, payload),
            chain
              .pipe(getBlockSelectionsCommand)
              .pipe(formatBlockCommand, payload),
            chain.pipe(formatNativeCommand, payload),
          ])
          .run();
      };
      const colorLabels = {
        red: editorMessage("com.myoxus.editor.table.color.red", "Red"),
        orange: editorMessage("com.myoxus.editor.table.color.orange", "Orange"),
        yellow: editorMessage("com.myoxus.editor.table.color.yellow", "Yellow"),
        green: editorMessage("com.myoxus.editor.table.color.green", "Green"),
        teal: editorMessage("com.myoxus.editor.table.color.teal", "Teal"),
        blue: editorMessage("com.myoxus.editor.table.color.blue", "Blue"),
        purple: editorMessage("com.myoxus.editor.table.color.purple", "Purple"),
        grey: editorMessage("com.myoxus.editor.table.color.grey", "Grey"),
      };
      const markerLabels = {
        yellow: editorMessage(
          "com.myoxus.editor.text-marker.yellow",
          "Neon yellow",
        ),
        green: editorMessage(
          "com.myoxus.editor.text-marker.green",
          "Neon green",
        ),
        pink: editorMessage("com.myoxus.editor.text-marker.pink", "Neon pink"),
        orange: editorMessage(
          "com.myoxus.editor.text-marker.orange",
          "Neon orange",
        ),
        blue: editorMessage("com.myoxus.editor.text-marker.blue", "Neon blue"),
      };
      const labels: Record<string, ReturnType<typeof editorMessage>> = key ===
      "color"
        ? colorLabels
        : markerLabels;
      return {
        type: "menu",
        items: ["default", ...Object.keys(labels)].map((color) => {
          const value =
            color === "default"
              ? null
              : "var(" +
                (key === "color"
                  ? "--myoxus-text-highlight-foreground-"
                  : "--myoxus-sem-text-marker-") +
                color +
                ")";
          return {
            id: color,
            icon: color === "default" ? "ResetIcon" : undefined,
            swatch: value ?? undefined,
            label:
              color !== "default"
                ? labels[color]
                : key === "color"
                  ? editorMessage(
                      "com.myoxus.editor.keyboard.default-color",
                      "Default Color",
                    )
                  : editorMessage(
                      "com.myoxus.editor.toolbar.remove-text-marker",
                      "Remove highlight",
                    ),
            run: () => update({ [key]: value }),
          };
        }),
      };
    },
  })),
} as const satisfies ToolbarActionGroup;

const labelToneAction = {
  id: "c.label-tone",
  when: ({ chain, readonly }) => !readonly && isFormatSupported(chain).run()[0],
  generate({ chain, std }) {
    const i18n = std.getOptional(EditorI18nProvider) ?? undefined;
    const resolve = (message: ReturnType<typeof editorMessage>) =>
      resolveEditorMessage(message, i18n);
    const label = editorMessage(
      "com.myoxus.editor.label-tone.label",
      "Label tone",
    );
    const mixed = editorMessage("com.myoxus.editor.label-tone.mixed", "Mixed");
    const clear = editorMessage(
      "com.myoxus.editor.label-tone.clear",
      "Clear label tone",
    );
    const [hasState, { textAttributeState }] = chain
      .pipe(getTextAttributeState, { key: "labelTone" })
      .run();
    if (!hasState || !textAttributeState) return null;

    const activeTone = isMyoxusLabelTone(textAttributeState.value)
      ? textAttributeState.value
      : undefined;
    const [hasTextSelection, { currentTextSelection }] = chain
      .pipe(getTextSelectionCommand)
      .run();
    const selection = document.getSelection();
    const nativeRange =
      !hasTextSelection && selection?.rangeCount
        ? selection.getRangeAt(0).cloneRange()
        : undefined;
    const buttonLabel = `${resolve(label)}: ${
      textAttributeState.mixed
        ? resolve(mixed)
        : activeTone
          ? resolve(labelToneMessages[activeTone])
          : resolve(clear)
    }`;
    const restoreSelection = () => {
      if (hasTextSelection && currentTextSelection) {
        std.range.syncTextSelectionToRange(currentTextSelection);
      } else if (nativeRange) {
        std.range.set(nativeRange);
      }
    };
    const update = (labelTone: MyoxusLabelTone | null) => {
      const payload = { styles: { labelTone } };
      if (hasTextSelection && currentTextSelection) {
        // The filterable menu owns focus while an option is chosen. Restore the
        // cached editor selection before the shared formatting command resolves
        // its inline range; the command remains the sole mark writer.
        std.range.syncTextSelectionToRange(currentTextSelection);
        chain
          .pipe(formatTextCommand, {
            ...payload,
            textSelection: currentTextSelection,
          })
          .run();
        return;
      }
      const nativePayload: {
        styles: MyoxusTextAttributes;
        range?: Range;
      } = {
        ...payload,
        range: nativeRange,
      };
      chain
        .try((candidate) => [
          candidate
            .pipe(getBlockSelectionsCommand)
            .pipe(formatBlockCommand, payload),
          candidate.pipe(formatNativeCommand, nativePayload),
        ])
        .run();
    };
    return {
      label: buttonLabel,
      icon: "TagsIcon",
      active: Boolean(activeTone) && !textAttributeState.mixed,
      control: {
        type: "menu",
        onClose: restoreSelection,
        items: [
          ...labelTones.map((tone) => ({
            id: tone,
            label: labelToneMessages[tone],
            active: !textAttributeState.mixed && activeTone === tone,
            run: () => {
              update(tone);
              restoreSelection();
            },
          })),
          {
            id: "clear",
            label: clear,
            active: !textAttributeState.mixed && activeTone === undefined,
            run: () => {
              update(null);
              restoreSelection();
            },
          },
        ],
      },
    };
  },
} as const satisfies ToolbarActionGenerator;

const eyebrowAction = {
  id: "b.eyebrow",
  when: ({ readonly }) => !readonly,
  generate({ chain, store }) {
    const [ok, { selectedModels = [] }] = chain
      .pipe(getSelectedModelsCommand, {
        types: ["text", "block"],
        mode: "flat",
      })
      .run();
    if (
      !ok ||
      !selectedModels.length ||
      !selectedModels.every(
        (model) =>
          model instanceof ParagraphBlockModel && model.props.type === "text",
      )
    ) {
      return null;
    }

    const paragraphIds = selectedModels.map((model) => model.id);
    const getCurrentParagraphs = () =>
      paragraphIds
        .map((id) => store.getBlock(id)?.model)
        .filter(
          (model): model is ParagraphBlockModel =>
            model instanceof ParagraphBlockModel && model.props.type === "text",
        );
    const label = editorMessage(
      "com.myoxus.editor.paragraph.eyebrow",
      "Small heading",
    );
    return {
      label,
      tooltip: label,
      icon: "TextTypeIcon",
      active: () => {
        const paragraphs = getCurrentParagraphs();
        return (
          paragraphs.length === paragraphIds.length &&
          paragraphs.every((model) => model.props.presentation === "eyebrow")
        );
      },
      run() {
        const paragraphs = getCurrentParagraphs();
        if (paragraphs.length !== paragraphIds.length) return;
        const remove = paragraphs.every(
          (model) => model.props.presentation === "eyebrow",
        );
        store.captureSync();
        for (const model of paragraphs) {
          if (remove) {
            store.updateBlock(model, () => {
              Reflect.deleteProperty(model.props, "presentation");
            });
          } else {
            store.updateBlock(model, { presentation: "eyebrow" });
          }
        }
        store.captureSync();
      },
    };
  },
} as const satisfies ToolbarActionGenerator;

const turnIntoLinkedDoc = {
  id: "f.convert-to-linked-doc",
  tooltip: editorMessage(
    "com.myoxus.editor.toolbar.create-linked-doc",
    "Create Linked Doc",
  ),
  icon: "LinkedPageIcon",
  when({ chain, std }) {
    const supportFlavours = [
      EmbedLinkedDocBlockSchema,
      EmbedSyncedDocBlockSchema,
    ].map((schema) => schema.model.flavour);
    if (
      supportFlavours.some(
        (flavour) => !std.getOptional(BlockViewIdentifier(flavour)),
      )
    )
      return false;

    const [ok, { selectedModels }] = chain
      .pipe(getSelectedModelsCommand, {
        types: ["block", "text"],
        mode: "flat",
      })
      .run();
    return ok && Boolean(selectedModels?.length);
  },
  run({ chain, store, selection, std, track }) {
    const [ok, { draftedModels, selectedModels }] = chain
      .pipe(getSelectedModelsCommand, {
        types: ["block", "text"],
        mode: "flat",
      })
      .pipe(draftSelectedModelsCommand)
      .run();
    if (!ok || !draftedModels || !selectedModels?.length) return;

    selection.clear();

    const autofill = getTitleFromSelectedModels(
      selectedModels.map(toDraftModel),
    );
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
} as const satisfies ToolbarAction;

const templateRepeatAction = {
  id: "d.template-repeat",
  when: ({ std, readonly }) =>
    !readonly &&
    Boolean(std.getOptional(MyoxusHostServiceIdentifier)?.isTemplateDocument()),
  generate({ chain, std, store }) {
    const [ok, { selectedModels = [] }] = chain
      .pipe(getSelectedModelsCommand, {
        types: ["text", "block"],
        mode: "flat",
      })
      .run();
    if (!ok || selectedModels.length !== 1) return null;
    const model = selectedModels[0];
    if (!["myoxus:paragraph", "myoxus:list"].includes(model.flavour))
      return null;
    const i18n = std.getOptional(EditorI18nProvider) ?? undefined;
    const open = (anchor: HTMLElement) => {
      popMenu(popupTargetFromElement(anchor), {
        options: templateRepeatMenuOptions({
          i18n,
          unit: () => ({
            binding: "repeat" in model.props ? model.props.repeat : undefined,
            texts: [model.text?.toString() ?? ""],
            leaf: model.children.length === 0,
          }),
          canWrite: () =>
            !store.readonly &&
            Boolean(
              std
                .getOptional(MyoxusHostServiceIdentifier)
                ?.isTemplateDocument(),
            ) &&
            store.getModelById(model.id) === model,
          change: (repeat) => {
            store.captureSync();
            // Partial update props deliberately ignore undefined. Removal must
            // delete the native property inside the existing Store transaction.
            if (repeat === undefined) {
              store.updateBlock(model, () => {
                Reflect.deleteProperty(model.props, "repeat");
              });
            } else store.updateBlock(model, { repeat });
            store.captureSync();
          },
          onClose: () => {
            if (store.getModelById(model.id)) focusTextModel(std, model.id);
          },
        }),
      });
    };
    return {
      label: templateRepeatLabel,
      icon: "RefreshCwIcon",
      run: (_ctx, anchor) => {
        if (anchor) open(anchor);
      },
    };
  },
} satisfies ToolbarActionGenerator;

const templateVariableAction = {
  id: "d.template-variable",
  when: ({ std, readonly }) =>
    !readonly &&
    Boolean(std.getOptional(MyoxusHostServiceIdentifier)?.isTemplateDocument()),
  generate({ chain, std, store }) {
    const [ok, { selectedModels = [] }] = chain
      .pipe(getSelectedModelsCommand, {
        types: ["text", "block"],
        mode: "flat",
      })
      .run();
    if (!ok || selectedModels.length !== 1) return null;
    const model = selectedModels[0];
    if (
      !model.text ||
      !["myoxus:paragraph", "myoxus:list"].includes(model.flavour)
    )
      return null;
    const host = std.getOptional(MyoxusHostServiceIdentifier);
    const capabilities = host?.getTemplateVariableCapabilities() ?? [];
    if (!capabilities.length || !host?.openTemplateVariablePicker) return null;
    const i18n = std.getOptional(EditorI18nProvider) ?? undefined;
    const open = (_anchor: HTMLElement) => {
      const inlineEditor = getInlineEditorByModel(std, model);
      const range = inlineEditor?.getInlineRange() ?? {
        index: model.text?.length ?? 0,
        length: 0,
      };
      let nextCaret = range.index;
      host.openTemplateVariablePicker?.({
        i18n,
        canWrite: () =>
          !store.readonly &&
          Boolean(inlineEditor) &&
          Boolean(
            std.getOptional(MyoxusHostServiceIdentifier)?.isTemplateDocument(),
          ) &&
          store.getModelById(model.id) === model,
        insert: (token) => {
          store.captureSync();
          inlineEditor?.insertText(range, token);
          nextCaret = range.index + token.length;
          store.captureSync();
        },
        onClose: () => {
          if (store.getModelById(model.id))
            focusTextModel(std, model.id, nextCaret);
        },
      });
    };
    return {
      label: templateVariableLabel,
      icon: "TextTypeIcon",
      run: (_ctx, anchor) => {
        if (anchor) open(anchor);
      },
    };
  },
} satisfies ToolbarActionGenerator;

export const builtinToolbarConfig = {
  actions: [
    conversionsActionGroup,
    alignActionGroup,
    inlineTextActionGroup,
    highlightActionGroup,
    labelToneAction,
    templateVariableAction,
    templateRepeatAction,
    {
      placement: ActionPlacement.More,
      id: "b.building-block",
      when: ({ std, readonly }) =>
        !readonly &&
        Boolean(
          std.getOptional(MyoxusHostServiceIdentifier)?.openBuildingBlockPicker,
        ),
      actions: [
        {
          id: "insert-building-block",
          label: editorMessage(
            "com.myoxus.templates.blocks.insert",
            "Insert building block…",
          ),
          icon: "TemplateIcon",
          run: ({ std }) =>
            std
              .getOptional(MyoxusHostServiceIdentifier)
              ?.openBuildingBlockPicker?.(std),
        },
        {
          id: "save-building-block-selection",
          label: editorMessage(
            "com.myoxus.templates.blocks.save-selection",
            "Save selection as building block…",
          ),
          icon: "TemplateIcon",
          when: ({ std }) =>
            Boolean(
              std.getOptional(MyoxusHostServiceIdentifier)
                ?.saveBuildingBlockSelection,
            ),
          run: ({ std }) =>
            std
              .getOptional(MyoxusHostServiceIdentifier)
              ?.saveBuildingBlockSelection?.(std),
        },
      ],
    },
    turnIntoLinkedDoc,
    {
      id: "g.comment",
      ...blockCommentToolbarButton,
    },
    {
      placement: ActionPlacement.More,
      id: "a.clipboard",
      actions: [
        {
          id: "copy",
          label: editorMessage("Copy", "Copy"),
          icon: "CopyIcon",
          run({ chain, host }) {
            const [ok] = chain
              .pipe(getSelectedModelsCommand)
              .pipe(draftSelectedModelsCommand)
              .pipe(copySelectedModelsCommand)
              .run();

            if (!ok) return;

            editorToast(
              host,
              editorMessage("Copied to clipboard", "Copied to clipboard"),
            );
          },
        },
        {
          id: "duplicate",
          label: editorMessage(
            "com.myoxus.editor.keyboard.duplicate",
            "Duplicate",
          ),
          icon: "DuplicateIcon",
          run({ chain, store, selection }) {
            store.captureSync();

            const [ok, { selectedBlocks = [] }] = chain
              .pipe(getTextSelectionCommand)
              .pipe(getSelectedBlocksCommand, {
                types: ["text"],
                mode: "highest",
              })
              .run();

            // If text selection exists, convert to block selection
            if (ok && selectedBlocks.length) {
              selection.setGroup(
                "note",
                selectedBlocks.map((block) =>
                  selection.create(BlockSelection, {
                    blockId: block.model.id,
                  }),
                ),
              );
            }

            chain
              .pipe(getSelectedModelsCommand, {
                types: ["block", "image"],
                mode: "highest",
              })
              .pipe(duplicateSelectedModelsCommand)
              .run();
          },
        },
      ],
      when(ctx) {
        return !ctx.flags.isNative();
      },
    },
    {
      placement: ActionPlacement.More,
      id: "c.delete",
      actions: [
        {
          id: "delete",
          label: editorMessage("Delete", "Delete"),
          icon: "DeleteIcon",
          variant: "destructive",
          run({ chain }) {
            // removes text
            const [ok] = chain
              .pipe(getTextSelectionCommand)
              .pipe(deleteTextCommand)
              .run();

            if (ok) return;

            // removes blocks
            chain
              .tryAll((chain) => [
                chain.pipe(getBlockSelectionsCommand),
                chain.pipe(getImageSelectionsCommand),
              ])
              .pipe(getSelectedModelsCommand)
              .pipe(deleteSelectedModelsCommand)
              .run();
          },
        },
      ],
      when(ctx) {
        return !ctx.flags.isNative();
      },
    },
  ],
} as const satisfies ToolbarModuleConfig;
