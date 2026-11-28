// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors

import { captureException } from "@sentry/react";
import type { EditorHost } from "@virgultum/editor/std";
import { BehaviorSubject, Subject } from "rxjs";

import type { ChatContextValue } from "../components/ai-chat-content";
import { RequestTimeoutError, UnauthorizedError } from "./error";

export interface AIUserInfo {
  id: string;
  email: string;
  name: string;
  avatarUrl: string | null;
}

export interface AIChatParams {
  host?: EditorHost | null;
  docId?: string;
  input?: string;
  mode?: "page" | "edgeless";
  /** Auto-select and forward editor selection via `Continue in AI Chat`. */
  autoSelect?: boolean;
  context?: Partial<ChatContextValue | null>;
  fromAnswer?: boolean;
}

export interface AISendParams {
  host?: EditorHost | null;
  docId?: string;
  input: string;
  context?: Partial<ChatContextValue | null>;
}

export interface AIEmbeddingStatus {
  embedded: number;
  total: number;
}

export type ActionEventType =
  | "started"
  | "finished"
  | "error"
  | "aborted:login-required"
  | "aborted:server-error"
  | "aborted:stop"
  | "aborted:timeout"
  | "result:insert"
  | "result:replace"
  | "result:use-as-caption"
  | "result:add-page"
  | "result:add-note"
  | "result:continue-in-chat"
  | "result:discard"
  | "result:retry";

export interface AIActionEvent {
  action: keyof VirgultumPresets.AIActions;
  options: VirgultumPresets.AITextActionOptions;
  event: ActionEventType;
}

type ActionFn<K extends keyof VirgultumPresets.AIActions> = (
  ...args: Parameters<VirgultumPresets.AIActions[K]>
) => Promise<ReturnType<VirgultumPresets.AIActions[K]>>;

type ForkChatFn = (
  options: VirgultumPresets.AIForkChatSessionOptions,
) => string | Promise<string>;

type UserInfoResolver = () => AIUserInfo | Promise<AIUserInfo> | null;

function isAsyncStream(
  value: VirgultumPresets.TextStream | Promise<string>,
): value is VirgultumPresets.TextStream {
  return (
    value !== null && typeof value === "object" && Symbol.asyncIterator in value
  );
}

/**
 * Central client registry binding server-backed AI services, actions, and
 * observable action-lifecycle slots for editor and chat surfaces.
 */
export class AIProvider {
  private static readonly singleton = new AIProvider();

  static LAST_ACTION_SESSIONID = "";
  static MAX_LOCAL_HISTORY = 10;

  static get slots() {
    return AIProvider.singleton.slots;
  }

  static get actions() {
    return AIProvider.singleton.actions;
  }

  static get userInfo() {
    return AIProvider.singleton.resolveUserInfo();
  }

  static get photoEngine() {
    return AIProvider.singleton.photoEngine;
  }

  static get histories() {
    return AIProvider.singleton.histories;
  }

  static get session() {
    return AIProvider.singleton.session;
  }

  static get context() {
    return AIProvider.singleton.context;
  }

  static get actionHistory() {
    return AIProvider.singleton.actionHistory;
  }

  static get forkChat() {
    return AIProvider.singleton.forkChat;
  }

  static get embedding() {
    return AIProvider.singleton.embedding;
  }

  private readonly actions: Partial<VirgultumPresets.AIActions> = {};
  private readonly actionHistory: Array<{
    action: keyof VirgultumPresets.AIActions;
    options: VirgultumPresets.AITextActionOptions;
  }> = [];

  private readonly slots = {
    requestOpenWithChat: new BehaviorSubject<AIChatParams | null>(null),
    requestSendWithChat: new BehaviorSubject<AISendParams | null>(null),
    requestLogin: new Subject<{ host?: EditorHost | null }>(),
    actions: new Subject<AIActionEvent>(),
    userInfo: new Subject<AIUserInfo | null>(),
    sessionReady: new BehaviorSubject<boolean>(false),
    previewPanelOpenChange: new Subject<boolean>(),
  };

  private resolveUserInfo: UserInfoResolver = () => null;
  private photoEngine: VirgultumPresets.AIPhotoEngineService | null = null;
  private histories: VirgultumPresets.AIHistoryService | null = null;
  private session: VirgultumPresets.AISessionService | null = null;
  private context: VirgultumPresets.AIContextService | null = null;
  private forkChat: ForkChatFn | null = null;
  private embedding: VirgultumPresets.AIEmbeddingService | null = null;

