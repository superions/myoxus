import type { FeatureFlagService } from "@myoxus/core/modules/feature-flag";
import type { PeekViewService } from "@myoxus/core/modules/peek-view";
import type { ReactToLit } from "@myoxus/lit-react";
import type { Signal } from "@preact/signals-core";
import type { ColorScheme } from "@virgultum/editor/model";
import type { BlockStdScope, EditorHost } from "@virgultum/editor/std";
import type { ExtensionType } from "@virgultum/editor/store";
import type { NotificationService } from "@virgultum/core/services";
import { createElement, type ReactNode } from "react";

import { StoredToolView } from "./stored-tool-view";
import { StreamParts } from "./stream-parts";

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
