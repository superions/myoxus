import { SignalWatcher, WithDisposable } from "@virgultum/global/lit";
import {
  DocModeProvider,
  TelemetryProvider,
  editorMessage,
  EditorI18nProvider,
  resolveEditorMessage,
  type EditorI18nMessage,
} from "@virgultum/shared/services";
import { unsafeCSSValue, unsafeCSSVar } from "@virgultum/shared/theme";
import { css, html, LitElement, nothing } from "lit";
import { property } from "lit/decorators.js";
import { classMap } from "lit/directives/class-map.js";

import type { CodeBlockComponent } from "../../code-block";
import { CodeBlockPreviewIdentifier } from "../../code-preview-extension";

export class PreviewButton extends WithDisposable(SignalWatcher(LitElement)) {
  private _text(message: EditorI18nMessage) {
    return resolveEditorMessage(
      message,
      this.blockComponent.std.getOptional(EditorI18nProvider) ?? undefined,
    );
  }

  static override styles = css`
    :host {
      margin-right: auto;
    }

    .preview-toggle-container {
      display: flex;
      padding: ${unsafeCSSValue("var(--mantine-spacing-2xs)")};
      align-items: flex-start;
      gap: ${unsafeCSSValue("var(--mantine-spacing-xs)")};
      border-radius: ${unsafeCSSValue("var(--mantine-radius-sm)")};
      background: ${unsafeCSSVar("hoverColor")};
    }

    .toggle-button {
      display: flex;
      padding: 0 ${unsafeCSSValue("var(--mantine-spacing-xs)")};
      justify-content: center;
      align-items: center;
      gap: ${unsafeCSSValue("var(--mantine-spacing-xs)")};
      border-radius: ${unsafeCSSValue("var(--mantine-radius-sm)")};
      color: ${unsafeCSSVar("textPrimaryColor")};
      font-family: ${unsafeCSSValue(
        "var(--mantine-font-family-body-small, var(--mantine-font-family))",
      )};
      font-size: ${unsafeCSSValue(
        "var(--mantine-font-size-body-small, var(--mantine-font-size-md))",
      )};
      font-style: normal;
      font-weight: ${unsafeCSSValue(
        "var(--mantine-font-weight-body-small, var(--mantine-font-weight-regular))",
      )};
      line-height: ${unsafeCSSValue(
        "var(--mantine-line-height-body-small, var(--mantine-line-height-md))",
      )};
    }

    .toggle-button:hover {
      background: ${unsafeCSSVar("hoverColor")};
    }

    .toggle-button.active {
      background: ${unsafeCSSVar("backgroundPrimaryColor")};
      box-shadow: ${unsafeCSSValue("var(--mantine-shadow-sm)")};
    }
  `;

  private readonly _toggle = (value: boolean) => {
    this.blockComponent.setPreviewState(value);

    const std = this.blockComponent.std;
    const mode = std.getOptional(DocModeProvider)?.getEditorMode() ?? "page";
    const telemetryService = std.getOptional(TelemetryProvider);
    if (!telemetryService) return;
    telemetryService.track("htmlBlockTogglePreview", {
      page: mode,
      segment: "code block",
      module: "code toolbar container",
      control: "preview toggle button",
    });
  };

  get preview() {
    return this.blockComponent.preview$.value;
  }

  override render() {
    const lang = this.blockComponent.model.props.language$.value ?? "";
    const previewContext = this.blockComponent.std.getOptional(
      CodeBlockPreviewIdentifier(lang),
    );
    if (!previewContext) return nothing;

    return html`
      <div class="preview-toggle-container">
        <div
          class=${classMap({
            "toggle-button": true,
            active: !this.preview,
          })}
          @click=${() => this._toggle(false)}
        >
          ${this._text(editorMessage("com.myoxus.editor.keyboard.code", "Code"))}
        </div>
        <div
          class=${classMap({
            "toggle-button": true,
            active: this.preview,
          })}
          @click=${() => this._toggle(true)}
        >
          ${this._text(editorMessage("com.myoxus.editor.toolbar.preview", "Preview"))}
        </div>
      </div>
    `;
  }

  @property({ attribute: false })
  accessor blockComponent!: CodeBlockComponent;
}
