import { UserFriendlyError } from "@myoxus/error";
import {
  backoffRetry,
  effect,
  exhaustMapWithTrailing,
  fromPromise,
  LiveData,
  OnEvent,
  Service,
} from "@myoxus/infra";
import { exhaustMap, groupBy, mergeMap, Observable } from "rxjs";

import { ApplicationFocused } from "../../lifecycle";
import type { WorkspaceService } from "../../workspace";
import type {
  DocPermissionActions,
  GuardStore,
  WorkspacePermissionActions,
} from "../stores/guard";

@OnEvent(ApplicationFocused, (service) => service.revalidateDesktopDocuments)
export class GuardService extends Service {
  constructor(
    private readonly guardStore: GuardStore,
    private readonly workspaceService: WorkspaceService,
  ) {
    super();
  }

  private readonly workspacePermissions$ = new LiveData<
    Partial<Record<WorkspacePermissionActions, boolean>>
  >({});

  private readonly docPermissions$ = new LiveData<
    Record<string, Partial<Record<DocPermissionActions, boolean>>>
  >({});
  private indexedPermissionKeys = new Set<string>();
  private readonly observedDesktopDocs = new Map<string, number>();

  private revalidateDesktopDocuments() {
    for (const docId of this.observedDesktopDocs.keys()) {
      this.revalidateDocPermission(docId);
    }
  }

  /**
   * @example
   * ```ts
   * guardService.can$('Workspace_Properties_Update');
   * guardService.can$('Doc_Update', docId);
   * ```
   *
   * @returns LiveData<boolean | undefined> the value is undefined if the permission is loading
   */
  can$<T extends WorkspacePermissionActions | DocPermissionActions>(
    action: T,
    ...args: T extends DocPermissionActions ? [string] : []
  ): LiveData<boolean | undefined> {
    if (this.workspaceService.workspace.flavour === "local") {
      // Local workspaces have no server capability projection. Preserve their
      // offline editing contract explicitly instead of inferring it from a
      // cloud role.
      return new LiveData<boolean | undefined>(true);
    }

    const docId = args[0];
    return LiveData.from(
      new Observable((subscriber) => {
        let prev: boolean | undefined = undefined;

        const emitPermission = (
          permissions: Partial<
            Record<WorkspacePermissionActions | DocPermissionActions, boolean>
          >,
        ) => {
          const current = permissions[action] ?? undefined;
          if (current !== prev) {
            prev = current;
            subscriber.next(current);
          }
        };
        const desktopDoc = BUILD_CONFIG.isElectron && !!docId;
        if (desktopDoc) {
          this.observedDesktopDocs.set(
            docId,
            (this.observedDesktopDocs.get(docId) ?? 0) + 1,
          );
        }
        // Electron observes the one persisted projection, so account changes
        // and newer responses in another window cannot leave a RAM grant alive.
        // Browser Web retains its online-only permission path.
        const subscription = desktopDoc
          ? this.guardStore
              .watchConfirmedDocPermissions(docId)
              .subscribe(emitPermission)
          : docId
            ? this.docPermissions$.subscribe((permissions) => {
                emitPermission(permissions[docId] ?? {});
              })
            : this.workspacePermissions$.subscribe(emitPermission);

        return () => {
          subscription.unsubscribe();
          if (desktopDoc) {
            const count = (this.observedDesktopDocs.get(docId) ?? 1) - 1;
            if (count) this.observedDesktopDocs.set(docId, count);
            else this.observedDesktopDocs.delete(docId);
          }
        };
      }),
      undefined,
    );
  }

  async can<T extends WorkspacePermissionActions | DocPermissionActions>(
    action: T,
    ...args: T extends DocPermissionActions ? [string] : []
  ): Promise<boolean> {
    const docId = args[0];

    if (this.workspaceService.workspace.flavour === "local") {
      return true;
    }

    const permissions = await (
      docId ? this.loadDocPermission(docId) : this.loadWorkspacePermission()
    ).catch((error: unknown) => {
      if (
        BUILD_CONFIG.isElectron &&
        docId &&
        UserFriendlyError.fromAny(error).isNetworkError()
      ) {
        return this.guardStore.getConfirmedDocPermissions(docId);
      }
      throw error;
    });

    return permissions[action as keyof typeof permissions] ?? false;
  }

