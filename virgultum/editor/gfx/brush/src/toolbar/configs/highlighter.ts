import { createToolbarColorControl } from "@virgultum/shared/services";
import {
  editorMessage,
  type ToolbarModuleConfig,
  ToolbarModuleExtension,
} from "@virgultum/shared/services";
import { EdgelessCRUDIdentifier } from "@virgultum/block-surface";
import {
  adjustColorAlpha,
  keepColor,
  packColor,
} from "@virgultum/components/color-picker";
import {
  DEFAULT_HIGHLIGHTER_LINE_WIDTH,
  DefaultTheme,
  HIGHLIGHTER_LINE_WIDTHS,
  HighlighterElementModel,
  resolveColor,
} from "@virgultum/model";

import {
  getMostCommonResolvedValue,
  getMostCommonValue,
} from "@virgultum/shared/utils";
import { BlockFlavourIdentifier } from "@virgultum/std";

const trackBaseProps = {
  category: "highlighter",
};

export const highlighterToolbarConfig = {
  actions: [
    {
      id: "a.line-width",
      label: editorMessage(
        "com.myoxus.settings.editorSettings.edgeless.pen.thickness",
        "Thickness",
      ),
      control(ctx) {
        const models = ctx.getSurfaceModelsByType(HighlighterElementModel);
        if (!models.length) return null;

        const lineWidth =
          getMostCommonValue(models, "lineWidth") ??
          DEFAULT_HIGHLIGHTER_LINE_WIDTH;
        const onPick = (lineWidth: number) => {
          for (const model of models) {
            ctx.std
              .get(EdgelessCRUDIdentifier)
              .updateElement(model.id, { lineWidth });
          }

          ctx.track("CanvasElementUpdated", {
            ...trackBaseProps,
            control: "line width",
          });
        };

        return {
          type: "choice",
          value: String(lineWidth),
          options: HIGHLIGHTER_LINE_WIDTHS.map((value) => ({
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
        const models = ctx.getSurfaceModelsByType(HighlighterElementModel);
        if (!models.length) return null;

        const theme = ctx.theme.edgeless$.value;

        const field = "color";
        const color = keepColor(
          getMostCommonResolvedValue(models, field, (color) =>
            resolveColor(color, theme),
          ) ?? resolveColor(DefaultTheme.black, theme),
        );
        return createToolbarColorControl({
          value: color,
          theme,
          palettes: DefaultTheme.StrokeColorShortPalettes,
          custom: false,
          change: (color) => {
            const value = adjustColorAlpha(color, 0.3);
            models.forEach((model) =>
              ctx.std
                .get(EdgelessCRUDIdentifier)
                .updateElement(model.id, packColor(field, value)),
            );
          },
          start: () => {
            models.forEach((model) => model.stash(field));
            ctx.track("CanvasElementUpdated", {
              ...trackBaseProps,
              control: "color picker",
            });
            return () => models.forEach((model) => model.pop(field));
          },
        });
      },
    },
  ],

  when: (ctx) => ctx.getSurfaceModelsByType(HighlighterElementModel).length > 0,
} as const satisfies ToolbarModuleConfig;

export const highlighterToolbarExtension = ToolbarModuleExtension({
  id: BlockFlavourIdentifier("myoxus:surface:highlighter"),
  config: highlighterToolbarConfig,
});
