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
  host: EditorHost;
  input?: string;
  mode?: "page" | "edgeless";
  // Auto select and append selection to input via `Continue in AI Chat` action.
  autoSelect?: boolean;
  context?: Partial<ChatContextValue | null>;
  fromAnswer?: boolean;
}

export interface AISendParams {
  host: EditorHost;
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

/**
 * AI provider for the block suite
 *
 * To use it, downstream (affine) has to provide AI actions implementation,
 * user info etc
 *
 * TODO: breakdown into different parts?
 */
export class AIProvider {
  static get slots() {
    return AIProvider.instance.slots;
  }

  static get actions() {
    return AIProvider.instance.actions;
  }

  static get userInfo() {
    return AIProvider.instance.userInfoFn();
  }

  static get photoEngine() {
    return AIProvider.instance.photoEngine;
  }

  static get histories() {
    return AIProvider.instance.histories;
  }

  static get session() {
    return AIProvider.instance.session;
  }

  static get context() {
    return AIProvider.instance.context;
  }

  static get actionHistory() {
    return AIProvider.instance.actionHistory;
  }

  static get forkChat() {
    return AIProvider.instance.forkChat;
  }

  static get embedding() {
    return AIProvider.instance.embedding;
  }

  private static readonly instance = new AIProvider();

  static LAST_ACTION_SESSIONID = "";

  static MAX_LOCAL_HISTORY = 10;

  private readonly actions: Partial<VirgultumPresets.AIActions> = {};

  private photoEngine: VirgultumPresets.AIPhotoEngineService | null = null;

  private histories: VirgultumPresets.AIHistoryService | null = null;

  private session: VirgultumPresets.AISessionService | null = null;

  private context: VirgultumPresets.AIContextService | null = null;

  private forkChat:
    | ((
        options: VirgultumPresets.AIForkChatSessionOptions,
      ) => string | Promise<string>)
    | null = null;

  private readonly slots = {
    // use case: when user selects "continue in chat" in an ask ai result panel
    // do we need to pass the context to the chat panel?

    requestOpenWithChat: new BehaviorSubject<AIChatParams | null>(null),
    requestSendWithChat: new BehaviorSubject<AISendParams | null>(null),
    requestLogin: new Subject<{ host?: EditorHost | null }>(),
    // stream of AI actions triggered by users
    actions: new Subject<{
      action: keyof VirgultumPresets.AIActions;
      options: VirgultumPresets.AITextActionOptions;
      event: ActionEventType;
    }>(),
    // downstream can emit this slot to notify ai presets that user info has been updated
    userInfo: new Subject<AIUserInfo | null>(),
    sessionReady: new BehaviorSubject<boolean>(false),
    previewPanelOpenChange: new Subject<boolean>(),
  };

  // track the history of triggered actions (in memory only)
  private readonly actionHistory: {
    action: keyof VirgultumPresets.AIActions;
    options: VirgultumPresets.AITextActionOptions;
  }[] = [];

  private userInfoFn: () => AIUserInfo | Promise<AIUserInfo> | null = () =>
    null;

  private embedding: VirgultumPresets.AIEmbeddingService | null = null;

