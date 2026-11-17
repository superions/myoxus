import {
  computed,
  type ReadonlySignal,
  type Signal,
} from "@preact/signals-core";
import { adjustColorAlpha } from "@virgultum/core/color";
import { SignalWatcher } from "@virgultum/core/primitives/lit";
import {
  BRUSH_LINE_WIDTHS,
  DefaultTheme,
  HIGHLIGHTER_LINE_WIDTHS,
} from "@virgultum/core/models";
import {
  ThemeProvider,
  EditorChromeHostIdentifier,
  createToolbarColorControl,
  EditorI18nProvider,
  editorMessage,
  resolveEditorMessage,
} from "@virgultum/core/services";
import type { ColorEvent } from "@virgultum/core/utils";
import { EdgelessToolbarToolMixin } from "../../../../../widgets/edgeless-toolbar/index";
import { LitElement, type TemplateResult } from "lit";
import { property } from "lit/decorators.js";

import { BrushTool } from "../../../brush-tool";
import { HighlighterTool } from "../../../highlighter-tool";
import { penInfoMap } from "./consts";
import type { Pen, PenMap } from "./types";

export class EdgelessPenMenu extends EdgelessToolbarToolMixin(
  SignalWatcher(LitElement),
) {
  override createRenderRoot() {
    return this;
  }

  private readonly _theme$ = computed(() => {
    return this.edgeless.std.get(ThemeProvider).theme$.value;
  });

  private readonly _onPickPen = (tool: Pen) => {
    this.pen$.value = tool;
    if (tool === "brush") {
      this.setEdgelessTool(BrushTool);
    } else {
      this.setEdgelessTool(HighlighterTool);
    }
  };

  private readonly _onPickColor = (e: ColorEvent) => {
    let color = e.detail.value;
    if (this.pen$.peek() === "highlighter") {
      color = adjustColorAlpha(color, 0.3);
    }
    this.onChange({ color });
  };

  private readonly _onPickLineWidth = (e: CustomEvent<number>) => {
    e.stopPropagation();
    this.onChange({ lineWidth: e.detail });
  };

  override type = [BrushTool, HighlighterTool];

  override render() {
    const {
      _theme$: { value: theme },
      colors$: {
        value: { brush: brushColor, highlighter: highlighterColor },
      },
      penIconMap$: {
        value: { brush: brushIcon, highlighter: highlighterIcon },
      },
      penInfo$: {
        value: { type, color, lineWidth },
      },
    } = this;

    const lineWidths =
      type === "brush" ? BRUSH_LINE_WIDTHS : HIGHLIGHTER_LINE_WIDTHS;

    const i18n = this.edgeless.std.getOptional(EditorI18nProvider) ?? undefined;
    return this.edgeless.std.get(EditorChromeHostIdentifier).renderCanvasMenu({
      tools: [
        {
          action: {
            id: "canvas-brush",
            label: resolveEditorMessage(
              editorMessage("com.myoxus.keyboardShortcuts.pen", "Pen"),
              i18n,
            ),
            shortcut: penInfoMap.brush.shortcut,
            disabled: false,
            active: type === "brush",
            run: () => this._onPickPen("brush"),
          },
          artwork: brushIcon,
          artworkColor: brushColor,
          artworkBounds: { width: 38, height: 64 },
        },
        {
          action: {
            id: "canvas-highlighter",
            label: resolveEditorMessage(
              editorMessage(
                "com.myoxus.editor.tool.highlighter",
                "Highlighter",
              ),
              i18n,
            ),
            shortcut: penInfoMap.highlighter.shortcut,
            disabled: false,
            active: type === "highlighter",
            run: () => this._onPickPen("highlighter"),
          },
          artwork: highlighterIcon,
          artworkColor: highlighterColor,
          artworkBounds: { width: 38, height: 64 },
        },
      ],
      actions: [
        {
          id: "canvas-pen-width",
          label: resolveEditorMessage(
            editorMessage(
              "com.myoxus.settings.editorSettings.edgeless.pen.thickness",
              "Thickness",
            ),
            i18n,
          ),
          disabled: false,
          control: {
            type: "number",
            value: lineWidth,
            presets: lineWidths,
            change: (value) =>
              this._onPickLineWidth(
                new CustomEvent("select", { detail: Number(value) }),
              ),
          },
        },
        {
          id: "canvas-pen-color",
          label: resolveEditorMessage(
            editorMessage(
              "com.myoxus.settings.editorSettings.edgeless.pen.color",
              "Color",
            ),
            i18n,
          ),
          disabled: false,
          control: createToolbarColorControl({
            value: color,
            theme,
            palettes: DefaultTheme.StrokeColorShortPalettes,
            custom: false,
            change: (value) =>
              this._onPickColor(
                new CustomEvent("select", { detail: { key: "", value } }),
              ),
          }),
        },
      ],
    });
  }

  @property({ attribute: false })
  accessor onChange!: (props: Record<string, unknown>) => void;

  @property({ attribute: false })
  accessor colors$!: ReadonlySignal<PenMap<string>>;

  @property({ attribute: false })
  accessor penIconMap$!: ReadonlySignal<PenMap<TemplateResult>>;

  @property({ attribute: false })
  accessor pen$!: Signal<Pen>;

  @property({ attribute: false })
  accessor penInfo$!: ReadonlySignal<{
    type: Pen;
    color: string;
    icon: TemplateResult<1>;
    lineWidth: number;
    tip: string;
    shortcut: string;
  }>;
}
