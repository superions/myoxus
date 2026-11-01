import type { MyoxusIconExportName } from "@myoxus/icons/names";
import {
  createToolbarColorControl,
  ActionPlacement,
  editorMessage,
  EditorI18nProvider,
  resolveEditorMessage,
  type ToolbarActions,
  type ToolbarContext,
} from "@virgultum/shared/services";
import { signal } from "@preact/signals-core";
import { EdgelessCRUDIdentifier, TextUtils } from "@virgultum/block-surface";
import { packColor } from "@virgultum/components/color-picker";

import {
  DefaultTheme,
  FontFamily,
  EdgelessTextBlockModel,
  ShapeElementModel,
  ParagraphBlockModel,
  ListBlockModel,
  FontStyle,
  FontWeight,
  FontWeightSchema,
  FontStyleSchema,
  resolveColor,
  type SurfaceTextModelMap,
  TextAlign,
  type TextStyleProps,
} from "@virgultum/model";

import {
  getMostCommonResolvedValue,
  getMostCommonValue,
} from "@virgultum/shared/utils";
import type { GfxModel } from "@virgultum/std/gfx";
import { BlockSelection } from "@virgultum/std";
import { formatBlockCommand } from "@virgultum/inline-preset";

const FONT_SIZE_LIST = [
  { value: 16 },
  { value: 24 },
  { value: 32 },
  { value: 40 },
  { value: 64 },
  { value: 128 },
] as const;

function supportedFontStyles(family: string) {
  return TextUtils.getFontStyles(family).filter(
    (face) =>
      FontWeightSchema.safeParse(face.weight).success &&
      FontStyleSchema.safeParse(face.style).success,
  );
}

const TEXT_ALIGN_LIST = [
  {
    label: editorMessage("com.myoxus.editor.toolbar.align-left", "Align left"),
    value: TextAlign.Left,
    icon: "TextAlignLeftIcon",
  },
  {
    label: editorMessage(
      "com.myoxus.editor.toolbar.align-center",
      "Align center",
    ),
    value: TextAlign.Center,
    icon: "TextAlignCenterIcon",
  },
  {
    label: editorMessage(
      "com.myoxus.editor.toolbar.align-right",
      "Align right",
    ),
    value: TextAlign.Right,
    icon: "TextAlignRightIcon",
  },
] as const satisfies {
  label: ReturnType<typeof editorMessage>;
  value: TextAlign;
  icon: MyoxusIconExportName;
}[];

export function createTextActions<
  K extends abstract new (...args: any[]) => SurfaceTextModelMap[T],
  T extends keyof SurfaceTextModelMap,
