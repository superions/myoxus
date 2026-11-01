import { createToolbarColorControl } from "@virgultum/shared/services";
import {
  editorMessage,
  type ToolbarModuleConfig,
  ToolbarModuleExtension,
} from "@virgultum/shared/services";
import { EdgelessCRUDIdentifier } from "@virgultum/block-surface";
import { packColor } from "@virgultum/components/color-picker";
import {
  BRUSH_LINE_WIDTHS,
  BrushElementModel,
  DefaultTheme,
  LineWidth,
  resolveColor,
} from "@virgultum/model";

import {
  getMostCommonResolvedValue,
  getMostCommonValue,
} from "@virgultum/shared/utils";
import { BlockFlavourIdentifier } from "@virgultum/std";

export const brushToolbarConfig = {
  actions: [
    {
      id: "a.line-width",
      label: editorMessage(
        "com.myoxus.settings.editorSettings.edgeless.pen.thickness",
        "Thickness",
      ),
      control(ctx) {
        const models = ctx.getSurfaceModelsByType(BrushElementModel);
        if (!models.length) return null;

        const lineWidth =
          getMostCommonValue(models, "lineWidth") ?? LineWidth.Four;
        const onPick = (lineWidth: number) => {
          for (const model of models) {
            ctx.std
              .get(EdgelessCRUDIdentifier)
              .updateElement(model.id, { lineWidth });
          }
        };

        return {
          type: "choice",
          value: String(lineWidth),
          options: BRUSH_LINE_WIDTHS.map((value) => ({
            value: String(value),
            label: String(value),
          })),
          change: (value) => onPick(Number(value)),
        };
      },
    },
    {
      id: "b.color-picker",
      label: editorMessage(
        "com.myoxus.settings.editorSettings.edgeless.pen.color",
        "Color",
      ),
      icon: "PaletteIcon",
      control(ctx) {
        const models = ctx.getSurfaceModelsByType(BrushElementModel);
        if (!models.length) return null;

        const theme = ctx.theme.edgeless$.value;

        const field = "color";
        const color =
          getMostCommonResolvedValue(models, field, (color) =>
            resolveColor(color, theme),
          ) ?? resolveColor(DefaultTheme.black, theme);
        return createToolbarColorControl({
          value: color,
          theme,
          change: (color) => {
            const props = packColor(field, color);
            const crud = ctx.std.get(EdgelessCRUDIdentifier);
            models.forEach((model) => crud.updateElement(model.id, props));
          },
          start: () => {
            ctx.store.captureSync();
            models.forEach((model) => model.stash(field));
            return () =>
              ctx.store.transact(() =>
                models.forEach((model) => model.pop(field)),
              );
          },
        });
      },
    },
  ],

  when: (ctx) => ctx.getSurfaceModelsByType(BrushElementModel).length > 0,
} as const satisfies ToolbarModuleConfig;

export const brushToolbarExtension = ToolbarModuleExtension({
  id: BlockFlavourIdentifier("myoxus:surface:brush"),
  config: brushToolbarConfig,
});
