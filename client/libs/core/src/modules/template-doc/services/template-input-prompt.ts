// SPDX-License-Identifier: AGPL-3.0-or-later

import { I18n } from "@myoxus/i18n";
import { LiveData, Service } from "@myoxus/infra";
import type { WorkspaceDialogService } from "../../dialogs";
import { templateFailureMessages } from "./template-application";
import {
  TemplateInstantiationError,
  waitForTemplateOperation,
} from "./template-instantiation-error";
import {
  normalizeTemplateInputs,
  type RequestTemplateInputs,
  type TemplateInputValues,
} from "./template-inputs";

export interface TemplateInputPromptState {
  names: readonly string[];
  busy: boolean;
  blocked?: boolean;
  error?: string;
}
export interface TemplateInputPrompt {
  state$: LiveData<TemplateInputPromptState>;
  submit: (values: TemplateInputValues) => void;
}

/** One ephemeral dialog per application; nothing is stored across operations. */
export class TemplateInputPromptService extends Service {
  private readonly lifetime = new AbortController();
  constructor(private readonly dialogs: WorkspaceDialogService) {
    super();
  }
  override dispose() {
    this.lifetime.abort(new TemplateInstantiationError("cancelled"));
    super.dispose();
  }

  async run<T>(
    operation: (
      request: RequestTemplateInputs,
      signal: AbortSignal,
    ) => Promise<T>,
    options?: {
      canRetry: (error: unknown) => boolean;
      propagateError?: (error: unknown) => boolean;
      uncertainMessage: string;
      signal?: AbortSignal;
    },
  ): Promise<T> {
    const abort = new AbortController();
    const signal = AbortSignal.any([
      abort.signal,
      this.lifetime.signal,
      ...(options?.signal ? [options.signal] : []),
    ]);
    let id: string | undefined;
    let fatalError: unknown;
    let answers: TemplateInputValues = {};
    let resolve: ((values: TemplateInputValues) => void) | undefined;
    const state$ = new LiveData<TemplateInputPromptState>({
      names: [],
      busy: false,
    });
    const next = (names: readonly string[], error?: string) => {
      // Install the next waiter before enabling Submit: retries are deliberate.
      const pending = new Promise<TemplateInputValues>((done) => {
        resolve = done;
      });
      state$.setValue({ names, busy: false, error });
      return waitForTemplateOperation(pending, signal);
    };
    const request: RequestTemplateInputs = async (names, attemptSignal) => {
      try {
        return normalizeTemplateInputs(names, answers);
      } catch {
        /* Missing values need this operation's dialog. */
      }
      if (!id) {
        id = this.dialogs.open(
          "template-inputs",
          {
            prompt: {
              state$,
              submit: (values) => {
                if (state$.value.busy || state$.value.blocked || !resolve)
                  return;
                const normalized = normalizeTemplateInputs(
                  state$.value.names,
                  values,
                );
                const done = resolve;
                resolve = undefined;
                answers = normalized;
                state$.setValue({
                  ...state$.value,
                  busy: true,
                  error: undefined,
                });
                done(normalized);
              },
            },
          },
          () =>
            abort.abort(
              fatalError ?? new TemplateInstantiationError("cancelled"),
            ),
        );
      }
      return await waitForTemplateOperation(next(names), attemptSignal);
    };
    try {
      for (;;) {
        signal.throwIfAborted();
        try {
          return await operation(request, signal);
        } catch (error) {
          signal.throwIfAborted();
          if (
            !id ||
            // Known rejections of caller-owned values must return to that draft,
            // not ask for new template answers or claim a lost write receipt.
            options?.propagateError?.(error) ||
            (error instanceof TemplateInstantiationError &&
              ["rollback-failed", "cancelled"].includes(error.reason))
          )
            throw error;
          // A lost write receipt must never turn this dialog into a replay loop.
          // Keep the answers visible until Close returns the error to the owner.
          if (options && !options.canRetry(error)) {
            fatalError = error;
            state$.setValue({
              ...state$.value,
              busy: false,
              blocked: true,
              error: options.uncertainMessage,
            });
            await waitForTemplateOperation(
              new Promise<never>(() => {}),
              signal,
            );
          }
          answers = await next(
            state$.value.names,
            error instanceof TemplateInstantiationError
              ? I18n[templateFailureMessages[error.reason]]()
              : I18n["com.myoxus.template-application.error.failed"](),
          );
        }
      }
    } finally {
      resolve = undefined;
      if (id) this.dialogs.close(id);
    }
  }
}
