// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  type AssistanceMode,
  type SaveAssistantSetupInput,
} from "@myoxus/graphql";
import { LiveData, OnEvent, Service } from "@myoxus/infra";
import { isEqual } from "lodash-es";
import type { Subscription } from "rxjs";

import { ApplicationFocused } from "../../lifecycle";
import { ServerStarted } from "../events/server-started";
import type {
  CachedUserPreferences,
  ConfirmedAssistance,
  EffectiveUserPreferenceValues,
  UpdateUserPreferencesInput,
  UserPreferences,
  UserPreferencesStore,
  WorkbenchToolLayout,
  WorkbenchToolLayoutsProjection,
  WorkbenchViewFamily,
  WorkspaceDashboardLayout,
  WorkspaceDashboardLayoutsProjection,
} from "../stores/user-preferences";
import {
  fromGraphQLWorkbenchToolLayouts,
  fromGraphQLWorkspaceDashboardLayouts,
  toGraphQLWorkbenchToolLayouts,
  toGraphQLWorkspaceDashboardLayouts,
} from "../stores/user-preferences";
import type { AuthService } from "./auth";
import type { ServerService } from "./server";

export type {
  EffectiveUserPreferenceValues,
  UpdateUserPreferencesInput,
  UserPreferences,
  UserPreferenceValues,
  WorkbenchToolId,
  WorkbenchToolLayout,
  WorkbenchToolLayoutsProjection,
  WorkbenchViewFamily,
  WorkspaceDashboardDashletId,
  WorkspaceDashboardDashletSize,
  WorkspaceDashboardLayout,
  WorkspaceDashboardLayoutsProjection,
} from "../stores/user-preferences";

type Scope = { serverId: string; userId: string };

const hasPatch = (patch: UpdateUserPreferencesInput) =>
  Object.keys(patch).length > 0;

const projectEffectiveValues = (
  confirmed: EffectiveUserPreferenceValues,
  patch: UpdateUserPreferencesInput,
): EffectiveUserPreferenceValues => {
  const projected = { ...confirmed };
  for (const [key, value] of Object.entries(patch)) {
    if (
      value !== undefined &&
      (value !== null ||
        key === "workbenchToolLayouts" ||
        key === "workspaceDashboardLayouts" ||
        key === "templateCatalogViews") &&
      key in projected
    ) {
      (projected as Record<string, unknown>)[key] = value;
    }
  }
  return projected;
};

const mergePending = (
  pending: UpdateUserPreferencesInput,
  patch: UpdateUserPreferencesInput,
) => ({ ...pending, ...patch });

const remainingPending = (
  current: UpdateUserPreferencesInput,
  acknowledged: UpdateUserPreferencesInput,
) => {
  const remaining: UpdateUserPreferencesInput = {};
  for (const [key, value] of Object.entries(current)) {
    if (
      !(key in acknowledged) ||
      !isEqual(acknowledged[key as keyof typeof acknowledged], value)
    ) {
      (remaining as Record<string, unknown>)[key] = value;
    }
  }
  return remaining;
};

/**
 * Single client boundary for account preferences.
 *
 * Cache writes happen before network writes. A failed request therefore keeps
 * one merged pending patch and reconnect sends it again. The patch is removed
 * only after the server returns the acknowledged aggregate. Settings that
 * require confirmed saves may request rollback of only their failed keys.
 * Assistance uses its explicit acknowledged channel and is never queued for
 * offline replay; contextual inheritance always comes from the native server.
 */
@OnEvent(ApplicationFocused, (service) => service.revalidate)
@OnEvent(ServerStarted, (service) => service.revalidate)
export class UserPreferencesService extends Service {
  userPreferences$ = new LiveData<UserPreferences | undefined>(undefined);
  readonly assistanceRevision$ = new LiveData(0);
  readonly preferenceIdentity$ = new LiveData<string | null>(null);
  readonly confirmedPreferences$ = new LiveData<UserPreferences | undefined>(
    undefined,
  );
  workbenchToolLayouts$ = new LiveData<WorkbenchToolLayoutsProjection>({
    confirmed: null,
    projected: null,
    syncStatus: "confirmed",
  });
  workspaceDashboardLayouts$ =
    new LiveData<WorkspaceDashboardLayoutsProjection>({
      confirmed: null,
      projected: null,
      syncStatus: "confirmed",
    });
  isLoading$ = new LiveData(false);
  isSyncing$ = new LiveData(false);
  error$ = new LiveData<unknown | undefined>(undefined);

