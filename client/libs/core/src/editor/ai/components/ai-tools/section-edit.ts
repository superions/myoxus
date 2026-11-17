import { createElement } from "react";
import {
  PageIcon as NativePageIcon,
  CopyIcon as NativeCopyIcon,
  InsertBleowIcon as NativeInsertBelowIcon,
  LinkedPageIcon as NativeLinkedPageIcon,
} from "@myoxus/icons/react";
import { useI18n } from "@myoxus/i18n";
import { Group, IconButton } from "@myoxus/ui-facade";
import { renderToolCallCard, renderToolFailedCard } from "./tool-cards";
import type { FeatureFlagService } from "@myoxus/core/modules/feature-flag";
import type { Signal } from "@preact/signals-core";
import { toReactNode, type ReactToLit } from "@myoxus/lit-react";
import { WithDisposable } from "@virgultum/editor/global/lit";
import type { ColorScheme } from "@virgultum/editor/model";
import {
  type BlockSelection,
  type EditorHost,
  ShadowlessElement,
  type TextSelection,
} from "@virgultum/editor/std";
import type { ExtensionType } from "@virgultum/editor/store";
import type { NotificationService } from "@virgultum/core/services";
import { isInsidePageEditor } from "@virgultum/core/utils";
import { html, nothing } from "lit";
import { property } from "lit/decorators.js";

import {
  EDGELESS_INSERT,
  PAGE_INSERT,
  SAVE_AS_DOC,
} from "../../_common/chat-actions-handle";
import { copyText } from "../../utils/editor-actions";
import type { ToolError } from "./type";
import { SectionEditResultView } from "./section-edit-result-view";

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

function SectionEditResultActions({
  copy,
  insert,
  createDoc,
}: {
  copy: () => void;
  insert?: () => void;
  createDoc?: () => void;
}) {
  const t = useI18n();
  return createElement(
    Group,
    null,
    createElement(IconButton, {
      icon: createElement(NativeCopyIcon),
      tooltip: t.Copy(),
      "aria-label": t.Copy(),
      onClick: copy,
    }),
    insert
      ? createElement(IconButton, {
          icon: createElement(NativeInsertBelowIcon),
          tooltip: t["com.myoxus.common.insert"](),
          "aria-label": t["com.myoxus.common.insert"](),
          onClick: insert,
        })
      : null,
    createDoc
      ? createElement(IconButton, {
          icon: createElement(NativeLinkedPageIcon),
          tooltip: t["com.myoxus.ai.chat-panel.save-as-doc"](),
          "aria-label": t["com.myoxus.ai.chat-panel.save-as-doc"](),
          onClick: createDoc,
        })
      : null,
  );
}

export class SectionEditTool extends WithDisposable(ShadowlessElement) {
  @property({ attribute: false }) accessor reactToLit: ReactToLit | undefined;
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
    return renderToolCallCard(this.reactToLit, {
      name: `Editing: ${this.data.args.instructions}`,
      icon: createElement(NativePageIcon),
    });
  }

  renderToolResult() {
    if (this.data.type !== "tool-result") {
      return nothing;
    }

    const result = this.data.result;
    if (result && "content" in result) {
      return (
        this.reactToLit?.(
          createElement(
            SectionEditResultView,
            {
              actions: createElement(SectionEditResultActions, {
                copy: async () => {
                  const success = await copyText(result.content);
                  if (success) {
                    this.notifySuccess("Copied to clipboard");
                  }
                },
                insert: this.independentMode
                  ? undefined
                  : async () => {
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
                    },
                createDoc: this.independentMode
                  ? undefined
                  : async () => {
                      if (!this.host) return;
                      SAVE_AS_DOC.handler(this.host, result.content);
                    },
              }),
            },
            toReactNode(
              html`<chat-content-rich-text
                .text=${result.content}
                .state=${"finished"}
                .extensions=${this.extensions}
                .myoxusFeatureFlagService=${this.myoxusFeatureFlagService}
                .theme=${this.theme}
              ></chat-content-rich-text>`,
            ),
          ),
          true,
        ) ?? nothing
      );
    }

    return renderToolFailedCard(this.reactToLit, {
      name: "Section edit failed",
      icon: createElement(NativePageIcon),
    });
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