  private reportFailure(
    action: keyof VirgultumPresets.AIActions,
    options: VirgultumPresets.AITextActionOptions,
    err: unknown,
    userId: string | undefined,
    classifyStreamErrors: boolean,
  ): void {
    if (options.signal?.aborted) {
      // Expected cancellation belongs to this action invocation and is never reported as an error.
      this.slots.actions.next({ action, options, event: "aborted:stop" });
      return;
    }

    this.slots.actions.next({ action, options, event: "error" });

    if (classifyStreamErrors && err instanceof RequestTimeoutError) {
      this.slots.actions.next({ action, options, event: "aborted:timeout" });
      return;
    }
    if (classifyStreamErrors && err instanceof UnauthorizedError) {
      this.slots.actions.next({
        action,
        options,
        event: "aborted:login-required",
      });
      return;
    }

    this.slots.actions.next({ action, options, event: "aborted:server-error" });
    captureException(err, {
      user: { id: userId },
      extra: {
        action,
        session: AIProvider.LAST_ACTION_SESSIONID,
      },
    });
  }

  private registerAction<K extends keyof VirgultumPresets.AIActions>(
    id: K,
    handler: ActionFn<K>,
  ): void {
    const wrapped = async (
      ...args: Parameters<VirgultumPresets.AIActions[K]>
    ) => {
      const options = args[0];
      this.slots.actions.next({ action: id, options, event: "started" });
      this.actionHistory.push({ action: id, options });
      if (this.actionHistory.length > AIProvider.MAX_LOCAL_HISTORY) {
        this.actionHistory.shift();
      }

      const rawResult = (await handler(...args)) as
        VirgultumPresets.TextStream | Promise<string>;

      if (isAsyncStream(rawResult)) {
        const emitFinished = () =>
          this.slots.actions.next({
            action: id,
            options,
            event: "finished",
          });
        const emitFailure = (err: unknown, userId: string | undefined) =>
          this.reportFailure(id, options, err, userId, true);

        return {
          [Symbol.asyncIterator]: async function* () {
            let user: AIUserInfo | null = null;
            try {
              user = await AIProvider.userInfo;
              yield* rawResult;
              options.signal?.throwIfAborted();
              emitFinished();
            } catch (err) {
              emitFailure(err, user?.id);
              throw err;
            }
          },
        };
      }

      let user: AIUserInfo | null = null;
      try {
        const text = await rawResult;
        options.signal?.throwIfAborted();
        user = await AIProvider.userInfo;
        this.slots.actions.next({
          action: id,
          options,
          event: "finished",
        });
        return text;
      } catch (err) {
        this.reportFailure(id, options, err, user?.id, false);
        throw err;
      }
    };

    (this.actions as Record<string, unknown>)[id] = wrapped;
  }

  static provide(id: "userInfo", fn: UserInfoResolver): void;
  static provide(
    id: "session",
    service: VirgultumPresets.AISessionService,
  ): void;
  static provide(
    id: "context",
    service: VirgultumPresets.AIContextService,
  ): void;
  static provide(
    id: "histories",
    service: VirgultumPresets.AIHistoryService,
  ): void;
  static provide(
    id: "photoEngine",
    engine: VirgultumPresets.AIPhotoEngineService,
  ): void;
  static provide(id: "forkChat", fn: ForkChatFn): void;
  static provide(id: "onboarding", fn: (value: boolean) => void): void;
  static provide(
    id: "embedding",
    service: VirgultumPresets.AIEmbeddingService,
  ): void;
  static provide<K extends keyof VirgultumPresets.AIActions>(
    id: K,
    action: ActionFn<K>,
  ): void;
  static provide(id: string, impl: unknown): void {
    const target = AIProvider.singleton;
    switch (id) {
      case "userInfo":
        target.resolveUserInfo = impl as UserInfoResolver;
        return;
      case "histories":
        target.histories = impl as VirgultumPresets.AIHistoryService;
        return;
      case "session":
        target.session = impl as VirgultumPresets.AISessionService;
        target.slots.sessionReady.next(true);
        return;
      case "context":
        target.context = impl as VirgultumPresets.AIContextService;
        return;
      case "photoEngine":
        target.photoEngine = impl as VirgultumPresets.AIPhotoEngineService;
        return;
      case "forkChat":
        target.forkChat = impl as ForkChatFn;
        return;
      case "embedding":
        target.embedding = impl as VirgultumPresets.AIEmbeddingService;
        return;
      case "onboarding":
        return;
      default:
        target.registerAction(
          id as keyof VirgultumPresets.AIActions,
          impl as ActionFn<keyof VirgultumPresets.AIActions>,
        );
    }
  }
}
