// SPDX-License-Identifier: MIT

import type { PeekViewService } from "@myoxus/core/modules/peek-view";
import type { NotificationService } from "@virgultum/core/services";
import type { BlockStdScope, EditorHost } from "@virgultum/editor/std";
import type { ReactNode } from "react";

import type { MyoxusAIPanelState } from "../../widgets/ai-panel/type";
import type { DocDisplayConfig } from "../ai-chat-chips";
import type { StreamObject } from "../ai-chat-messages/type";
import {
  CodeArtifactTool,
  type CodeArtifactToolCall,
  type CodeArtifactToolResult,
} from "../ai-tools/code-artifact";
import {
  DocComposeTool,
  type DocComposeToolCall,
  type DocComposeToolResult,
} from "../ai-tools/doc-compose";
import { StoredAnswerText } from "./stored-answer-text";
import { StoredToolView } from "./stored-tool-view";
import { StreamParts } from "./stream-parts";

type StreamObjectsPresentation = {
  answer: readonly StreamObject[];
  reasoningIdentity?: ReactNode;
  host?: EditorHost | null;
  std?: BlockStdScope | null;
  state: MyoxusAIPanelState;
  independentMode?: boolean;
  readOnly?: boolean;
  notificationService?: NotificationService;
  docDisplayService?: DocDisplayConfig;
  peekViewService?: PeekViewService;
  onOpenDoc?: (docId: string, sessionId?: string) => void;
};

export function StreamObjectsView(p: StreamObjectsPresentation) {
  const richText = (text: string, annotation = false) => (
    <StoredAnswerText host={p.host} text={text} annotation={annotation} />
  );

  const tool = (
    data: Extract<StreamObject, { type: "tool-call" | "tool-result" }>,
  ) => {
    if (data.toolName === "doc_compose") {
      return (
        <DocComposeTool
          data={data as DocComposeToolCall | DocComposeToolResult}
          std={p.std ?? p.host?.std}
          readOnly={p.readOnly}
          notificationService={p.notificationService}
        />
      );
    }
    if (data.toolName === "code_artifact") {
      return (
        <CodeArtifactTool
          data={data as CodeArtifactToolCall | CodeArtifactToolResult}
          std={p.std ?? p.host?.std}
          independentMode={p.independentMode || p.readOnly}
          notificationService={p.notificationService}
        />
      );
    }
    return (
      <StoredToolView
        data={data}
        host={p.host}
        readOnly={p.readOnly}
        independentMode={p.independentMode}
        generating={p.state === "generating"}
        docDisplayService={p.docDisplayService}
        peekViewService={p.peekViewService}
        onOpenDoc={p.onOpenDoc}
        notificationService={p.notificationService}
        renderRichText={richText}
      />
    );
  };

  return (
    <StreamParts
      answer={p.answer}
      state={p.state}
      reasoningIdentity={p.reasoningIdentity}
      showReasoning
      renderText={richText}
      renderTool={tool}
    />
  );
}
