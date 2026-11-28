// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors

import type { GlobalDialogService } from "@myoxus/core/modules/dialogs";
import type { AuthAccountInfo, AuthService } from "@myoxus/core/modules/server";
import type { WorkspaceService } from "@myoxus/core/modules/workspace";
import type {
  AddContextFileInput,
  ContextWorkspaceEmbeddingStatus,
  getCopilotHistoriesQuery,
  QueryChatHistoriesInput,
  RequestOptions,
  UpdateChatSessionInput,
} from "@myoxus/graphql";
import { z } from "zod";

import { AIProvider } from "./ai-provider";
import { type CopilotClient, Endpoint } from "./copilot-client";
import type { PromptKey } from "./prompt";
import { textToText } from "./request";
import { persistAttachmentWithBlobSync } from "./request-attachments";
import { setupTracker } from "./tracker";

const ContextCategories = { Tag: "Tag", Collection: "Collection" } as const;

const CHAT_MESSAGE_TIMEOUT_MS = 5 * 60 * 1000;
const WORKFLOW_TIMEOUT_MS = 3 * 60 * 1000;
const CONTEXT_POLL_MIN_MS = 1000;
const CONTEXT_POLL_MAX_MS = 30_000;
const EMBEDDING_POLL_MS = 10_000;

type DirectTextActionKey =
  | "summary"
  | "improveWriting"
  | "improveGrammar"
  | "fixSpelling"
  | "createHeadings"
  | "makeLonger"
  | "makeShorter"
  | "checkCodeErrors"
  | "explainCode"
  | "writeArticle"
  | "writeTwitterPost"
  | "writePoem"
  | "writeOutline"
  | "writeBlogPost"
  | "brainstorm"
  | "findActions"
  | "explain"
  | "explainImage"
  | "generateCaption"
  | "continueWriting";

/** Declarative prompt table for standard single-input text and vision actions. */
const DIRECT_TEXT_ACTIONS: ReadonlyArray<
  readonly [DirectTextActionKey, PromptKey]
> = [
  ["summary", "Summary"],
  ["improveWriting", "Improve writing for it"],
  ["improveGrammar", "Improve grammar for it"],
  ["fixSpelling", "Fix spelling for it"],
  ["createHeadings", "Create headings"],
  ["makeLonger", "Make it longer"],
  ["makeShorter", "Make it shorter"],
  ["checkCodeErrors", "Check code error"],
  ["explainCode", "Explain this code"],
  ["writeArticle", "Write an article about this"],
  ["writeTwitterPost", "Write a twitter about this"],
  ["writePoem", "Write a poem about this"],
  ["writeOutline", "Write outline"],
  ["writeBlogPost", "Write a blog post about this"],
  ["brainstorm", "Brainstorm ideas about this"],
  ["findActions", "Find action items from it"],
  ["explain", "Explain this"],
  ["explainImage", "Explain this image"],
  ["generateCaption", "Generate a caption"],
  ["continueWriting", "Continue writing"],
];

const SlideLineSchema = z.object({
  page: z.number(),
  type: z.enum(["name", "title", "content"]),
  content: z.string(),
});

function formatPresentationOutline(rawLines: string): string {
  const formatted: string[] = [];
  for (const line of rawLines.split("\n")) {
    let parsed: z.infer<typeof SlideLineSchema> | null = null;
    try {
      parsed = SlideLineSchema.parse(JSON.parse(line));
    } catch {
      continue;
    }
    if (parsed.type === "name") {
      formatted.push(`- ${parsed.content}`);
    } else if (parsed.type === "title") {
      formatted.push(`  - ${parsed.content}`);
    } else if (parsed.content.includes("\n")) {
      formatted.push(
        parsed.content
          .split("\n")
          .map((part) => `    - ${part}`)
          .join("\n"),
      );
    } else {
      formatted.push(`    - ${parsed.content}`);
    }
  }
  return formatted.join("\n");
}

function toAIUserInfo(account: AuthAccountInfo | null) {
  if (!account) return null;
  return {
    avatarUrl: account.avatar ?? "",
    email: account.email ?? "",
    id: account.id,
    name: account.label,
  };
}

