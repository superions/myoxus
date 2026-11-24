import { calloutPresets } from "../presets";
import {
  type CalloutAppearance,
  calloutPresentation,
  CalloutBlockModel,
  normalizeCalloutAppearance,
} from "@virgultum/core/models";
import {
  ActionPlacement,
  editorMessage,
  editorBackgroundColors,
  type ToolbarAction,
  type ToolbarActionGroup,
  type ToolbarModuleConfig,
  ToolbarModuleExtension,
} from "@virgultum/core/services";
import { BlockFlavourIdentifier } from "@virgultum/core/runtime";
import type { ExtensionType } from "@virgultum/core/store";

import { openCalloutIconPicker } from "../icon-picker-wrapper";

const appearanceOptions = [
  {
    value: "soft",
    label: editorMessage("com.myoxus.editor.callout.appearance.soft", "Soft"),
  },
  {
    value: "accent",
    label: editorMessage(
      "com.myoxus.editor.callout.appearance.accent",
      "Accent",
    ),
  },
  {
    value: "outline",
    label: editorMessage(
      "com.myoxus.editor.callout.appearance.outline",
      "Outline",
    ),
  },
] as const satisfies ReadonlyArray<{
  value: CalloutAppearance;
  label: ReturnType<typeof editorMessage>;
}>;

const backgroundColorLabel = editorMessage(
  "com.myoxus.editor.toolbar.background-color",
  "Background Color",
);
const backgroundColorTooltip = editorMessage(
  "com.myoxus.editor.toolbar.change-background-color",
  "Change background color",
);

const backgroundColorAction = {
  id: "background-color",
  label: backgroundColorLabel,
  tooltip: backgroundColorTooltip,
  icon: "PaletteIcon",
  control(ctx) {
    const model = ctx.getCurrentModelByType(CalloutBlockModel);
    if (!model) return null;
    const current = model.props.backgroundColorName || "grey";
    const update = (name: string) => {
      ctx.store.captureSync();
      ctx.store.updateBlock(model, { backgroundColorName: name });
      ctx.store.captureSync();
    };
    return {
      type: "menu",
      items: [
        {
          id: "default",
          label: editorMessage(
            "com.myoxus.editor.callout.background.default",
            "Default background",
          ),
          icon: "ResetIcon",
          run: () => update("grey"),
        },
        ...editorBackgroundColors.map(({ name, label, background }) => ({
          id: name,
          label,
          swatch: background,
          active:
            current === name || (name === "grey" && current === "default"),
          run: () => update(name),
        })),
      ],
    };
  },
} satisfies ToolbarAction;

const appearanceLabel = editorMessage(
  "com.myoxus.editor.callout.appearance",
  "Appearance",
);
const appearanceTooltip = editorMessage(
  "com.myoxus.editor.callout.change-appearance",
  "Change appearance",
);

const appearanceAction = {
  id: "appearance",
  label: appearanceLabel,
  tooltip: appearanceTooltip,
  icon: "AppearanceIcon",
  control(ctx) {
    const model = ctx.getCurrentModelByType(CalloutBlockModel);
    if (!model) return null;
    const current =
      normalizeCalloutAppearance(model.props.appearance$.value) ?? "soft";
    return {
      type: "choice",
      value: current,
      options: appearanceOptions,
      change: (value) => {
        if (value === current) return;
        ctx.store.captureSync();
        ctx.store.updateBlock(model, {
          // updateBlock ignores undefined properties; persist the explicit default.
          appearance: value as CalloutAppearance,
        });
      },
    };
  },
} satisfies ToolbarAction;

const typeAction = {
  id: "callout-type",
  label: editorMessage("com.myoxus.editor.callout.type", "Callout type"),
  icon: "MegaphoneIcon",
  control(ctx) {
    const model = ctx.getCurrentModelByType(CalloutBlockModel);
    if (!model) return null;
    const current = model.props.type$.value;
    return {
      type: "choice",
      value: current ?? "note",
      options: [
        ...calloutPresets.map(({ type, label }) => ({ value: type, label })),
        ...(current && !calloutPresets.some((preset) => preset.type === current)
          ? [{ value: current, label: current }]
          : []),
      ],
      change: (type) => {
        if (type === current) return;
        const presentation = calloutPresentation(type);
        ctx.store.captureSync();
        ctx.store.updateBlock(model, {
          type,
          icon: { type: "emoji", unicode: presentation.icon },
          backgroundColorName: presentation.background,
        });
        ctx.store.captureSync();
      },
    };
  },
} satisfies ToolbarAction;

const iconPickerAction = {
  id: "icon-picker",
  label: editorMessage("com.myoxus.editor.toolbar.icon-picker", "Icon Picker"),
  tooltip: editorMessage(
    "com.myoxus.editor.toolbar.change-icon",
    "Change icon",
  ),
  icon: "SmileIcon",
  run(ctx, anchor) {
    if (!anchor) return;
    const model = ctx.getCurrentModelByType(CalloutBlockModel);
    if (!model) return;

    openCalloutIconPicker(ctx.std, model, anchor);
  },
} satisfies ToolbarAction;

const builtinToolbarConfig = {
  actions: [
    {
      id: "style",
      actions: [typeAction, appearanceAction, backgroundColorAction],
    } satisfies ToolbarActionGroup<ToolbarAction>,
    {
      id: "icon",
      actions: [iconPickerAction],
    } satisfies ToolbarActionGroup<ToolbarAction>,
    {
      placement: ActionPlacement.More,
      id: "c.delete",
      label: editorMessage("Delete", "Delete"),
      icon: "DeleteIcon",
      variant: "destructive",
      run(ctx) {
        const model = ctx.getCurrentModelByType(CalloutBlockModel);
        if (!model) return;

        ctx.store.deleteBlock(model);

        // Clears
        ctx.select("note");
        ctx.reset();
      },
    } satisfies ToolbarAction,
  ],
} as const satisfies ToolbarModuleConfig;

export const createBuiltinToolbarConfigExtension = (
  flavour: string,
): ExtensionType[] => {
  return [
    ToolbarModuleExtension({
      id: BlockFlavourIdentifier(flavour),
      config: builtinToolbarConfig,
    }),
  ];
};
