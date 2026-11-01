import { computed } from "@preact/signals-core";
import {
  EdgelessCRUDIdentifier,
  EdgelessLegacySlotIdentifier,
} from "@virgultum/block-surface";
import { Bound } from "@virgultum/global/gfx";
import {
  DefaultTheme,
  NoteShadow,
  resolveColor,
  type NoteProps,
  NoteBlockModel,
  NoteDisplayMode,
} from "@virgultum/model";
import {
  EditorI18nProvider,
  editorMessage,
  NotificationProvider,
  resolveLegacyEditorText,
  SidebarExtensionIdentifier,
  type ToolbarAction,
  type ToolbarContext,
  type ToolbarModuleConfig,
  ToolbarModuleExtension,
} from "@virgultum/shared/services";
import { BlockFlavourIdentifier } from "@virgultum/std";
import type { ExtensionType } from "@virgultum/store";

import { changeNoteDisplayMode } from "../commands";
import { NoteConfigExtension } from "../config";

const trackBaseProps = {
  category: "note",
};

const builtinSurfaceToolbarConfig = {
  actions: [
    {
      id: "a.show-in",
      when(ctx) {
        return (
          ctx.getSurfaceModelsByType(NoteBlockModel).length === 1 &&
          ctx.features.getFlag("enable_advanced_block_visibility")
        );
      },
      label: editorMessage(
        "com.myoxus.editor.note.display-mode",
        "Display mode",
      ),
      control(ctx) {
        const [model] = ctx.getSurfaceModelsByType(NoteBlockModel);
        if (!model) return null;
        return {
          type: "choice",
          value: String(model.props.displayMode),
          options: [
            {
              value: String(NoteDisplayMode.DocAndEdgeless),
              label: editorMessage(
                "com.myoxus.sidebar.outline.mode-both",
                "Both",
              ),
            },
            {
              value: String(NoteDisplayMode.EdgelessOnly),
              label: editorMessage(
                "com.myoxus.sidebar.outline.mode-edgeless",
                "Edgeless",
              ),
            },
            {
              value: String(NoteDisplayMode.DocOnly),
              label: editorMessage("Page", "Page"),
            },
          ],
          change: (value) =>
            setDisplayMode(ctx, model, value as NoteDisplayMode),
        };
      },
    },
    {
      id: "b.display-in-page",
      when(ctx) {
        const elements = ctx.getSurfaceModelsByType(NoteBlockModel);
        return (
          elements.length === 1 &&
          !elements[0].isPageBlock() &&
          !ctx.features.getFlag("enable_advanced_block_visibility")
        );
      },
      generate(ctx) {
        const i18n = ctx.std.getOptional(EditorI18nProvider) ?? undefined;
        const text = (value: string) =>
          resolveLegacyEditorText(value, i18n) ?? value;
        const models = ctx.getSurfaceModelsByType(NoteBlockModel);
        if (!models.length) return null;

        const firstModel = models[0];
        const shouldShowTooltip$ = computed(
          () =>
            firstModel.props.displayMode$.value ===
            NoteDisplayMode.DocAndEdgeless,
        );
        const label$ = computed(() =>
          text(
            firstModel.props.displayMode$.value === NoteDisplayMode.EdgelessOnly
              ? "Display in Page"
              : "Displayed in Page",
          ),
        );
        const onSelect = () => {
          const newMode =
            firstModel.props.displayMode === NoteDisplayMode.EdgelessOnly
              ? NoteDisplayMode.DocAndEdgeless
              : NoteDisplayMode.EdgelessOnly;
          setDisplayMode(ctx, firstModel, newMode);

          ctx.track("BlockCreated", {
            page: "whiteboard editor",
            module: "toolbar",
            segment: "toolbar",
            blockType: "myoxus:note",
            control: "toolbar:general",
            other: `display in page: ${newMode === NoteDisplayMode.EdgelessOnly ? "off" : "on"}`,
          });
        };

        return {
          label: label$.value,
          showLabel: true,
          icon: "InsertIntoPageIcon",
          tooltip: shouldShowTooltip$.value
            ? text(
                "This note is part of Page Mode. Click to remove it from the page.",
              )
            : label$.value,
          run: onSelect,
        };
      },
    },
    {
      id: "d.style",
      when(ctx) {
        const elements = ctx.getSurfaceModelsByType(NoteBlockModel);
        return (
          elements.length > 0 &&
          elements[0].props.displayMode !== NoteDisplayMode.DocOnly
        );
      },
      actions: [
        {
          id: "b.style",
          when: (ctx) => {
            const models = ctx.getSurfaceModels();
            return (
              models.length > 0 &&
              models.every((model) => model instanceof NoteBlockModel)
            );
          },
          label: editorMessage("com.myoxus.editor.toolbar.style", "Style"),
          icon: "PaletteIcon",
          control(ctx) {
            const notes = ctx.getSurfaceModelsByType(NoteBlockModel);
            const first = notes[0];
            if (!first) return null;
            const updateStyle = (
              patch: Partial<NoteProps["edgeless"]["style"]>,
            ) => {
              ctx.store.captureSync();
              for (const note of notes)
                ctx.std.get(EdgelessCRUDIdentifier).updateElement(note.id, {
                  edgeless: {
                    ...note.props.edgeless,
                    style: { ...note.props.edgeless.style, ...patch },
                  },
                });
              ctx.store.captureSync();
            };
            const theme = ctx.theme.edgeless$.value;
            return {
              type: "menu",
              items: [
                {
                  id: "fill",
                  label: editorMessage(
                    "com.myoxus.editor.note.fill-color",
                    "Fill color",
                  ),
                  control: {
                    type: "color",
                    value: resolveColor(first.props.background, theme),
                    swatches: DefaultTheme.NoteBackgroundColorPalettes.map(
                      (color) => resolveColor(color.value, theme),
                    ),
                    change: (color) => {
                      ctx.store.captureSync();
                      notes.forEach((note) =>
                        ctx.std
                          .get(EdgelessCRUDIdentifier)
                          .updateElement(note.id, {
                            background:
                              DefaultTheme.NoteBackgroundColorPalettes.find(
                                (swatch) =>
                                  resolveColor(swatch.value, theme) === color,
                              )?.value ?? color,
                          }),
                      );
                      ctx.store.captureSync();
                    },
                  },
                },
                {
                  id: "shadow",
                  label: editorMessage(
                    "com.myoxus.editor.note.shadow",
                    "Shadow",
                  ),
                  control: {
                    type: "choice",
                    value: String(first.props.edgeless.style.shadowType),
                    options: [
                      [
                        NoteShadow.None,
                        editorMessage(
                          "com.myoxus.editor.note.shadow.none",
                          "No shadow",
                        ),
                      ],
                      [
                        NoteShadow.Box,
                        editorMessage(
                          "com.myoxus.editor.note.shadow.box",
                          "Box shadow",
                        ),
                      ],
                      [
                        NoteShadow.Sticker,
                        editorMessage(
                          "com.myoxus.editor.note.shadow.sticker",
                          "Sticker shadow",
                        ),
                      ],
                      [
                        NoteShadow.Paper,
                        editorMessage(
                          "com.myoxus.editor.note.shadow.paper",
                          "Paper shadow",
                        ),
                      ],
                      [
                        NoteShadow.Float,
                        editorMessage(
                          "com.myoxus.editor.note.shadow.floating",
                          "Floating shadow",
                        ),
                      ],
                      [
                        NoteShadow.Film,
                        editorMessage(
                          "com.myoxus.editor.note.shadow.film",
                          "Film shadow",
                        ),
                      ],
                    ].map(([value, label]) => ({
                      value: String(value),
                      label,
                    })),
                    change: (value) =>
                      updateStyle({ shadowType: value as NoteShadow }),
                  },
                },
                {
                  id: "border-size",
                  label: editorMessage(
                    "com.myoxus.settings.editorSettings.edgeless.note.border-thickness",
                    "Border width",
                  ),
                  control: {
                    type: "number",
                    value: first.props.edgeless.style.borderSize,
                    min: 0,
                    change: (value) => {
                      if (typeof value === "number")
                        updateStyle({ borderSize: value });
                    },
                  },
                },
                {
                  id: "border-style",
                  label: editorMessage(
                    "com.myoxus.editor.toolbar.stroke-style",
                    "Stroke style",
                  ),
                  control: {
                    type: "choice",
                    value: first.props.edgeless.style.borderStyle,
                    options: ["solid", "dash", "none"].map((value) => ({
                      value,
                      label:
                        value === "solid"
                          ? editorMessage(
                              "com.myoxus.settings.editorSettings.edgeless.note.border.solid",
                              "Solid",
                            )
                          : value === "dash"
                            ? editorMessage(
                                "com.myoxus.settings.editorSettings.edgeless.note.border.dash",
                                "Dash",
                              )
                            : editorMessage(
                                "com.myoxus.settings.editorSettings.edgeless.note.border.none",
                                "None",
                              ),
                    })),
                    change: (value) =>
                      updateStyle({
                        borderStyle:
                          value as NoteProps["edgeless"]["style"]["borderStyle"],
                      }),
                  },
                },
                {
                  id: "radius",
                  label: editorMessage(
                    "com.myoxus.editor.note.corner-radius",
                    "Corner Radius",
                  ),
                  control: {
                    type: "number",
                    value: first.props.edgeless.style.borderRadius,
                    min: 0,
                    max: 32,
                    change: (value) => {
                      if (typeof value === "number")
                        updateStyle({ borderRadius: value });
                    },
                  },
                },
              ],
            };
          },
        } satisfies ToolbarAction,
      ],
    },
    {
      id: "e.slicer",
      when(ctx) {
        return (
          ctx.getSurfaceModelsByType(NoteBlockModel).length === 1 &&
          ctx.features.getFlag("enable_advanced_block_visibility")
        );
      },
      generate(ctx) {
        const textLabel = editorMessage(
          "com.myoxus.editor.toolbar.slicer",
          "Slicer",
        );
        return {
          label: editorMessage("com.myoxus.editor.toolbar.slicer", "Slicer"),
          icon: "ScissorsIcon",
          tooltip: textLabel,
          active: false,
          run() {
            ctx.std.get(EdgelessLegacySlotIdentifier).toggleNoteSlicer.next();
          },
        };
      },
    },
    {
      id: "f.auto-height",
      label: editorMessage("com.myoxus.editor.toolbar.size", "Size"),
      when(ctx) {
        const elements = ctx.getSurfaceModelsByType(NoteBlockModel);
        return (
          elements.length > 0 &&
          (!elements[0].isPageBlock() ||
            !ctx.std.getOptional(NoteConfigExtension.identifier)
              ?.edgelessNoteHeader)
        );
      },
      generate(ctx) {
        const models = ctx.getSurfaceModelsByType(NoteBlockModel);
        if (!models.length) return null;

        const firstModel = models[0];
        const { collapse } = firstModel.props.edgeless$.value;
        const options: Pick<ToolbarAction, "tooltip" | "icon"> = collapse
          ? {
              tooltip: editorMessage(
                "com.myoxus.editor.toolbar.auto-height",
                "Auto height",
              ),
              icon: "AutoHeightIcon",
            }
          : {
              tooltip: editorMessage(
                "com.myoxus.editor.toolbar.customized-height",
                "Customized height",
              ),
              icon: "CustomizedHeightIcon",
            };

        return {
          ...options,
          run(ctx) {
            ctx.store.captureSync();

            for (const model of models) {
              const edgeless = model.props.edgeless;

              if (edgeless.collapse) {
                ctx.store.updateBlock(model, () => {
                  model.props.edgeless.collapse = false;
                });
                continue;
              }

              if (edgeless.collapsedHeight) {
                const bounds = Bound.deserialize(model.xywh);
                bounds.h = edgeless.collapsedHeight * (edgeless.scale ?? 1);
                const xywh = bounds.serialize();

                ctx.store.updateBlock(model, () => {
                  model.xywh = xywh;
                  model.props.edgeless.collapse = true;
                });
              }
            }
          },
        };
      },
    },
    {
      id: "g.scale",
      label: editorMessage("com.myoxus.editor.toolbar.scale", "Scale"),
      control(ctx) {
        const models = ctx.getSurfaceModelsByType(NoteBlockModel);
        if (!models.length) return null;
        return {
          type: "number",
          value: Math.round(100 * (models[0].props.edgeless.scale ?? 1)),
          min: 0,
          max: 400,
          suffix: "%",
          presets: [50, 100, 200],
          step: 10,
          change: (value) => {
            if (typeof value !== "number" || value <= 0) return;
            const scale = value / 100;

            models.forEach((model) => {
              const bounds = Bound.deserialize(model.xywh);
              const oldScale = model.props.edgeless.scale ?? 1;
              const ratio = scale / oldScale;
              bounds.w *= ratio;
              bounds.h *= ratio;
              const xywh = bounds.serialize();

              ctx.store.updateBlock(model, () => {
                model.xywh = xywh;
                model.props.edgeless.scale = scale;
              });
            });

            ctx.track("SelectedCardScale", {
              ...trackBaseProps,
              control: "select card scale",
            });
          },
        };
      },
    },
  ],

  when: (ctx) => ctx.getSurfaceModelsByType(NoteBlockModel).length > 0,
} as const satisfies ToolbarModuleConfig;

