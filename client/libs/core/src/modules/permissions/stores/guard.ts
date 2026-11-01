import { UserFriendlyError } from "@myoxus/error";
import {
  type GetDocRolePermissionsQuery,
  getDocRolePermissionsQuery,
  type GetWorkspaceInfoQuery,
  getWorkspaceInfoQuery,
} from "@myoxus/graphql";
import { LiveData, Store } from "@myoxus/infra";
import {
  distinctUntilChanged,
  map,
  of,
  type Subscription,
  switchMap,
} from "rxjs";

import type { WorkspaceServerService } from "../../server";
import type { GlobalState } from "../../storage";
import type { WorkspaceService } from "../../workspace";

type WorkspacePermissions = NonNullable<
  GetWorkspaceInfoQuery["workspace"]
>["permissions"];

type DocPermissions = NonNullable<
  NonNullable<GetDocRolePermissionsQuery["workspace"]>["doc"]
>["permissions"];

export type WorkspacePermissionActions = keyof Omit<
  WorkspacePermissions,
  "__typename"
>;

export type DocPermissionActions = keyof Omit<DocPermissions, "__typename">;
type ConfirmedDocPermissions = Partial<Record<DocPermissionActions, boolean>>;

function confirmedPermissions(value: unknown): ConfirmedDocPermissions {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value).filter(
      ([key, permission]) =>
        key.startsWith("Doc_") && typeof permission === "boolean",
    ),
  );
}

export class GuardStore extends Store {
  private readonly desktopScope$ = new LiveData<{ prefix: string } | null>(
    null,
  );
  private readonly scopeSubscription?: Subscription;

  constructor(
    private readonly workspaceService: WorkspaceService,
    private readonly workspaceServerService: WorkspaceServerService,
    private readonly globalState: GlobalState,
  ) {
    super();
    if (
      BUILD_CONFIG.isElectron &&
      !workspaceService.workspace.openOptions.isSharedMode
    ) {
      this.scopeSubscription = workspaceServerService.server$
        .pipe(
          switchMap((server) =>
            server
              ? server.account$.pipe(
                  map((account) =>
                    account
                      ? `desktop-doc-permissions:${JSON.stringify([server.id, server.baseUrl, account.id, workspaceService.workspace.id])}:`
                      : null,
                  ),
                )
              : of(null),
          ),
          distinctUntilChanged(),
        )
        .subscribe((prefix) => {
          const previous = this.desktopScope$.value;
          // A logout/account switch invalidates the old projection. A normal
          // scope disposal deliberately retains it for an offline restart.
          this.desktopScope$.next(prefix ? { prefix } : null);
          if (previous) {
            for (const key of globalState.keys()) {
              if (key.startsWith(previous.prefix)) globalState.del(key);
            }
          }
        });
    }
  }

  /** Desktop-only projection of server-confirmed rights, never inferred roles. */
  watchConfirmedDocPermissions(docId: string) {
    return this.desktopScope$.pipe(
      switchMap((scope) =>
        scope
          ? this.globalState
              .watch(scope.prefix + JSON.stringify(docId))
              .pipe(map(confirmedPermissions))
          : of({} as ConfirmedDocPermissions),
      ),
    );
  }

  getConfirmedDocPermissions(docId: string): ConfirmedDocPermissions {
    const scope = this.desktopScope$.value;
    return scope
      ? confirmedPermissions(
          this.globalState.get(scope.prefix + JSON.stringify(docId)),
        )
      : {};
  }

  async getWorkspacePermissions(): Promise<
    Record<WorkspacePermissionActions, boolean>
  > {
    if (!this.workspaceServerService.server) {
      throw new Error("No server");
    }
    const data = await this.workspaceServerService.server.gql({
      query: getWorkspaceInfoQuery,
      variables: {
        workspaceId: this.workspaceService.workspace.id,
      },
    });
    if (!data.workspace) {
      throw new Error("Workspace permissions unavailable");
    }
    return data.workspace.permissions;
  }

  async getDocPermissions(docId: string): Promise<ConfirmedDocPermissions> {
    if (!this.workspaceServerService.server) {
      throw new Error("No server");
    }
    const scope = this.desktopScope$.value;
    if (BUILD_CONFIG.isElectron && !scope) {
      throw new Error("No authenticated document permission scope");
    }
    const key = scope ? scope.prefix + JSON.stringify(docId) : null;
    try {
      const data = await this.workspaceServerService.server.gql({
        query: getDocRolePermissionsQuery,
        variables: {
          workspaceId: this.workspaceService.workspace.id,
          docId,
        },
      });
      if (!data.workspace?.doc) {
        throw new Error("Document permissions unavailable");
      }
      if (BUILD_CONFIG.isElectron && scope !== this.desktopScope$.value) {
        throw new Error("Document permission account changed");
      }
      if (key)
        this.globalState.set(
          key,
          confirmedPermissions(data.workspace.doc.permissions),
        );
      return data.workspace.doc.permissions;
    } catch (cause) {
      if (BUILD_CONFIG.isElectron && scope !== this.desktopScope$.value) {
        // Network failures are fenced too: an old request must not make
        // GuardService.can() fall back to a newly signed-in account's rights.
        throw new Error("Document permission account changed", { cause });
      }
      const error = UserFriendlyError.fromAny(cause);
      // Only loss of connectivity preserves the last confirmed projection.
      // Server denials must close the editor, including GraphQL denials that
      // arrive as HTTP 200. No cached grant authorizes a server-side write.
      if (
        key &&
        scope === this.desktopScope$.value &&
        !error.isNetworkError() &&
        !error.is("REQUEST_ABORTED")
      ) {
        this.globalState.set(key, { Doc_Read: false, Doc_Update: false });
      }
      throw cause;
    }
  }

  override dispose() {
    this.scopeSubscription?.unsubscribe();
    // Fence in-flight replies without deleting the restart snapshot.
    this.desktopScope$.next(null);
    super.dispose();
  }
}
