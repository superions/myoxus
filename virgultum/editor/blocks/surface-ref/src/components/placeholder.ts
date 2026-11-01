import {
  editorMessage,
  resolveEditorMessage,
  type EditorI18nService,
} from "@virgultum/shared/services";
import { DeleteIcon } from "@myoxus/icons/lit";
import { SignalWatcher, WithDisposable } from "@virgultum/global/lit";
import { ColorScheme } from "@virgultum/model";
import { unsafeCSSVar } from "@virgultum/shared/theme";
import { ShadowlessElement } from "@virgultum/std";
import { type GfxModel } from "@virgultum/std/gfx";
import { css, html, nothing } from "lit";
import { property } from "lit/decorators.js";
import { classMap } from "lit/directives/class-map.js";

import { DarkDeletedSmallBanner, LightDeletedSmallBanner } from "../icons";
import { getReferenceModelTitle, TYPE_ICON_MAP } from "../utils";

export class SurfaceRefPlaceHolder extends SignalWatcher(
  WithDisposable(ShadowlessElement),
) {
  static override styles = css`
    .surface-ref-placeholder {
      display: flex;
      flex-direction: column;
      gap: 12px;
      padding: 12px;
    }

    .surface-ref-placeholder.not-found {
      background: ${unsafeCSSVar("backgroundSecondaryColor")};
    }

    .surface-ref-placeholder-heading {
      position: relative;
      display: flex;
      align-items: center;
      gap: 8px;
      align-self: stretch;

      font-size: 14px;
      font-weight: 500;
      line-height: 22px;

      text-overflow: ellipsis;
      white-space: nowrap;
      overflow: hidden;

      color: ${unsafeCSSVar("textPrimaryColor")};
    }

    .surface-ref-placeholder-body {
      position: relative;
      font-size: 12px;
      font-weight: 400;
      line-height: 20px;
      text-overflow: ellipsis;
      white-space: nowrap;
      overflow: hidden;
      color: ${unsafeCSSVar("textDisableColor")};
    }

    .surface-ref-not-found-background {
      position: absolute;
      right: 12px;
      bottom: -5px;
    }
  `;

  @property({ attribute: false })
  accessor referenceModel: GfxModel | null = null;

  @property({ attribute: false })
  accessor refFlavour = "";

  @property({ attribute: false })
  accessor inEdgeless = false;

  @property({ attribute: false })
  accessor theme: ColorScheme = ColorScheme.Light;

  @property({ attribute: false })
  accessor i18n: EditorI18nService | undefined;

  override render() {
    const text = (message: ReturnType<typeof editorMessage>) =>
      resolveEditorMessage(message, this.i18n);
    const names = {
      "myoxus:frame": editorMessage("com.myoxus.editor.slash.frame", "Frame"),
      group: editorMessage("com.myoxus.editor.surface-ref.group", "Group"),
      mindmap: editorMessage("com.myoxus.editor.slash.mind-map", "Mind Map"),
      edgeless: editorMessage(
        "com.myoxus.editor.surface-ref.content",
        "Edgeless content",
      ),
    };
    const { referenceModel, refFlavour, inEdgeless } = this;

    // When surface ref is in page mode and reference exists, don't render placeholder
    if (referenceModel && !inEdgeless) return nothing;

    const modelNotFound = !referenceModel;
    const matchedType = TYPE_ICON_MAP[refFlavour] ?? TYPE_ICON_MAP["edgeless"];

    const typeName = text(
      names[refFlavour as keyof typeof names] ?? names.edgeless,
    );

    const title =
      (referenceModel && getReferenceModelTitle(referenceModel)) ?? typeName;

    const notFoundBackground =
      this.theme === ColorScheme.Light
        ? LightDeletedSmallBanner
        : DarkDeletedSmallBanner;

    return html`
      <div
        class=${classMap({
          "surface-ref-placeholder": true,
          "not-found": modelNotFound,
        })}
      >
        ${
          modelNotFound
            ? html`<div class="surface-ref-not-found-background">
                ${notFoundBackground}
              </div>`
            : nothing
        }
        <div class="surface-ref-placeholder-heading">
          ${modelNotFound ? DeleteIcon() : matchedType.icon}
          <span class="surface-ref-title">
            ${
              modelNotFound
                ? text(
                    editorMessage(
                      "com.myoxus.editor.surface-ref.unavailable",
                      "{{type}} is not available",
                      { type: typeName },
                    ),
                  )
                : `${title}`
            }
          </span>
        </div>
        <div class="surface-ref-placeholder-body">
          <span class="surface-ref-text">
            ${
              modelNotFound
                ? text(
                    editorMessage(
                      "com.myoxus.editor.surface-ref.deleted",
                      "The referenced content was deleted or is not in this document.",
                    ),
                  )
                : text(
                    editorMessage(
                      "com.myoxus.editor.surface-ref.page-hint",
                      "This content is inserted but cannot display in Edgeless mode. Switch to Page mode to view it.",
                    ),
                  )
            }
          </span>
        </div>
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "surface-ref-placeholder": SurfaceRefPlaceHolder;
  }
}
