// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors

import type { AIToolsConfig } from "@myoxus/core/modules/ai-button";
import type {
  AddContextFileInput,
  ContextWorkspaceEmbeddingStatus,
  CopilotChatHistoryFragment,
  CopilotContextBlob,
  CopilotContextCategory,
  CopilotContextDoc,
  CopilotContextFile,
  CopilotContextMatchedDoc,
  CopilotContextMatchedFile,
  CopilotHistories,
  getCopilotHistoriesQuery,
  QueryChatHistoriesInput,
  RequestOptions,
  StreamObject,
  UpdateChatSessionInput,
} from "@myoxus/graphql";
import type { EditorHost } from "@virgultum/editor/std";
import type { GfxModel } from "@virgultum/editor/std/gfx";
import type { BlockModel } from "@virgultum/editor/store";

import type { CopilotGeneratedFile } from "../components/ai-chat-messages/type";
import type { AIEmbeddingStatus } from "../provider";
import type { PromptKey } from "../provider/prompt";

export const translateLangs = [
  "English",
  "Brazilian Portuguese",
  "Spanish",
  "German",
  "French",
  "Italian",
  "Simplified Chinese",
  "Traditional Chinese",
  "Japanese",
  "Russian",
  "Korean",
] as const;

export const textTones = [
  "Professional",
  "Informal",
  "Friendly",
  "Critical",
  "Humorous",
] as const;