function setDisplayMode(
  ctx: ToolbarContext,
  model: NoteBlockModel,
  newMode: NoteDisplayMode,
) {
  const i18n = ctx.std.getOptional(EditorI18nProvider) ?? undefined;
  const text = (value: string) => resolveLegacyEditorText(value, i18n) ?? value;
  const displayMode = model.props.displayMode;

  ctx.command.exec(changeNoteDisplayMode, {
    noteId: model.id,
    mode: newMode,
    stopCapture: true,
  });

  // if change note to page only, should clear the selection
  if (newMode === NoteDisplayMode.DocOnly) {
    ctx.selection.clear();
  }

  const data =
    newMode === NoteDisplayMode.EdgelessOnly
      ? {
          title: text("Note removed from Page Mode"),
          message: text("Content removed from your page."),
        }
      : {
          title: text("Note displayed in Page Mode"),
          message: text("Content added to your page."),
        };

  const notification = ctx.std.getOptional(NotificationProvider);
  notification?.notifyWithUndoAction({
    title: data.title,
    message: `${data.message} ${text("Find it in the TOC for quick navigation.")}`,
    accent: "success",
    duration: 5 * 1000,
    actions: [
      {
        key: "view-in-toc",
        label: text("View in Toc"),
        onClick: () => {
          const sidebar = ctx.std.getOptional(SidebarExtensionIdentifier);
          sidebar?.open("outline");
        },
      },
    ],
  });

  ctx.track("NoteDisplayModeChanged", {
    ...trackBaseProps,
    control: "display mode",
    other: `from ${displayMode} to ${newMode}`,
  });
}

export const createBuiltinToolbarConfigExtension = (
  flavour: string,
): ExtensionType[] => {
  const name = flavour.split(":").pop();

  return [
    ToolbarModuleExtension({
      // Match the live Surface flavour used by the toolbar dispatcher.
      id: BlockFlavourIdentifier(`myoxus:surface:${name}`),
      config: builtinSurfaceToolbarConfig,
    }),
  ];
};
