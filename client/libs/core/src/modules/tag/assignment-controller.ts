// SPDX-License-Identifier: AGPL-3.0-or-later

import { LiveData } from "@myoxus/infra";

export type WorkspaceTagAssignmentCommit = (
  nextIds: string[],
) => string[] | void | Promise<string[] | void>;

export type WorkspaceTagAssignmentState = {
  confirmedIds: string[];
  projectedIds: string[];
  status: "idle" | "saving" | "error";
  failedTargetIds: string[] | null;
  error: unknown | null;
};

function orderedUnique(ids: readonly string[]) {
  return Array.from(new Set(ids));
}

function sameIds(left: readonly string[], right: readonly string[]) {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

/**
 * Serializes full-value tag assignments without owning persistence.
 *
 * A projected value may advance while a commit is in flight. Only the latest
 * queued target is committed next, while confirmed values move exclusively
 * after an adapter acknowledgement or an external authoritative update.
 */
export class WorkspaceTagAssignmentController {
  private readonly mutableState$: LiveData<WorkspaceTagAssignmentState>;
  readonly state$: LiveData<WorkspaceTagAssignmentState>;

  private queuedTargetIds: string[] | null = null;
  private cyclePromise: Promise<void> | null = null;
  private resolveCycle: (() => void) | null = null;

  constructor(
    confirmedIds: readonly string[],
    private readonly commit: WorkspaceTagAssignmentCommit,
  ) {
    const normalized = orderedUnique(confirmedIds);
    this.mutableState$ = new LiveData<WorkspaceTagAssignmentState>({
      confirmedIds: normalized,
      projectedIds: normalized,
      status: "idle",
      failedTargetIds: null,
      error: null,
    });
    this.state$ = this.mutableState$.map((state) => state);
  }

  replace(nextIds: readonly string[]) {
    if (this.mutableState$.value.status === "error") {
      return;
    }
    const target = orderedUnique(nextIds);
    if (sameIds(target, this.mutableState$.value.projectedIds)) {
      return;
    }
    this.queuedTargetIds = target;
    this.mutableState$.next({
      ...this.mutableState$.value,
      projectedIds: target,
      status: "saving",
      failedTargetIds: null,
      error: null,
    });
    this.scheduleDrain();
  }

  select(id: string) {
    if (this.mutableState$.value.projectedIds.includes(id)) {
      return;
    }
    this.replace([...this.mutableState$.value.projectedIds, id]);
  }

  deselect(id: string) {
    this.replace(
      this.mutableState$.value.projectedIds.filter(
        (candidate) => candidate !== id,
      ),
    );
  }

  /**
   * Reconciles an external authoritative value. While saving, it becomes the
   * newest rollback baseline without replacing the local projected target.
   */
  setConfirmedIds(ids: readonly string[]) {
    const confirmedIds = orderedUnique(ids);
    const state = this.mutableState$.value;
    this.mutableState$.next({
      ...state,
      confirmedIds,
      projectedIds:
        state.status === "saving" ? state.projectedIds : confirmedIds,
    });
  }

  retry() {
    const state = this.mutableState$.value;
    if (state.status !== "error" || !state.failedTargetIds) {
      return;
    }
    const target = [...state.failedTargetIds];
    this.queuedTargetIds = target;
    this.mutableState$.next({
      ...state,
      projectedIds: target,
      status: "saving",
      error: null,
    });
    this.scheduleDrain();
  }

  async flush() {
    while (this.cyclePromise) {
      await this.cyclePromise;
    }
    const state = this.mutableState$.value;
    if (state.status === "error") {
      throw state.error;
    }
    return [...state.confirmedIds];
  }

  private scheduleDrain() {
    if (this.cyclePromise) {
      return;
    }
    this.cyclePromise = new Promise<void>((resolve) => {
      this.resolveCycle = resolve;
    });
    queueMicrotask(() => {
      void this.drain();
    });
  }

  private async drain() {
    try {
      while (this.queuedTargetIds) {
        const target = this.queuedTargetIds;
        this.queuedTargetIds = null;
        try {
          const response = await this.commit([...target]);
          const confirmedIds = orderedUnique(response ?? target);
          if (
            this.queuedTargetIds &&
            sameIds(this.queuedTargetIds, confirmedIds)
          ) {
            this.queuedTargetIds = null;
          }
          this.mutableState$.next({
            confirmedIds,
            projectedIds: this.queuedTargetIds
              ? this.mutableState$.value.projectedIds
              : confirmedIds,
            status: this.queuedTargetIds ? "saving" : "idle",
            failedTargetIds: null,
            error: null,
          });
        } catch (error) {
          const state = this.mutableState$.value;
          const failedTargetIds = [...state.projectedIds];
          this.queuedTargetIds = null;
          this.mutableState$.next({
            confirmedIds: state.confirmedIds,
            projectedIds: state.confirmedIds,
            status: "error",
            failedTargetIds,
            error,
          });
        }
      }
    } finally {
      this.resolveCycle?.();
      this.resolveCycle = null;
      this.cyclePromise = null;
      if (this.queuedTargetIds) {
        this.scheduleDrain();
      }
    }
  }
}
