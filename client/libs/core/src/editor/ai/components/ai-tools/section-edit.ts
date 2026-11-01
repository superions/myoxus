import type { FeatureFlagService } from "@myoxus/core/modules/feature-flag";
import {
  CopyIcon,
  InsertBleowIcon,
  LinkedPageIcon,
  PageIcon,
} from "@myoxus/icons/lit";
import type { Signal } from "@preact/signals-core";
import type { ReactToLit } from "@myoxus/lit-react";
import { WithDisposable } from "@virgultum/editor/global/lit";
import type { ColorScheme } from "@virgultum/editor/model";
import { fontSMStyle } from "@virgultum/editor/shared/styles";
import { unsafeCSSValue, unsafeCSSVar } from "@virgultum/editor/shared/theme";
import {
  type BlockSelection,
  type EditorHost,
  ShadowlessElement,
  type TextSelection,
} from "@virgultum/editor/std";
import type { ExtensionType } from "@virgultum/editor/store";
import type { NotificationService } from "@virgultum/shared/services";
import { isInsidePageEditor } from "@virgultum/shared/utils";
import { css, html, nothing } from "lit";
import { property } from "lit/decorators.js";

import {
  EDGELESS_INSERT,
  PAGE_INSERT,
  SAVE_AS_DOC,
} from "../../_common/chat-actions-handle";
import { copyText } from "../../utils/editor-actions";
import type { ToolError } from "./type";

interface SectionEditToolCall {
  type: "tool-call";
  toolCallId: string;
  toolName: string;
  args: { section: string; instructions: string };
}

interface SectionEditToolResult {
  type: "tool-result";
  toolCallId: string;
  toolName: string;
  args: { section: string; instructions: string };
  result: { content: string } | ToolError | null;
}

export class SectionEditTool extends WithDisposable(ShadowlessElement) {
  @property({ attribute: false }) accessor reactToLit: ReactToLit | undefined;
  static override styles = css`
    .section-edit-result {
      padding: ${unsafeCSSValue("var(--mantine-spacing-md)")};
      margin: ${unsafeCSSValue("var(--mantine-spacing-sm)")} 0;
      border-radius: ${unsafeCSSValue("var(--mantine-radius-lg)")};
      border: ${unsafeCSSValue("calc(var(--mantine-scale) * 1px)")} solid
        ${unsafeCSSVar("borderColor")};

      .section-edit-header {
        min-height: ${unsafeCSSValue("var(--mantine-spacing-xl)")};
        margin-bottom: ${unsafeCSSValue("var(--mantine-spacing-sm)")};
        display: flex;
        justify-content: space-between;
        align-items: center;

        .section-edit-title {
          display: flex;
          align-items: center;
          gap: ${unsafeCSSValue("var(--mantine-spacing-sm)")};

          svg {
            width: ${unsafeCSSValue("var(--mantine-spacing-xl)")};
            height: ${unsafeCSSValue("var(--mantine-spacing-xl)")};
            color: ${unsafeCSSVar("iconColor")};
          }

          span {
            color: ${unsafeCSSVar("iconColor")};
          }
        }

        ${fontSMStyle(".section-edit-title span")}

        .section-edit-actions {
          display: flex;
          align-items: center;
          gap: ${unsafeCSSValue("var(--mantine-spacing-sm)")};

          .edit-button {
            width: ${unsafeCSSValue("var(--mantine-spacing-xl)")};
            height: ${unsafeCSSValue("var(--mantine-spacing-xl)")};
            display: flex;
            align-items: center;
            justify-content: center;
            border-radius: ${unsafeCSSValue("var(--mantine-radius-sm)")};
            cursor: pointer;
            &:hover {
              background-color: ${unsafeCSSVar("hoverColor")};
            }

            svg {
              width: ${unsafeCSSValue(
                "calc(var(--mantine-spacing-lg) + var(--mantine-spacing-xs))",
              )};
              height: ${unsafeCSSValue(
                "calc(var(--mantine-spacing-lg) + var(--mantine-spacing-xs))",
              )};
              color: ${unsafeCSSVar("iconColor")};
            }
          }
        }
      }
    }
  `;

