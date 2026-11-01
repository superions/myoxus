import { createToolbarColorControl } from "@virgultum/shared/services";
import { getGfxManagedOwner } from "@virgultum/std/gfx";

import { EdgelessCRUDIdentifier } from "@virgultum/block-surface";
import { packColor } from "@virgultum/components/color-picker";

import { createTextActions } from "@virgultum/gfx-text";
import { Bound } from "@virgultum/global/gfx";
import {
  type Color,
  DefaultTheme,
  FontFamily,
  getShapeName,
  getShapeRadius,
  getShapeType,
  isTransparent,
  LineWidth,
  BRUSH_LINE_WIDTHS,
  resolveColor,
  ShapeElementModel,
  type ShapeName,
  ShapeStyle,
  ShapeType,
  StrokeStyle,
} from "@virgultum/model";
import {
  type ToolbarGenericAction,
  type ToolbarModuleConfig,
  ToolbarModuleExtension,
  editorMessage,
} from "@virgultum/shared/services";
import { getMostCommonValue } from "@virgultum/shared/utils";
import { BlockFlavourIdentifier } from "@virgultum/std";
import { getRootBlock } from "@virgultum/widget-edgeless-toolbar";

import isEqual from "lodash-es/isEqual";

import { normalizeShapeBound } from "../element-renderer";
import type { ShapeToolOption } from "../shape-tool";
import { mountShapeTextEditor } from "../text/edgeless-shape-text-editor";
import { ShapeComponentConfig } from "./shape-menu-config";

function mermaidFlowchartShapeFromGenericShapeName(shapeName: ShapeName) {
  if (shapeName === ShapeType.Rect) return "rect";
  if (shapeName === "roundedRect") return "rounded";
  if (shapeName === ShapeType.Ellipse) return "circle";
  if (shapeName === ShapeType.Diamond) return "diamond";
  if (shapeName === ShapeType.Triangle) return "tri";
  return null;
}

