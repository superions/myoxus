import {
  EditorI18nProvider,
  EditPropsStore,
  EditorChromeHostIdentifier,
  createToolbarColorControl,
  ThemeProvider,
  editorMessage,
  resolveEditorMessage,
} from "@virgultum/core/services";
import { computed } from "@preact/signals-core";
import { SignalWatcher } from "@virgultum/core/primitives/lit";
import {
  ConnectorMode,
  DefaultTheme,
  BRUSH_LINE_WIDTHS,
  resolveColor,
} from "@virgultum/core/models";

import { EdgelessToolbarToolMixin } from "../../../widgets/edgeless-toolbar/index";
import { LitElement } from "lit";
import { property } from "lit/decorators.js";

import { ConnectorTool } from "../connector-tool";

export class EdgelessConnectorMenu extends EdgelessToolbarToolMixin(
  SignalWatcher(LitElement),
) {
  override createRenderRoot() {
    return this;
  }

  private readonly _props$ = computed(() => {
    const { mode, stroke, strokeWidth } =
      this.edgeless.std.get(EditPropsStore).lastProps$.value.connector;
    return { mode, stroke, strokeWidth };
  });

  private readonly _theme$ = computed(() => {
    return this.edgeless.std.get(ThemeProvider).theme$.value;
  });

  override type = ConnectorTool;

  override render() {
    const { stroke, strokeWidth, mode } = this._props$.value;
    const i18n = this.edgeless.std.getOptional(EditorI18nProvider) ?? undefined;
    const theme = this._theme$.value;
    return this.edgeless.std.get(EditorChromeHostIdentifier).renderCanvasMenu({
      tools: [
        {
          action: {
            id: "canvas-connector-curve",
            icon: "ConnectorCIcon",
            label: resolveEditorMessage(
              editorMessage("com.myoxus.editor.menu.curve", "Curve"),
              i18n,
            ),
            active: mode === ConnectorMode.Curve,
            disabled: false,
            run: () => this.onChange({ mode: ConnectorMode.Curve }),
          },
        },
        {
          action: {
            id: "canvas-connector-elbow",
            icon: "ConnectorEIcon",
            label: resolveEditorMessage(
              editorMessage("com.myoxus.editor.menu.elbowed", "Elbowed"),
              i18n,
            ),
            active: mode === ConnectorMode.Orthogonal,
            disabled: false,
            run: () => this.onChange({ mode: ConnectorMode.Orthogonal }),
          },
        },
        {
          action: {
            id: "canvas-connector-straight",
            icon: "ConnectorLIcon",
            label: resolveEditorMessage(
              editorMessage("com.myoxus.editor.menu.straight", "Straight"),
              i18n,
            ),
            active: mode === ConnectorMode.Straight,
            disabled: false,
            run: () => this.onChange({ mode: ConnectorMode.Straight }),
          },
        },
      ],
      actions: [
        {
          id: "canvas-connector-width",
          label: resolveEditorMessage(
            editorMessage(
              "com.myoxus.settings.editorSettings.edgeless.connecter.border-thickness",
              "Border thickness",
            ),
            i18n,
          ),
          disabled: false,
          control: {
            type: "number",
            value: strokeWidth,
            presets: BRUSH_LINE_WIDTHS,
            change: (value) => this.onChange({ strokeWidth: Number(value) }),
          },
        },
        {
          id: "canvas-connector-color",
          label: resolveEditorMessage(
            editorMessage(
              "com.myoxus.settings.editorSettings.edgeless.connecter.color",
              "Color",
            ),
            i18n,
          ),
          disabled: false,
          control: createToolbarColorControl({
            value: resolveColor(stroke, theme),
            theme,
            palettes: DefaultTheme.StrokeColorShortPalettes,
            custom: false,
            change: (value) => this.onChange({ stroke: value }),
          }),
        },
      ],
    });
  }

  @property({ attribute: false })
  accessor onChange!: (props: Record<string, unknown>) => void;
}