  revalidateCan<T extends WorkspacePermissionActions | DocPermissionActions>(
    _action: T,
    ...args: T extends DocPermissionActions ? [string] : []
  ) {
    if (this.workspaceService.workspace.flavour === "local") {
      return;
    }

    const docId = args[0];
    // revalidate permission
    if (docId) {
      this.revalidateDocPermission(docId);
    } else {
      this.revalidateWorkspacePermission();
    }
  }

  revalidateDocPermissionIfMissing(
    action: DocPermissionActions,
    docId: string,
  ) {
    if (
      !BUILD_CONFIG.isElectron &&
      this.docPermissions$.value[docId]?.[action] !== undefined
    ) {
      return;
    }
    this.revalidateDocPermission(docId);
  }

  /** Prime list-only permissions from the actor-filtered metadata index. */
  primeIndexedDocPermissions(
    rows: ReadonlyArray<{
      docId: string;
      externalId?: string | null;
      canPublish: boolean;
    }>,
  ) {
    const nextKeys = new Set<string>();
    const next = { ...this.docPermissions$.value };
    for (const row of rows) {
      for (const key of new Set([row.docId, row.externalId ?? row.docId])) {
        nextKeys.add(key);
        // The index response is the newest server projection for this action.
        // A prior full permission read must not keep a stale publish grant.
        next[key] = { ...next[key], Doc_Publish: row.canPublish };
      }
    }
    for (const key of this.indexedPermissionKeys) {
      if (nextKeys.has(key)) continue;
      const { Doc_Publish: _removed, ...remaining } = next[key] ?? {};
      if (Object.keys(remaining).length === 0) delete next[key];
      else next[key] = remaining;
    }
    this.indexedPermissionKeys = nextKeys;
    this.docPermissions$.next(next);
  }

  private readonly revalidateWorkspacePermission = effect(
    exhaustMapWithTrailing(() =>
      fromPromise(() => this.loadWorkspacePermission()).pipe(
        backoffRetry({
          count: Infinity,
        }),
      ),
    ),
  );

  private readonly revalidateDocPermission = effect(
    groupBy((docId: string) => docId),
    mergeMap((doc$) =>
      doc$.pipe(
        exhaustMap((docId: string) =>
          fromPromise(() => this.loadDocPermission(docId)).pipe(
            backoffRetry({
              count: Infinity,
            }),
          ),
        ),
      ),
    ),
  );

  private readonly loadWorkspacePermission = async () => {
    if (this.workspaceService.workspace.openOptions.isSharedMode) {
      const permissions = {} as Record<WorkspacePermissionActions, boolean>;
      this.workspacePermissions$.next(permissions);
      return permissions;
    }
    const permissions = await this.guardStore.getWorkspacePermissions();
    this.workspacePermissions$.next(permissions);
    return permissions;
  };

  private readonly loadDocPermission = async (docId: string) => {
    if (this.workspaceService.workspace.openOptions.isSharedMode) {
      const permissions = {} as Record<DocPermissionActions, boolean>;
      this.docPermissions$.next({
        ...this.docPermissions$.value,
        [docId]: permissions,
      });
      return permissions;
    }
    const permissions = await this.guardStore.getDocPermissions(docId);
    if (!BUILD_CONFIG.isElectron) {
      this.docPermissions$.next({
        ...this.docPermissions$.value,
        [docId]: permissions,
      });
    }
    return permissions;
  };

  override dispose() {
    this.revalidateWorkspacePermission.unsubscribe();
    this.revalidateDocPermission.unsubscribe();
    this.indexedPermissionKeys.clear();
    super.dispose();
  }
}