  private scope: Scope | null = null;
  private syncPromise: Promise<void> | null = null;
  private syncScopeKey: string | null = null;
  private syncIsAssistance = false;
  private readonly accountSubscription: Subscription;
  private cacheSubscription: Subscription | undefined;
  private assistanceCacheStamp: string | undefined;

  constructor(
    private readonly store: UserPreferencesStore,
    private readonly authService: AuthService,
    private readonly serverService: ServerService,
  ) {
    super();
    this.accountSubscription = this.authService.session.account$.subscribe(
      (account) => {
        this.cacheSubscription?.unsubscribe();
        // Profile refreshes keep the owner epoch; logout/account changes do not.
        this.scope = account
          ? this.scope?.userId === account.id &&
            this.scope.serverId === this.serverService.server.id
            ? this.scope
            : { serverId: this.serverService.server.id, userId: account.id }
          : null;
        // Electron frames share this cache. Observe its existing IPC-backed
        // channel so Shell and inactive tabs repaint confirmed/pending settings
        // without writing them back or starting another network sync.
        this.cacheSubscription = this.scope
          ? this.store
              .watchCached(this.scope.serverId, this.scope.userId)
              .subscribe(() => this.publish())
          : undefined;
        this.publish();
        if (account) void this.revalidate();
      },
    );
  }

  private readCached() {
    if (!this.scope) return undefined;
    return this.store.getCached(this.scope.serverId, this.scope.userId);
  }

  private writeCached(value: CachedUserPreferences) {
    if (!this.scope) return;
    this.store.setCached(this.scope.serverId, this.scope.userId, value);
  }

  private readCachedProjection(): UserPreferences | undefined {
    const cached = this.readCached();
    if (!cached) return undefined;
    return {
      values: {
        ...cached.confirmedValues,
        ...cached.pendingPatch,
        // Assistance patches are native per-key updates, never offline
        // aggregate projections or optimistic eligibility.
        assistanceMode: cached.confirmedValues.assistanceMode,
        workspaceAssistanceOverrides:
          cached.confirmedValues.workspaceAssistanceOverrides,
        projectAssistanceOverrides:
          cached.confirmedValues.projectAssistanceOverrides,
      },
      effectiveValues: projectEffectiveValues(
        cached.confirmedEffectiveValues,
        cached.pendingPatch,
      ),
      updatedAt: cached.confirmedUpdatedAt,
    };
  }

  private publish() {
    this.preferenceIdentity$.value = this.scope
      ? JSON.stringify([this.scope.serverId, this.scope.userId])
      : null;
    this.userPreferences$.value = this.readCachedProjection();
    const cached = this.readCached();
    // IPC/cache updates invalidate contextual reads without projecting an
    // optimistic mode or reproducing native inheritance in another frame.
    const assistanceStamp = JSON.stringify([
      this.preferenceIdentity$.value,
      cached?.confirmedUpdatedAt,
      cached?.confirmedValues.assistanceMode,
      cached?.confirmedValues.workspaceAssistanceOverrides,
      cached?.confirmedValues.projectAssistanceOverrides,
    ]);
    if (assistanceStamp !== this.assistanceCacheStamp) {
      this.assistanceCacheStamp = assistanceStamp;
      this.assistanceRevision$.value += 1;
    }
    this.confirmedPreferences$.value = cached
      ? {
          values: cached.confirmedValues,
          effectiveValues: cached.confirmedEffectiveValues,
          updatedAt: cached.confirmedUpdatedAt,
        }
      : undefined;
    const confirmed = fromGraphQLWorkbenchToolLayouts(
      cached?.confirmedValues.workbenchToolLayouts ?? null,
    );
    const hasPendingLayouts = Boolean(
      cached &&
      Object.prototype.hasOwnProperty.call(
        cached.pendingPatch,
        "workbenchToolLayouts",
      ),
    );
    const pendingLayouts = cached?.pendingPatch.workbenchToolLayouts;
    this.workbenchToolLayouts$.value = {
      confirmed,
      projected: hasPendingLayouts
        ? pendingLayouts === null || pendingLayouts === undefined
          ? null
          : fromGraphQLWorkbenchToolLayouts(pendingLayouts)
        : confirmed,
      syncStatus: hasPendingLayouts ? "pending" : "confirmed",
    };
    const confirmedDashboard = fromGraphQLWorkspaceDashboardLayouts(
      cached?.confirmedValues.workspaceDashboardLayouts ?? null,
    );
    const hasPendingDashboard = Boolean(
      cached &&
      Object.prototype.hasOwnProperty.call(
        cached.pendingPatch,
        "workspaceDashboardLayouts",
      ),
    );
    const pendingDashboard = cached?.pendingPatch.workspaceDashboardLayouts;
    this.workspaceDashboardLayouts$.value = {
      confirmed: confirmedDashboard,
      projected: hasPendingDashboard
        ? pendingDashboard === null || pendingDashboard === undefined
          ? null
          : fromGraphQLWorkspaceDashboardLayouts(pendingDashboard)
        : confirmedDashboard,
      syncStatus: hasPendingDashboard ? "pending" : "confirmed",
    };
  }