>(
  klass: K,
  type: T,
  update: (
    ctx: ToolbarContext,
    model: InstanceType<K>,
    props: Partial<TextStyleProps>,
  ) => void = (ctx, model, props) =>
    ctx.std.get(EdgelessCRUDIdentifier).updateElement(model.id, props),
  mapInto: (model: InstanceType<K>) => Partial<TextStyleProps> = (model) =>
    model as Partial<TextStyleProps>,
  stash: (
    model: InstanceType<K>,
    type: "stash" | "pop",
    field: "color",
  ) => void = (model, type, field) => model[type](field as never),
) {
  const fontChoices = new WeakMap<InstanceType<K>, object>();
  return [
    {
      id: "a.font",
      label: editorMessage("com.myoxus.editor.toolbar.font", "Font"),
      control(ctx) {
        const models = ctx.getSurfaceModelsByType(klass);
        if (!models.length) return null;
        const allowed = models.every((model) =>
          isSurfaceTextModel(model, klass, type),
        );
        if (!allowed) return null;

        const mappedModels = models.map(mapInto);

        const fontFamily =
          getMostCommonValue(mappedModels, "fontFamily") ?? FontFamily.Inter;

        const onPick = (fontFamily: FontFamily) => {
          let fontWeight =
            getMostCommonValue(mappedModels, "fontWeight") ??
            FontWeight.Regular;
          let fontStyle =
            getMostCommonValue(mappedModels, "fontStyle") ?? FontStyle.Normal;

          if (!TextUtils.supportsFontFace(fontFamily, fontWeight, fontStyle)) {
            const available = supportedFontStyles(fontFamily);
            const fallback =
              available.find(
                (face) =>
                  face.weight === FontWeight.Regular &&
                  face.style === FontStyle.Normal,
              ) ?? available[0];
            if (!fallback) return;
            fontWeight = fallback.weight as FontWeight;
            fontStyle = fallback.style as FontStyle;
          }

          const request = {};
          models.forEach((model) => fontChoices.set(model, request));
          const signature = () =>
            JSON.stringify(
              models.map((model) => {
                const value = mapInto(model);
                return [value.fontFamily, value.fontWeight, value.fontStyle];
              }),
            );
          const previous = signature();
          const apply = () => {
            const selected = ctx.getSurfaceModelsByType(klass);
            // Font loading may finish after the editor, selection or formatting changed.
            if (
              !ctx.host.isConnected ||
              ctx.readonly ||
              selected.length !== models.length ||
              models.some(
                (model) =>
                  !selected.includes(model) ||
                  fontChoices.get(model) !== request,
              ) ||
              signature() !== previous
            )
              return;
            ctx.store.captureSync();
            models.forEach((model) =>
              update(ctx, model, { fontFamily, fontWeight, fontStyle }),
            );
            ctx.store.captureSync();
          };
          const font = `${fontStyle} ${fontWeight} ${FONT_SIZE_LIST[0].value}px ${TextUtils.wrapFontFamily(fontFamily)}`;
          if (document.fonts.check(font)) apply();
          else void document.fonts.load(font).then(apply).catch(console.error);
        };

        return {
          type: "choice",
          value: TextUtils.getFontFamilyName(fontFamily),
          options: TextUtils.getFontFamilies().map((value) => ({
            value,
            label: value,
          })),
          change: (value) => onPick(value as FontFamily),
        };
      },
    },
    {
      id: "b.text-color",
      label: editorMessage(
        "com.myoxus.editor.toolbar.text-color",
        "Text color",
      ),
      control(ctx) {
        const models = ctx.getSurfaceModelsByType(klass);
        if (!models.length) return null;
        const allowed = models.every((model) =>
          isSurfaceTextModel(model, klass, type),
        );
        if (!allowed) return null;

        const theme = ctx.theme.edgeless$.value;

        const palettes =
          type === "shape"
            ? DefaultTheme.ShapeTextColorPalettes
            : DefaultTheme.Palettes;
        const defaultColor =
          type === "shape"
            ? DefaultTheme.shapeTextColor
            : DefaultTheme.textColor;

        const mappedModels = models.map(mapInto);

        const field = "color";
        const color =
          getMostCommonResolvedValue(mappedModels, field, (color) =>
            resolveColor(color ?? defaultColor, theme),
          ) ?? resolveColor(defaultColor, theme);

        return createToolbarColorControl({
          value: color,
          theme,
          palettes,
          change: (color) => {
            const props = packColor(field, color);
            models.forEach((model) => update(ctx, model, props));
          },
          start: () => {
            ctx.store.captureSync();
            models.forEach((model) => stash(model, "stash", field));
            return () =>
              ctx.store.transact(() =>
                models.forEach((model) => stash(model, "pop", field)),
              );
          },
        });
      },
    },
    {
      id: "c.font-style",
      generate(ctx) {
        const models = ctx.getSurfaceModelsByType(klass);
        if (
          !models.length ||
          !models.every((model) => isSurfaceTextModel(model, klass, type))
        )
          return null;
        const values = models.map(mapInto);
        const weight =
          getMostCommonValue(values, "fontWeight") ?? FontWeight.Regular;
        const style =
          getMostCommonValue(values, "fontStyle") ?? FontStyle.Normal;
        const bold = Number(weight) >= Number(FontWeight.SemiBold);
        const supports = (w: FontWeight, s: FontStyle) =>
          values.every((value) =>
            TextUtils.supportsFontFace(
              value.fontFamily ?? FontFamily.Inter,
              w,
              s,
            ),
          );
        const set = (fontWeight: FontWeight, fontStyle: FontStyle) => {
          ctx.store.captureSync();
          models.forEach((model) =>
            update(ctx, model, { fontWeight, fontStyle }),
          );
          ctx.store.captureSync();
        };
        const boldWeight = supports(FontWeight.Bold, style)
          ? FontWeight.Bold
          : FontWeight.SemiBold;
        return {
          actions: [
            {
              id: "normal",
              score: 0,
              label: editorMessage("com.myoxus.editor.menu.regular", "Regular"),
              icon: "FontIcon",
              disabled: !supports(FontWeight.Regular, FontStyle.Normal),
              active:
                weight === FontWeight.Regular && style === FontStyle.Normal,
              run: () => set(FontWeight.Regular, FontStyle.Normal),
            },
            {
              id: "bold",
              score: 1,
              label: editorMessage("Bold", "Bold"),
              icon: "BoldIcon",
              active: bold,
              disabled: !bold && !supports(boldWeight, style),
              run: () => set(bold ? FontWeight.Regular : boldWeight, style),
            },
            {
              id: "italic",
              score: 2,
              label: editorMessage(
                "com.myoxus.editor.keyboard.italic",
                "Italic",
              ),
              icon: "ItalicIcon",
              active: style === FontStyle.Italic,
              disabled:
                style !== FontStyle.Italic &&
                !supports(weight, FontStyle.Italic),
              run: () =>
                set(
                  weight,
                  style === FontStyle.Italic
                    ? FontStyle.Normal
                    : FontStyle.Italic,
                ),
            },
          ],
        };
      },
    },
    {
      id: "c.text-decoration",
      generate(ctx) {
        const models = ctx.getSurfaceModelsByType(klass);
        if (!models.length) return null;
        if (
          type === "shape" &&
          models.every((model) => model instanceof ShapeElementModel)
        ) {
          const active = models.every(
            (model) => model.textDecoration === "underline",
          );
          return {
            actions: [
              {
                id: "underline",
                label: editorMessage(
                  "com.myoxus.editor.keyboard.underline",
                  "Underline",
                ),
                icon: "UnderLineIcon",
                active,
                run: () => {
                  ctx.store.captureSync();
                  models.forEach((model) =>
                    ctx.std
                      .get(EdgelessCRUDIdentifier)
                      .updateElement(model.id, {
                        textDecoration: active ? "none" : "underline",
                      }),
                  );
                  ctx.store.captureSync();
                },
              },
            ],
          };
        }
        if (
          type !== "edgeless-text" ||
          !models.every((model) => model instanceof EdgelessTextBlockModel)
        )
          return null;
        const blocks = models
          .flatMap((model) => model.children)
          .filter(
            (block): block is ParagraphBlockModel | ListBlockModel =>
              block instanceof ParagraphBlockModel ||
              block instanceof ListBlockModel,
          );
        if (!blocks.length) return null;
        return {
          actions: (["underline", "strike"] as const).map((key) => {
            const active = blocks.every(
              (block) =>
                block.props.text.length > 0 &&
                block.props.text
                  .toDelta()
                  .every((delta) => Boolean(delta.attributes?.[key])),
            );
            return {
              id: key,
              score: key === "underline" ? 0 : 1,
              label:
                key === "underline"
                  ? editorMessage(
                      "com.myoxus.editor.keyboard.underline",
                      "Underline",
                    )
                  : editorMessage(
                      "com.myoxus.editor.keyboard.strike-through",
                      "Strikethrough",
                    ),
              icon:
                key === "underline"
                  ? ("UnderLineIcon" as const)
                  : ("StrikeThroughIcon" as const),
              active,
              run: () =>
                ctx.command.exec(formatBlockCommand, {
                  blockSelections: blocks.map((block) =>
                    ctx.selection.create(BlockSelection, { blockId: block.id }),
                  ),
                  styles: { [key]: active ? null : true },
                }),
            };
          }),
        };
      },
    },
    {
      id: "c.font-style-variants",
      placement: ActionPlacement.More,
      label: editorMessage(
        "com.myoxus.editor.toolbar.font-style",
        "Font style",
      ),
      control(ctx) {
        const models = ctx.getSurfaceModelsByType(klass);
        if (!models.length) return null;
        const allowed = models.every((model) =>
          isSurfaceTextModel(model, klass, type),
        );
        if (!allowed) return null;

        const fontFamily =
          getMostCommonValue(models.map(mapInto), "fontFamily") ??
          FontFamily.Inter;
        const fontWeight =
          getMostCommonValue(models.map(mapInto), "fontWeight") ??
          FontWeight.Regular;
        const fontStyle =
          getMostCommonValue(models.map(mapInto), "fontStyle") ??
          FontStyle.Normal;
        let matchFontFaces = supportedFontStyles(fontFamily);
        // Keep the authored style visible before font-face metadata is available.
        if (!matchFontFaces.length)
          matchFontFaces = [{ weight: fontWeight, style: fontStyle }];
        const disabled =
          matchFontFaces.length === 1 &&
          matchFontFaces[0].style === fontStyle &&
          matchFontFaces[0].weight === fontWeight;

        const onPick = (fontWeight: FontWeight, fontStyle: FontStyle) => {
          for (const model of models) {
            update(ctx, model, { fontWeight, fontStyle });
          }
        };

        const i18n = ctx.std.getOptional(EditorI18nProvider) ?? undefined;
        const weights = {
          [FontWeight.Bold]: editorMessage("Bold", "Bold"),
          [FontWeight.Medium]: editorMessage(
            "com.myoxus.editor.menu.medium",
            "Medium",
          ),
          [FontWeight.Light]: editorMessage(
            "com.myoxus.editor.menu.light",
            "Light",
          ),
          [FontWeight.Regular]: editorMessage(
            "com.myoxus.editor.menu.regular",
            "Regular",
          ),
          [FontWeight.SemiBold]: editorMessage(
            "com.myoxus.editor.menu.semibold",
            "Semibold",
          ),
        } satisfies Record<FontWeight, ReturnType<typeof editorMessage>>;
        return {
          type: "choice",
          value: fontWeight + ":" + fontStyle,
          options: matchFontFaces.map((face) => ({
            value: face.weight + ":" + face.style,
            label: [
              resolveEditorMessage(weights[face.weight as FontWeight], i18n),
              face.style === FontStyle.Italic
                ? resolveEditorMessage(
                    editorMessage(
                      "com.myoxus.editor.keyboard.italic",
                      "Italic",
                    ),
                    i18n,
                  )
                : "",
            ]
              .filter(Boolean)
              .join(" "),
            disabled,
          })),
          change: (value) => {
            const face = matchFontFaces.find(
              (face) => face.weight + ":" + face.style === value,
            );
            if (face)
              onPick(face.weight as FontWeight, face.style as FontStyle);
          },
        };
      },
    },
    {
      id: "d.font-size",
      when: type !== "edgeless-text",
      label: editorMessage("com.myoxus.editor.toolbar.font-size", "Font size"),
      control(ctx) {
        const models = ctx.getSurfaceModelsByType(klass);
        if (!models.length) return null;
        const allowed = models.every((model) =>
          isSurfaceTextModel(model, klass, type),
        );
        if (!allowed) return null;

        const fontSize$ = signal(
          Math.trunc(
            getMostCommonValue(models.map(mapInto), "fontSize") ??
              FONT_SIZE_LIST[0].value,
          ),
        );

        const onPick = (fontSize: number) => {
          for (const model of models) {
            update(ctx, model, { fontSize });
          }
        };

        return {
          type: "number",
          value: fontSize$.value,
          min: 0,
          max: 400,
          presets: FONT_SIZE_LIST.map(({ value }) => value),
          change: (value) => {
            if (typeof value === "number") onPick(value);
          },
        };
      },
    },
    {
      id: "e.alignment",
      label: editorMessage("com.myoxus.editor.toolbar.alignment", "Alignment"),
      control(ctx) {
        const models = ctx.getSurfaceModelsByType(klass);
        if (!models.length) return null;
        const allowed = models.every((model) =>
          isSurfaceTextModel(model, klass, type),
        );
        if (!allowed) return null;

        const textAlign =
          getMostCommonValue(models.map(mapInto), "textAlign") ??
          TextAlign.Left;

        const onPick = (textAlign: TextAlign) => {
          for (const model of models) {
            update(ctx, model, { textAlign });
          }
        };

        return {
          type: "choice",
          presentation: "icons",
          value: textAlign,
          options: TEXT_ALIGN_LIST.map((item) => ({
            value: item.value,
            label: item.label,
            icon: item.icon,
          })),
          change: (value) => onPick(value as TextAlign),
        };
      },
    },
  ] as const satisfies ToolbarActions;
}

function isSurfaceTextModel<
  K extends abstract new (...args: any) => any,
  T extends keyof SurfaceTextModelMap,
>(model: GfxModel, klass: K, type: T): model is InstanceType<K> {
  return model instanceof klass || ("type" in model && model.type === type);
}
