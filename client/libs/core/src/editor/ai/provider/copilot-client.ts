// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors

import { showAILoginRequiredAtom } from "@myoxus/core/components/myoxus/auth/ai-login-required";
import type { AIToolsConfig } from "@myoxus/core/modules/ai-button";
import { downloadBlob } from "@myoxus/core/utils/resource";
import { UserFriendlyError } from "@myoxus/error";
import {
  addContextBlobMutation,
  addContextCategoryMutation,
  addContextDocMutation,
  addContextFileMutation,
  applyDocUpdatesMutation,
  cleanupCopilotSessionMutation,
  CopilotExportFormat,
  createCopilotContextMutation,
  createCopilotMessageMutation,
  createCopilotSessionMutation,
  createCopilotSessionWithHistoryMutation,
  exportCopilotMessageMutation,
  forkCopilotSessionMutation,
  getCopilotHistoriesQuery,
  getCopilotHistoryIdsQuery,
  getCopilotRecentSessionsQuery,
  getCopilotSessionQuery,
  getCopilotSessionsQuery,
  getWorkspaceEmbeddingStatusQuery,
  type GraphQLQuery,
  listContextObjectQuery,
  listContextQuery,
  matchContextQuery,
  type PaginationInput,
  type QueryOptions,
  type QueryResponse,
  removeContextBlobMutation,
  removeContextCategoryMutation,
  removeContextDocMutation,
  removeContextFileMutation,
  type RequestOptions,
  retryContextFileMutation,
  updateCopilotSessionMutation,
} from "@myoxus/graphql";
import { getCurrentStore } from "@myoxus/infra";

import type { CopilotGeneratedFile } from "../components/ai-chat-messages/type";
import { GeneralNetworkError, UnauthorizedError } from "./error";

export enum Endpoint {
  StreamObject = "stream-object",
  Workflow = "workflow",
}

type OptionsField<T extends GraphQLQuery> =
  RequestOptions<T>["variables"] extends { options: infer U } ? U : never;

type GqlExecutor = <Query extends GraphQLQuery>(
  options: QueryOptions<Query>,
) => Promise<QueryResponse<Query>>;

type EventSourceFactory = (
  url: string,
  eventSourceInitDict?: EventSourceInit,
) => EventSource;

function normalizeError(raw: unknown): UserFriendlyError {
  return raw instanceof UserFriendlyError
    ? raw
    : UserFriendlyError.fromAny(raw);
}

function isAbortFailure(err: UserFriendlyError): boolean {
  return (
    err.name === "REQUEST_ABORTED" ||
    err.code === "REQUEST_ABORTED" ||
    err.message?.toLowerCase().includes("aborted") === true
  );
}

export function resolveError(raw: unknown) {
  const err = normalizeError(raw);
  if (err.status === 401) {
    return new UnauthorizedError();
  }
  const message = err.code
    ? `${err.code}: ${err.message}\nIdentify: ${err.name}`
    : err.message;
  return new GeneralNetworkError(message, err.code);
}

export function handleError(raw: unknown) {
  const mapped = resolveError(raw);
  if (mapped instanceof UnauthorizedError) {
    getCurrentStore().set(showAILoginRequiredAtom, true);
  }
  return mapped;
}

/** Downloads a persisted Copilot file via the authenticated server transport. */
export async function downloadSavedCopilotFile(
  fetchFile: (url: string) => Promise<Response>,
  file: CopilotGeneratedFile,
  isCurrent: () => boolean = () => true,
) {
  const response = await fetchFile(file.downloadUrl);
  if (!response.ok) {
    throw new Error("File download failed");
  }
  const blob = await response.blob();
  if (isCurrent()) {
    await downloadBlob(blob, file.fileName);
  }
}

/**
 * GraphQL and SSE transport client for server-owned Myoxus AI endpoints.
 */
export class CopilotClient {
  private readonly pendingExports = new Map<
    string,
    Promise<CopilotGeneratedFile>
  >();

  constructor(
    readonly gql: GqlExecutor,
    readonly eventSource: EventSourceFactory,
    readonly fetchFile?: (url: string) => Promise<Response>,
  ) {}

  private async runResolved<T>(task: () => Promise<T>): Promise<T> {
    try {
      return await task();
    } catch (err) {
      throw resolveError(err);
    }
  }

  private async runAbortTolerant<T>(
    task: () => Promise<T>,
    fallback: T,
  ): Promise<T> {
    try {
      return await task();
    } catch (err) {
      const parsed = normalizeError(err);
      if (isAbortFailure(parsed)) {
        return fallback;
      }
      throw resolveError(parsed);
    }
  }

