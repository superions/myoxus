import {
  editorMessage,
  resolveEditorMessage,
  type EditorI18nService,
} from "@virgultum/shared/services";
import { InformationIcon } from "@myoxus/icons/lit";
import { WithDisposable, SignalWatcher } from "@virgultum/global/lit";
import { fontBaseStyle, panelBaseColorsStyle } from "@virgultum/shared/styles";
import { unsafeCSSVar } from "@virgultum/shared/theme";
import { createButtonPopper, stopPropagation } from "@virgultum/shared/utils";
import { PropTypes, requiredProperties } from "@virgultum/std";
import { css, html, LitElement } from "lit";
import { property, query } from "lit/decorators.js";

@requiredProperties({
  message: PropTypes.string,
  needUpload: PropTypes.boolean,
  action: PropTypes.instanceOf(Function),
})
export class ResourceStatus extends SignalWatcher(WithDisposable(LitElement)) {
  static override styles = css`
    button.status {
      display: flex;
      align-items: center;
      justify-content: center;
      width: 24px;
      height: 24px;
      border-radius: 50%;
      font-size: 18px;
      outline: none;
      border: none;
      cursor: pointer;
      color: ${unsafeCSSVar("pureWhite")};
      background: ${unsafeCSSVar("errorColor")};
      box-shadow: ${unsafeCSSVar("overlayShadow")};
    }

    ${panelBaseColorsStyle(".popper")}
    ${fontBaseStyle(".popper")}
    .popper {
      display: none;
      outline: none;
      padding: 8px;
      border-radius: 8px;
      width: 260px;
      font-style: normal;
      font-weight: 400;
      line-height: 22px;
      font-size: ${unsafeCSSVar("fontSm")};

      &[data-show] {
        display: flex;
        flex-direction: column;
        gap: 4px;
      }
    }

    .header {
      font-weight: 500;
    }

    .content {
      font-feature-settings:
        "liga" off,
        "clig" off;
      color: ${unsafeCSSVar("textPrimaryColor")};
    }

    .footer {
      display: flex;
      justify-content: flex-end;
      margin-top: 4px;
    }

    button.action {
      display: flex;
      align-items: center;
      padding: 2px 12px;
      border-radius: 8px;
      border: none;
      background: none;
      cursor: pointer;
      outline: none;
      color: ${unsafeCSSVar("primaryColor")};
    }
  `;

  private _popper: ReturnType<typeof createButtonPopper> | null = null;

  private _updatePopper() {
    this._popper?.dispose();
    this._popper = createButtonPopper({
      reference: this._trigger,
      popperElement: this._content,
      mainAxis: 8,
      allowedPlacements: ["top-start", "bottom-start"],
    });
  }

  override firstUpdated() {
    this._updatePopper();
    this.disposables.addFromEvent(this, "click", stopPropagation);
    this.disposables.addFromEvent(this, "keydown", (e: KeyboardEvent) => {
      e.stopPropagation();
      if (e.key === "Escape") {
        this._popper?.hide();
      }
    });
    this.disposables.addFromEvent(this._trigger, "click", (_: MouseEvent) => {
      this._popper?.toggle();
    });
    this.disposables.addFromEvent(
      this._actionButton,
      "click",
      (_: MouseEvent) => {
        this._popper?.hide();
        this.action();
      },
    );
    this.disposables.add(() => this._popper?.dispose());
  }

  override render() {
    const { message, needUpload } = this;
    const label = resolveEditorMessage(
      needUpload
        ? editorMessage("Retry", "Retry")
        : editorMessage("com.myoxus.editor.toolbar.reload", "Reload"),
      this.i18n,
    );
    const title = resolveEditorMessage(
      needUpload
        ? editorMessage(
            "com.myoxus.editor.resource.upload-failed",
            "Upload failed",
          )
        : editorMessage(
            "com.myoxus.editor.resource.download-failed",
            "Download failed",
          ),
      this.i18n,
    );

    return html`
      <button class="status">${InformationIcon()}</button>
      <div class="popper">
        <div class="header">${title}</div>
        <div class="content">${message}</div>
        <div class="footer">
          <button class="action">${label}</button>
        </div>
      </div>
    `;
  }

  @query("div.popper")
  private accessor _content!: HTMLDivElement;

  @query("button.status")
  private accessor _trigger!: HTMLButtonElement;

  @query("button.action")
  private accessor _actionButton!: HTMLButtonElement;

  @property({ attribute: false })
  accessor i18n: EditorI18nService | undefined;

  @property({ attribute: false })
  accessor message!: string;

  @property({ attribute: false })
  accessor needUpload!: boolean;

  @property({ attribute: false })
  accessor action!: () => void;
}