export const shapeToolbarConfig = {
  actions: [
    {
      id: "c.switch-type",
      when(ctx) {
        const models = ctx.getSurfaceModelsByType(ShapeElementModel);
        return models.length > 0 && models.every((model) => !hasGrouped(model));
      },
      label: editorMessage(
        "com.myoxus.editor.toolbar.switch-shape-type",
        "Switch shape type",
      ),
      icon: "ShapeIcon",
      control(ctx) {
        const models = ctx.getSurfaceModelsByType(ShapeElementModel);
        if (!models.length) return null;

        const shapeName =
          getMostCommonValue<ShapeToolOption, "shapeName">(
            models.map((model) => ({
              shapeName: getShapeName(model.shapeType, model.radius),
            })),
            "shapeName",
          ) ?? ShapeType.Rect;

        const onPick = (shapeName: ShapeName) => {
          const shapeType = getShapeType(shapeName);
          const radius = getShapeRadius(shapeName);

          ctx.std.store.captureSync();

          for (const model of models) {
            const updates: Record<string, unknown> = { shapeType, radius };
            const mermaidNodeShape =
              mermaidFlowchartShapeFromGenericShapeName(shapeName);
            if (
              mermaidNodeShape &&
              model.yMap?.get?.("mermaidRole") === "mermaid-flowchart-node"
            ) {
              model.yMap.set("mermaidNodeShape", mermaidNodeShape);
              updates["mermaidNodeShape"] = mermaidNodeShape;
            }
            ctx.std
              .get(EdgelessCRUDIdentifier)
              .updateElement(model.id, updates);
          }
        };

        return {
          type: "choice",
          value: shapeName,
          options: ShapeComponentConfig.map((item) => ({
            value: item.name,
            label: item.tooltip,
            icon: item.iconName,
            disabled: item.disabled,
          })),
          change: (value) => onPick(value as ShapeName),
        };
      },
    },
    {
      id: "d.style",
      when: (ctx) => ctx.features.getFlag("enable_edgeless_scribbled_style"),
      label: editorMessage("com.myoxus.editor.toolbar.style", "Style"),
      control(ctx) {
        const models = ctx.getSurfaceModelsByType(ShapeElementModel);
        if (!models.length) return null;

        const field = "shapeStyle";
        const shapeStyle =
          getMostCommonValue(models, field) ?? ShapeStyle.General;
        const onPick = (value: boolean) => {
          const shapeStyle = value ? ShapeStyle.Scribbled : ShapeStyle.General;
          const fontFamily = value ? FontFamily.Kalam : FontFamily.Inter;

          for (const model of models) {
            ctx.std
              .get(EdgelessCRUDIdentifier)
              .updateElement(model.id, { shapeStyle, fontFamily });
          }
        };

        return {
          type: "choice",
          value: String(shapeStyle === ShapeStyle.Scribbled),
          options: [
            {
              value: "false",
              label: editorMessage(
                "com.myoxus.settings.editorSettings.edgeless.style.general",
                "General",
              ),
            },
            {
              value: "true",
              label: editorMessage(
                "com.myoxus.settings.editorSettings.edgeless.style.scribbled",
                "Scribbled",
              ),
            },
          ],
          change: (value) => onPick(value === "true"),
        };
      },
    },
    {
      id: "e.color",
      when(ctx) {
        const models = ctx.getSurfaceModelsByType(ShapeElementModel);
        return models.length > 0 && models.every((model) => !hasGrouped(model));
      },
      label: editorMessage("com.myoxus.editor.toolbar.style", "Style"),
      icon: "PaletteIcon",
      control(ctx) {
        const models = ctx.getSurfaceModelsByType(ShapeElementModel);
        if (!models.length) return null;

        const theme = ctx.theme.edgeless$.value;

        const mapped = models.map(
          ({ filled, fillColor, strokeColor, strokeWidth, strokeStyle }) => ({
            fillColor: filled
              ? resolveColor(fillColor, theme)
              : DefaultTheme.transparent,
            strokeColor: resolveColor(strokeColor, theme),
            strokeWidth,
            strokeStyle,
          }),
        );
        const fillColor =
          getMostCommonValue(mapped, "fillColor") ??
          resolveColor(DefaultTheme.shapeFillColor, theme);
        const strokeColor =
          getMostCommonValue(mapped, "strokeColor") ??
          resolveColor(DefaultTheme.shapeStrokeColor, theme);
        const strokeWidth =
          getMostCommonValue(mapped, "strokeWidth") ?? LineWidth.Four;
        const strokeStyle =
          getMostCommonValue(mapped, "strokeStyle") ?? StrokeStyle.Solid;

        const start = (field: string) => {
          ctx.store.captureSync();
          models.forEach((model) => model.stash(field));
          return () =>
            ctx.store.transact(() =>
              models.forEach((model) => model.pop(field)),
            );
        };
        const crud = ctx.std.get(EdgelessCRUDIdentifier);
        return {
          type: "menu",
          items: [
            {
              id: "fill",
              label: editorMessage(
                "com.myoxus.editor.note.fill-color",
                "Fill color",
              ),
              control: createToolbarColorControl({
                value: fillColor,
                theme,
                start: () => start("fillColor"),
                change: (value) => {
                  const filled = isTransparent(value);
                  const props = packColor("fillColor", value);
                  models.forEach((model) => {
                    if (filled && !model.filled)
                      Object.assign(props, {
                        filled,
                        color: getTextColor(value, filled),
                      });
                    crud.updateElement(model.id, props);
                  });
                },
              }),
            },
            {
              id: "stroke",
              label: editorMessage(
                "com.myoxus.editor.mermaid.quadrant-stroke-color",
                "Stroke color",
              ),
              control: createToolbarColorControl({
                value: strokeColor,
                theme,
                start: () => start("strokeColor"),
                change: (value) => {
                  const props = packColor("strokeColor", value);
                  models.forEach((model) =>
                    crud.updateElement(model.id, props),
                  );
                },
              }),
            },
            {
              id: "width",
              label: editorMessage(
                "com.myoxus.settings.editorSettings.edgeless.pen.thickness",
                "Thickness",
              ),
              disabled: strokeStyle === StrokeStyle.None,
              control: {
                type: "choice",
                value: String(strokeWidth),
                options: BRUSH_LINE_WIDTHS.map((value) => ({
                  value: String(value),
                  label: String(value),
                })),
                change: (value) =>
                  models.forEach((model) =>
                    crud.updateElement(model.id, {
                      strokeWidth: Number(value),
                    }),
                  ),
              },
            },
            {
              id: "style",
              label: editorMessage(
                "com.myoxus.editor.toolbar.stroke-style",
                "Stroke style",
              ),
              control: {
                type: "choice",
                value: strokeStyle,
                options: [
                  {
                    value: StrokeStyle.Solid,
                    label: editorMessage(
                      "com.myoxus.settings.editorSettings.edgeless.note.border.solid",
                      "Solid",
                    ),
                  },
                  {
                    value: StrokeStyle.Dash,
                    label: editorMessage(
                      "com.myoxus.settings.editorSettings.edgeless.note.border.dash",
                      "Dash",
                    ),
                  },
                  {
                    value: StrokeStyle.None,
                    label: editorMessage(
                      "com.myoxus.settings.editorSettings.edgeless.note.border.none",
                      "None",
                    ),
                  },
                ],
                change: (value) =>
                  models.forEach((model) =>
                    crud.updateElement(model.id, {
                      strokeStyle: value as StrokeStyle,
                    }),
                  ),
              },
            },
          ],
        };
      },
    },
    {
      id: "f.text",
      tooltip: editorMessage("com.myoxus.editor.toolbar.add-text", "Add text"),
      icon: "AddTextIcon",
      when(ctx) {
        const models = ctx.getSurfaceModelsByType(ShapeElementModel);
        return models.length === 1 && !hasGrouped(models[0]) && !models[0].text;
      },
      run(ctx) {
        const model = ctx.getCurrentModelByType(ShapeElementModel);
        if (!model) return;

        const rootBlock = getRootBlock(ctx);
        if (!rootBlock) return;

        mountShapeTextEditor(model, rootBlock);
      },
    },
    // id: `g.text`
    ...createTextActions(ShapeElementModel, "shape", (ctx, model, props) => {
      // No need to adjust element bounds
      if (props["textAlign"]) {
        ctx.std.get(EdgelessCRUDIdentifier).updateElement(model.id, props);
        return;
      }

      const xywh = normalizeShapeBound(
        model,
        Bound.fromXYWH(model.deserializedXYWH),
      ).serialize();

      ctx.std
        .get(EdgelessCRUDIdentifier)
        .updateElement(model.id, { ...props, xywh });
    }).map<ToolbarGenericAction>((action) => ({
      ...action,
      id: `g.text-${action.id}`,
      when(ctx) {
        const models = ctx.getSurfaceModelsByType(ShapeElementModel);
        return (
          models.length > 0 &&
          models.every((model) => !hasGrouped(model) && model.text)
        );
      },
    })),
  ],

  when: (ctx) => {
    const models = ctx.getSurfaceModelsByType(ShapeElementModel);
    return (
      models.length > 0 && models.every((model) => !getGfxManagedOwner(model))
    );
  },
} as const satisfies ToolbarModuleConfig;

// When the shape is filled with black color, the text color should be white.
// When the shape is transparent, the text color should be set according to the theme.
// Otherwise, the text color should be black.
function getTextColor(fillColor: Color, isNotTransparent = false) {
  if (isNotTransparent) {
    if (isEqual(fillColor, DefaultTheme.black)) {
      return DefaultTheme.white;
    } else if (isEqual(fillColor, DefaultTheme.white)) {
      return DefaultTheme.black;
    } else if (isEqual(fillColor, DefaultTheme.pureBlack)) {
      return DefaultTheme.pureWhite;
    } else if (isEqual(fillColor, DefaultTheme.pureWhite)) {
      return DefaultTheme.pureBlack;
    }
  }

  // aka `DefaultTheme.pureBlack`
  return DefaultTheme.shapeTextColor;
}

export function hasGrouped(model: ShapeElementModel) {
  return !!getGfxManagedOwner(model);
}

export const shapeToolbarExtension = ToolbarModuleExtension({
  id: BlockFlavourIdentifier("myoxus:surface:shape"),
  config: shapeToolbarConfig,
});