  private provideAction<T extends keyof VirgultumPresets.AIActions>(
    id: T,
    action: (
      ...options: Parameters<VirgultumPresets.AIActions[T]>
    ) => Promise<ReturnType<VirgultumPresets.AIActions[T]>>,
  ): void {
    // @ts-expect-error TODO: maybe fix this
    this.actions[id] = async (
      ...args: Parameters<VirgultumPresets.AIActions[T]>
    ) => {
      const options = args[0];
      const slots = this.slots;
      slots.actions.next({
        action: id,
        options,
        event: "started",
      });
      this.actionHistory.push({ action: id, options });
      if (this.actionHistory.length > AIProvider.MAX_LOCAL_HISTORY) {
        this.actionHistory.shift();
      }
      // wrap the action with slot actions
      const result: VirgultumPresets.TextStream | Promise<string> =
        await action(...args);
      const isTextStream = (
        m: VirgultumPresets.TextStream | Promise<string>,
      ): m is VirgultumPresets.TextStream =>
        Reflect.has(m, Symbol.asyncIterator);
      if (isTextStream(result)) {
        return {
          [Symbol.asyncIterator]: async function* () {
            let user = null;
            try {
              user = await AIProvider.userInfo;
              yield* result;
              options.signal?.throwIfAborted();
              slots.actions.next({
                action: id,
                options,
                event: "finished",
              });
            } catch (err) {
              if (options.signal?.aborted) {
                // Expected cancellation belongs to this action, not whichever
                // action is currently last in the global reporter's history.
                slots.actions.next({
                  action: id,
                  options,
                  event: "aborted:stop",
                });
                throw err;
              }
              slots.actions.next({
                action: id,
                options,
                event: "error",
              });
              if (err instanceof RequestTimeoutError) {
                slots.actions.next({
                  action: id,
                  options,
                  event: "aborted:timeout",
                });
              } else if (err instanceof UnauthorizedError) {
                slots.actions.next({
                  action: id,
                  options,
                  event: "aborted:login-required",
                });
              } else {
                slots.actions.next({
                  action: id,
                  options,
                  event: "aborted:server-error",
                });
                captureException(err, {
                  user: { id: user?.id },
                  extra: {
                    action: id,
                    session: AIProvider.LAST_ACTION_SESSIONID,
                  },
                });
              }
              throw err;
            }
          },
        };
      } else {
        let user: any = null;
        return result
          .then(async (result) => {
            options.signal?.throwIfAborted();
            user = await AIProvider.userInfo;
            slots.actions.next({
              action: id,
              options,
              event: "finished",
            });
            return result;
          })
          .catch((err) => {
            if (options.signal?.aborted) {
              slots.actions.next({
                action: id,
                options,
                event: "aborted:stop",
              });
              throw err;
            }
            slots.actions.next({
              action: id,
              options,
              event: "error",
            });
            slots.actions.next({
              action: id,
              options,
              event: "aborted:server-error",
            });
            captureException(err, {
              user: { id: user?.id },
              extra: {
                action: id,
                session: AIProvider.LAST_ACTION_SESSIONID,
              },
            });
            throw err;
          });
      }
    };
  }

  static provide(
    id: "userInfo",
    fn: () => AIUserInfo | Promise<AIUserInfo> | null,
  ): void;

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

  static provide(
    id: "forkChat",
    fn: (
      options: VirgultumPresets.AIForkChatSessionOptions,
    ) => string | Promise<string>,
  ): void;

  static provide(id: "onboarding", fn: (value: boolean) => void): void;

  static provide(
    id: "embedding",
    service: VirgultumPresets.AIEmbeddingService,
  ): void;

  // actions:
  static provide<T extends keyof VirgultumPresets.AIActions>(
    id: T,
    action: (
      ...options: Parameters<VirgultumPresets.AIActions[T]>
    ) => Promise<ReturnType<VirgultumPresets.AIActions[T]>>,
  ): void;

  static provide(id: unknown, action: unknown) {
    if (id === "userInfo") {
      AIProvider.instance.userInfoFn = action as () => AIUserInfo;
    } else if (id === "histories") {
      AIProvider.instance.histories =
        action as VirgultumPresets.AIHistoryService;
    } else if (id === "session") {
      AIProvider.instance.session = action as VirgultumPresets.AISessionService;
      AIProvider.instance.slots.sessionReady.next(true);
    } else if (id === "context") {
      AIProvider.instance.context = action as VirgultumPresets.AIContextService;
    } else if (id === "photoEngine") {
      AIProvider.instance.photoEngine =
        action as VirgultumPresets.AIPhotoEngineService;
    } else if (id === "forkChat") {
      AIProvider.instance.forkChat = action as (
        options: VirgultumPresets.AIForkChatSessionOptions,
      ) => string | Promise<string>;
    } else if (id === "embedding") {
      AIProvider.instance.embedding =
        action as VirgultumPresets.AIEmbeddingService;
    } else {
      AIProvider.instance.provideAction(id as any, action as any);
    }
  }
}
