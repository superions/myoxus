// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors

import type { PeekViewService } from "@myoxus/core/modules/peek-view";
import type { NotificationService } from "@virgultum/core/services";
import type { BlockStdScope, EditorHost } from "@virgultum/editor/std";
import type { ReactNode } from "react";

import type { PageAiBridge } from "../../../virgultum/doc-editor/page-ai-bridge";
import type { MyoxusAIPanelState } from "../../widgets/ai-panel/type";
import type { DocDisplayConfig } from "../ai-chat-chips";
import type {
  CopilotGeneratedFile,
  StreamObject,
} from "../ai-chat-messages/type";
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

export interface StreamObjectsViewProps {
  answer: readonly StreamObject[];
  reasoningIdentity?: ReactNode;
  host?: EditorHost | null;
  pageBridge?: PageAiBridge | null;
  std?: BlockStdScope | null;
  state: MyoxusAIPanelState;
  independentMode?: boolean;
  readOnly?: boolean;
  notificationService?: NotificationService;
  docDisplayService?: DocDisplayConfig;
  peekViewService?: PeekViewService;
  onOpenDoc?: (docId: string, sessionId?: string) => void;
  messageId?: string;
  generatedFiles?: readonly CopilotGeneratedFile[];
  downloadSavedFile?: (
    file: CopilotGeneratedFile,
    current: () => boolean,
  ) => Promise<void>;
}

/** Dispatches streamed assistant parts to markdown, artifact, compose, or stored tool views. */
export function StreamObjectsView(props: StreamObjectsViewProps) {
  const activeStd = props.std ?? props.host?.std;

  const renderRichText = (text: string, annotation = false) => (
    <StoredAnswerText
      host={props.host}
      pageBridge={props.pageBridge}
      text={text}
      annotation={annotation}
    />
  );

  const renderTool = (
    data: Extract<StreamObject, { type: "tool-call" | "tool-result" }>,
  ) => {
    if (data.toolName === "doc_compose") {
      return (
        <DocComposeTool
          data={data as DocComposeToolCall | DocComposeToolResult}
          std={activeStd}
          pageBridge={props.pageBridge}
          readOnly={props.readOnly}
          notificationService={props.notificationService}
        />
      );
    }
    if (data.toolName === "code_artifact") {
      return (
        <CodeArtifactTool
          data={data as CodeArtifactToolCall | CodeArtifactToolResult}
          std={activeStd}
          independentMode={props.independentMode || props.readOnly}
          notificationService={props.notificationService}
        />
      );
    }
    return (
      <StoredToolView
        data={data}
        host={props.host}
        pageBridge={props.pageBridge}
        readOnly={props.readOnly}
        independentMode={props.independentMode}
        generating={props.state === "generating"}
        docDisplayService={props.docDisplayService}
        peekViewService={props.peekViewService}
        onOpenDoc={props.onOpenDoc}
        notificationService={props.notificationService}
        renderRichText={renderRichText}
        messageId={props.messageId}
        generatedFiles={props.generatedFiles}
        downloadSavedFile={props.downloadSavedFile}
      />
    );
  };

  return (
    <StreamParts
      answer={props.answer}
      state={props.state}
      reasoningIdentity={props.reasoningIdentity}
      showReasoning
      renderText={renderRichText}
      renderTool={renderTool}
    />
  );
}
