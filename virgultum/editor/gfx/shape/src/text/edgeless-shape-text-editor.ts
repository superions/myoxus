import { consume } from "@lit/context";
import {
  DefaultTool,
  EdgelessCRUDIdentifier,
  TextUtils,
} from "@virgultum/block-surface";
import { ErrorCode, VirgultumError } from "@virgultum/global/exceptions";
import { Bound, clamp, toRadian, Vec } from "@virgultum/global/gfx";
import { WithDisposable } from "@virgultum/global/lit";
import {
  LocalShapeElementModel,
  ShapeElementModel,
  TextResizing,
} from "@virgultum/model";
import type { RichText } from "@virgultum/rich-text";
import { ThemeProvider } from "@virgultum/shared/services";
import { getSelectedRect } from "@virgultum/shared/utils";
import {
  type BlockComponent,
  type BlockStdScope,
  ShadowlessElement,
  stdContext,
} from "@virgultum/std";
import { GfxControllerIdentifier } from "@virgultum/std/gfx";
import {
  RANGE_SYNC_EXCLUDE_ATTR,
  ZERO_WIDTH_FOR_EMPTY_LINE,
} from "@virgultum/std/inline";
import { html, nothing, type TemplateResult } from "lit";
import { property, query } from "lit/decorators.js";
import { styleMap } from "lit/directives/style-map.js";
import * as Y from "yjs";

export type ShapeTextEditDraftActions = {
  readonly apply: () => void;
  readonly cancel: () => void;
  /** View-space anchor in the editor host, matching the rendered text field. */
  readonly bounds: { left: number; top: number; width: number; height: number };
};

/** Optional plain text draft in the existing shape mount. No Y.Doc or child
 * Y.Text owns it; only Apply may write Source, and cancellation never commits blur. */
export type ShapeTextEditDraft = {
  readonly ariaLabel: string;
  readonly value: string;
  readonly isValid: () => boolean;
  /** Existing inline edits accept blur; creation can require explicit Apply/Enter. */
  readonly applyOnBlur?: boolean;
  /** Return false to retain a rejected draft; accepted writes may remount its shape. */
  readonly apply: (
    value: string,
  ) => boolean | void | { applied: boolean; diagnostic?: string };
  /** A transient relayout can replace its local shape without replacing focus. */
  readonly preview?: (
    value: string,
  ) => ShapeElementModel | LocalShapeElementModel | void;
  readonly cancel?: () => void;
  /** The consuming family supplies its existing UI renderer; text remains owned here. */
  readonly renderActions?: (
    actions: ShapeTextEditDraftActions,
  ) => TemplateResult | undefined;
  readonly subscribeInvalidation?: (invalidate: () => void) => () => void;
};

export function mountShapeTextEditor(
  shapeElement: ShapeElementModel | LocalShapeElementModel,
  edgeless: BlockComponent,
  options: {
    onTextCommit?: (value: string) => void;
    draft?: ShapeTextEditDraft;
    /** Scoped canvas hosts mount in their own context-bearing editor host. */
    draftContainer?: HTMLElement;
  } = {},
) {
  const mountElm =
    options.draft && options.draftContainer
      ? options.draftContainer
      : edgeless.querySelector(".edgeless-mount-point");
  if (!mountElm) {
    throw new VirgultumError(
      ErrorCode.ValueNotExists,
      "edgeless block's mount point does not exist",
    );
  }

  if (options.draft && !options.draft.isValid()) return;

  const gfx = edgeless.std.get(GfxControllerIdentifier);
  const crud = edgeless.std.get(EdgelessCRUDIdentifier);

  const updatedElement =
    shapeElement instanceof LocalShapeElementModel
      ? shapeElement
      : crud.getElementById(shapeElement.id);

  if (
    !(updatedElement instanceof ShapeElementModel) &&
    !(updatedElement instanceof LocalShapeElementModel && options.draft)
  ) {
    console.error("Cannot mount text editor on a non-shape element");
    return;
  }

  // Reveal only the missing part of a draft. Centering a newly added child
  // throws its parent out of view, and moving visible labels interrupts clicks.
  if (options.draft && updatedElement instanceof LocalShapeElementModel) {
    const viewport = gfx.viewport;
    const visible = viewport.viewportBounds;
    const bound = Bound.deserialize(updatedElement.xywh).expand(
      8 / viewport.zoom,
    );
    if (!visible.contains(bound))
      viewport.setCenter(
        bound.w <= visible.w
          ? clamp(
              viewport.centerX,
              bound.maxX - visible.w / 2,
              bound.x + visible.w / 2,
            )
          : bound.x + bound.w / 2,
        bound.h <= visible.h
          ? clamp(
              viewport.centerY,
              bound.maxY - visible.h / 2,
              bound.y + visible.h / 2,
            )
          : bound.y + bound.h / 2,
      );
  }
  if (!options.draft) gfx.tool.setTool(DefaultTool);
  gfx.selection.set({
    elements: [shapeElement.id],
    editing: true,
  });

  if (!options.draft && !shapeElement.text) {
    const text = new Y.Text();
    edgeless.std
      .get(EdgelessCRUDIdentifier)
      .updateElement(shapeElement.id, { text });
  }

  const shapeEditor = new EdgelessShapeTextEditor();
  shapeEditor.element = updatedElement;
  shapeEditor.onTextCommit = options.onTextCommit;
  shapeEditor.draft = options.draft;

  mountElm.append(shapeEditor);
  return shapeEditor;
}

