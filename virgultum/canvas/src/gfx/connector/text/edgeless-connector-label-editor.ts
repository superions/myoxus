import {
  CanvasTextOverlay,
  updateOverlayPlaceholder,
} from "../../canvas-text-overlay";
import {
  EdgelessCRUDIdentifier,
  TextUtils,
} from "@virgultum/canvas-runtime/surface";
import { getLineHeight } from "../../text/index";
import { Bound, Vec } from "@virgultum/core/primitives/gfx";
import type { ConnectorElementModel } from "@virgultum/core/models";
import {
  ThemeProvider,
  editorMessage,
  EditorI18nProvider,
  resolveEditorMessage,
  type EditorI18nMessage,
} from "@virgultum/core/services";
import {
  almostEqual,
  requestThrottledConnectedFrame,
} from "@virgultum/core/utils";
import { GfxControllerIdentifier } from "@virgultum/core/runtime/gfx";
import * as Y from "yjs";

const HORIZONTAL_PADDING = 2;
const VERTICAL_PADDING = 2;
const BORDER_WIDTH = 1;

export class EdgelessConnectorLabelEditor extends CanvasTextOverlay {
  private _text(message: EditorI18nMessage) {
    return resolveEditorMessage(
      message,
      this.std.getOptional(EditorI18nProvider) ?? undefined,
    );
  }

  private static styles = `
    .edgeless-connector-label-editor {
      position: absolute;
      left: 0;
      top: 0;
      transform-origin: center;
      z-index: 10;
      padding: ${VERTICAL_PADDING}px ${HORIZONTAL_PADDING}px;
      border: ${BORDER_WIDTH}px solid var(--myoxus-primary-color, #1e96eb);
      background: var(--myoxus-background-primary-color, #fff);
      border-radius: 2px;
      box-shadow: 0px 0px 0px 2px rgba(30, 150, 235, 0.3);
      box-sizing: border-box;
      overflow: visible;

      .inline-editor {
        white-space: pre-wrap !important;
        outline: none;
      }

      .inline-editor span {
        word-break: normal !important;
        overflow-wrap: anywhere !important;
      }

      .edgeless-connector-label-editor-placeholder {
        pointer-events: none;
        color: var(--myoxus-text-disable-color);
        white-space: nowrap;
      }
    }
  `;

  get crud() {
    return this.std.get(EdgelessCRUDIdentifier);
  }

  get gfx() {
    return this.std.get(GfxControllerIdentifier);
  }

  get selection() {
    return this.gfx.selection;
  }

  private _isComposition = false;

  private _keeping = false;

  private _resizeObserver: ResizeObserver | null = null;

  private readonly _updateLabelRect = () => {
    const { connector, isConnected } = this;
    if (!connector || !isConnected) return;

    if (!this.inlineEditorContainer) return;

    const newWidth = this.inlineEditorContainer.scrollWidth;
    const newHeight = this.inlineEditorContainer.scrollHeight;
    const center = connector.labelXYWH
      ? Bound.fromXYWH(connector.labelXYWH).center
      : connector.getPointByOffsetDistance(connector.labelOffset.distance);
    const bounds = Bound.fromCenter(center, newWidth, newHeight);
    const labelXYWH = bounds.toXYWH();

    if (
      !connector.labelXYWH ||
      labelXYWH.some((p, i) => !almostEqual(p, connector.labelXYWH![i]))
    ) {
      this.crud.updateElement(connector.id, {
        labelXYWH,
      });
    }
  };

  get inlineEditor() {
    return this.richText.inlineEditor;
  }

  get inlineEditorContainer() {
    return this.inlineEditor?.rootElement;
  }

  private readonly container = this.ownerDocument.createElement("div");
  private readonly placeholder = this.ownerDocument.createElement("span");

  protected mountOverlay() {
    this.container.className = "edgeless-connector-label-editor";
    this.placeholder.className = "edgeless-connector-label-editor-placeholder";
    this.placeholder.textContent = this._text(
      editorMessage("com.myoxus.editor.toolbar.add-text", "Add text"),
    );
    this.richText.yText = this.connector.text!;

    this.container.append(this.richText);
    this.append(
      this.overlayStyle(EdgelessConnectorLabelEditor.styles),
      this.container,
    );
  }

  override disconnectedCallback() {
    this._resizeObserver?.disconnect();
    this._resizeObserver = null;
    super.disconnectedCallback();
  }