  /** Coalesces duplicate in-flight export mutations for the same message and format. */
  exportMessage(
    messageId: string,
    format: "pdf" | "html",
  ): Promise<CopilotGeneratedFile> {
    const key = `${messageId}:${format}`;
    const existing = this.pendingExports.get(key);
    if (existing) {
      return existing;
    }

    const promise = this.gql({
      timeout: 0,
      query: exportCopilotMessageMutation,
      variables: {
        messageId,
        format:
          format === "pdf" ? CopilotExportFormat.PDF : CopilotExportFormat.HTML,
      },
    })
      .then((res) => res.exportCopilotMessage)
      .finally(() => {
        if (this.pendingExports.get(key) === promise) {
          this.pendingExports.delete(key);
        }
      });

    this.pendingExports.set(key, promise);
    return promise;
  }

  async downloadGeneratedFile(file: CopilotGeneratedFile) {
    if (!this.fetchFile) {
      throw new Error("Authenticated file transport unavailable");
    }
    await downloadSavedCopilotFile(this.fetchFile, file);
  }

  createSession(options: OptionsField<typeof createCopilotSessionMutation>) {
    return this.runResolved(async () => {
      const res = await this.gql({
        query: createCopilotSessionMutation,
        variables: { options },
      });
      return res.createCopilotSession;
    });
  }

  createSessionWithHistory(
    options: OptionsField<typeof createCopilotSessionWithHistoryMutation>,
  ) {
    return this.runResolved(async () => {
      const res = await this.gql({
        query: createCopilotSessionWithHistoryMutation,
        variables: { options },
      });
      return res.createCopilotSessionWithHistory;
    });
  }

  updateSession(options: OptionsField<typeof updateCopilotSessionMutation>) {
    return this.runResolved(async () => {
      const res = await this.gql({
        query: updateCopilotSessionMutation,
        variables: { options },
      });
      return res.updateCopilotSession;
    });
  }

  forkSession(options: OptionsField<typeof forkCopilotSessionMutation>) {
    return this.runResolved(async () => {
      const res = await this.gql({
        query: forkCopilotSessionMutation,
        variables: { options },
      });
      return res.forkCopilotSession;
    });
  }

  createMessage(
    options: OptionsField<typeof createCopilotMessageMutation>,
    requestOptions?: Pick<
      RequestOptions<typeof createCopilotMessageMutation>,
      "timeout" | "signal"
    >,
  ) {
    return this.runResolved(async () => {
      const res = await this.gql({
        query: createCopilotMessageMutation,
        variables: { options },
        timeout: requestOptions?.timeout,
        signal: requestOptions?.signal,
      });
      return res.createCopilotMessage;
    });
  }

  getSession(workspaceId: string, sessionId: string) {
    return this.runResolved(async () => {
      const res = await this.gql({
        query: getCopilotSessionQuery,
        variables: { sessionId, workspaceId },
      });
      return res.currentUser?.copilot?.chats?.edges?.[0]?.node;
    });
  }

  getSessions(
    workspaceId: string,
    pagination: PaginationInput,
    docId?: string,
    options?: RequestOptions<
      typeof getCopilotSessionsQuery
    >["variables"]["options"],
    signal?: AbortSignal,
  ) {
    return this.runAbortTolerant(async () => {
      const res = await this.gql({
        query: getCopilotSessionsQuery,
        variables: { workspaceId, pagination, docId, options },
        signal,
      });
      return res.currentUser?.copilot?.chats.edges.map((edge) => edge.node);
    }, []);
  }

  getRecentSessions(workspaceId: string, limit?: number, offset?: number) {
    return this.runAbortTolerant(async () => {
      const res = await this.gql({
        query: getCopilotRecentSessionsQuery,
        variables: { workspaceId, limit, offset },
      });
      const connection = res.currentUser?.copilot?.chats;
      return connection
        ? {
            sessions: connection.edges.map((edge) => edge.node),
            hasNextPage: connection.pageInfo.hasNextPage,
          }
        : undefined;
    }, undefined);
  }

  getHistories(
    workspaceId: string,
    pagination: PaginationInput,
    docId?: string,
    options?: RequestOptions<
      typeof getCopilotHistoriesQuery
    >["variables"]["options"],
  ) {
    return this.runAbortTolerant(async () => {
      const res = await this.gql({
        query: getCopilotHistoriesQuery,
        variables: { workspaceId, pagination, docId, options },
      });
      return res.currentUser?.copilot?.chats.edges.map((edge) => edge.node);
    }, []);
  }

  getHistoryIds(
    workspaceId: string,
    pagination: PaginationInput,
    docId?: string,
    options?: RequestOptions<
      typeof getCopilotHistoryIdsQuery
    >["variables"]["options"],
  ) {
    return this.runAbortTolerant(async () => {
      const res = await this.gql({
        query: getCopilotHistoryIdsQuery,
        variables: { workspaceId, pagination, docId, options },
      });
      return res.currentUser?.copilot?.chats.edges.map((edge) => edge.node);
    }, []);
  }

  cleanupSessions(input: {
    workspaceId: string;
    docId: string | undefined;
    sessionIds: string[];
  }) {
    return this.runResolved(async () => {
      const res = await this.gql({
        query: cleanupCopilotSessionMutation,
        variables: { input },
      });
      return res.cleanupCopilotSession;
    });
  }