  /** Return the projected override for one Workspace/view scope. */
  getWorkbenchToolLayout(workspaceId: string, viewFamily: WorkbenchViewFamily) {
    return (
      this.workbenchToolLayouts$.value.projected?.find(
        (layout) =>
          layout.workspaceId === workspaceId &&
          layout.viewFamily === viewFamily,
      ) ?? null
    );
  }

  /**
   * Replace or remove one scoped override through the existing offline queue.
   * Product defaults remain outside this service and are never persisted.
   */
  async updateWorkbenchToolLayout(layout: WorkbenchToolLayout) {
    const current = this.workbenchToolLayouts$.value.projected ?? [];
    const next = current.filter(
      (candidate) =>
        candidate.workspaceId !== layout.workspaceId ||
        candidate.viewFamily !== layout.viewFamily,
    );
    next.push(layout);
    await this.update({
      workbenchToolLayouts: toGraphQLWorkbenchToolLayouts(next),
    });
  }

  async resetWorkbenchToolLayout(
    workspaceId: string,
    viewFamily: WorkbenchViewFamily,
  ) {
    const current = this.workbenchToolLayouts$.value.projected ?? [];
    const next = current.filter(
      (layout) =>
        layout.workspaceId !== workspaceId || layout.viewFamily !== viewFamily,
    );
    await this.update({
      workbenchToolLayouts:
        next.length > 0 ? toGraphQLWorkbenchToolLayouts(next) : null,
    });
  }

  /** Return the projected personal Dashboard override for one Workspace. */
  getWorkspaceDashboardLayout(workspaceId: string) {
    return (
      this.workspaceDashboardLayouts$.value.projected?.find(
        (layout) => layout.workspaceId === workspaceId,
      ) ?? null
    );
  }

  /**
   * Replace one Workspace override through the account-scoped offline queue.
   * Other Workspace layouts remain part of the aggregate patch.
   */
  async updateWorkspaceDashboardLayout(layout: WorkspaceDashboardLayout) {
    const current = this.workspaceDashboardLayouts$.value.projected ?? [];
    const next = current.filter(
      (candidate) => candidate.workspaceId !== layout.workspaceId,
    );
    next.push(layout);
    await this.update({
      workspaceDashboardLayouts: toGraphQLWorkspaceDashboardLayouts(next),
    });
  }

  /** Remove one Workspace override without materializing product defaults. */
  async resetWorkspaceDashboardLayout(workspaceId: string) {
    const current = this.workspaceDashboardLayouts$.value.projected ?? [];
    const next = current.filter((layout) => layout.workspaceId !== workspaceId);
    await this.update({
      workspaceDashboardLayouts:
        next.length > 0 ? toGraphQLWorkspaceDashboardLayouts(next) : null,
    });
  }

  /** Context and inheritance are native server projections, never inferred from
   * optimistic preferences. A late response cannot authorize another account. */
  async getAssistance(workspaceId?: string, projectId?: string) {
    const requestedScope = this.scope;
    if (!requestedScope) throw new Error("Assistance requires an account");
    const result = await this.store.getAssistance(
      workspaceId,
      projectId,
      requestedScope.userId,
    );
    if (this.scope !== requestedScope)
      throw new Error("Assistance preference owner changed");
    return result;
  }

