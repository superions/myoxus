import { cssVar } from "@myoxus/theme";
import {
  createPopup,
  popupTargetFromElement,
} from "@virgultum/components/context-menu";

import {
  type CalloutAppearance,
  CalloutBlockModel,
  normalizeCalloutAppearance,
} from "@virgultum/model";
import {
  ActionPlacement,
  editorMessage,
  type IconData,
  IconPickerServiceIdentifier,
  type ToolbarAction,
  type ToolbarActionGroup,
  type ToolbarModuleConfig,
  ToolbarModuleExtension,
} from "@virgultum/shared/services";
import { BlockFlavourIdentifier } from "@virgultum/std";
import type { ExtensionType } from "@virgultum/store";

import { IconPickerWrapper } from "../icon-picker-wrapper.js";

const colors = [
  "default",
  "red",
  "orange",
  "yellow",
  "green",
  "teal",
  "blue",
  "purple",
  "grey",
] as const;

const colorLabels = {
  default: editorMessage(
    "com.myoxus.editor.callout.background.default",
    "Default background",
  ),
  red: editorMessage(
    "com.myoxus.editor.callout.background.red",
    "Red background",
  ),
  orange: editorMessage(
    "com.myoxus.editor.callout.background.orange",
    "Orange background",
  ),
  yellow: editorMessage(
    "com.myoxus.editor.callout.background.yellow",
    "Yellow background",
  ),
  green: editorMessage(
    "com.myoxus.editor.callout.background.green",
    "Green background",
  ),
  teal: editorMessage(
    "com.myoxus.editor.callout.background.teal",
    "Teal background",
  ),
  blue: editorMessage(
    "com.myoxus.editor.callout.background.blue",
    "Blue background",
  ),
  purple: editorMessage(
    "com.myoxus.editor.callout.background.purple",
    "Purple background",
  ),
  grey: editorMessage(
    "com.myoxus.editor.callout.background.grey",
    "Grey background",
  ),
} as const;

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
    return {
      type: "choice",
      value: model.props.backgroundColorName ?? "grey",
      options: colors.map((value) => ({ value, label: colorLabels[value] })),
      change: (color) =>
        ctx.store.updateBlock(model, {
          backgroundColorName: color === "default" ? "grey" : color,
        }),
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
          appearance:
            value === "soft" ? undefined : (value as CalloutAppearance),
        });
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

    const iconPickerService = ctx.std.getOptional(IconPickerServiceIdentifier);
    if (!iconPickerService) {
      console.warn("IconPickerService not found");
      return;
    }

    const iconPickerComponent = iconPickerService.iconPickerComponent;

    const props = {
      onSelect: (iconData?: IconData) => {
        // When iconData is undefined (delete icon), set icon to undefined
        ctx.store.updateBlock(model, { icon: iconData });
        closeHandler(); // Close the picker after selection
      },
      onClose: () => {
        closeHandler();
      },
    };

    const wrapper = new IconPickerWrapper();
    wrapper.iconPickerComponent = iconPickerComponent;
    wrapper.props = props;
    wrapper.style.position = "absolute";
    wrapper.style.backgroundColor = cssVar("backgroundOverlayPanelColor");
    wrapper.style.boxShadow = "var(--myoxus-menu-shadow)";
    wrapper.style.borderRadius = "8px";

    const target = popupTargetFromElement(anchor);

    const closeHandler = createPopup(target, wrapper, {
      onClose: () => {},
    });
  },
} satisfies ToolbarAction;

const builtinToolbarConfig = {
  actions: [
    {
      id: "style",
      actions: [appearanceAction, backgroundColorAction],
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
