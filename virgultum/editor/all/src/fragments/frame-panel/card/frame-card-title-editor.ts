import type { RichText } from "@virgultum/content/rich-text";
import type { FrameBlockModel } from "@virgultum/core/models";
import { DisposableGroup } from "@virgultum/core/primitives/disposable";
import { NativeViewElement } from "@virgultum/core/primitives/env";

const STYLE_ID = "myoxus-frame-card-title-editor-styles";
const STYLES = `
  myoxus-frame-card-title-editor rich-text .nowrap-lines::-webkit-scrollbar,
  frame-card-title-editor rich-text .nowrap-lines::-webkit-scrollbar {
    display: none;
  }
`;

function ensureStyles(doc: Document) {
  if (!doc.head || doc.getElementById(STYLE_ID)) return;
  const style = doc.createElement("style");
  style.id = STYLE_ID;
  style.textContent = STYLES;
  doc.head.append(style);
}

export const MYOXUS_FRAME_TITLE_EDITOR = "myoxus-frame-card-title-editor";

export class FrameCardTitleEditor extends NativeViewElement {
  disposables = new DisposableGroup();

  private readonly _isComposing = false;

  frameModel!: FrameBlockModel;
  left!: number;
  maxWidth!: number;
  richText!: RichText;
  titleContentElement!: HTMLElement;

  get inlineEditor() {
    return this.richText?.inlineEditor ?? null;
  }

  private _unmount() {
    // dispose in advance to avoid execute `this.remove()` twice
    this.disposables.dispose();
    this.remove();
    if (this.titleContentElement) {
      this.titleContentElement.style.display = "block";
    }
  }

  connectedCallback() {
    if (this.disposables.disposed) {
      this.disposables = new DisposableGroup();
    }
    ensureStyles(this.ownerDocument);

    const richText = this.ownerDocument.createElement("rich-text") as RichText;
    richText.yText = this.frameModel.props.title.yText;
    richText.enableFormat = false;
    richText.enableAutoScrollHorizontally = true;
    richText.enableUndoRedo = false;
    richText.wrapText = false;
    Object.assign(richText.style, {
      transformOrigin: "top left",
      borderRadius: "4px",
      maxWidth: `${this.maxWidth}px`,
      maxHeight: "20px",
      width: "fit-content",
      height: "20px",
      fontSize: "var(--myoxus-font-sm)",
      lineHeight: "20px",
      position: "absolute",
      left: `${this.left}px`,
      top: "0px",
      minWidth: "8px",
      background: "var(--myoxus-background-primary-color)",
      border: "1px solid var(--myoxus-primary-color)",
      color: "var(--myoxus-text-primary-color)",
      boxShadow: "0px 0px 0px 2px rgba(30, 150, 235, 0.30)",
      zIndex: "1",
      display: "block",
    });

    this.richText = richText;
    this.replaceChildren(richText);

    Promise.resolve(
      (richText as unknown as { updateComplete?: Promise<unknown> })
        .updateComplete,
    )
      .then(() => {
        if (!this.isConnected || this.inlineEditor === null) return;

        this.titleContentElement.style.display = "none";

        this.inlineEditor.selectAll();

        const inlineEditorContainer = this.inlineEditor.rootElement;
        if (!inlineEditorContainer) return;

        this.disposables.addFromEvent(inlineEditorContainer, "blur", () => {
          this._unmount();
        });
        this.disposables.addFromEvent(inlineEditorContainer, "click", (e) => {
          e.stopPropagation();
        });
        this.disposables.addFromEvent(
          inlineEditorContainer,
          "dblclick",
          (e) => {
            e.stopPropagation();
          },
        );

        this.disposables.addFromEvent(inlineEditorContainer, "keydown", (e) => {
          e.stopPropagation();
          if (e.key === "Enter" && !this._isComposing) {
            this._unmount();
          }
        });
      })
      .catch(console.error);
  }

  disconnectedCallback() {
    this.disposables.dispose();
  }
}

declare global {
  interface HTMLElementTagNameMap {
    [MYOXUS_FRAME_TITLE_EDITOR]: FrameCardTitleEditor;
  }
}