  /** Assistance is an acknowledged save, not an offline intent. Serialize with
   * the existing preference writer, preserve unrelated pending keys, and reject
   * every stale-scope completion, including failures after an account switch. */
  async updateAssistance(
    mode: AssistanceMode | null,
    workspaceId?: string,
    projectId?: string,
  ) {
    const requestedScope = this.scope;
    if (!requestedScope) throw new Error("Assistance requires an account");
    while (this.syncPromise) {
      await this.syncPromise;
      if (this.scope !== requestedScope)
        throw new Error("Assistance preference owner changed");
    }
    if (projectId && !workspaceId)
      throw new Error("Project assistance requires a workspace");
    const patch: UpdateUserPreferencesInput =
      projectId && workspaceId
        ? { projectAssistanceOverrides: [{ workspaceId, projectId, mode }] }
        : workspaceId
          ? { workspaceAssistanceOverrides: [{ workspaceId, mode }] }
          : { assistanceMode: mode };
    let confirmed: ConfirmedAssistance | undefined;
    const operation = (async () => {
      const acknowledged = await this.store.patchRemote(patch);
      if (this.scope !== requestedScope)
        throw new Error("Assistance preference owner changed");
      this.writeCached({
        confirmedValues: acknowledged.values,
        confirmedEffectiveValues: acknowledged.effectiveValues,
        confirmedUpdatedAt: acknowledged.updatedAt,
        pendingPatch: this.readCached()?.pendingPatch ?? {},
      });
      this.publish();
      confirmed = await this.getAssistance(workspaceId, projectId);
      if (this.scope !== requestedScope)
        throw new Error("Assistance preference owner changed");
    })();
    this.syncIsAssistance = true;
    this.syncPromise = operation;
    this.syncScopeKey = `${requestedScope.serverId}:${requestedScope.userId}`;
    try {
      await operation;
      if (!confirmed || this.scope !== requestedScope)
        throw new Error("Assistance preference owner changed");
      return confirmed;
    } finally {
      if (this.syncPromise === operation) {
        this.syncPromise = null;
        this.syncScopeKey = null;
        this.syncIsAssistance = false;
        // Ordinary settings edited during this acknowledged save retain their
        // existing offline queue; assistance itself never enters that queue.
        if (
          this.scope === requestedScope &&
          hasPatch(this.readCached()?.pendingPatch ?? {})
        ) {
          void this.sync().catch(() => undefined);
        }
      }
    }
  }

  async revalidate() {
    const requestedScope = this.scope;
    if (!requestedScope) return;
    this.assistanceRevision$.value += 1;
    this.isLoading$.value = true;
    try {
      const remote = await this.store.getRemote();
      if (!remote || this.scope !== requestedScope) return;
      const pendingPatch = this.readCached()?.pendingPatch ?? {};
      this.writeCached({
        confirmedValues: remote.values,
        confirmedEffectiveValues: remote.effectiveValues,
        confirmedUpdatedAt: remote.updatedAt,
        pendingPatch,
      });
      this.error$.value = undefined;
      this.publish();
      this.assistanceRevision$.value += 1;
      if (hasPatch(pendingPatch)) await this.sync();
    } catch (error) {
      if (this.scope === requestedScope) this.error$.value = error;
    } finally {
      if (this.scope === requestedScope) this.isLoading$.value = false;
    }
  }

  /** This online slice never joins the offline patch or persists executable data.
   * The same account scope must own the request and its acknowledged result. */
  private async savedSetupRequest<T>(operation: (actor: string) => Promise<T>) {
    const scope = this.scope;
    if (!scope || this.authService.session.account$.value?.id !== scope.userId)
      throw new Error("Saved setups require an account");
    const result = await operation(scope.userId);
    if (
      this.scope !== scope ||
      this.authService.session.account$.value?.id !== scope.userId
    )
      throw new Error("Saved setup owner changed");
    return result;
  }

  getSavedSetups() {
    return this.savedSetupRequest((actor) => this.store.getSavedSetups(actor));
  }

  saveSetup(input: SaveAssistantSetupInput) {
    return this.savedSetupRequest((actor) =>
      this.store.saveSetup(input, actor),
    );
  }

