import type { MyoxusIconExportName } from "@myoxus/icons/names";
import { createToolbarColorControl } from "@virgultum/shared/services";
import {
  editorMessage,
  type ToolbarContext,
  type ToolbarGenericAction,
  type ToolbarModuleConfig,
  ToolbarModuleExtension,
} from "@virgultum/shared/services";

import { EdgelessCRUDIdentifier } from "@virgultum/block-surface";
import { packColor } from "@virgultum/components/color-picker";

import { createTextActions, normalizeTextBound } from "@virgultum/gfx-text";
import { Bound } from "@virgultum/global/gfx";
import {
  ConnectorElementModel,
  type ConnectorElementProps,
  type ConnectorLabelProps,
  ConnectorMode,
  DEFAULT_FRONT_ENDPOINT_STYLE,
  DEFAULT_REAR_ENDPOINT_STYLE,
  DefaultTheme,
  LineWidth,
  BRUSH_LINE_WIDTHS,
  PointStyle,
  resolveColor,
  StrokeStyle,
} from "@virgultum/model";

import {
  getMostCommonResolvedValue,
  getMostCommonValue,
} from "@virgultum/shared/utils";
import { BlockFlavourIdentifier } from "@virgultum/std";
import { getRootBlock } from "@virgultum/widget-edgeless-toolbar";

import { isConnectorWithLabel } from "../connector-manager";
import { mountConnectorLabelEditor } from "../text";

const FRONT_ENDPOINT_STYLE_LIST = [
  {
    value: PointStyle.None,
    icon: "StartPointIcon",
  },
  {
    value: PointStyle.Arrow,
    icon: "StartPointArrowIcon",
  },
  {
    value: PointStyle.Triangle,
    icon: "StartPointTriangleIcon",
  },
  {
    value: PointStyle.Circle,
    icon: "StartPointCircleIcon",
  },
  {
    value: PointStyle.Diamond,
    icon: "StartPointDiamondIcon",
  },
] as const satisfies { value: PointStyle; icon: MyoxusIconExportName }[];

const REAR_ENDPOINT_STYLE_LIST = [
  {
    value: PointStyle.Diamond,
    icon: "EndPointDiamondIcon",
  },
  {
    value: PointStyle.Circle,
    icon: "EndPointCircleIcon",
  },
  {
    value: PointStyle.Triangle,
    icon: "EndPointTriangleIcon",
  },
  {
    value: PointStyle.Arrow,
    icon: "EndPointArrowIcon",
  },
  {
    value: PointStyle.None,
    icon: "StartPointIcon",
  },
] as const satisfies { value: PointStyle; icon: MyoxusIconExportName }[];

const CONNECTOR_MODE_LIST = [
  {
    key: "Curve",
    value: ConnectorMode.Curve,
    icon: "ConnectorCIcon",
  },
  {
    key: "Elbowed",
    value: ConnectorMode.Orthogonal,
    icon: "ConnectorEIcon",
  },
  {
    key: "Straight",
    value: ConnectorMode.Straight,
    icon: "ConnectorLIcon",
  },
] as const satisfies {
  key: string;
  value: ConnectorMode;
  icon: MyoxusIconExportName;
}[];

const endpointLabels = {
  [PointStyle.None]: editorMessage(
    "com.myoxus.settings.editorSettings.edgeless.note.border.none",
    "None",
  ),
  [PointStyle.Arrow]: editorMessage(
    "com.myoxus.editor.mermaid.option-arrow",
    "Arrow",
  ),
  [PointStyle.Triangle]: editorMessage(
    "com.myoxus.settings.editorSettings.edgeless.shape.triangle",
    "Triangle",
  ),
  [PointStyle.Circle]: editorMessage(
    "com.myoxus.editor.mermaid.shape-circle",
    "Circle",
  ),
  [PointStyle.Diamond]: editorMessage(
    "com.myoxus.settings.editorSettings.edgeless.shape.diamond",
    "Diamond",
  ),
};
const modeLabels = {
  [ConnectorMode.Curve]: editorMessage("com.myoxus.editor.menu.curve", "Curve"),
  [ConnectorMode.Orthogonal]: editorMessage(
    "com.myoxus.editor.menu.elbowed",
    "Elbowed",
  ),
  [ConnectorMode.Straight]: editorMessage(
    "com.myoxus.editor.menu.straight",
    "Straight",
  ),
};