function waitAbortable(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const finish = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    signal.addEventListener("abort", finish, { once: true });
  });
}

export function setupAIProvider(
  client: CopilotClient,
  globalDialogService: GlobalDialogService,
  authService: AuthService,
  workspaceService: WorkspaceService,
) {
  async function createSession(
    options: VirgultumPresets.AICreateSessionOptions,
  ) {
    if (options.sessionId) return options.sessionId;
    if (options.retry) return AIProvider.LAST_ACTION_SESSIONID;

    return client.createSession({
      workspaceId: options.workspaceId,
      docId: options.docId,
      promptName: options.promptName,
      pinned: options.pinned,
      reuseLatestChat: options.reuseLatestChat,
    });
  }

  AIProvider.provide("userInfo", () =>
    toAIUserInfo(authService.session.account$.value),
  );

  const accountSubscription = authService.session.account$.subscribe(
    (account) => {
      AIProvider.slots.userInfo.next(toAIUserInfo(account));
    },
  );

  for (const [actionId, promptName] of DIRECT_TEXT_ACTIONS) {
    AIProvider.provide(actionId, async (options) => {
      const sessionId = await createSession({ promptName, ...options });
      return textToText({
        ...options,
        client,
        sessionId,
        content: options.input,
      });
    });
  }

  AIProvider.provide("chat", async (options) => {
    const { input, contexts } = options;
    const sessionId = await createSession({
      promptName: "Chat With Myoxus AI",
      ...options,
    });

    return textToText({
      ...options,
      persistAttachment: (attachment) =>
        persistAttachmentWithBlobSync(
          workspaceService.workspace.docCollection.blobSync,
          attachment,
          options.signal,
        ),
      modelId: options.modelId,
      client,
      sessionId,
      content: input,
      timeout: CHAT_MESSAGE_TIMEOUT_MS,
      streamTimeout: null,
      params: {
        docs: contexts?.docs,
        files: contexts?.files,
        selectedSnapshot: contexts?.selectedSnapshot,
        selectedMarkdown: contexts?.selectedMarkdown,
        html: contexts?.html,
        ...(options.docId ? { currentDocId: options.docId } : {}),
      },
      endpoint: Endpoint.StreamObject,
    });
  });

  AIProvider.provide("translate", async (options) => {
    const sessionId = await createSession({
      promptName: "Translate to",
      ...options,
    });
    return textToText({
      ...options,
      client,
      sessionId,
      content: options.input,
      params: { language: options.lang },
    });
  });

  AIProvider.provide("changeTone", async (options) => {
    const sessionId = await createSession({
      promptName: "Change tone to",
      ...options,
    });
    return textToText({
      ...options,
      client,
      sessionId,
      content: options.input,
      params: { tone: options.tone.toLowerCase() },
    });
  });

  AIProvider.provide("brainstormMindmap", async (options) => {
    const sessionId = await createSession({
      promptName: "workflow:brainstorm",
      ...options,
    });
    return textToText({
      ...options,
      client,
      sessionId,
      content: options.input,
      timeout: WORKFLOW_TIMEOUT_MS,
      endpoint: Endpoint.Workflow,
    });
  });

  AIProvider.provide("expandMindmap", async (options) => {
    if (!options.input) {
      throw new Error("expandMindmap action requires input");
    }
    const sessionId = await createSession({
      promptName: "Expand mind map",
      ...options,
    });
    return textToText({
      ...options,
      client,
      sessionId,
      content: options.input,
      params: { mindmap: options.mindmap, node: options.input },
    });
  });

  AIProvider.provide("makeItReal", async (options) => {
    const hasWireframes = Boolean(options.attachments?.length);
    const promptName: PromptKey = hasWireframes
      ? "Make it real"
      : "Make it real with text";
    const baseInput = options.input || "";
    const content = hasWireframes
      ? `Here are the latest wireframes. Could you make a new website based on these wireframes and notes and send back just the html file?\nHere are our design notes:\n ${baseInput}.`
      : `Here are the latest notes: \n ${baseInput}.\nCould you make a new website based on these notes and send back just the html file?`;

    const sessionId = await createSession({ promptName, ...options });
    return textToText({
      ...options,
      client,
      sessionId,
      content,
    });
  });

  AIProvider.provide("createSlides", async (options) => {
    const sessionId = await createSession({
      promptName: "workflow:presentation",
      ...options,
    });
    return textToText({
      ...options,
      client,
      sessionId,
      content: options.input,
      timeout: WORKFLOW_TIMEOUT_MS,
      endpoint: Endpoint.Workflow,
      postfix: formatPresentationOutline,
    });
  });

  AIProvider.provide("session", {
    exportMessage: (messageId, format) =>
      client.exportMessage(messageId, format),
    downloadGeneratedFile: (file) => client.downloadGeneratedFile(file),
    createSession,
    createSessionWithHistory: async (options) => {
      if (!options.sessionId && !options.retry) {
        return client.createSessionWithHistory({
          workspaceId: options.workspaceId,
          docId: options.docId,
          promptName: options.promptName,
          pinned: options.pinned,
          reuseLatestChat: options.reuseLatestChat,
        });
      }
      const sessionId = await createSession(options);
      if (!sessionId) return undefined;
      return client.getSession(options.workspaceId, sessionId);
    },
    getSession: (workspaceId: string, sessionId: string) =>
      client.getSession(workspaceId, sessionId),
    getSessions: (
      workspaceId: string,
      docId?: string,
      options?: QueryChatHistoriesInput,
    ) => client.getSessions(workspaceId, {}, docId, options),
    getRecentSessions: (workspaceId: string, limit?: number, offset?: number) =>
      client.getRecentSessions(workspaceId, limit, offset),
    updateSession: (options: UpdateChatSessionInput) =>
      client.updateSession(options),
  });

  AIProvider.provide("context", {
    createContext: (workspaceId: string, sessionId: string) =>
      client.createContext(workspaceId, sessionId),
    getContextId: (workspaceId: string, sessionId: string) =>
      client.getContextId(workspaceId, sessionId),
    addContextDoc: (options: { contextId: string; docId: string }) =>
      client.addContextDoc(options),
    removeContextDoc: (options: { contextId: string; docId: string }) =>
      client.removeContextDoc(options),
    addContextFile: (file: File, options: AddContextFileInput) =>
      client.addContextFile(file, options),
    removeContextFile: (options: { contextId: string; fileId: string }) =>
      client.removeContextFile(options),
    retryContextFile: (options) => client.retryContextFile(options),
    addContextTag: (options: {
      contextId: string;
      tagId: string;
      docIds: string[];
    }) =>
      client.addContextCategory({
        contextId: options.contextId,
        type: ContextCategories.Tag,
        categoryId: options.tagId,
        docs: options.docIds,
      }),
    removeContextTag: (options: { contextId: string; tagId: string }) =>
      client.removeContextCategory({
        contextId: options.contextId,
        type: ContextCategories.Tag,
        categoryId: options.tagId,
      }),
    addContextCollection: (options: {
      contextId: string;
      collectionId: string;
      docIds: string[];
    }) =>
      client.addContextCategory({
        contextId: options.contextId,
        type: ContextCategories.Collection,
        categoryId: options.collectionId,
        docs: options.docIds,
      }),
    removeContextCollection: (options: {
      contextId: string;
      collectionId: string;
    }) =>
      client.removeContextCategory({
        contextId: options.contextId,
        type: ContextCategories.Collection,
        categoryId: options.collectionId,
      }),
    getContextDocsAndFiles: (
      workspaceId: string,
      sessionId: string,
      contextId: string,
    ) => client.getContextDocsAndFiles(workspaceId, sessionId, contextId),
    pollContextDocsAndFiles: async (
      workspaceId: string,
      sessionId: string,
      contextId: string,
      onPoll: (
        result: VirgultumPresets.AIDocsAndFilesContext | undefined,
      ) => void,
      abortSignal: AbortSignal,
    ) => {
      let attempt = 0;
      while (!abortSignal.aborted) {
        const result = await client.getContextDocsAndFiles(
          workspaceId,
          sessionId,
          contextId,
        );
        if (abortSignal.aborted) return;
        onPoll(result);
        const delay = Math.min(
          CONTEXT_POLL_MIN_MS * Math.pow(1.5, attempt),
          CONTEXT_POLL_MAX_MS,
        );
        attempt += 1;
        await waitAbortable(delay, abortSignal);
      }
    },
    pollEmbeddingStatus: async (
      workspaceId: string,
      onPoll: (result: ContextWorkspaceEmbeddingStatus) => void,
      abortSignal: AbortSignal,
    ) => {
      while (!abortSignal.aborted) {
        const result = await client.getEmbeddingStatus(workspaceId);
        if (abortSignal.aborted) return;
        onPoll(result);
        // Terminal outcomes (finished/failed/unconfigured) stop the poll loop.
        if (result.status !== "processing") return;
        await waitAbortable(EMBEDDING_POLL_MS, abortSignal);
      }
    },
    matchContext: (
      content: string,
      contextId?: string,
      workspaceId?: string,
      limit?: number,
      scopedThreshold?: number,
      threshold?: number,
    ) =>
      client.matchContext(
        content,
        contextId,
        workspaceId,
        limit,
        scopedThreshold,
        threshold,
      ),
    applyDocUpdates: (
      workspaceId: string,
      docId: string,
      op: string,
      updates: string,
    ) => client.applyDocUpdates(workspaceId, docId, op, updates),
    addContextBlob: (options: { blobId: string; contextId: string }) =>
      client.addContextBlob({
        contextId: options.contextId,
        blobId: options.blobId,
      }),
    removeContextBlob: (options: { blobId: string; contextId: string }) =>
      client.removeContextBlob({
        contextId: options.contextId,
        blobId: options.blobId,
      }),
  });

  AIProvider.provide("histories", {
    actions: async (
      workspaceId: string,
      docId: string,
    ): Promise<VirgultumPresets.AIHistory[]> => {
      const rows = await client.getHistories(workspaceId, {}, docId, {
        action: true,
        withPrompt: true,
        withMessages: true,
      });
      return (rows ?? []) as unknown as VirgultumPresets.AIHistory[];
    },
    chats: async (
      workspaceId: string,
      sessionId: string,
      docId?: string,
    ): Promise<VirgultumPresets.AIHistory[]> => {
      const rows = await client.getHistories(workspaceId, {}, docId, {
        sessionId,
        withMessages: true,
      });
      return (rows ?? []) as unknown as VirgultumPresets.AIHistory[];
    },
    cleanup: async (
      workspaceId: string,
      docId: string | undefined,
      sessionIds: string[],
    ) => {
      await client.cleanupSessions({ workspaceId, docId, sessionIds });
    },
    ids: async (
      workspaceId: string,
      docId?: string,
      options?: RequestOptions<
        typeof getCopilotHistoriesQuery
      >["variables"]["options"],
    ): Promise<VirgultumPresets.AIHistoryIds[]> => {
      const rows = await client.getHistoryIds(workspaceId, {}, docId, options);
      return rows as unknown as VirgultumPresets.AIHistoryIds[];
    },
  });

  AIProvider.provide("photoEngine", {
    async searchImages(options): Promise<string[]> {
      const endpoint = options.query
        ? `/api/copilot/unsplash/photos?query=${encodeURIComponent(options.query)}`
        : "/api/copilot/unsplash/photos";
      const response = await fetch(endpoint);
      const payload: {
        results?: Array<{ urls: { regular: string } }>;
      } = await response.json();
      if (!payload.results?.length) {
        return [];
      }

      const dpr = String(window.devicePixelRatio ?? 2);
      return payload.results.map((entry) => {
        const parsed = new URL(entry.urls.regular);
        parsed.searchParams.set("fit", "crop");
        parsed.searchParams.set("crop", "edges");
        parsed.searchParams.set("dpr", dpr);
        parsed.searchParams.set("w", String(options.width));
        parsed.searchParams.set("h", String(options.height));
        return parsed.toString();
      });
    },
  });

  AIProvider.provide("forkChat", (options) => client.forkSession(options));

  const loginSubscription = AIProvider.slots.requestLogin.subscribe(() => {
    globalDialogService.open("sign-in", {});
  });

  setupTracker();

  return () => {
    loginSubscription.unsubscribe();
    accountSubscription.unsubscribe();
  };
}