export class EdgelessShapeTextEditor extends WithDisposable(ShadowlessElement) {
  private _keeping = false;
  private _draftValue = "";
  private _draftFinished = false;
  private _draftInvalidation: (() => void) | undefined;
  private _originalTextDisplay = true;

  /** Finish before DOM removal so the resulting blur cannot apply a cancelled draft. */
  cancelDraft() {
    this._finishDraft(false);
  }

  private _finishDraft(apply: boolean) {
    if (!this.draft || this._draftFinished) return;
    this._draftFinished = true;
    const value = this._draftInput?.value ?? this._draftValue;
    const valid = this.draft.isValid();
    if (apply && valid) {
      this.element.textDisplay = this._originalTextDisplay;
      try {
        const result = this.draft.apply(value);
        if (
          result === false ||
          (result && typeof result === "object" && !result.applied)
        ) {
          this.element.textDisplay = false;
          this._draftFinished = false;
          const diagnostic =
            typeof result === "object" ? result.diagnostic : undefined;
          this._draftInput?.setCustomValidity(diagnostic ?? "");
          if (diagnostic) this._draftInput?.reportValidity();
          return;
        }
      } catch (error) {
        this.element.textDisplay = false;
        this._draftFinished = false;
        throw error;
      }
    } else this.draft.cancel?.();
    this.element.textDisplay = this._originalTextDisplay;
    this.remove();
    if (this.element instanceof ShapeElementModel)
      this.selection.set({ elements: [this.element.id], editing: false });
  }

  override disconnectedCallback() {
    if (this.draft && !this._draftFinished) {
      this._draftFinished = true;
      this.element.textDisplay = this._originalTextDisplay;
      this.draft.cancel?.();
    }
    this._draftInvalidation?.();
    this._draftInvalidation = undefined;
    super.disconnectedCallback();
  }

  private _lastXYWH = "";

  private _resizeObserver: ResizeObserver | null = null;

  get inlineEditor() {
    return this.richText?.inlineEditor;
  }

  get crud() {
    return this.std.get(EdgelessCRUDIdentifier);
  }

  get gfx() {
    return this.std.get(GfxControllerIdentifier);
  }

  get selection() {
    return this.gfx.selection;
  }

  get inlineEditorContainer() {
    return this.inlineEditor?.rootElement;
  }

  /** Normal editors let their family configure the shape-text-editor-opened
   * event before focus; drafts own this lifecycle through their explicit port. */
  selectAllOnMount = false;
  onGeometryChanged?: () => void;

  private _unmount() {
    if (this.draft) {
      this._finishDraft(true);
      return;
    }
    this._resizeObserver?.disconnect();
    this._resizeObserver = null;
    this._commitVisibleInlineText();

    if (this.element.text) {
      const text = this.element.text.toString();
      const trimed = text.trim();
      const len = trimed.length;
      if (len === 0) {
        this.element.text = undefined;
      } else if (len < text.length) {
        const trimmedText = new Y.Text();
        trimmedText.insert(0, trimed);
        this.element.text = trimmedText;
      }
    }

    const committedValue = this.element.text?.toString().trim() ?? "";
    this.element.textDisplay = true;

    this.remove();
    this.onTextCommit?.(committedValue);
    this.selection.set({
      elements: [],
      editing: false,
    });
  }

