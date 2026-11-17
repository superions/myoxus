import { computed, effect, type Signal, signal } from "@preact/signals-core";
import { SignalWatcher, WithDisposable } from "@virgultum/core/primitives/lit";
import {
  DefaultTheme,
  resolveColor,
  isTransparent,
  type Palette,
  type ShapeName,
  ShapeStyle,
  ShapeType,
} from "@virgultum/core/models";
import {
  EditPropsStore,
  EditorChromeHostIdentifier,
  createToolbarColorControl,
  ThemeProvider,
  editorMessage,
  EditorI18nProvider,
  resolveEditorMessage,
  type EditorI18nMessage,
} from "@virgultum/core/services";
import type { BlockComponent } from "@virgultum/core/runtime";
import {
  GfxControllerIdentifier,
  type ToolOptionWithType,
} from "@virgultum/core/runtime/gfx";
import { LitElement } from "lit";
import { property } from "lit/decorators.js";

import { ShapeTool } from "../shape-tool";
import { ShapeComponentConfig } from "../toolbar";

export class EdgelessShapeMenu extends SignalWatcher(
  WithDisposable(LitElement),
) {
  private _text(message: EditorI18nMessage) {
    return resolveEditorMessage(
      message,
      this.edgeless.std.getOptional(EditorI18nProvider) ?? undefined,
    );
  }

  override createRenderRoot() {
    return this;
  }

  private readonly _shapeName$: Signal<ShapeName> = signal(ShapeType.Rect);

  @property({ attribute: false })
  accessor edgeless!: BlockComponent;

  private readonly _props$ = computed(() => {
    const shapeName: ShapeName = this._shapeName$.value;
    const { shapeStyle, fillColor, strokeColor, radius } =
      this.edgeless.std.get(EditPropsStore).lastProps$.value[
        `shape:${shapeName}`
      ];
    return {
      shapeStyle,
      shapeName,
      fillColor,
      strokeColor,
      radius,
    };
  });

  private readonly _setFillColor = ({ key, value }: Palette) => {
    const filled = !isTransparent(value);
    const fillColor = value;
    const strokeColor = filled
      ? DefaultTheme.StrokeColorShortPalettes.find(
          (palette) => palette.key === key,
        )?.value
      : DefaultTheme.StrokeColorShortMap.Grey;

    const { shapeName } = this._props$.value;
    this.edgeless.std
      .get(EditPropsStore)
      .recordLastProps(`shape:${shapeName}`, {
        filled,
        fillColor,
        strokeColor,
      });
    this.onChange(shapeName);
  };

  private readonly _theme$ = computed(() => {
    return this.edgeless.std.get(ThemeProvider).theme$.value;
  });

  override connectedCallback(): void {
    super.connectedCallback();

    const gfx = this.edgeless.std.get(GfxControllerIdentifier);
    this._disposables.add(
      effect(() => {
        const value = gfx.tool.currentToolOption$.value;

        if (value && value.toolType === ShapeTool) {
          const shapeName = (value as ToolOptionWithType<ShapeTool>).options
            ?.shapeName;
          if (shapeName) {
            this._shapeName$.value = shapeName;
          }
        }
      }),
    );
  }

  override render() {
    const { fillColor, shapeStyle, shapeName } = this._props$.value;

    const theme = this._theme$.value;
    return this.edgeless.std.get(EditorChromeHostIdentifier).renderCanvasMenu({
      tools: ShapeComponentConfig.map(
        ({ name, generalIcon, scribbledIcon, tooltip }) => ({
          action: {
            id: `canvas-shape-${name}`,
            label: this._text(tooltip),
            active: shapeName === name,
            disabled: false,
            run: () => this.onChange(name),
          },
          artwork:
            shapeStyle === ShapeStyle.General ? generalIcon : scribbledIcon,
        }),
      ),
      actions: [
        {
          id: "canvas-shape-color",
          label: this._text(
            editorMessage(
              "com.myoxus.settings.editorSettings.edgeless.pen.color",
              "Color",
            ),
          ),
          disabled: false,
          control: createToolbarColorControl({
            value: resolveColor(fillColor, theme),
            theme,
            palettes: DefaultTheme.FillColorShortPalettes,
            custom: false,
            change: (value) => {
              const palette = DefaultTheme.FillColorShortPalettes.find(
                (palette) => palette.value === value,
              );
              if (palette) this._setFillColor(palette);
            },
          }),
        },
      ],
    });
  }

  @property({ attribute: false })
  accessor onChange!: (name: ShapeName) => void;
}