declare global {
  // oxlint-disable-next-line typescript/no-namespace
  namespace VirgultumPresets {
    type TrackerControl =
      "format-bar" | "slash-menu" | "chat-send" | "block-action-bar";

    type TrackerWhere =
      "chat-panel" | "inline-chat-panel" | "ai-panel" | "ai-chat-block";

    interface TrackerOptions {
      control: TrackerControl;
      where: TrackerWhere;
    }

    interface AITextActionOptions {
      input?: string;
      stream?: boolean;
      /** String attachments are persisted workspace blob keys, never data URLs. */
      attachments?: Array<string | File | Blob>;
      signal?: AbortSignal;
      retry?: boolean;
      requestId?: string;
      messageId?: string;
      responseId?: string;
      expectedStreamId?: string;
      onMessageCreated?: (messageId: string) => void | Promise<void>;
      docId?: string;
      workspaceId: string;
      host?: EditorHost;
      models?: Array<BlockModel | GfxModel>;
      control?: TrackerControl;
      where?: TrackerWhere;
    }

    interface AIForkChatSessionOptions {
      docId: string;
      workspaceId: string;
      sessionId: string;
      latestMessageId?: string;
    }

    interface AIImageActionOptions extends AITextActionOptions {
      seed?: string;
    }

    type TextStream = {
      [Symbol.asyncIterator](): AsyncIterableIterator<string>;
    };

    type AIActionTextResponse<T extends AITextActionOptions> =
      T["stream"] extends true ? TextStream : Promise<string>;

    interface AIDocContextOption {
      docId: string;
      docTitle: string;
      docContent: string;
      tags: string;
      createDate: string;
      updatedDate: string;
    }

    interface AIFileContextOption {
      blobId: string;
      fileName: string;
      fileType: string;
      fileContent: string;
    }

    interface ChatOptions extends AITextActionOptions {
      sessionId?: string;
      isRootSession?: boolean;
      reasoning?: boolean;
      modelId?: string;
      toolsConfig?: AIToolsConfig | undefined;
      onRetrievalStatus?: (available: boolean) => void;
      contexts?: {
        docs: AIDocContextOption[];
        files: AIFileContextOption[];
        selectedSnapshot?: string;
        selectedMarkdown?: string;
        html?: string;
      };
      postfix?: (text: string) => string;
    }

    interface TranslateOptions extends AITextActionOptions {
      lang: (typeof translateLangs)[number];
    }

    interface ChangeToneOptions extends AITextActionOptions {
      tone: (typeof textTones)[number];
    }

    interface ExpandMindMap extends AITextActionOptions {
      mindmap: string;
    }

    interface BrainstormMindMap extends AITextActionOptions {
      regenerate?: boolean;
    }

    type TextActionHandler<
      O extends AITextActionOptions = AITextActionOptions,
    > = <T extends O>(options: T) => Promise<AIActionTextResponse<T>>;

    interface AIActions {
      chat: TextActionHandler<ChatOptions>;
      summary: TextActionHandler;
      improveWriting: TextActionHandler;
      improveGrammar: TextActionHandler;
      fixSpelling: TextActionHandler;
      createHeadings: TextActionHandler;
      makeLonger: TextActionHandler;
      makeShorter: TextActionHandler;
      continueWriting: TextActionHandler;
      checkCodeErrors: TextActionHandler;
      explainCode: TextActionHandler;
      writeArticle: TextActionHandler;
      writeTwitterPost: TextActionHandler;
      writePoem: TextActionHandler;
      writeBlogPost: TextActionHandler;
      brainstorm: TextActionHandler;
      writeOutline: TextActionHandler;
      explainImage: TextActionHandler;
      findActions: TextActionHandler;
      brainstormMindmap: TextActionHandler<BrainstormMindMap>;
      expandMindmap: TextActionHandler<ExpandMindMap>;
      createSlides: TextActionHandler;
      explain: TextActionHandler;
      translate: TextActionHandler<TranslateOptions>;
      changeTone: TextActionHandler<ChangeToneOptions>;
      makeItReal: TextActionHandler<AIImageActionOptions>;
      generateCaption: TextActionHandler;
    }

    type AIDocsAndFilesContext = {
      docs: CopilotContextDoc[];
      files: CopilotContextFile[];
      tags: CopilotContextCategory[];
      collections: CopilotContextCategory[];
      blobs: CopilotContextBlob[];
    };

    interface AIContextService {
      createContext: (
        workspaceId: string,
        sessionId: string,
      ) => Promise<string>;
      getContextId: (
        workspaceId: string,
        sessionId: string,
      ) => Promise<string | undefined>;
      addContextDoc: (options: {
        contextId: string;
        docId: string;
      }) => Promise<CopilotContextDoc>;
      removeContextDoc: (options: {
        contextId: string;
        docId: string;
      }) => Promise<boolean>;
      addContextFile: (
        file: File,
        options: AddContextFileInput,
      ) => Promise<CopilotContextFile>;
      removeContextFile: (options: {
        contextId: string;
        fileId: string;
      }) => Promise<boolean>;
      retryContextFile: (options: {
        contextId: string;
        fileId: string;
      }) => Promise<CopilotContextFile>;
      addContextTag: (options: {
        contextId: string;
        tagId: string;
        docIds: string[];
      }) => Promise<CopilotContextCategory>;
      removeContextTag: (options: {
        contextId: string;
        tagId: string;
      }) => Promise<boolean>;
      addContextCollection: (options: {
        contextId: string;
        collectionId: string;
        docIds: string[];
      }) => Promise<CopilotContextCategory>;
      removeContextCollection: (options: {
        contextId: string;
        collectionId: string;
      }) => Promise<boolean>;
      getContextDocsAndFiles: (
        workspaceId: string,
        sessionId: string,
        contextId: string,
      ) => Promise<AIDocsAndFilesContext | undefined>;
      pollContextDocsAndFiles: (
        workspaceId: string,
        sessionId: string,
        contextId: string,
        onPoll: (result: AIDocsAndFilesContext | undefined) => void,
        abortSignal: AbortSignal,
      ) => Promise<void>;
      pollEmbeddingStatus: (
        workspaceId: string,
        onPoll: (result: ContextWorkspaceEmbeddingStatus) => void,
        abortSignal: AbortSignal,
      ) => Promise<void>;
      matchContext: (
        content: string,
        contextId?: string,
        workspaceId?: string,
        limit?: number,
        scopedThreshold?: number,
        threshold?: number,
      ) => Promise<{
        files?: CopilotContextMatchedFile[];
        docs?: CopilotContextMatchedDoc[];
      }>;
      applyDocUpdates: (
        workspaceId: string,
        docId: string,
        op: string,
        updates: string,
      ) => Promise<string>;
      addContextBlob: (options: {
        blobId: string;
        contextId: string;
      }) => Promise<CopilotContextBlob>;
      removeContextBlob: (options: {
        blobId: string;
        contextId: string;
      }) => Promise<boolean>;
    }

    type MessageRole = "user" | "assistant";

    interface AIHistory {
      sessionId: string;
      tokens: number;
      action: string | null;
      createdAt: string;
      messages: Array<{
        id: string | null;
        content: string;
        createdAt: string;
        role: MessageRole;
        attachments?: string[] | null;
        generatedFiles?: CopilotGeneratedFile[] | null;
        streamObjects?: StreamObject[] | null;
      }>;
    }

    type AIHistoryIds = Pick<AIHistory, "sessionId" | "messages"> & {
      messages: Array<
        Pick<AIHistory["messages"][number], "id" | "createdAt" | "role">
      >;
    };

    interface AICreateSessionOptions {
      promptName: PromptKey;
      workspaceId: string;
      docId?: string;
      sessionId?: string;
      retry?: boolean;
      pinned?: boolean;
      reuseLatestChat?: boolean;
    }

    type AIRecentSession = Omit<CopilotHistories, "messages">;

    interface AISessionService {
      exportMessage?: (
        messageId: string,
        format: "pdf" | "html",
      ) => Promise<CopilotGeneratedFile>;
      downloadGeneratedFile?: (file: CopilotGeneratedFile) => Promise<void>;
      createSession: (options: AICreateSessionOptions) => Promise<string>;
      createSessionWithHistory: (
        options: AICreateSessionOptions,
      ) => Promise<CopilotChatHistoryFragment | undefined>;
      getSession: (
        workspaceId: string,
        sessionId: string,
      ) => Promise<CopilotChatHistoryFragment | undefined>;
      getSessions: (
        workspaceId: string,
        docId?: string,
        options?: QueryChatHistoriesInput,
      ) => Promise<CopilotChatHistoryFragment[] | undefined>;
      getRecentSessions: (
        workspaceId: string,
        limit?: number,
        offset?: number,
      ) => Promise<
        { sessions: AIRecentSession[]; hasNextPage: boolean } | undefined
      >;
      updateSession: (options: UpdateChatSessionInput) => Promise<string>;
    }

    interface AIHistoryService {
      actions: (
        workspaceId: string,
        docId: string,
      ) => Promise<AIHistory[] | undefined>;
      chats: (
        workspaceId: string,
        sessionId: string,
        docId?: string,
      ) => Promise<AIHistory[] | undefined>;
      cleanup: (
        workspaceId: string,
        docId: string | undefined,
        sessionIds: string[],
      ) => Promise<void>;
      ids: (
        workspaceId: string,
        docId?: string,
        options?: RequestOptions<
          typeof getCopilotHistoriesQuery
        >["variables"]["options"],
      ) => Promise<AIHistoryIds[] | undefined>;
    }

    interface AIPhotoEngineService {
      searchImages(options: {
        width: number;
        height: number;
        query: string;
      }): Promise<string[]>;
    }

    interface AIEmbeddingService {
      getEmbeddingStatus(workspaceId: string): Promise<AIEmbeddingStatus>;
    }
  }
}
