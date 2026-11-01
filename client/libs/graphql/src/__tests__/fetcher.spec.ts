/**
 * @file fetcher.spec.ts — @myoxus/graphql
 *
 * Unit tests for the GraphQL HTTP transport layer ({@link gqlFetcherFactory}).
 * Tests cover: POST method, JSON body serialisation, nil-variable filtering,
 * and GraphQL error propagation.
 *
 * All network calls are intercepted via a vitest mock — no real HTTP is made.
 */
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  type Mock,
  vi,
} from "vitest";

import { gqlFetcherFactory } from "../fetcher";
import type { GraphQLQuery } from "../graphql";
import {
  adminReplacePdfTemplateBundleMutation,
  adminUploadPdfTemplateMutation,
  createWorkspaceEventMutation,
  serverConfigQuery,
} from "../graphql";

const query: GraphQLQuery = {
  id: "query",
  query: "query { field }",
  op: "query",
};

let fetch: Mock;
let gql: ReturnType<typeof gqlFetcherFactory>;
describe("GraphQL fetcher", () => {
  beforeEach(() => {
    fetch = vi.fn(() =>
      Promise.resolve(
        new Response(JSON.stringify({ data: { field: 1 } }), {
          headers: {
            "content-type": "application/json",
          },
        }),
      ),
    );
    gql = gqlFetcherFactory("https://example.com/graphql", fetch);
  });

  afterEach(() => {
    fetch.mockReset();
  });

  it.each([
    adminUploadPdfTemplateMutation,
    adminReplacePdfTemplateBundleMutation,
  ])(
    "sends $op bundle files through multipart transport",
    async (operation) => {
      const source = new File(["#let label = [Local module]"], "module.typ", {
        type: "text/plain",
      });
      await gql({
        query: operation,
        variables: {
          id: "existing-template",
          manifest: { id: "local-import" },
          filePaths: ["nested/module.typ"],
          files: [source],
          rightsConfirmed: true,
        },
      });

      const request = fetch.mock.lastCall?.[1] as RequestInit;
      expect(request.body).toBeInstanceOf(FormData);
      const form = request.body as FormData;
      expect(JSON.parse(form.get("map") as string)).toEqual({
        "0": ["variables.files.0"],
      });
      expect(
        JSON.parse(form.get("operations") as string).variables.filePaths,
      ).toEqual(["nested/module.typ"]);
      expect(await (form.get("0") as File).text()).toBe(await source.text());
      expect(new Headers(request.headers).has("content-type")).toBe(false);
    },
  );

  it("should send POST request to given endpoint", async () => {
    await gql(
      // @ts-expect-error variables is actually optional
      { query },
    );

    expect(fetch).toBeCalledTimes(1);
    expect(fetch.mock.lastCall?.[0]).toBe("https://example.com/graphql");
    const ctx = fetch.mock.lastCall?.[1] as RequestInit;
    expect(ctx.method).toBe("POST");
  });

  it("should send with correct graphql JSON body", async () => {
    await gql({
      query,
      // @ts-expect-error forgive the fake variables
      variables: { a: 1, b: "2", c: { d: false } },
    });

    expect(fetch.mock.lastCall?.[1]).toEqual(
      expect.objectContaining({
        body: '{"query":"query { field }","variables":{"a":1,"b":"2","c":{"d":false}},"operationName":"query"}',
        headers: expect.objectContaining({
          "content-type": "application/json",
          "x-operation-name": "query",
        }),
        method: "POST",
      }),
    );
  });

  it("should correctly ignore nil variables", async () => {
    await gql({
      query,
      // @ts-expect-error forgive the fake variables
      variables: { a: false, b: null, c: undefined },
    });

    expect(fetch.mock.lastCall?.[1].body).toMatchInlineSnapshot(
      `"{"query":"query { field }","variables":{"a":false,"b":null},"operationName":"query"}"`,
    );

    await gql({
      query,
      // @ts-expect-error forgive the fake variables
      variables: { a: false, b: null, c: undefined },
      keepNilVariables: false,
    });

    expect(fetch.mock.lastCall?.[1].body).toMatchInlineSnapshot(
      `"{"query":"query { field }","variables":{"a":false},"operationName":"query"}"`,
    );
  });

  it("deduplicates concurrent identical generated queries", async () => {
    let resolve!: (v: Response) => void;
    const pending = new Promise<Response>((r) => {
      resolve = r;
    });
    fetch.mockReturnValue(pending);

    expect(serverConfigQuery.kind).toBe("query");
    const p1 = gql({ query: serverConfigQuery, variables: void 0 });
    const p2 = gql({ query: serverConfigQuery, variables: void 0 });

    // Only one network request should have been issued
    expect(fetch).toBeCalledTimes(1);

    resolve(
      new Response(JSON.stringify({ data: { field: 42 } }), {
        headers: { "content-type": "application/json" },
      }),
    );

    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1).toEqual({ field: 42 });
    expect(r2).toEqual({ field: 42 });
    // Still only one fetch call
    expect(fetch).toBeCalledTimes(1);
  });

  it("keeps equal generated mutations as independent write intentions", async () => {
    let resolveFirst!: (value: Response) => void;
    let resolveSecond!: (value: Response) => void;
    fetch
      .mockReturnValueOnce(
        new Promise<Response>((resolve) => {
          resolveFirst = resolve;
        }),
      )
      .mockReturnValueOnce(
        new Promise<Response>((resolve) => {
          resolveSecond = resolve;
        }),
      );

    expect(createWorkspaceEventMutation.kind).toBe("mutation");
    const first = gql({
      query: createWorkspaceEventMutation,
      variables: {} as never,
    });
    const second = gql({
      query: createWorkspaceEventMutation,
      variables: {} as never,
    });

    expect(fetch).toBeCalledTimes(2);
    resolveFirst(
      new Response(JSON.stringify({ data: { sequence: "first" } }), {
        headers: { "content-type": "application/json" },
      }),
    );
    resolveSecond(
      new Response(JSON.stringify({ data: { sequence: "second" } }), {
        headers: { "content-type": "application/json" },
      }),
    );

    await expect(first).resolves.toEqual({ sequence: "first" });
    await expect(second).resolves.toEqual({ sequence: "second" });
  });

  it("does not deduplicate operations with unknown kind", async () => {
    const pending = new Promise<Response>(() => {});
    fetch.mockReturnValue(pending);

    void gql({ query, variables: void 0 });
    void gql({ query, variables: void 0 });

    expect(fetch).toBeCalledTimes(2);
  });

  it("does not deduplicate requests with different variables", async () => {
    // @ts-expect-error forgive the fake variables
    await gql({ query, variables: { id: "1" } });
    // @ts-expect-error forgive the fake variables
    await gql({ query, variables: { id: "2" } });
    expect(fetch).toBeCalledTimes(2);
  });

  it("does not share cancellation ownership between abortable requests", async () => {
    const firstController = new AbortController();
    const secondController = new AbortController();
    const pending = new Promise<Response>(() => {});
    fetch.mockReturnValue(pending);

    void gql({
      query: serverConfigQuery,
      variables: void 0,
      signal: firstController.signal,
    });
    void gql({
      query: serverConfigQuery,
      variables: void 0,
      signal: secondController.signal,
    });

    expect(fetch).toBeCalledTimes(2);
    expect(fetch.mock.calls[0]?.[1].signal).toBe(firstController.signal);
    expect(fetch.mock.calls[1]?.[1].signal).toBe(secondController.signal);
  });

  it("allows a second identical request after the first has settled", async () => {
    await gql({ query: serverConfigQuery, variables: void 0 });
    await gql({ query: serverConfigQuery, variables: void 0 });
    expect(fetch).toBeCalledTimes(2);
  });

  it("cleans up a rejected generated query before an identical retry", async () => {
    fetch
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ errors: [{ message: "temporary" }] }), {
          headers: { "content-type": "application/json" },
          status: 500,
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ data: { recovered: true } }), {
          headers: { "content-type": "application/json" },
        }),
      );

    await expect(
      gql({ query: serverConfigQuery, variables: void 0 }),
    ).rejects.toThrow("temporary");
    await expect(
      gql({ query: serverConfigQuery, variables: void 0 }),
    ).resolves.toEqual({ recovered: true });
    expect(fetch).toBeCalledTimes(2);
  });

  it("should correct handle graphql error", async () => {
    fetch.mockResolvedValue(
      new Response(
        JSON.stringify({
          data: null,
          errors: [{ message: "error", path: ["field"] }],
        }),
        {
          headers: {
            "content-type": "application/json",
          },
          status: 400,
        },
      ),
    );

    await expect(
      gql({ query, variables: void 0 }),
    ).rejects.toMatchInlineSnapshot(`[GraphQLError: error]`);
  });
});
