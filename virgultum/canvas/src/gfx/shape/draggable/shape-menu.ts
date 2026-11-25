import { computed, effect, type Signal, signal } from "@preact/signals-core";
import { DisposableGroup } from "@virgultum/core/primitives/disposable";
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
  type EditorCanvasMenuControls,
  createToolbarColorControl,
  ThemeProvider,
  editorMessage,
  EditorI18nProvider,
  resolveEditorMessage,
  type EditorI18nMessage,
} from "@virgultum/core/services";
import {
  type BlockComponent,
  NativeViewElement,
} from "@virgultum/core/runtime";
import {
  GfxControllerIdentifier,
  type ToolOptionWithType,
} from "@virgultum/core/runtime/gfx";

import { ShapeTool } from "../shape-tool";
import { ShapeComponentConfig } from "../toolbar";

export class EdgelessShapeMenu extends NativeViewElement {
  private _disposables = new DisposableGroup();
  private _edgeless!: BlockComponent;
  private _onChange!: (name: ShapeName) => void;
  private readonly _revision$ = signal(0);
  private _bound = false;
  private _chrome?: {
    host: HTMLSpanElement;
    state$: Signal<EditorCanvasMenuControls | null>;
    unmount: () => void;
  };

  private _text(message: EditorI18nMessage) {
    return resolveEditorMessage(
      message,
      this.edgeless.std.getOptional(EditorI18nProvider) ?? undefined,
    );
  }

  private readonly _shapeName$: Signal<ShapeName> = signal(ShapeType.Rect);

  get edgeless() {
    return this._edgeless;
  }

  set edgeless(value: BlockComponent) {
    if (this._edgeless === value) return;
    this._edgeless = value;
    if (this.isConnected) {
      this._ensureBound();
      this._requestUpdate();
    }
  }

  get onChange() {
    return this._onChange;
  }

  set onChange(value: (name: ShapeName) => void) {
    this._onChange = value;
    this._requestUpdate();
  }

  private _requestUpdate() {
    this._revision$.value = this._revision$.peek() + 1;
  }

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

  private _ensureBound() {
    if (this._bound || !this.isConnected || !this._edgeless) return;
    this._bound = true;
    if (this._disposables.disposed) {
      this._disposables = new DisposableGroup();
    }

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
    this._disposables.add(
      effect(() => {
        void this._revision$.value;
        if (!this.isConnected || !this._edgeless) return;
        this._paint();
      }),
    );
  }

  connectedCallback(): void {
    this._ensureBound();
  }

  disconnectedCallback(): void {
    if (this._chrome) {
      this._chrome.unmount();
      this._chrome.host.remove();
      this._chrome = undefined;
    }
    this._disposables.dispose();
    this._bound = false;
  }

  private _paint() {
    const chrome = this.edgeless.std.getOptional(EditorChromeHostIdentifier);
    if (!chrome) return;
    const i18n = this.edgeless.std.getOptional(EditorI18nProvider) ?? undefined;
    void i18n?.locale$.value;
    const { fillColor, shapeStyle, shapeName } = this._props$.value;
    const theme = this._theme$.value;

    const controls: EditorCanvasMenuControls = {
      tools: ShapeComponentConfig.map(
        ({ name, iconName, scribbledIcon, tooltip }) => ({
          action: {
            id: `canvas-shape-${name}`,
            icon: shapeStyle === ShapeStyle.General ? iconName : undefined,
            label: this._text(tooltip),
            active: shapeName === name,
            disabled: false,
            run: () => this.onChange(name),
          },
          artworkSvg:
            shapeStyle === ShapeStyle.General ? undefined : scribbledIcon,
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
    };

    if (!this._chrome) {
      const host = this.ownerDocument.createElement("span");
      host.style.display = "contents";
      this.append(host);
      const state$ = signal<EditorCanvasMenuControls | null>(controls);
      const unmount = chrome.mountCanvasMenu(host, state$);
      this._chrome = { host, state$, unmount };
    } else {
      this._chrome.state$.value = controls;
    }
  }
}