  private _visibleInlineText() {
    const container =
      this.inlineEditorContainer ??
      this.querySelector<HTMLElement>(".inline-editor") ??
      this.richText;
    if (!container) return;

    // VLine owns hard line boundaries. The enclosing textContent concatenates
    // lines and includes Lit whitespace around empty caret placeholders; it is
    // not a serialization of authored text. Keep the existing DOM-ahead-of-Y.Text
    // handoff, reading visible lines without treating an empty line as content.
    const lines = Array.from(container.querySelectorAll("v-line"));
    return lines.length
      ? lines
          .map((line) => {
            const text = line.innerText;
            return !line.vElements.length && text === ZERO_WIDTH_FOR_EMPTY_LINE
              ? ""
              : text;
          })
          .join("\n")
      : container.innerText;
  }

  private _commitVisibleInlineText() {
    const visibleText = this._visibleInlineText();
    if (visibleText === undefined) return;

    const nextText = visibleText.trim();
    const currentText = this.element.text?.toString().trim() ?? "";
    if (nextText === currentText) return;
    // Empty inline lines render caret placeholders, not authored characters.
    // Do not resurrect them after deletion. An intentional zero-width character
    // already present in Y.Text is preserved by the non-empty model guard.
    if (
      !currentText &&
      !nextText.replaceAll(ZERO_WIDTH_FOR_EMPTY_LINE, "").trim()
    )
      return;

    // RichText normally writes into the shape Y.Text before blur. Freshly
    // restored GFX children can still expose the new DOM text one tick before
    // their Y.Text catches up; commit that visible text so Escape/blur never
    // discards what the user just typed.
    const committedText = new Y.Text();
    committedText.insert(0, nextText);
    this.crud.updateElement(this.element.id, {
      text: committedText,
      textDisplay: true,
    });
  }

  private _updateElementWH() {
    if (this.draft || !(this.element instanceof ShapeElementModel)) return;
    const bcr = this.richText.getBoundingClientRect();
    const containerHeight = this.richText.offsetHeight;
    const containerWidth = this.richText.offsetWidth;
    const textResizing = this.element.textResizing;

    if (
      (containerHeight !== this.element.h &&
        textResizing === TextResizing.AUTO_HEIGHT) ||
      (textResizing === TextResizing.AUTO_WIDTH_AND_HEIGHT &&
        (containerWidth !== this.element.w ||
          containerHeight !== this.element.h))
    ) {
      const [leftTopX, leftTopY] = Vec.rotWith(
        [this.richText.offsetLeft, this.richText.offsetTop],
        [bcr.left + bcr.width / 2, bcr.top + bcr.height / 2],
        toRadian(-this.element.rotate),
      );

      const [modelLeftTopX, modelLeftTopY] = this.gfx.viewport.toModelCoord(
        leftTopX,
        leftTopY,
      );

      this.crud.updateElement(this.element.id, {
        xywh: new Bound(
          modelLeftTopX,
          modelLeftTopY,
          textResizing === TextResizing.AUTO_WIDTH_AND_HEIGHT
            ? containerWidth
            : this.element.w,
          containerHeight,
        ).serialize(),
      });

      if (this._lastXYWH !== this.element.xywh) {
        this.requestUpdate();
      }

      this.onGeometryChanged?.();

      this.richText.style.minHeight = `${containerHeight}px`;
    }

    this.selection.set({
      elements: [this.element.id],
      editing: true,
    });
  }

  override connectedCallback() {
    super.connectedCallback();
    this.setAttribute(RANGE_SYNC_EXCLUDE_ATTR, "true");
    if (this.draft) {
      this._originalTextDisplay = this.element.textDisplay;
      this._draftValue = this.draft.value;
      this._draftInvalidation = this.draft.subscribeInvalidation?.(() =>
        this._finishDraft(false),
      );
    }
  }

