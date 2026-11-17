import { EdgelessCRUDIdentifier } from "@virgultum/canvas-runtime/surface";
import { Bound } from "@virgultum/core/primitives/gfx";
import { TextElementModel } from "@virgultum/core/models";
import {
  type ToolbarModuleConfig,
  ToolbarModuleExtension,
} from "@virgultum/core/services";
import { BlockFlavourIdentifier } from "@virgultum/core/runtime";

import { normalizeTextBound } from "../element-renderer/utils";
import { createTextActions } from "./actions";

export const textToolbarConfig = {
  actions: createTextActions(TextElementModel, "text", (ctx, model, props) => {
    // No need to adjust element bounds
    if (props["textAlign"]) {
      ctx.std.get(EdgelessCRUDIdentifier).updateElement(model.id, props);
      return;
    }

    const { text: yText, hasMaxWidth } = model;
    const textStyle = {
      fontFamily: model.fontFamily,
      fontStyle: model.fontStyle,
      fontSize: model.fontSize,
      fontWeight: model.fontWeight,
      ...props,
    };

    const { fontFamily, fontStyle, fontSize, fontWeight } = textStyle;

    const bounds = normalizeTextBound(
      {
        yText,
        fontFamily,
        fontStyle,
        fontSize,
        fontWeight,
        hasMaxWidth,
      },
      Bound.fromXYWH(model.deserializedXYWH),
    );

    ctx.std.get(EdgelessCRUDIdentifier).updateElement(model.id, {
      ...textStyle,
      xywh: bounds.serialize(),
    });
  }),

  when: (ctx) => ctx.getSurfaceModelsByType(TextElementModel).length > 0,
} as const satisfies ToolbarModuleConfig;

export const textToolbarExtension = ToolbarModuleExtension({
  id: BlockFlavourIdentifier("myoxus:surface:text"),
  config: textToolbarConfig,
});
