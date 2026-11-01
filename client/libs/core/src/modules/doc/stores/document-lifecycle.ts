// SPDX-License-Identifier: AGPL-3.0-or-later

import { LiveData, Store } from "@myoxus/infra";
import { Subject } from "rxjs";

export type DocumentLifecycleState = "available" | "creating" | "not-found";
export type DocumentLifecycleResetSource = "created" | "membership";

type DocumentLifecycle = {
  controller: AbortController;
  state$: LiveData<DocumentLifecycleState>;
};

const TERMINAL_ABORT_REASON = new Error("Document lifecycle is not available");
const CREATING_ABORT_REASON = new Error(
  "Document lifecycle is awaiting initial server sync",
);

/**
 * Workspace-owned request generation for server-backed document consumers.
 *
 * `creating` and `not-found` both expose aborted signals, but for different
 * reasons: creation prevents metadata/comments/graph from racing the first
 * durable leaf push, while not-found is terminal for the current generation.
 * Only confirmed create or new membership may install an available generation;
 * route mounts, focus, reconnect and retry callbacks must remain read-only.
 */
export class DocumentLifecycleStore extends Store {
  private readonly lifecycles = new Map<string, DocumentLifecycle>();
  private readonly notFoundSubject = new Subject<string>();
  readonly notFound$ = this.notFoundSubject.asObservable();

  state(docId: string): DocumentLifecycleState {
    return this.lifecycle(docId).state$.value;
  }

  state$(docId: string): LiveData<DocumentLifecycleState> {
    return this.lifecycle(docId).state$;
  }

  signal(docId: string): AbortSignal {
    return this.lifecycle(docId).controller.signal;
  }

  requestSignal(docId: string, attemptSignal?: AbortSignal): AbortSignal {
    const lifecycleSignal = this.signal(docId);
    lifecycleSignal.throwIfAborted();
    return attemptSignal
      ? AbortSignal.any([lifecycleSignal, attemptSignal])
      : lifecycleSignal;
  }

  async waitUntilAvailable(
    docId: string,
    attemptSignal?: AbortSignal,
  ): Promise<AbortSignal> {
    attemptSignal?.throwIfAborted();
    await this.state$(docId).waitFor(
      (state) => state !== "creating",
      attemptSignal,
    );
    attemptSignal?.throwIfAborted();
    return this.requestSignal(docId, attemptSignal);
  }

  isAvailable(docId: string): boolean {
    return this.state(docId) === "available";
  }

  markNotFound(docId: string): boolean {
    const lifecycle = this.lifecycle(docId);
    if (lifecycle.state$.value === "not-found") {
      return false;
    }
    lifecycle.controller.abort(TERMINAL_ABORT_REASON);
    const controller = new AbortController();
    controller.abort(TERMINAL_ABORT_REASON);
    this.lifecycles.set(docId, {
      controller,
      state$: lifecycle.state$,
    });
    lifecycle.state$.setValue("not-found");
    this.notFoundSubject.next(docId);
    return true;
  }

  beginCreating(docId: string): boolean {
    const current = this.lifecycle(docId);
    if (current.state$.value === "creating") {
      return false;
    }
    current.controller.abort(CREATING_ABORT_REASON);
    const controller = new AbortController();
    controller.abort(CREATING_ABORT_REASON);
    this.lifecycles.set(docId, {
      controller,
      state$: current.state$,
    });
    current.state$.setValue("creating");
    return true;
  }

  beginAvailableLifecycle(
    docId: string,
    _source: DocumentLifecycleResetSource,
  ): boolean {
    const current = this.lifecycle(docId);
    if (current.state$.value === "available") {
      return false;
    }
    this.lifecycles.set(docId, {
      controller: new AbortController(),
      state$: current.state$,
    });
    current.state$.setValue("available");
    return true;
  }

  override dispose(): void {
    for (const lifecycle of this.lifecycles.values()) {
      lifecycle.controller.abort(TERMINAL_ABORT_REASON);
      lifecycle.state$.complete();
    }
    this.lifecycles.clear();
    this.notFoundSubject.complete();
    super.dispose();
  }

  private lifecycle(docId: string): DocumentLifecycle {
    let lifecycle = this.lifecycles.get(docId);
    if (!lifecycle) {
      lifecycle = {
        controller: new AbortController(),
        state$: new LiveData<DocumentLifecycleState>("available"),
      };
      this.lifecycles.set(docId, lifecycle);
    }
    return lifecycle;
  }
}
