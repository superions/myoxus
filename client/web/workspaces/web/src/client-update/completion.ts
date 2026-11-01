// SPDX-License-Identifier: AGPL-3.0-or-later

import type { ClientUpdateGateSnapshot } from "@myoxus/storage";
import {
  readAppliedClientUpdateState,
  updateAppliedClientUpdateState,
} from "@myoxus/storage/cloud";

import type { ControllerReloadCoordinator } from "../service-worker-update";
import {
  resetClientUpdateCacheResetStore,
  resetRegisteredCloudCaches,
} from "./cache-reset";

export interface ClientUpdateCompletionSource {
  getSnapshot(): ClientUpdateGateSnapshot;
  subscribe(listener: () => void): () => void;
}

interface CompletionCoordinatorOptions {
  source: ClientUpdateCompletionSource;
  endpoint: string;
  reload: ControllerReloadCoordinator;
  updateServiceWorker(requiredBuildId: string | null): Promise<void>;
  getCurrentBuildId(): Promise<string | null>;
  onError?(error: unknown): void;
}

/**
 * Applies server completion markers once per page runtime while retaining one
 * endpoint-scoped recovery record across restarts. A locally observed
 * operation remains eligible in every open tab even when another tab updates
 * the shared applied marker first.
 */
export function startClientUpdateCompletionCoordinator({
  source,
  endpoint,
  reload,
  updateServiceWorker,
  getCurrentBuildId,
  onError = (error) =>
    console.warn("Client update completion could not be applied", error),
}: CompletionCoordinatorOptions): () => void {
  let stopped = false;
  let locallyObservedOperationId: string | null = null;
  const handledCompletions = new Set<string>();
  const abort = new AbortController();
  let reconcileQueue = Promise.resolve();

  const reconcile = async (snapshot: ClientUpdateGateSnapshot) => {
    if (stopped) return;
    if (snapshot.status !== "ready") {
      reload.setReloadBlocked(true);
      return;
    }

    const { control } = snapshot;
    if (control.phase !== "normal") {
      reload.setReloadBlocked(true);
      locallyObservedOperationId = control.operationId;
      if (control.operationId) {
        await updateAppliedClientUpdateState(endpoint, (current) => ({
          ...current,
          observedOperationId: control.operationId,
        }));
      }
      return;
    }

    const completion = control.completion;
    const state = await readAppliedClientUpdateState(endpoint);
    const resetEpoch =
      state.resetInProgressEpoch ??
      (control.cacheEpoch > state.appliedCacheEpoch
        ? control.cacheEpoch
        : null);
    if (resetEpoch !== null) {
      const resetKey = `cache:${resetEpoch}`;
      if (handledCompletions.has(resetKey)) return;
      handledCompletions.add(resetKey);
      reload.setReloadBlocked(true);
      await updateAppliedClientUpdateState(endpoint, (current) => ({
        ...current,
        resetInProgressEpoch: resetEpoch,
      }));
      try {
        await resetRegisteredCloudCaches(endpoint, abort.signal);
        await updateAppliedClientUpdateState(endpoint, (current) => ({
          ...current,
          appliedCacheEpoch: resetEpoch,
          resetInProgressEpoch: null,
          appliedCompletionOperationId:
            completion?.operationId ?? current.appliedCompletionOperationId,
        }));
        reload.setReloadBlocked(false);
        reload.requestReload();
      } catch (error) {
        handledCompletions.delete(resetKey);
        throw error;
      }
      return;
    }

    if (!completion) {
      reload.setReloadBlocked(false);
      return;
    }

    if (completion.action === "none") {
      if (state.appliedCompletionOperationId !== completion.operationId) {
        await updateAppliedClientUpdateState(endpoint, (current) => ({
          ...current,
          appliedCompletionOperationId: completion.operationId,
        }));
      }
      reload.setReloadBlocked(false);
      return;
    }

    const currentBuildId = control.requiredWebBuildId
      ? await getCurrentBuildId()
      : null;
    const buildMismatch =
      control.requiredWebBuildId !== null &&
      currentBuildId !== control.requiredWebBuildId;
    const observedInThisRuntime =
      locallyObservedOperationId === completion.operationId;
    const eligible =
      observedInThisRuntime ||
      state.observedOperationId === completion.operationId ||
      buildMismatch;
    if (
      !eligible ||
      handledCompletions.has(completion.operationId) ||
      (state.appliedCompletionOperationId === completion.operationId &&
        !observedInThisRuntime &&
        !buildMismatch)
    ) {
      reload.setReloadBlocked(false);
      return;
    }

    // Keep a controllerchange pending until the durable marker is committed.
    // Otherwise the new page could observe the same completion and loop.
    reload.setReloadBlocked(true);
    handledCompletions.add(completion.operationId);
    try {
      await updateServiceWorker(control.requiredWebBuildId);
      await updateAppliedClientUpdateState(endpoint, (current) => ({
        ...current,
        appliedCompletionOperationId: completion.operationId,
      }));
      reload.setReloadBlocked(false);
      reload.requestReload();
    } catch (error) {
      handledCompletions.delete(completion.operationId);
      throw error;
    }
  };

  const scheduleReconcile = () => {
    const snapshot = source.getSnapshot();
    reconcileQueue = reconcileQueue
      .then(() => reconcile(snapshot))
      .catch(onError);
  };

  const unsubscribe = source.subscribe(scheduleReconcile);
  scheduleReconcile();

  return () => {
    stopped = true;
    abort.abort(new Error("Client update completion stopped"));
    resetClientUpdateCacheResetStore();
    unsubscribe();
  };
}
