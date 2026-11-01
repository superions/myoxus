/**
 * @vitest-environment happy-dom
 */

// SPDX-License-Identifier: AGPL-3.0-or-later

import { UserFriendlyError } from "@myoxus/error";
import { Framework } from "@myoxus/infra";
import { of } from "rxjs";
import { afterEach, describe, expect, test, vi } from "vitest";

import { DocService, DocsService } from "../../doc";
import { DocumentLifecycleStore } from "../../doc/stores/document-lifecycle";
import { DocsSearchService } from "../../docs-search";
import { FeatureFlagService } from "../../feature-flag";
import { DefaultServerService, WorkspaceServerService } from "../../server";
import { WorkspaceService } from "../../workspace";
import { DocBacklinks } from "./doc-backlinks";
import { DocLinks } from "./doc-links";

function notFound() {
  return new UserFriendlyError({
    status: 404,
    code: "DOC_NOT_FOUND",
    type: "NOT_FOUND",
    name: "DOC_NOT_FOUND",
    message: "not found: document",
  });
}

function emptyGraph() {
  return {
    workspace: {
      documentLinks: {
        nodes: [],
        edges: [],
        databaseReferences: [],
      },
    },
  };
}

function createFixture(kind: "links" | "backlinks", error: Error = notFound()) {
  const gql = vi.fn().mockRejectedValue(error);
  const framework = new Framework();
  const testFramework = framework as any;
  testFramework.service(DocsSearchService, {
    watchRefsFrom: () => of([]),
    indexer: { aggregate: vi.fn() },
  });
  testFramework.service(DocService, { doc: { id: "doc-1" } });
  testFramework.service(DocsService, {
    list: { doc$: () => ({ value: null }) },
  });
  testFramework.service(FeatureFlagService, {
    flags: { enable_battery_save_mode: { value: false } },
  });
  testFramework.service(WorkspaceService, {
    workspace: { id: "workspace-1", flavour: "cloud" },
  });
  const server = { scope: { get: () => ({ gql }) } };
  testFramework.service(WorkspaceServerService, { server });
  testFramework.service(DefaultServerService, { server: null });
  framework.store(DocumentLifecycleStore);
  if (kind === "links") {
    framework.entity(DocLinks, [
      DocsSearchService,
      DocService,
      WorkspaceService,
      WorkspaceServerService,
      DefaultServerService,
      DocumentLifecycleStore,
    ]);
  } else {
    framework.entity(DocBacklinks, [
      DocsSearchService,
      DocService,
      DocsService,
      FeatureFlagService,
      WorkspaceService,
      WorkspaceServerService,
      DefaultServerService,
      DocumentLifecycleStore,
    ]);
  }
  const provider = framework.provider();
  return {
    entity:
      kind === "links"
        ? provider.createEntity(DocLinks)
        : provider.createEntity(DocBacklinks),
    gql,
    lifecycle: provider.get(DocumentLifecycleStore),
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe.each(["links", "backlinks"] as const)(
  "%s terminal document lifecycle",
  (kind) => {
    test("shares initial consumer demand but preserves explicit refresh during flight", async () => {
      const { entity, gql } = createFixture(kind);
      let resolveInitial!: (value: ReturnType<typeof emptyGraph>) => void;
      const initial = new Promise<ReturnType<typeof emptyGraph>>((resolve) => {
        resolveInitial = resolve;
      });
      gql.mockImplementationOnce(() => initial).mockResolvedValue(emptyGraph());

      const releaseFirst = entity.acquireLoadDemand();
      const releaseSecond = entity.acquireLoadDemand();
      await vi.waitFor(() => expect(gql).toHaveBeenCalledOnce());
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(gql).toHaveBeenCalledOnce();

      entity.revalidateFromCloud();
      resolveInitial(emptyGraph());
      await vi.waitFor(() => expect(gql).toHaveBeenCalledTimes(2));
      expect(entity.isLoaded$.value).toBe(true);

      releaseFirst();
      releaseSecond();
      entity.dispose();
    });

    test("does not retry DOC_NOT_FOUND or issue a later revalidation request", async () => {
      const { entity, gql, lifecycle } = createFixture(kind);

      entity.revalidateFromCloud();
      await vi.waitFor(() => {
        expect(lifecycle.state("doc-1")).toBe("not-found");
      });
      expect(gql).toHaveBeenCalledOnce();

      entity.revalidateFromCloud();
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(gql).toHaveBeenCalledOnce();
      if (entity instanceof DocLinks) {
        expect(entity.links$.value).toEqual([]);
      } else {
        expect(entity.backlinks$.value).toEqual([]);
        expect(entity.databaseReferences$.value).toEqual([]);
      }

      entity.dispose();
    });

    test("gates a scheduled network retry when a peer marks the document terminal", async () => {
      vi.useFakeTimers();
      const networkError = new UserFriendlyError({
        status: 0,
        code: "NETWORK_ERROR",
        type: "NETWORK_ERROR",
        name: "NETWORK_ERROR",
        message: "offline",
      });
      const { entity, gql, lifecycle } = createFixture(kind, networkError);

      entity.revalidateFromCloud();
      await vi.advanceTimersByTimeAsync(0);
      expect(gql).toHaveBeenCalledOnce();

      lifecycle.markNotFound("doc-1");
      await vi.advanceTimersByTimeAsync(2_000);
      expect(gql).toHaveBeenCalledOnce();

      entity.dispose();
    });

    test("waits for server create confirmation before loading the graph", async () => {
      const { entity, gql, lifecycle } = createFixture(kind);
      gql.mockResolvedValue({
        workspace: {
          documentLinks: {
            nodes: [],
            edges: [],
            databaseReferences: [],
          },
        },
      });

      lifecycle.beginCreating("doc-1");
      entity.revalidateFromCloud();
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(gql).not.toHaveBeenCalled();

      lifecycle.beginAvailableLifecycle("doc-1", "created");
      await vi.waitFor(() => expect(gql).toHaveBeenCalledOnce());

      entity.dispose();
    });

    test("does not turn a create lifecycle into demand for an unobserved graph", async () => {
      const { entity, gql, lifecycle } = createFixture(kind);

      lifecycle.beginCreating("doc-1");
      lifecycle.beginAvailableLifecycle("doc-1", "created");
      await new Promise((resolve) => setTimeout(resolve, 20));

      expect(gql).not.toHaveBeenCalled();
      entity.dispose();
    });
  },
);