  protected beginEditing() {
    const { connector, selection, std } = this;
    const dispatcher = std.event;

    // The persisted size feeds back into the input width. Write once in the next frame.
    const resize = requestThrottledConnectedFrame(() => {
      this._updateLabelRect();
      this.requestUpdate();
    }, this);
    this._resizeObserver = new ResizeObserver(() => resize());
    this._resizeObserver.observe(this.richText);

    this.connector.stash("labelXYWH");

    this.updateComplete
      .then(() => {
        if (!this.isConnected || !this.inlineEditor) return;
        this.inlineEditor.selectAll();

        this.disposables.add(
          this.inlineEditor.slots.renderComplete.subscribe(() => {
            this.requestUpdate();
          }),
        );

        this.disposables.add(
          dispatcher.add("keyDown", (ctx) => {
            const state = ctx.get("keyboardState");
            const { key, ctrlKey, metaKey, altKey, shiftKey, isComposing } =
              state.raw;
            const onlyCmd = (ctrlKey || metaKey) && !altKey && !shiftKey;
            const isModEnter = onlyCmd && key === "Enter";
            const isEscape = key === "Escape";
            if (!isComposing && (isModEnter || isEscape)) {
              this.inlineEditorContainer?.blur();

              selection.set({
                elements: [connector.id],
                editing: false,
              });
              return true;
            }
            return false;
          }),
        );

        const surface = this.gfx.surface;

        if (surface) {
          this.disposables.add(
            surface.elementUpdated.subscribe(({ id }) => {
              if (id === connector.id) this.requestUpdate();
            }),
          );
        }

        this.disposables.add(
          this.gfx.viewport.viewportUpdated.subscribe(() => {
            this.requestUpdate();
          }),
        );

        this.disposables.add(dispatcher.add("click", () => true));
        this.disposables.add(dispatcher.add("doubleClick", () => true));

        this.disposables.add(() => {
          if (connector.text) {
            const text = connector.text.toString();
            const trimed = text.trim();
            const len = trimed.length;
            // An empty existing label remains editable at its authored anchor.
            if (len === 0 && !this.hadLabel) {
              this.crud.updateElement(connector.id, {
                text: undefined,
                labelXYWH: undefined,
                labelOffset: undefined,
              });
            } else if (len < text.length) {
              this.crud.updateElement(connector.id, {
                // @TODO: trim in Y.Text?
                text: new Y.Text(trimed),
              });
            }
          }

          connector.labelEditing = false;
          connector.pop("labelXYWH");

          selection.set({
            elements: [],
            editing: false,
          });
        });

        if (!this.inlineEditorContainer) return;

        this.disposables.addFromEvent(
          this.inlineEditorContainer,
          "blur",
          () => {
            if (this._keeping) return;
            this.remove();
          },
        );

        this.disposables.addFromEvent(
          this.inlineEditorContainer,
          "compositionstart",
          () => {
            this._isComposition = true;
            this.requestUpdate();
          },
        );
        this.disposables.addFromEvent(
          this.inlineEditorContainer,
          "compositionend",
          () => {
            this._isComposition = false;
            this.requestUpdate();
          },
        );
      })
      .catch(console.error);
  }

  protected paintOverlay() {
    const { connector } = this;
    const {
      labelOffset: { distance },
      labelStyle: {
        fontFamily,
        fontSize,
        fontStyle,
        fontWeight,
        textAlign,
        color: labelColor,
      },
      labelConstraints: { hasMaxWidth, maxWidth },
    } = connector;

    const lineHeight = getLineHeight(fontFamily, fontSize, fontWeight);
    const { translateX, translateY, viewScale, zoom } = this.gfx.viewport;
    const localScale = viewScale > 0 ? viewScale : 1;
    // `labelXYWH` is the rendered label's authoritative position. Anchored
    // labels may intentionally sit above or below the connector path, so
    // reopening their editor at the raw path midpoint visibly detaches the
    // input and lets its content collapse to a one-character column.
    const labelCenter = connector.labelXYWH
      ? Bound.fromXYWH(connector.labelXYWH).center
      : connector.getPointByOffsetDistance(distance);
    const [x, y] = Vec.mul(labelCenter, zoom);
    const initialLabelWidth = connector.labelXYWH?.[2] ?? 0;
    const transformOperation = [
      "translate(-50%, -50%)",
      // The editor is mounted inside the same viewport as GFX block views.
      // Mirror their viewScale compensation so an ancestor Edgeless transform
      // does not displace the editable label from its rendered connector.
      `translate(${translateX / localScale}px, ${translateY / localScale}px)`,
      `translate(${x / localScale}px, ${y / localScale}px)`,
      `scale(${zoom / localScale})`,
    ];

    const isEmpty = !connector.text?.length && !this._isComposition;
    const color = this.std
      .get(ThemeProvider)
      .generateColorProperty(labelColor, "#000000");

    Object.assign(this.container.style, {
      fontFamily: TextUtils.wrapFontFamily(fontFamily),
      fontSize: `${fontSize}px`,
      fontStyle,
      fontWeight,
      textAlign,
      lineHeight: `${lineHeight}px`,
      maxWidth: hasMaxWidth
        ? `${maxWidth + BORDER_WIDTH * 2 + HORIZONTAL_PADDING * 2}px`
        : "initial",
      minWidth: initialLabelWidth
        ? `${initialLabelWidth + BORDER_WIDTH * 2 + HORIZONTAL_PADDING * 2}px`
        : "initial",
      width: "max-content",
      color,
      transform: transformOperation.join(" "),
    });
    updateOverlayPlaceholder(
      this.richText,
      this.placeholder,
      isEmpty,
      `${VERTICAL_PADDING}px ${HORIZONTAL_PADDING}px`,
    );
  }

  setKeeping(keeping: boolean) {
    this._keeping = keeping;
  }

  connector!: ConnectorElementModel;
  hadLabel = false;
}
