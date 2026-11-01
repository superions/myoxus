/**
 * @vitest-environment happy-dom
 */

import { indexerSearchDocsQuery } from "@myoxus/graphql";
import { Framework } from "@myoxus/infra";
import { firstValueFrom, of } from "rxjs";
import { describe, expect, test, vi } from "vitest";

import { DocsService } from "../../doc";
import { WorkspaceServerService } from "../../server";
import { WorkspaceService } from "../../workspace";
import { DocsSearchService } from "./docs-search";

describe("DocsSearchService remote full-text search", () => {
  test("uses workspace.searchDocs and never the generic remote block indexer", async () => {
    const aggregate$ = vi.fn(() => of({ buckets: [] }));
    const gql = vi.fn(async () => ({
      workspace: {
        searchDocs: [
          {
            docId: "doc-1",
            externalId: "external-doc-1",
            title: "Roadmap",
            blockId: "doc-1",
            highlight: "The release needle is in the document body.",
          },
        ],
      },
    }));
    const framework = new Framework();
    framework
      .service(WorkspaceService, {
        workspace: {
          id: "workspace-1",
          engine: {
            indexer: {
              state$: of({ completed: true }),
              aggregate$,
            },
          },
        },
      } as any)
      .service(WorkspaceServerService, {
        server: { gql },
      } as any)
      .service(DocsService, {} as any)
      .service(DocsSearchService, [
        WorkspaceService,
        WorkspaceServerService,
        DocsService,
      ]);
    const service = framework.provider().get(DocsSearchService);

    const result = await firstValueFrom(
      service.search$("  release needle  ", "remote"),
    );

    expect(gql).toHaveBeenCalledExactlyOnceWith({
      query: indexerSearchDocsQuery,
      variables: {
        id: "workspace-1",
        input: {
          keyword: "release needle",
          limit: 50,
          useSemanticSearch: false,
        },
      },
      context: { signal: expect.any(AbortSignal) },
    });
    expect(aggregate$).not.toHaveBeenCalled();
    expect(result).toEqual([
      {
        docId: "external-doc-1",
        title: "Roadmap",
        score: 1,
        blockId: undefined,
        blockContent: "The release needle is in the document body.",
      },
    ]);
  });

  test("aborts only the unsubscribed remote request", async () => {
    const requests: Array<{
      signal: AbortSignal;
      resolve: (value: any) => void;
    }> = [];
    const gql = vi.fn(
      ({ context }: { context: { signal: AbortSignal } }) =>
        new Promise<any>((resolve) => {
          requests.push({ signal: context.signal, resolve });
        }),
    );
    const framework = new Framework();
    framework
      .service(WorkspaceService, {
        workspace: {
          id: "workspace-1",
          engine: { indexer: { state$: of({ completed: true }) } },
        },
      } as any)
      .service(WorkspaceServerService, { server: { gql } } as any)
      .service(DocsService, {} as any)
      .service(DocsSearchService, [
        WorkspaceService,
        WorkspaceServerService,
        DocsService,
      ]);
    const service = framework.provider().get(DocsSearchService);

    const first = service.search$("first", "remote").subscribe();
    expect(requests[0].signal.aborted).toBe(false);
    first.unsubscribe();
    expect(requests[0].signal.aborted).toBe(true);

    const replacementResult = firstValueFrom(
      service.search$("replacement", "remote"),
    );
    expect(requests[1].signal.aborted).toBe(false);
    requests[1].resolve({ workspace: { searchDocs: [] } });

    await expect(replacementResult).resolves.toEqual([]);
    expect(requests[1].signal.aborted).toBe(true);
  });
});
