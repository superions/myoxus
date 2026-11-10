// SPDX-License-Identifier: AGPL-3.0-or-later

import { waitForTaskReferenceOperation } from "../tasks/task-reference-operation";
import {
  databaseTaskReferencesQuery,
  type DatabaseTaskReferenceFragment,
} from "@myoxus/graphql";
import type { FrameworkProvider } from "@myoxus/infra";
import { subscribeTaskFreshness } from "../tasks/use-task-freshness";
import type { useTaskIdentity } from "../tasks/use-workspace-tasks";
import type { TaskReferenceTarget } from "../tasks/task-reference-insertion";

type Owner = ReturnType<typeof useTaskIdentity>;
export type TaskReferenceRead =
  | { status: "loading" | "offline" | "unavailable" }
  | { status: "ready"; reference: DatabaseTaskReferenceFragment };
const loading: TaskReferenceRead = { status: "loading" };
const offline: TaskReferenceRead = { status: "offline" };
const unavailable: TaskReferenceRead = { status: "unavailable" };
const managers = new WeakMap<FrameworkProvider, TaskReferenceBatch>();
const keyOf = (target: TaskReferenceTarget) =>
  JSON.stringify([target.workspaceId, target.databaseId, target.rowId]);

/** One active document batches unique scoped targets. Last disposal releases
 * hints and cached private projections; generation fences every delayed read.
 */
export class TaskReferenceBatch {
  private owner?: Owner;
  private generation = 0;
  private entries = new Map<
    string,
    {
      target: TaskReferenceTarget;
      state: TaskReferenceRead;
      listeners: Set<() => void>;
    }
  >();
  private stopFreshness?: () => void;
  private queued = false;
  private running?: { controller: AbortController };
  private again = false;
  private current(owner: Owner) {
    return Boolean(
      owner.identity &&
      owner.server &&
      owner.availability.status === "available" &&
      JSON.stringify([
        owner.server.id,
        owner.server.baseUrl,
        owner.server.account$.value?.id,
        owner.workspace.id,
      ]) === owner.identity,
    );
  }
  snapshot(owner: Owner, target: TaskReferenceTarget): TaskReferenceRead {
    if (!this.current(owner)) return unavailable;
    if (owner.identity !== this.owner?.identity) return loading;
    return this.entries.get(keyOf(target))?.state ?? loading;
  }
  attach(owner: Owner, target: TaskReferenceTarget, listener: () => void) {
    if (!this.current(owner)) return () => {};
    if (this.owner?.identity !== owner.identity) {
      this.stopFreshness?.();
      this.stopFreshness = undefined;
      this.running?.controller.abort();
      this.running = undefined;
      this.again = false;
      this.generation++;
      for (const entry of this.entries.values()) {
        entry.state = unavailable;
        for (const notify of entry.listeners) notify();
      }
      this.entries.clear();
      this.owner = owner;
    }
    const key = keyOf(target);
    let entry = this.entries.get(key);
    const added = !entry;
    if (!entry) {
      entry = { target, state: loading, listeners: new Set() };
      this.entries.set(key, entry);
    }
    entry.listeners.add(listener);
    if (!this.stopFreshness) {
      // Browser offline can leave an existing WebSocket connected. Its status
      // cannot authorize retaining private HTTP projections across that boundary.
      const disconnected = () => this.clear(offline);
      const reconnected = () => this.schedule();
      window.addEventListener("offline", disconnected);
      window.addEventListener("online", reconnected);
      const stop = subscribeTaskFreshness(
        owner,
        () => this.refresh(),
        (live) => {
          if (!live) this.clear(offline);
        },
      );
      this.stopFreshness = () => {
        window.removeEventListener("offline", disconnected);
        window.removeEventListener("online", reconnected);
        stop();
      };
    }
    if (added) this.schedule();
    const owned = entry;
    return () => {
      owned.listeners.delete(listener);
      if (!owned.listeners.size && this.entries.get(key) === owned)
        this.entries.delete(key);
      if (!this.entries.size) {
        this.stopFreshness?.();
        this.stopFreshness = undefined;
        this.running?.controller.abort();
        this.running = undefined;
        this.again = false;
        this.owner = undefined;
        this.generation++;
      }
    };
  }
  private clear(state: TaskReferenceRead) {
    if (state.status === "offline") {
      this.running?.controller.abort();
      this.running = undefined;
      this.again = false;
    }
    this.generation++;
    for (const entry of this.entries.values()) {
      entry.state = state;
      for (const notify of entry.listeners) notify();
    }
  }
  private schedule() {
    if (this.queued) return;
    this.queued = true;
    queueMicrotask(() => {
      this.queued = false;
      void this.refresh();
    });
  }
  async refresh() {
    const owner = this.owner;
    if (!owner || !this.current(owner) || !this.entries.size) return;
    if (!navigator.onLine) {
      this.clear(offline);
      return;
    }
    if (this.running) {
      this.again = true;
      return;
    }
    const running = { controller: new AbortController() };
    const signal = AbortSignal.any([
      running.controller.signal,
      AbortSignal.timeout(10_000),
    ]);
    this.running = running;
    // Same-actor refreshes must retain mounted native editors and their drafts.
    // Actor changes, disconnects and rejected reads still clear private state.
    const generation = ++this.generation;
    const entries = [...this.entries.entries()];
    try {
      for (let offset = 0; offset < entries.length; offset += 500) {
        const chunk = entries.slice(offset, offset + 500);
        const response = await waitForTaskReferenceOperation(
          owner.server!.gql({
            query: databaseTaskReferencesQuery,
            variables: {
              workspaceId: owner.workspace.id,
              targets: chunk.map(([, entry]) => entry.target),
            },
            context: { signal },
          }),
          signal,
        );
        if (
          generation !== this.generation ||
          this.owner !== owner ||
          !this.current(owner)
        )
          return;
        const references = response.workspace?.databaseTaskReferences;
        if (!references || references.length !== chunk.length)
          throw new Error("Task reference read incomplete");
        if (
          chunk.some(
            ([, entry], index) =>
              !references[index] ||
              references[index].workspaceId !== entry.target.workspaceId ||
              references[index].rowId !== entry.target.rowId ||
              (references[index].task &&
                (references[index].task!.workspaceId !==
                  entry.target.workspaceId ||
                  references[index].task!.rowId !== entry.target.rowId ||
                  references[index].task!.databaseId !==
                    references[index].databaseId)),
          )
        )
          throw new Error("Task reference scope mismatch");
        chunk.forEach(([key, entry], index) => {
          const reference = references[index];
          if (this.entries.get(key) !== entry) return;
          entry.state = { status: "ready", reference };
          for (const notify of entry.listeners) notify();
        });
      }
    } catch {
      if (generation === this.generation && this.owner === owner)
        this.clear(unavailable);
    } finally {
      if (this.running === running) {
        this.running = undefined;
        if (this.again) {
          this.again = false;
          this.schedule();
        }
      }
    }
  }
}
export function taskReferenceBatch(framework: FrameworkProvider) {
  let manager = managers.get(framework);
  if (!manager) {
    manager = new TaskReferenceBatch();
    managers.set(framework, manager);
  }
  return manager;
}
