import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { Framework } from "@myoxus/infra";
import { afterEach, describe, expect, test, vi } from "vitest";

import { FetchService } from "./fetch";
import {
  configureMyoxusGraphQLClientContext,
  GraphQLService,
  resetMyoxusGraphQLClientContext,
  withMyoxusClientContextHeaders,
} from "./graphql";

const repoRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../../../../..",
);

function readRepoFile(path: string): string {
  return readFileSync(resolve(repoRoot, path), "utf8");
}

describe("GraphQLService client context headers", () => {
  afterEach(() => {
    resetMyoxusGraphQLClientContext();
  });

  test("adds native document metadata client context by default", () => {
    const context = withMyoxusClientContextHeaders(undefined);
    const headers = new Headers(context?.headers);

    expect(headers.get("x-myoxus-client")).toBe("core");
    expect(headers.get("x-myoxus-client-format")).toBe("myoxus-native");
    expect(headers.get("x-myoxus-client-capabilities")).toBe(
      "document-metadata",
    );
  });

  test("preserves caller-provided client context overrides", () => {
    const context = withMyoxusClientContextHeaders({
      headers: {
        "x-myoxus-client": "electron",
        "x-myoxus-client-capabilities": "document-metadata,pdf-export",
      },
    });
    const headers = new Headers(context?.headers);

    expect(headers.get("x-myoxus-client")).toBe("electron");
    expect(headers.get("x-myoxus-client-format")).toBe("myoxus-native");
    expect(headers.get("x-myoxus-client-capabilities")).toBe(
      "document-metadata,pdf-export",
    );
  });

  test("allows app shells to configure their native client family centrally", () => {
    const restore = configureMyoxusGraphQLClientContext({
      client: "myoxus-electron",
      clientCapabilities: "document-metadata,pdf-export",
    });

    try {
      const context = withMyoxusClientContextHeaders(undefined);
      const headers = new Headers(context?.headers);

      expect(headers.get("x-myoxus-client")).toBe("myoxus-electron");
      expect(headers.get("x-myoxus-client-format")).toBe("myoxus-native");
      expect(headers.get("x-myoxus-client-capabilities")).toBe(
        "document-metadata,pdf-export",
      );
    } finally {
      restore();
    }
  });

  test("sends native context headers through the real GraphQL fetch path", async () => {
    const fetch = vi.fn(async () => {
      return new Response(JSON.stringify({ data: { ok: true } }), {
        headers: { "content-type": "application/json" },
      });
    });
    const framework = new Framework();
    framework.service(FetchService, { fetch } as any);
    framework.service(GraphQLService, [FetchService]);
    const service = framework.provider().get(GraphQLService);

    await service.gql({
      query: {
        id: "nativeHeaderProbe",
        op: "nativeHeaderProbe",
        query: "query nativeHeaderProbe { ok }",
      },
    } as never);

    expect(fetch).toHaveBeenCalledOnce();
    const [, init = {}] = fetch.mock.calls[0] as unknown as [
      string,
      RequestInit | undefined,
    ];
    const headers = new Headers(init.headers);
    expect(headers.get("content-type")).toBe("application/json");
    expect(headers.get("x-operation-name")).toBe("nativeHeaderProbe");
    expect(headers.get("x-myoxus-client")).toBe("core");
    expect(headers.get("x-myoxus-client-format")).toBe("myoxus-native");
    expect(headers.get("x-myoxus-client-capabilities")).toBe(
      "document-metadata",
    );
  });

  test("retains machine-readable GraphQL conflict metadata", async () => {
    const latestState = JSON.stringify({
      kind: "row",
      editRevision: 3,
      title: "Remote title",
    });
    const fetch = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          data: null,
          errors: [
            {
              message: "database row changed",
              extensions: {
                code: "MIX_DATABASE_ROW_CONFLICT",
                type: "MIX_DATABASE_ROW_CONFLICT",
                name: "MIX_DATABASE_ROW_CONFLICT",
                latestState,
              },
            },
          ],
        }),
        { headers: { "content-type": "application/json" } },
      );
    });
    const framework = new Framework();
    framework.service(FetchService, { fetch } as any);
    framework.service(GraphQLService, [FetchService]);
    const service = framework.provider().get(GraphQLService);

    await expect(
      service.gql({
        query: {
          id: "databaseConflictProbe",
          op: "databaseConflictProbe",
          query: "mutation databaseConflictProbe { ok }",
        },
      } as never),
    ).rejects.toMatchObject({
      code: "MIX_DATABASE_ROW_CONFLICT",
      message: "database row changed",
      extensions: {
        code: "MIX_DATABASE_ROW_CONFLICT",
        latestState,
      },
    });
  });

  test("app entrypoints configure their native GraphQL client family", () => {
    const expectedClients = new Map([
      ["client/web/workspaces/web/src/setup.ts", "web"],
      ["client/apps/mobile/src/setup.ts", "mobile"],
      ["client/apps/android/src/setup.ts", "android"],
      ["client/apps/ios/src/setup.ts", "ios"],
      ["client/libs/core/src/bootstrap/electron.ts", "myoxus-electron"],
    ]);

    for (const [entrypoint, client] of expectedClients) {
      const source = readRepoFile(entrypoint);
      expect(source).toContain("configureMyoxusGraphQLClientContext");
      expect(source).toContain(`client: "${client}"`);
    }
  });
});