  override firstUpdated(): void {
    const dispatcher = this.std.event;

    this.element.textDisplay = false;
    if (!this.draft)
      this.dispatchEvent(
        new CustomEvent("shape-text-editor-opened", {
          bubbles: true,
          composed: true,
          detail: this,
        }),
      );

    this.disposables.add(
      this.gfx.viewport.viewportUpdated.subscribe(() => {
        this.requestUpdate();
        this.updateComplete
          .then(() => {
            this._updateElementWH();
          })
          .catch(console.error);
      }),
    );
    this.disposables.add(
      dispatcher.add("click", () => {
        return true;
      }),
    );
    this.disposables.add(
      dispatcher.add("doubleClick", () => {
        return true;
      }),
    );

    this.updateComplete
      .then(() => {
        if (this.draft) {
          this._draftInput?.focus({ preventScroll: true });
          this._draftInput?.select();
          if (this._draftInput)
            this.disposables.addFromEvent(this._draftInput, "blur", () => {
              if (!this._keeping)
                this._finishDraft(this.draft?.applyOnBlur !== false);
            });
          return;
        }
        if (!this.inlineEditor) return;
        if (this.selectAllOnMount) {
          this.inlineEditor.selectAll();
        } else {
          this.inlineEditor.focusEnd();
        }

        this.disposables.add(
          this.inlineEditor.slots.renderComplete.subscribe(() => {
            this._updateElementWH();
          }),
        );

        if (!this.inlineEditorContainer) return;
        this.disposables.addFromEvent(
          this.inlineEditorContainer,
          "blur",
          () => {
            if (this._keeping) return;
            this._unmount();
          },
        );
      })
      .catch(console.error);

    this.disposables.addFromEvent(this, "keydown", (evt) => {
      if (this.draft) {
        if (evt.isComposing) return;
        if (
          evt.key === "Escape" ||
          (evt.key === "Enter" && !evt.shiftKey && !evt.isComposing)
        ) {
          evt.preventDefault();
          evt.stopPropagation();
          this._finishDraft(evt.key !== "Escape");
        }
        return;
      }
      if (evt.key === "Escape") {
        this._commitVisibleInlineText();
        requestAnimationFrame(() => {
          this.selection.set({
            elements: [this.element.id],
            editing: false,
          });
        });

        (this.ownerDocument.activeElement as HTMLElement).blur();
      }
    });
  }

  override async getUpdateComplete(): Promise<boolean> {
    const result = await super.getUpdateComplete();
    await this.richText?.updateComplete;
    return result;
  }