export const connectorToolbarConfig = {
  actions: [
    {
      id: "a.stroke-color",
      label: editorMessage(
        "com.myoxus.editor.toolbar.stroke-style",
        "Stroke style",
      ),
      icon: "PaletteIcon",
      control(ctx) {
        const models = ctx.getSurfaceModelsByType(ConnectorElementModel);
        if (!models.length) return null;
        const theme = ctx.theme.edgeless$.value;
        const field = "stroke";
        const strokeWidth =
          getMostCommonValue(models, "strokeWidth") ?? LineWidth.Four;
        const strokeStyle =
          getMostCommonValue(models, "strokeStyle") ?? StrokeStyle.Solid;
        const value =
          getMostCommonResolvedValue(models, field, (color) =>
            resolveColor(color, theme),
          ) ?? resolveColor(DefaultTheme.connectorColor, theme);
        return {
          type: "menu",
          items: [
            {
              id: "color",
              label: editorMessage(
                "com.myoxus.editor.mermaid.quadrant-stroke-color",
                "Stroke color",
              ),
              control: createToolbarColorControl({
                value,
                theme,
                change: (color) => {
                  const props = packColor(field, color);
                  models.forEach((model) =>
                    ctx.std
                      .get(EdgelessCRUDIdentifier)
                      .updateElement(model.id, props),
                  );
                },
                start: () => {
                  ctx.store.captureSync();
                  models.forEach((model) => model.stash(field));
                  return () =>
                    ctx.store.transact(() =>
                      models.forEach((model) => model.pop(field)),
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
                  updateModelsWith(ctx, models, "strokeWidth", Number(value)),
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
                  updateModelsWith(
                    ctx,
                    models,
                    "strokeStyle",
                    value as StrokeStyle,
                  ),
              },
            },
          ],
        };
      },
    },
    {
      id: "b.style",
      when: (ctx) => ctx.features.getFlag("enable_edgeless_scribbled_style"),
      label: editorMessage("com.myoxus.editor.toolbar.style", "Style"),
      control(ctx) {
        const models = ctx.getSurfaceModelsByType(ConnectorElementModel);
        if (!models.length) return null;

        const field = "rough";
        const rough = getMostCommonValue(models, field) ?? false;
        const onPick = (value: boolean) => {
          updateModelsWith(ctx, models, field, value);
        };

        return {
          type: "choice",
          value: String(rough),
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
      id: "c.endpoint-style",
      actions: [
        {
          id: "a.start-point-style",
          label: editorMessage(
            "com.myoxus.editor.toolbar.start-point-style",
            "Endpoint style",
          ),
          control(ctx) {
            const models = ctx.getSurfaceModelsByType(ConnectorElementModel);
            if (!models.length) return null;

            const field = "frontEndpointStyle";
            const pointStyle =
              getMostCommonValue(models, field) ?? DEFAULT_FRONT_ENDPOINT_STYLE;
            const onPick = (value: PointStyle) => {
              updateModelsWith(ctx, models, field, value);
            };

            return {
              type: "choice",
              value: String(pointStyle),
              options: FRONT_ENDPOINT_STYLE_LIST.map((item) => ({
                value: String(item.value),
                label: endpointLabels[item.value],
                icon: item.icon,
              })),
              change: (value) => onPick(value as PointStyle),
            };
          },
        },
        {
          id: "b.flip-direction",
          icon: "FlipDirectionIcon",
          tooltip: editorMessage(
            "com.myoxus.editor.toolbar.flip-direction",
            "Flip direction",
          ),
          run(ctx) {
            const models = ctx.getSurfaceModelsByType(ConnectorElementModel);
            if (!models.length) return;

            const frontEndpointStyle =
              getMostCommonValue(models, "frontEndpointStyle") ??
              DEFAULT_FRONT_ENDPOINT_STYLE;
            const rearEndpointStyle =
              getMostCommonValue(models, "rearEndpointStyle") ??
              DEFAULT_REAR_ENDPOINT_STYLE;

            if (frontEndpointStyle === rearEndpointStyle) return;

            for (const model of models) {
              ctx.std.get(EdgelessCRUDIdentifier).updateElement(model.id, {
                frontEndpointStyle: rearEndpointStyle,
                rearEndpointStyle: frontEndpointStyle,
              });
            }
          },
        },
        {
          id: "c.end-point-style",
          label: editorMessage(
            "com.myoxus.editor.toolbar.end-point-style",
            "Endpoint style",
          ),
          control(ctx) {
            const models = ctx.getSurfaceModelsByType(ConnectorElementModel);
            if (!models.length) return null;

            const field = "rearEndpointStyle";
            const pointStyle =
              getMostCommonValue(models, field) ?? DEFAULT_REAR_ENDPOINT_STYLE;
            const onPick = (value: PointStyle) => {
              updateModelsWith(ctx, models, field, value);
            };

            return {
              type: "choice",
              value: String(pointStyle),
              options: REAR_ENDPOINT_STYLE_LIST.map((item) => ({
                value: String(item.value),
                label: endpointLabels[item.value],
                icon: item.icon,
              })),
              change: (value) => onPick(value as PointStyle),
            };
          },
        },
        {
          id: "d.connector-shape",
          label: editorMessage(
            "com.myoxus.editor.toolbar.connector-shape",
            "Connector shape",
          ),
          control(ctx) {
            const models = ctx.getSurfaceModelsByType(ConnectorElementModel);
            if (!models.length) return null;

            const field = "mode";
            const mode =
              getMostCommonValue(models, field) ?? ConnectorMode.Orthogonal;
            const onPick = (value: ConnectorMode) => {
              updateModelsWith(ctx, models, field, value);
            };

            return {
              type: "choice",
              value: String(mode),
              options: CONNECTOR_MODE_LIST.map((item) => ({
                value: String(item.value),
                label: modeLabels[item.value],
                icon: item.icon,
              })),
              change: (value) => onPick(Number(value) as ConnectorMode),
            };
          },
        },
      ],
    },
    {
      id: "g.text",
      label: editorMessage("com.myoxus.editor.toolbar.add-text", "Add text"),
      icon: "AddTextIcon",
      when: (ctx) => {
        const models = ctx.getSurfaceModelsByType(ConnectorElementModel);
        return models.length === 1 && !models[0].text;
      },
      run(ctx) {
        const model = ctx.getCurrentModelByType(ConnectorElementModel);
        const root = getRootBlock(ctx);
        if (model && root) mountConnectorLabelEditor(model, root);
      },
    },
    {
      id: "g.edit-text",
      label: editorMessage(
        "com.myoxus.editor.toolbar.edit-label",
        "Edit label",
      ),
      icon: "AddTextIcon",
      when: (ctx) => {
        const models = ctx.getSurfaceModelsByType(ConnectorElementModel);
        return models.length === 1 && Boolean(models[0].text);
      },
      run(ctx) {
        const model = ctx.getCurrentModelByType(ConnectorElementModel);
        const root = getRootBlock(ctx);
        if (model && root) mountConnectorLabelEditor(model, root);
      },
    },
    // id: `g.text`
    ...createTextActions(
      ConnectorElementModel,
      "connector",
      (ctx, model, props) => {
        if (!isConnectorWithLabel(model)) return;

        const labelStyle = { ...model.labelStyle, ...props };

        // No need to adjust element bounds
        if (props["textAlign"]) {
          ctx.std
            .get(EdgelessCRUDIdentifier)
            .updateElement(model.id, { labelStyle });
          return;
        }

        const { fontFamily, fontStyle, fontSize, fontWeight } = labelStyle;
        const {
          text,
          labelXYWH,
          labelConstraints: { hasMaxWidth, maxWidth },
        } = model;
        const prevBounds = Bound.fromXYWH(labelXYWH || [0, 0, 16, 16]);
        const center = prevBounds.center;
        const bounds = normalizeTextBound(
          {
            yText: text!,
            fontFamily,
            fontStyle,
            fontSize,
            fontWeight,
            hasMaxWidth,
            maxWidth,
          },
          prevBounds,
        );
        bounds.center = center;

        ctx.std.get(EdgelessCRUDIdentifier).updateElement(model.id, {
          labelStyle,
          labelXYWH: bounds.toXYWH(),
        });
      },
      (model) => model.labelStyle,
      (model, type, _) => model[type]("labelStyle"),
    ).map<ToolbarGenericAction>((action) => ({
      ...action,
      id: `g.text-${action.id}`,
      when(ctx) {
        const models = ctx.getSurfaceModelsByType(ConnectorElementModel);
        return models.length > 0 && models.every((model) => model.hasLabel());
      },
    })),
  ],

  when: (ctx) => ctx.getSurfaceModelsByType(ConnectorElementModel).length > 0,
} as const satisfies ToolbarModuleConfig;

function updateModelsWith<
  T extends keyof Omit<ConnectorElementProps, keyof ConnectorLabelProps>,
>(
  ctx: ToolbarContext,
  models: ConnectorElementModel[],
  field: T,
  value: ConnectorElementProps[T],
) {
  ctx.store.captureSync();

  for (const model of models) {
    ctx.std
      .get(EdgelessCRUDIdentifier)
      .updateElement(model.id, { [field]: value });
  }
}

export const connectorToolbarExtension = ToolbarModuleExtension({
  id: BlockFlavourIdentifier("myoxus:surface:connector"),
  config: connectorToolbarConfig,
});
