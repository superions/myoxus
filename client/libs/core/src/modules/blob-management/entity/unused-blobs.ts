import { unusedBlobsQuery } from "@myoxus/graphql";
import {
  catchErrorInto,
  effect,
  Entity,
  fromPromise,
  LiveData,
  onComplete,
  onStart,
} from "@myoxus/infra";
import type { ListedBlobRecord } from "@myoxus/storage";
import { fileTypeFromBuffer } from "file-type";
import { switchMap, tap } from "rxjs";

import type { DocsSearchService } from "../../docs-search";
import type { WorkspaceServerService } from "../../server";
import type { WorkspaceService } from "../../workspace";
import type { WorkspaceFlavoursService } from "../../workspace/services/flavours";

interface HydratedBlobRecord extends ListedBlobRecord, Disposable {
  url: string;
  extension?: string;
  type?: string;
}

const UNUSED_BLOBS_INDEX_TIMEOUT_MS = 8_000;

async function withTimeout<T>(
  run: (signal: AbortSignal) => Promise<T>,
  parentSignal: AbortSignal | undefined,
  timeoutMs: number,
  message: string,
): Promise<T> {
  const abortController = new AbortController();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const abort = () => abortController.abort();
  parentSignal?.addEventListener("abort", abort, { once: true });
  try {
    return await Promise.race([
      run(abortController.signal),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => {
          const error = new Error(message);
          abortController.abort(error);
          reject(error);
        }, timeoutMs);
      }),
    ]);
  } finally {
    parentSignal?.removeEventListener("abort", abort);
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}

export class UnusedBlobs extends Entity {
  constructor(
    private readonly flavoursService: WorkspaceFlavoursService,
    private readonly workspaceService: WorkspaceService,
    private readonly docsSearchService: DocsSearchService,
    private readonly workspaceServer: WorkspaceServerService,
  ) {
    super();
  }

  isLoading$ = new LiveData(false);
  loadError$ = new LiveData<any | null>(null);
  unusedBlobs$ = new LiveData<ListedBlobRecord[]>([]);
  total$ = new LiveData(0);
  private get serverPaged() {
    return (
      BUILD_CONFIG.isWeb && this.workspaceService.workspace.flavour !== "local"
    );
  }

  readonly revalidate = effect(
    switchMap(({ offset, first }: { offset: number; first: number }) =>
      fromPromise(async (signal) => {
        if (this.serverPaged) return this.readPage(offset, first, signal);
        const items = await this.getUnusedBlobs(signal);
        return {
          items: items.slice(offset, offset + first),
          total: items.length,
        };
      }).pipe(
        tap((data) => {
          this.loadError$.setValue(null);
          this.unusedBlobs$.setValue(data.items);
          this.total$.setValue(data.total);
        }),
        catchErrorInto(this.loadError$, (error) => {
          console.warn("[workspace-storage] unused blob scan failed", {
            workspaceId: this.workspaceService.workspace.id,
            error,
          });
        }),
        onStart(() => {
          this.unusedBlobs$.setValue([]);
          this.isLoading$.setValue(true);
        }),
        onComplete(() => this.isLoading$.setValue(false)),
      ),
    ),
  );

  private get flavourProvider() {
    return this.flavoursService.flavours$.value.find(
      (f) => f.flavour === this.workspaceService.workspace.flavour,
    );
  }

  async listBlobs() {
    const blobs = await this.flavourProvider?.listBlobs(
      this.workspaceService.workspace.id,
    );
    return blobs;
  }

  async getBlob(blobKey: string) {
    const blob = await this.flavourProvider?.getWorkspaceBlob(
      this.workspaceService.workspace.id,
      blobKey,
    );
    return blob;
  }

  async deleteBlob(blob: string, permanent: boolean) {
    if (this.serverPaged) {
      await this.workspaceService.workspace.engine.doc.waitForSynced();
    }
    await this.flavourProvider?.deleteBlob(
      this.workspaceService.workspace.id,
      blob,
      permanent,
      this.serverPaged || undefined,
    );
  }

  async getUnusedBlobs(abortSignal?: AbortSignal) {
    // Wait for both sync and indexing to complete
    await this.workspaceService.workspace.engine.doc.waitForSynced();

    await withTimeout(
      (signal) => this.docsSearchService.indexer.waitForCompleted(signal),
      abortSignal,
      UNUSED_BLOBS_INDEX_TIMEOUT_MS,
      `Unused blob scan timed out after ${UNUSED_BLOBS_INDEX_TIMEOUT_MS}ms while waiting for the document indexer.`,
    );

    const [blobs, usedBlobs] = await Promise.all([
      this.listBlobs(),
      this.getUsedBlobs(),
    ]);

    // ignore the workspace avatar
    const workspaceAvatar = this.workspaceService.workspace.avatar$.value;

    return (
      blobs?.filter(
        (blob) => !usedBlobs.includes(blob.key) && blob.key !== workspaceAvatar,
      ) ?? []
    );
  }

  private async readPage(offset: number, first: number, signal?: AbortSignal) {
    const workspace = this.workspaceService.workspace;
    await workspace.engine.doc.waitForSynced(undefined, signal);
    const server = this.workspaceServer.server;
    if (!server) throw new Error("Workspace server unavailable");
    const result = await server.gql({
      query: unusedBlobsQuery,
      variables: { workspaceId: workspace.id, offset, first },
      context: { signal },
    });
    const page = result.workspace?.unusedBlobs;
    if (!page?.ready)
      throw new Error("Document attachment usage is not current");
    return {
      total: page.total,
      items: page.items.map((b) => ({
        ...b,
        createdAt: new Date(b.createdAt),
      })),
    };
  }

  private async getUsedBlobs(): Promise<string[]> {
    const result = await this.docsSearchService.indexer.aggregate(
      "block",
      {
        type: "boolean",
        occur: "must",
        queries: [
          {
            type: "exists",
            field: "blob",
          },
        ],
      },
      "blob",
      {
        pagination: {
          limit: Number.MAX_SAFE_INTEGER,
        },
      },
    );

    return result.buckets.map((bucket) => bucket.key);
  }

  async hydrateBlob(
    record: ListedBlobRecord,
    abortSignal?: AbortSignal,
  ): Promise<HydratedBlobRecord | null> {
    const blob = await this.getBlob(record.key);

    if (!blob || abortSignal?.aborted) {
      return null;
    }

    const fileType = await fileTypeFromBuffer(await blob.arrayBuffer());

    if (abortSignal?.aborted) {
      return null;
    }

    const mime = record.mime || fileType?.mime || "unknown";
    const url = URL.createObjectURL(new Blob([blob], { type: mime }));
    // todo(@pengx17): the following may not be sufficient
    const extension = fileType?.ext;
    const type = extension ?? (mime?.startsWith("text/") ? "txt" : "unknown");
    return {
      ...record,
      url,
      extension,
      type,
      mime,
      [Symbol.dispose]: () => {
        URL.revokeObjectURL(url);
      },
    };
  }
}
