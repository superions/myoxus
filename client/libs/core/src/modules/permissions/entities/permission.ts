import { Permission } from "@myoxus/graphql";
import {
  backoffRetry,
  effect,
  Entity,
  exhaustMapWithTrailing,
  fromPromise,
  LiveData,
  onComplete,
  onStart,
} from "@myoxus/infra";
import { tap } from "rxjs";

import type { WorkspaceService } from "../../workspace";
import type { WorkspacePermissionStore } from "../stores/permission";

export class WorkspacePermission extends Entity {
  private readonly cache$ = LiveData.from(
    this.store.watchWorkspacePermissionCache(),
    undefined,
  );
  isOwner$ = this.cache$.map((cache) => cache?.isOwner ?? null);
  isAdmin$ = this.cache$.map((cache) => cache?.isAdmin ?? null);
  isOwnerOrAdmin$ = this.cache$.map(
    (cache) => (cache?.isOwner ?? null) || (cache?.isAdmin ?? null),
  );
  isShared$ = this.cache$.map((cache) => cache?.isShared ?? null);
  isRevalidating$ = new LiveData(false);

  constructor(
    private readonly workspaceService: WorkspaceService,
    private readonly store: WorkspacePermissionStore,
  ) {
    super();
  }

  revalidate = effect(
    exhaustMapWithTrailing(() => {
      return fromPromise(async (signal) => {
        if (
          this.workspaceService.workspace.flavour !== "local" &&
          !this.workspaceService.workspace.openOptions.isSharedMode
        ) {
          const info = await this.store.fetchWorkspaceInfo(
            this.workspaceService.workspace.id,
            signal,
          );
          const workspace = info.workspace;
          if (!workspace) {
            throw new Error("Workspace permission info not found");
          }

          return {
            isOwner: workspace.role === Permission.Owner,
            isAdmin: workspace.role === Permission.Admin,
            isShared: workspace.workspaceType === "Shared",
          };
        } else {
          return { isOwner: true, isAdmin: false, isShared: false };
        }
      }).pipe(
        backoffRetry({
          count: Infinity,
        }),
        tap(({ isOwner, isAdmin, isShared }) => {
          this.store.setWorkspacePermissionCache({
            isOwner,
            isAdmin,
            isShared,
          });
        }),
        onStart(() => this.isRevalidating$.setValue(true)),
        onComplete(() => this.isRevalidating$.setValue(false)),
      );
    }),
  );

  async waitForRevalidation(signal?: AbortSignal) {
    this.revalidate();
    await this.isRevalidating$.waitFor(
      (isRevalidating) => !isRevalidating,
      signal,
    );
  }

  override dispose(): void {
    this.revalidate.unsubscribe();
  }
}