  override render() {
    const text = this.element.text;
    if (!this.draft && !text) {
      console.error("Failed to mount shape editor because of no text.");
      return nothing;
    }

    const [verticalPadding, horiPadding] = this.element.padding;
    const textResizing =
      this.element instanceof ShapeElementModel
        ? this.element.textResizing
        : TextResizing.AUTO_HEIGHT;
    const viewport = this.gfx.viewport;
    const viewportRect = viewport.boundingClientRect;
    // Nested canvas DOM is already scaled by its enclosing Note. Match the
    // native canvas transform once; toViewCoord also contains that outer scale.
    const viewScale = this.draft ? viewport.viewScale : 1;
    const zoom = viewport.zoom / viewScale;
    const rect =
      this.element instanceof LocalShapeElementModel
        ? new DOMRect(
            this.element.x,
            this.element.y,
            this.element.w,
            this.element.h,
          )
        : getSelectedRect([this.element]);
    const rotate = this.element.rotate;
    const [leftTopX, leftTopY] = Vec.rotWith(
      [rect.left, rect.top],
      [rect.left + rect.width / 2, rect.top + rect.height / 2],
      toRadian(rotate),
    );
    const autoWidth = textResizing === TextResizing.AUTO_WIDTH_AND_HEIGHT;
    const [viewX, viewY] = viewport.toViewCoord(leftTopX, leftTopY);
    const rawX = viewX / viewScale / viewScale,
      rawY = viewY / viewScale / viewScale;
    const viewportWidth =
      Number.isFinite(viewportRect.width) && viewportRect.width > 0
        ? viewportRect.width / viewScale
        : viewport.width;
    const viewportHeight =
      Number.isFinite(viewportRect.height) && viewportRect.height > 0
        ? viewportRect.height / viewScale
        : viewport.height;
    const editorWidth =
      textResizing === TextResizing.AUTO_HEIGHT
        ? rect.width * zoom
        : Math.min(rect.width * zoom, 240);
    const editorHeight = Math.max(32, rect.height * zoom);
    const x = clamp(
      Number.isFinite(rawX) ? rawX : 8,
      8,
      Math.max(8, viewportWidth - Math.min(editorWidth, viewportWidth - 16)),
    );
    const y = clamp(
      Number.isFinite(rawY) ? rawY : 8,
      8,
      Math.max(8, viewportHeight - Math.min(editorHeight, viewportHeight - 16)),
    );
    const color = this.std
      .get(ThemeProvider)
      .generateColorProperty(this.element.color, "#000000");

    const inlineEditorStyles = {
      position: "absolute",
      left: x + "px",
      top: y + "px",
      width:
        textResizing === TextResizing.AUTO_HEIGHT
          ? rect.width + "px"
          : "fit-content",
      // override rich-text style (height: 100%)
      height: "initial",
      minHeight:
        textResizing === TextResizing.AUTO_WIDTH_AND_HEIGHT
          ? "1em"
          : `${rect.height}px`,
      maxWidth:
        textResizing === TextResizing.AUTO_WIDTH_AND_HEIGHT
          ? this.element instanceof ShapeElementModel && this.element.maxWidth
            ? `${this.element.maxWidth}px`
            : undefined
          : undefined,
      boxSizing: "border-box",
      fontSize: this.element.fontSize + "px",
      fontFamily: TextUtils.wrapFontFamily(this.element.fontFamily),
      fontWeight: this.element.fontWeight,
      fontStyle: this.element.fontStyle,
      lineHeight: this.element.labelProjection
        ? `${this.element.labelProjection.lineHeight}px`
        : "normal",
      outline: "none",
      transform: `scale(${zoom}, ${zoom}) rotate(${rotate}deg)`,
      transformOrigin: "top left",
      color,
      padding: `${verticalPadding}px ${horiPadding}px`,
      textAlign: this.element.textAlign,
      display: "grid",
      gridTemplateColumns: "100%",
      alignItems:
        this.element.textVerticalAlign === "center"
          ? "center"
          : this.element.textVerticalAlign === "bottom"
            ? "end"
            : "start",
      // Block textareas also honor align-content; keep the local draft aligned
      // with the shape instead of centering a top-aligned record-card title.
      alignContent:
        this.element.textVerticalAlign === "center"
          ? "center"
          : this.element.textVerticalAlign === "bottom"
            ? "end"
            : "start",
      gap: "0",
      zIndex: "1",
    };
    const inlineEditorStyle = styleMap(inlineEditorStyles);

    this._lastXYWH = this.element.xywh;

    if (this.draft)
      return html`<textarea
          data-shape-text-draft
          rows="1"
          wrap="off"
          data-myoxus-editor-keyboard-owner="shape-draft"
          aria-label=${this.draft.ariaLabel}
          .value=${this._draftValue}
          @input=${(event: InputEvent) => {
            this._draftInput.setCustomValidity("");
            this._draftValue = (event.target as HTMLTextAreaElement).value;
            if (!this.draft?.isValid()) this._finishDraft(false);
            else {
              const next = this.draft.preview?.(this._draftValue);
              if (next) {
                this._originalTextDisplay = next.textDisplay;
                next.textDisplay = false;
                this.element = next;
                this.selection.set({ elements: [next.id], editing: true });
                this.requestUpdate();
              }
            }
          }}
          style=${styleMap({ ...inlineEditorStyles, height: `${rect.height}px`, lineHeight: this.element.labelProjection ? `${this.element.labelProjection.lineHeight}px` : "normal", display: "block", border: "none", margin: "0", resize: "none", background: "transparent" })}
        ></textarea
        >${
          this.draft.renderActions?.({
            apply: () => this._finishDraft(true),
            cancel: () => this.cancelDraft(),
            bounds: {
              left: x,
              top: y,
              width: rect.width * zoom,
              height: rect.height * zoom,
            },
          }) ?? nothing
        }`;

    return html` <style>
        edgeless-shape-text-editor v-text [data-v-text] {
          overflow-wrap: ${autoWidth ? "normal" : "anywhere"};
          word-break: ${autoWidth ? "normal" : "break-word"} !important;
          white-space: ${autoWidth ? "pre" : "pre-wrap"} !important;
        }

        edgeless-shape-text-editor .inline-editor {
          min-width: 1px;
        }
      </style>
      <rich-text
        .yText=${text}
        .enableFormat=${false}
        .enableAutoScrollHorizontally=${false}
        style=${inlineEditorStyle}
      ></rich-text>`;
  }

  setKeeping(keeping: boolean) {
    this._keeping = keeping;
  }

  @property({ attribute: false })
  accessor element!: ShapeElementModel | LocalShapeElementModel;

  @property({ attribute: false })
  accessor draft: ShapeTextEditDraft | undefined;

  @property({ attribute: false })
  accessor onTextCommit: ((value: string) => void) | undefined;

  @consume({
    context: stdContext,
  })
  accessor std!: BlockStdScope;

  @query("textarea[data-shape-text-draft]")
  accessor _draftInput!: HTMLTextAreaElement;

  @query("rich-text")
  accessor richText!: RichText;
}