  deleteSetup(id: string) {
    return this.savedSetupRequest((actor) => this.store.deleteSetup(id, actor));
  }

  resolveSetup(id: string) {
    return this.savedSetupRequest((actor) =>
      this.store.resolveSetup(id, actor),
    );
  }

  async update(
    patch: UpdateUserPreferencesInput,
    options: { rollbackOnError?: boolean } = {},
  ) {
    if (
      [
        "assistanceMode",
        "workspaceAssistanceOverrides",
        "projectAssistanceOverrides",
      ].some((key) => Object.prototype.hasOwnProperty.call(patch, key))
    )
      throw new Error("Assistance requires a confirmed save");
    const requestedScope = this.scope;
    if (!requestedScope) {
      this.error$.value = new Error(
        "Cannot update preferences without an account",
      );
      return;
    }
    const cached = this.readCached();
    if (!cached) {
      await this.revalidate();
    }
    if (this.scope !== requestedScope) return;
    const current = this.readCached();
    if (!current) {
      this.error$.value = new Error("User preferences are not available");
      return;
    }
    this.writeCached({
      ...current,
      pendingPatch: mergePending(current.pendingPatch, patch),
    });
    this.publish();
    try {
      await this.sync();
    } catch (error) {
      if (!options.rollbackOnError) return;
      const latest = this.store.getCached(
        requestedScope.serverId,
        requestedScope.userId,
      );
      if (latest) {
        const pendingPatch = { ...latest.pendingPatch };
        // Preserve unrelated offline edits and any newer value written while
        // this request was in flight; rollback belongs to this account only.
        for (const key of Object.keys(
          patch,
        ) as (keyof UpdateUserPreferencesInput)[]) {
          if (!isEqual(pendingPatch[key], patch[key])) continue;
          if (key in current.pendingPatch) {
            (pendingPatch as Record<string, unknown>)[key] =
              current.pendingPatch[key];
          } else {
            delete pendingPatch[key];
          }
        }
        this.store.setCached(requestedScope.serverId, requestedScope.userId, {
          ...latest,
          pendingPatch,
        });
        if (this.scope === requestedScope) this.publish();
      }
      if (this.scope === requestedScope) throw error;
    }
  }

  async sync(): Promise<void> {
    const scopeKey = this.scope
      ? `${this.scope.serverId}:${this.scope.userId}`
      : null;
    if (!scopeKey) return;
    if (this.syncPromise) {
      // A confirmed assistance request has its own failure contract. Ordinary
      // rollback-capable edits must await their own native write, not inherit
      // another setting's rejection before their patch has been attempted.
      if (this.syncScopeKey === scopeKey && !this.syncIsAssistance)
        return this.syncPromise;
      await this.syncPromise.catch(() => undefined);
      return this.sync();
    }
    const promise = this.runSync();
    this.syncPromise = promise;
    this.syncScopeKey = scopeKey;
    try {
      await promise;
    } finally {
      if (this.syncPromise === promise) {
        this.syncPromise = null;
        this.syncScopeKey = null;
      }
    }
  }

  private async runSync() {
    const requestedScope = this.scope;
    if (!requestedScope) return;
    const cached = this.readCached();
    if (!cached || !hasPatch(cached.pendingPatch)) return;
    const sentPatch = { ...cached.pendingPatch };
    this.isSyncing$.value = true;
    try {
      const acknowledged = await this.store.patchRemote(sentPatch);
      if (this.scope !== requestedScope) return;
      const currentPending = this.readCached()?.pendingPatch ?? {};
      const pendingPatch = remainingPending(currentPending, sentPatch);
      this.writeCached({
        confirmedValues: acknowledged.values,
        confirmedEffectiveValues: acknowledged.effectiveValues,
        confirmedUpdatedAt: acknowledged.updatedAt,
        pendingPatch,
      });
      this.error$.value = undefined;
      this.publish();
      this.assistanceRevision$.value += 1;
      if (hasPatch(pendingPatch)) await this.runSync();
    } catch (error) {
      if (this.scope === requestedScope) this.error$.value = error;
      throw error;
    } finally {
      if (this.scope === requestedScope) this.isSyncing$.value = false;
    }
  }

  override dispose() {
    this.accountSubscription.unsubscribe();
    this.cacheSubscription?.unsubscribe();
  }
}