  @property({ attribute: false })
  accessor data!: SectionEditToolCall | SectionEditToolResult;

  @property({ attribute: false })
  accessor extensions!: ExtensionType[];

  @property({ attribute: false })
  accessor myoxusFeatureFlagService!: FeatureFlagService;

  @property({ attribute: false })
  accessor notificationService!: NotificationService;

  @property({ attribute: false })
  accessor theme!: Signal<ColorScheme>;

  @property({ attribute: false })
  accessor host: EditorHost | null | undefined;

  @property({ attribute: false })
  accessor independentMode: boolean | undefined;

  private get selection() {
    const value = this.host?.selection.value ?? [];
    return {
      text: value.find((v) => v.type === "text") as TextSelection | undefined,
      blocks: value.filter((v) => v.type === "block") as BlockSelection[],
    };
  }

  renderToolCall() {
    return html`
      <tool-call-card
        .reactToLit=${this.reactToLit}
        .name=${`Editing: ${this.data.args.instructions}`}
        .icon=${PageIcon()}
      ></tool-call-card>
    `;
  }

  renderToolResult() {
    if (this.data.type !== "tool-result") {
      return nothing;
    }

    const result = this.data.result;
    if (result && "content" in result) {
      return html`
        <div class="section-edit-result">
          <div class="section-edit-header">
            <div class="section-edit-title">
              ${PageIcon()}
              <span>Edited Content</span>
            </div>
            <div class="section-edit-actions">
              <div
                class="edit-button"
                @click=${async () => {
                  const success = await copyText(result.content);
                  if (success) {
                    this.notifySuccess("Copied to clipboard");
                  }
                }}
              >
                ${CopyIcon()}
                <myoxus-tooltip>Copy</myoxus-tooltip>
              </div>
              ${
                this.independentMode
                  ? nothing
                  : html`<div
                      class="edit-button"
                      @click=${async () => {
                        if (!this.host) return;
                        if (this.host.std.store.readonly$.value) {
                          this.notificationService.notify({
                            title: "Cannot insert in read-only mode",
                            accent: "error",
                            onClose: () => {},
                          });
                          return;
                        }
                        if (isInsidePageEditor(this.host)) {
                          await PAGE_INSERT.handler(
                            this.host,
                            result.content,
                            this.selection,
                          );
                        } else {
                          await EDGELESS_INSERT.handler(
                            this.host,
                            result.content,
                            this.selection,
                          );
                        }
                      }}
                    >
                      ${InsertBleowIcon()}
                      <myoxus-tooltip>Insert below</myoxus-tooltip>
                    </div>`
              }
              ${
                this.independentMode
                  ? nothing
                  : html`<div
                      class="edit-button"
                      @click=${async () => {
                        if (!this.host) return;
                        SAVE_AS_DOC.handler(this.host, result.content);
                      }}
                    >
                      ${LinkedPageIcon()}
                      <myoxus-tooltip>Create new doc</myoxus-tooltip>
                    </div>`
              }
            </div>
          </div>
          <chat-content-rich-text
            .text=${result.content}
            .state=${"finished"}
            .extensions=${this.extensions}
            .myoxusFeatureFlagService=${this.myoxusFeatureFlagService}
            .theme=${this.theme}
          ></chat-content-rich-text>
        </div>
      `;
    }

    return html`
      <tool-call-failed
        .reactToLit=${this.reactToLit}
        .name=${"Section edit failed"}
        .icon=${PageIcon()}
      ></tool-call-failed>
    `;
  }

  private readonly notifySuccess = (title: string) => {
    this.notificationService.notify({
      title: title,
      accent: "success",
      onClose: function (): void {},
    });
  };

  protected override render() {
    const { data } = this;

    if (data.type === "tool-call") {
      return this.renderToolCall();
    }
    if (data.type === "tool-result") {
      return this.renderToolResult();
    }
    return nothing;
  }
}
