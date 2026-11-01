import { DebugLogger } from "@myoxus/debug";
import type { GetWorkspaceConfigQuery, InviteLink } from "@myoxus/graphql";
import {
  catchErrorInto,
  effect,
  Entity,
  fromPromise,
  LiveData,
  onComplete,
  onStart,
  smartRetry,
} from "@myoxus/infra";
import { exhaustMap, tap } from "rxjs";

import type { WorkspaceService } from "../../workspace";
import type { WorkspaceShareSettingStore } from "../stores/share-setting";

type WorkspaceConfig = NonNullable<GetWorkspaceConfigQuery["workspace"]>;
type EnableAi = WorkspaceConfig["enableAi"];
type EnableSharing = WorkspaceConfig["enableSharing"];
type EnableUrlPreview = WorkspaceConfig["enableUrlPreview"];
type Public = WorkspaceConfig["public"];
type Description = WorkspaceConfig["description"];

const logger = new DebugLogger("myoxus:workspace-permission");

export class WorkspaceShareSetting extends Entity {
  enableAi$ = new LiveData<EnableAi | null>(null);
  enableSharing$ = new LiveData<EnableSharing | null>(null);
  enableUrlPreview$ = new LiveData<EnableUrlPreview | null>(null);
  public$ = new LiveData<Public | null>(null);
  publicDeliveryEnabled$ = new LiveData<boolean | null>(null);
  publiclyAccessible$ = new LiveData<boolean | null>(null);
  publicDocumentSelectionCount$ = new LiveData<number | null>(null);
  name$ = new LiveData<string | null>(null);
  description$ = new LiveData<Description | null>(null);
  inviteLink$ = new LiveData<InviteLink | null>(null);
  isLoading$ = new LiveData(false);
  error$ = new LiveData<any>(null);

  constructor(
    private readonly workspaceService: WorkspaceService,
    private readonly store: WorkspaceShareSettingStore,
  ) {
    super();
    this.revalidate();
  }

  revalidate = effect(
    exhaustMap(() => {
      return fromPromise((signal) =>
        this.store.fetchWorkspaceConfig(
          this.workspaceService.workspace.id,
          signal,
        ),
      ).pipe(
        smartRetry(),
        tap((value) => {
          if (value) {
            this.error$.next(null);
            this.public$.next(value.public);
            this.publicDeliveryEnabled$.next(value.publicDeliveryEnabled);
            this.publiclyAccessible$.next(value.publiclyAccessible);
            this.publicDocumentSelectionCount$.next(
              value.publicDocumentSelectionCount,
            );
            this.name$.next(value.name);
            this.description$.next(value.description);
            this.enableAi$.next(value.enableAi);
            this.enableSharing$.next(value.enableSharing);
            this.enableUrlPreview$.next(value.enableUrlPreview);
            this.inviteLink$.next(value.inviteLink);
          }
        }),
        catchErrorInto(this.error$, (error) => {
          logger.error("Failed to fetch workspace share settings", error);
        }),
        onStart(() => {
          this.error$.next(null);
          this.isLoading$.setValue(true);
        }),
        onComplete(() => this.isLoading$.setValue(false)),
      );
    }),
  );

  async waitForRevalidation(signal?: AbortSignal) {
    this.revalidate();
    await this.isLoading$.waitFor((isLoading) => !isLoading, signal);
  }

  async setEnableUrlPreview(enableUrlPreview: EnableUrlPreview) {
    await this.store.updateWorkspaceEnableUrlPreview(
      this.workspaceService.workspace.id,
      enableUrlPreview,
    );
    await this.waitForRevalidation();
  }

  async setEnableSharing(enableSharing: EnableSharing) {
    await this.store.updateWorkspaceEnableSharing(
      this.workspaceService.workspace.id,
      enableSharing,
    );
    await this.waitForRevalidation();
  }

  async setPublic(publicAccess: Public) {
    await this.store.updateWorkspacePublic(
      this.workspaceService.workspace.id,
      publicAccess,
    );
    await this.waitForRevalidation();
  }

  async setDescription(description: Description) {
    await this.store.updateWorkspaceDescription(
      this.workspaceService.workspace.id,
      description,
    );
    await this.waitForRevalidation();
  }

  async setEnableAi(enableAi: EnableAi) {
    await this.store.updateWorkspaceEnableAi(
      this.workspaceService.workspace.id,
      enableAi,
    );
    await this.waitForRevalidation();
  }

  override dispose(): void {
    this.revalidate.unsubscribe();
  }
}
