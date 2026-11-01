import { UserFriendlyError } from "@myoxus/error";
import type { GetWorkspacePageByIdQuery, PublicDocMode } from "@myoxus/graphql";
import {
  catchErrorInto,
  effect,
  Entity,
  fromPromise,
  LiveData,
  mapInto,
  onComplete,
  onStart,
  smartRetry,
} from "@myoxus/infra";
import { switchMap } from "rxjs";

import type { DocService } from "../../doc";
import type { WorkspaceService } from "../../workspace";
import type { ShareDocsListService } from "../services/share-docs-list";
import type { ShareStore } from "../stores/share";

type ShareInfoType = NonNullable<GetWorkspacePageByIdQuery["workspace"]>["doc"];

export function createPublicDocUnavailableError({
  docId,
  workspaceId,
}: {
  docId: string;
  workspaceId: string;
}) {
  return new UserFriendlyError({
    status: 404,
    code: "NOT FOUND",
    type: "DOC_NOT_FOUND",
    name: "DOC_NOT_FOUND",
    message: "Document is not available on the server.",
    data: { docId, spaceId: workspaceId },
  });
}

export class ShareInfo extends Entity {
  info$ = new LiveData<ShareInfoType | undefined | null>(null);
  isShared$ = this.info$.map((info) => info?.public);
  sharedMode$ = this.info$.map((info) => (info !== null ? info?.mode : null));

  error$ = new LiveData<any>(null);
  isRevalidating$ = new LiveData<boolean>(false);

  constructor(
    private readonly workspaceService: WorkspaceService,
    private readonly docService: DocService,
    private readonly store: ShareStore,
    private readonly shareDocsListService: ShareDocsListService,
  ) {
    super();
  }

  revalidate = effect(
    switchMap(() => {
      return fromPromise((signal) =>
        this.store.getShareInfoByDocId(
          this.workspaceService.workspace.id,
          this.docService.doc.id,
          signal,
        ),
      ).pipe(
        smartRetry(),
        mapInto(this.info$),
        catchErrorInto(this.error$),
        onStart(() => this.isRevalidating$.next(true)),
        onComplete(() => this.isRevalidating$.next(false)),
      );
    }),
  );

  waitForRevalidation(signal?: AbortSignal) {
    this.revalidate();
    return this.isRevalidating$.waitFor((v) => v === false, signal);
  }

  private async requireServerDocument(signal?: AbortSignal) {
    const workspaceId = this.workspaceService.workspace.id;
    const docId = this.docService.doc.id;
    this.isRevalidating$.next(true);

    try {
      const info = await this.store.getShareInfoByDocId(
        workspaceId,
        docId,
        signal,
      );
      this.info$.next(info);
      this.error$.next(null);

      if (!info) {
        // Public publishing renders the server copy. A stale browser route or a
        // not-yet-materialized sync document must stop before the mutation so
        // the UI can show the specific recovery hint instead of a generic
        // GraphQL/internal-server error.
        throw createPublicDocUnavailableError({ docId, workspaceId });
      }

      return info;
    } catch (error) {
      this.error$.next(error);
      throw error;
    } finally {
      this.isRevalidating$.next(false);
    }
  }

  async enableShare(mode: PublicDocMode) {
    await this.requireServerDocument();
    await this.store.enableSharePage(
      this.workspaceService.workspace.id,
      this.docService.doc.id,
      mode,
    );
    await this.waitForRevalidation();
    await this.shareDocsListService.shareDocs?.refreshAfterMutation();
  }

  async changeShare(mode: PublicDocMode) {
    await this.enableShare(mode);
  }

  async disableShare() {
    await this.requireServerDocument();
    await this.store.disableSharePage(
      this.workspaceService.workspace.id,
      this.docService.doc.id,
    );
    await this.waitForRevalidation();
    await this.shareDocsListService.shareDocs?.refreshAfterMutation();
  }
}