  async createContext(workspaceId: string, sessionId: string) {
    const res = await this.gql({
      query: createCopilotContextMutation,
      variables: { workspaceId, sessionId },
    });
    return res.createCopilotContext;
  }

  async getContextId(workspaceId: string, sessionId: string) {
    const res = await this.gql({
      query: listContextQuery,
      variables: { workspaceId, sessionId },
    });
    return res.currentUser?.copilot?.contexts?.[0]?.id || undefined;
  }

  async addContextDoc(options: OptionsField<typeof addContextDocMutation>) {
    const res = await this.gql({
      query: addContextDocMutation,
      variables: { options },
    });
    return res.addContextDoc;
  }

  async removeContextDoc(
    options: OptionsField<typeof removeContextDocMutation>,
  ) {
    const res = await this.gql({
      query: removeContextDocMutation,
      variables: { options },
    });
    return res.removeContextDoc;
  }

  async addContextFile(
    content: File,
    options: OptionsField<typeof addContextFileMutation>,
  ) {
    const res = await this.gql({
      query: addContextFileMutation,
      variables: { content, options },
      timeout: 60_000,
    });
    return res.addContextFile;
  }

  async removeContextFile(
    options: OptionsField<typeof removeContextFileMutation>,
  ) {
    const res = await this.gql({
      query: removeContextFileMutation,
      variables: { options },
    });
    return res.removeContextFile;
  }

  async retryContextFile(
    options: OptionsField<typeof retryContextFileMutation>,
  ) {
    const res = await this.gql({
      query: retryContextFileMutation,
      variables: { options },
    });
    return res.retryContextFile;
  }

  async addContextCategory(
    options: OptionsField<typeof addContextCategoryMutation>,
  ) {
    const res = await this.gql({
      query: addContextCategoryMutation,
      variables: { options },
    });
    return res.addContextCategory;
  }

  async removeContextCategory(
    options: OptionsField<typeof removeContextCategoryMutation>,
  ) {
    const res = await this.gql({
      query: removeContextCategoryMutation,
      variables: { options },
    });
    return res.removeContextCategory;
  }

  async getContextDocsAndFiles(
    workspaceId: string,
    sessionId: string,
    contextId: string,
  ) {
    const res = await this.gql({
      query: listContextObjectQuery,
      variables: { workspaceId, sessionId, contextId },
    });
    return res.currentUser?.copilot?.contexts?.[0];
  }

  async matchContext(
    content: string,
    contextId?: string,
    workspaceId?: string,
    limit?: number,
    scopedThreshold?: number,
    threshold?: number,
  ) {
    const res = await this.gql({
      query: matchContextQuery,
      variables: {
        content,
        contextId,
        workspaceId,
        limit,
        scopedThreshold,
        threshold,
      },
    });
    const ctx = res.currentUser?.copilot?.contexts?.[0];
    return {
      files: ctx?.matchFiles,
      docs: ctx?.matchWorkspaceDocs,
    };
  }

  chatTextStream(
    params: {
      sessionId: string;
      messageId?: string;
      requestId?: string;
      responseId?: string;
      expectedStreamId?: string;
      reasoning?: boolean;
      modelId?: string;
      toolsConfig?: AIToolsConfig;
    },
    endpoint: Endpoint = Endpoint.StreamObject,
  ): EventSource {
    const { sessionId, ...queryParams } = params;
    const baseUrl = `/api/copilot/chat/${sessionId}/${endpoint}`;
    const qs = this.paramsToQueryString(queryParams);
    return this.eventSource(qs ? `${baseUrl}?${qs}` : baseUrl);
  }

  paramsToQueryString(
    params: Record<string, string | boolean | object | undefined>,
  ): string {
    const search = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
      if (typeof value === "boolean") {
        // Explicit `false` overrides server default and must be serialized.
        search.append(key, String(value));
      } else if (typeof value === "string") {
        search.append(key, value);
      } else if (value !== null && typeof value === "object") {
        search.append(key, JSON.stringify(value));
      }
    }
    return search.toString();
  }

  getEmbeddingStatus(workspaceId: string) {
    return this.gql({
      query: getWorkspaceEmbeddingStatusQuery,
      variables: { workspaceId },
    }).then((res) => res.queryWorkspaceEmbeddingStatus);
  }

  applyDocUpdates(
    workspaceId: string,
    docId: string,
    op: string,
    updates: string,
  ) {
    return this.gql({
      query: applyDocUpdatesMutation,
      variables: { workspaceId, docId, op, updates },
    }).then((res) => res.applyDocUpdates);
  }

  addContextBlob(options: OptionsField<typeof addContextBlobMutation>) {
    return this.gql({
      query: addContextBlobMutation,
      variables: { options },
    }).then((res) => res.addContextBlob);
  }

  removeContextBlob(options: OptionsField<typeof removeContextBlobMutation>) {
    return this.gql({
      query: removeContextBlobMutation,
      variables: { options },
    }).then((res) => res.removeContextBlob);
  }
}
