import type { FeatureFlagService } from "@myoxus/core/modules/feature-flag";
import type { PeekViewService } from "@myoxus/core/modules/peek-view";
import type { ReactToLit } from "@myoxus/lit-react";
import type { Signal } from "@preact/signals-core";
import { WithDisposable } from "@virgultum/editor/global/lit";
import type { ColorScheme } from "@virgultum/editor/model";
import {
  type BlockStdScope,
  type EditorHost,
  ShadowlessElement,
} from "@virgultum/editor/std";
import type { ExtensionType } from "@virgultum/editor/store";
import type { NotificationService } from "@virgultum/core/services";
import { html } from "lit";
import { property } from "lit/decorators.js";
import { createElement, type ReactNode } from "react";

import { StoredToolView } from "./stored-tool-view";
import { StreamParts } from "./stream-parts";

import { mergeStreamObjects } from "../../utils/stream-objects";
import type { MyoxusAIPanelState } from "../../widgets/ai-panel/type";
import type { DocDisplayConfig } from "../ai-chat-chips";
import type { StreamObject } from "../ai-chat-messages";

type StreamObjectsPresentation = {
  answer: readonly StreamObject[];
  reactToLit?: ReactToLit;
  reasoningIdentity?: ReactNode;
  host?: EditorHost | null;
  std?: BlockStdScope | null;
  state: MyoxusAIPanelState;
  width?: Signal<number | undefined>;
  extensions?: ExtensionType[];
  myoxusFeatureFlagService?: FeatureFlagService;
  theme: Signal<ColorScheme>;
  independentMode?: boolean;
  readOnly?: boolean;
  notificationService?: NotificationService;
  docDisplayService?: DocDisplayConfig;
  peekViewService?: PeekViewService;
  onOpenDoc?: (docId: string, sessionId?: string) => void;
};

export function StreamObjectsView(p: StreamObjectsPresentation) {
  const richText = (text: string, annotation = false) =>
    createElement("chat-content-rich-text", {
      text,
      annotation,
      state: p.state,
      extensions: p.extensions,
      theme: p.theme,
      myoxusFeatureFlagService: p.myoxusFeatureFlagService,
    });

  const tool = (
    data: Extract<StreamObject, { type: "tool-call" | "tool-result" }>,
  ) => {
    if (data.toolName === "doc_compose" || data.toolName === "code_artifact") {
      return createElement(
        data.toolName === "doc_compose"
          ? "doc-compose-tool"
          : "code-artifact-tool",
        {
          data,
          reactToLit: p.reactToLit,
          independentMode: p.independentMode || p.readOnly,
          std: p.std ?? p.host?.std,
          readOnly: p.readOnly,
          width: p.width,
          theme: p.theme,
          notificationService: p.notificationService,
        },
      );
    }
    return createElement(StoredToolView, {
      data,
      host: p.host,
      readOnly: p.readOnly,
      independentMode: p.independentMode,
      generating: p.state === "generating",
      docDisplayService: p.docDisplayService,
      peekViewService: p.peekViewService,
      onOpenDoc: p.onOpenDoc,
      notificationService: p.notificationService,
      renderRichText: richText,
    });
  };
  return createElement(StreamParts, {
    answer: p.answer,
    state: p.state,
    reasoningIdentity: p.reasoningIdentity,
    showReasoning: !!p.reactToLit,
    renderText: richText,
    renderTool: tool,
  });
}

/** The existing app composer supplies its React context at the mount boundary. */
export class ChatContentStreamObjects extends WithDisposable(
  ShadowlessElement,
) {
  @property({ attribute: false }) accessor reactToLit: ReactToLit | undefined;

  @property({ attribute: false }) accessor reasoningIdentity: ReactNode;

  @property({ attribute: false })
  accessor answer!: StreamObject[];

  @property({ attribute: false })
  accessor host: EditorHost | null | undefined;

  @property({ attribute: false })
  accessor std: BlockStdScope | null | undefined;

  @property({ attribute: false })
  accessor state: MyoxusAIPanelState = "finished";

  @property({ attribute: false })
  accessor width: Signal<number | undefined> | undefined;

  @property({ attribute: false })
  accessor extensions!: ExtensionType[];

  @property({ attribute: false })
  accessor myoxusFeatureFlagService!: FeatureFlagService;

  @property({ attribute: false })
  accessor theme!: Signal<ColorScheme>;

  @property({ attribute: false })
  accessor independentMode: boolean | undefined;

  @property({ attribute: false })
  accessor notificationService!: NotificationService;

  @property({ attribute: false })
  accessor docDisplayService!: DocDisplayConfig;

  @property({ attribute: false })
  accessor peekViewService!: PeekViewService;

  @property({ attribute: false })
  accessor onOpenDoc!: (docId: string, sessionId?: string) => void;

  protected override render() {
    const { reactToLit } = this;
    const view = createElement(StreamObjectsView, {
      answer: this.answer,
      reactToLit,
      reasoningIdentity: this.reasoningIdentity,
      host: this.host,
      std: this.std,
      state: this.state,
      width: this.width,
      extensions: this.extensions,
      myoxusFeatureFlagService: this.myoxusFeatureFlagService,
      theme: this.theme,
      independentMode: this.independentMode,
      notificationService: this.notificationService,
      docDisplayService: this.docDisplayService,
      peekViewService: this.peekViewService,
      onOpenDoc: this.onOpenDoc,
    });
    return (
      reactToLit?.(view, true) ??
      html`${mergeStreamObjects(this.answer).map((part) =>
        part.type === "text-delta"
          ? html`<chat-content-rich-text
              .text=${part.textDelta}
              .state=${this.state}
              .extensions=${this.extensions}
              .theme=${this.theme}
              .myoxusFeatureFlagService=${this.myoxusFeatureFlagService}
            ></chat-content-rich-text>`
          : part.type === "tool-call" || part.type === "tool-result"
            ? part.toolName
            : null,
      )}`
    );
  }
}
