/**
 * @file fetcher.ts — @myoxus/graphql
 *
 * Core HTTP transport layer for GraphQL operations.
 *
 * This file contains locally-adapted logic (beyond what code-generation
 * produces): file-upload multipart handling (GraphQL multipart request spec),
 * nil-variable filtering, per-request timeouts, and a factory pattern that
 * allows consumers to inject a custom `fetch` implementation (e.g. for tests
 * or Electron's net module).
 *
 * Consumers: `client/admin`, `client/web`.
 */

import { DebugLogger } from "@myoxus/debug";
import { GraphQLError } from "@myoxus/error";
import type { ExecutionResult } from "graphql";
import { isNil, isObject, merge } from "lodash-es";

import type { GraphQLQuery } from "./graphql";
import type { Mutations, Queries } from "./operations";

/** Ensures a type is not an array. Used to constrain response-data types. */
export type NotArray<T> = T extends Array<unknown> ? never : T;

/** Extends the standard `RequestInit` with an optional request timeout in milliseconds. */
export type FetchInit = RequestInit & { timeout?: number };

/**
 * Resolves the variable type for a given query/mutation, falling back to
 * `undefined` when the operation has no variables.
 *
 * @internal Prefer {@link QueryVariables} for external use.
 */
export type _QueryVariables<Q extends GraphQLQuery> =
  Q["id"] extends Queries["name"]
    ? Extract<Queries, { name: Q["id"] }>["variables"]
    : Q["id"] extends Mutations["name"]
      ? Extract<Mutations, { name: Q["id"] }>["variables"]
      : undefined;

/**
 * Resolves to the variable type required by a query/mutation, or `never` when
 * the operation takes no variables.
 */
export type QueryVariables<Q extends GraphQLQuery> =
  _QueryVariables<Q> extends never | Record<string, never>
    ? never
    : _QueryVariables<Q>;

/** Resolves to the response data type for a given query or mutation. */
export type QueryResponse<Q extends GraphQLQuery> = Extract<
  Queries | Mutations,
  { name: Q["id"] }
>["response"];

type NullableKeys<T> = {
  [K in keyof T]: null extends T[K] ? K : never;
}[keyof T];

type NonNullableKeys<T> = {
  [K in keyof T]: null extends T[K] ? never : K;
}[keyof T];

/**
 * Recursively makes all nullable fields optional.
 *
 * Used to allow callers to omit nullable variables rather than explicitly
 * passing `null`.
 */
export type RecursiveMaybeFields<T> = T extends
  number | boolean | string | null | undefined
  ? T
  : {
      [K in NullableKeys<T>]?: RecursiveMaybeFields<T[K]>;
    } & {
      [K in NonNullableKeys<T>]: RecursiveMaybeFields<T[K]>;
    };

type AllowedRequestContext = Omit<RequestInit, "method" | "body">;

/**
 * The JSON body sent to the GraphQL endpoint.
 *
 * When the operation includes file uploads, `form` is populated and the body
 * is encoded as multipart/form-data instead of JSON (see {@link transformToForm}).
 */
export interface RequestBody {
  operationName?: string;
  variables: any;
  query: string;
  form?: FormData;
}

type QueryVariablesOption<Q extends GraphQLQuery> =
  QueryVariables<Q> extends never
    ? {
        variables?: undefined;
      }
    : { variables: RecursiveMaybeFields<QueryVariables<Q>> };

export type RequestOptions<Q extends GraphQLQuery> = QueryVariablesOption<Q> & {
  /**
   * parameter passed to `fetch` function
   */
  context?: AllowedRequestContext;
  /**
   * Whether keep null or undefined value in variables.
   *
   * if `false` given, `{ a: 0, b: undefined, c: null }` will be converted to `{ a: 0 }`
   *
   * @default true
   */
  keepNilVariables?: boolean;
  /**
   * Request timeout in milliseconds
   * @default 15000
   */
  timeout?: number;
  /**
   * Abort signal
   */
  signal?: AbortSignal;
};

/** Options for {@link gqlFetcherFactory} query calls. */
export type QueryOptions<Q extends GraphQLQuery> = RequestOptions<Q> & {
  query: Q;
};
/** Options for {@link gqlFetcherFactory} mutation calls. */
export type MutationOptions<M extends GraphQLQuery> = RequestOptions<M> & {
  mutation: M;
};

/**
 * Recursively strips `null` and `undefined` values from a variables object.
 *
 * Used when `keepNilVariables` is `false` so that the GraphQL server does not
 * receive explicit `null` fields that the caller merely omitted.
 *
 * `File` instances are intentionally excluded from object recursion — they must
 * remain at the top level of the variable tree so that {@link transformToForm}
 * can discover them.
 *
 * @internal Not exported; invoked by {@link formatRequestBody}.
 */
function filterEmptyValue(vars: any) {
  const newVars: Record<string, any> = {};
  Object.entries(vars).forEach(([key, value]) => {
    if (isNil(value)) {
      return;
    }
    if (isObject(value) && !(value instanceof File)) {
      newVars[key] = filterEmptyValue(value);
      return;
    }
    newVars[key] = value;
  });

  return newVars;
}

/**
 * Converts a GraphQL request body containing `File` variables into a
 * multipart/form-data payload following the
 * [GraphQL multipart request spec](https://github.com/jaydenseric/graphql-multipart-request-spec).
 *
 * @param body - The JSON request body that contains one or more `File` values
 *   nested anywhere inside `variables`.
 */
export function transformToForm(body: RequestBody) {
  const form = new FormData();
  const gqlBody: {
    name?: string;
    query: string;
    variables: any;
    map: any;
  } = {
    query: body.query,
    variables: body.variables,
    map: {},
  };

  if (body.operationName) {
    gqlBody.name = body.operationName;
  }
  const map: Record<string, string[]> = {};
  const files: File[] = [];
  if (body.variables) {
    let i = 0;
    const buildMap = (key: string, value: any) => {
      if (value instanceof File) {
        map["" + i] = [key];
        files[i] = value;
        i++;
      } else if (Array.isArray(value)) {
        value.forEach((v, index) => {
          buildMap(`${key}.${index}`, v);
        });
      } else if (isObject(value)) {
        Object.entries(value).forEach(([k, v]) => {
          buildMap(`${key}.${k}`, v);
        });
      }
    };
    buildMap("variables", body.variables);
  }

  form.set("operations", JSON.stringify(gqlBody));
  form.set("map", JSON.stringify(map));
  for (const [i, file] of files.entries()) {
    form.set(`${i}`, file);
  }
  return form;
}

/**
 * Serialises a {@link QueryOptions} object into either a JSON {@link RequestBody}
 * or a `FormData` multipart payload.
 *
 * Multipart encoding is triggered when `query.file` is `true`, which signals
 * that at least one variable is a `File` instance.
 *
 * @internal Used only by the closure returned from {@link gqlFetcherFactory}.
 */
function formatRequestBody<Q extends GraphQLQuery>({
  query,
  variables,
  keepNilVariables,
}: QueryOptions<Q>): RequestBody | FormData {
  const body: RequestBody = {
    query: query.query,
    variables:
      (keepNilVariables ?? true) ? variables : filterEmptyValue(variables),
  };

  if (query.op) {
    body.operationName = query.op;
  }

  if (query.file) {
    return transformToForm(body);
  }
  return body;
}

/**
 * Creates a typed GraphQL fetch function bound to a specific endpoint.
 *
 * The returned function executes a query or mutation and returns the
 * strongly-typed `data` field from the response.  Errors from the server are
 * thrown as {@link GraphQLError}.
 *
 * @param endpoint - Absolute URL of the GraphQL endpoint (e.g. `/api/graphql`).
 * @param fetcher - Fetch implementation; defaults to the global `fetch`. Swap
 *   this in tests or Electron's `net.fetch` to customise transport behaviour.
 *
 * @example
 * ```ts
 * const gql = gqlFetcherFactory('/api/graphql');
 * const data = await gql({ query: GetUserQuery, variables: { id: '1' } });
 * ```
 */
export const gqlFetcherFactory = (
  endpoint: string,
  fetcher: (input: string, init?: FetchInit) => Promise<Response> = fetch,
) => {
  const logger = new DebugLogger("GraphQL");
  // Only generated Query operations may share an in-flight request. Mutations
  // represent independent write intentions even when their payloads are equal.
  const inFlight = new Map<string, Promise<any>>();

  const gqlFetch = async <Query extends GraphQLQuery>(
    options: QueryOptions<Query>,
  ): Promise<QueryResponse<Query>> => {
    if (
      BUILD_CONFIG.appBuildType === "internal" &&
      options.query.deprecations?.length
    ) {
      options.query.deprecations.forEach((deprecation) => {
        logger.warn(deprecation);
      });
    }

    const body = formatRequestBody(options);

    const isFormData = body instanceof FormData;
    const headers: Record<string, string> = {
      "x-operation-name": options.query.op,
    };
    if (!isFormData) {
      headers["content-type"] = "application/json";
    }

    const serialisedBody = isFormData ? null : JSON.stringify(body);

    // A request with a caller-owned AbortSignal must retain independent
    // cancellation ownership. Sharing an abortable promise lets one
    // superseded consumer cancel a newer identical request.
    const hasAbortSignal = Boolean(options.signal ?? options.context?.signal);
    const dedupeEligible =
      options.query.kind === "query" &&
      !isFormData &&
      serialisedBody !== null &&
      !hasAbortSignal;
    if (dedupeEligible) {
      const dedupeKey = options.query.op + ":" + serialisedBody;
      const existing = inFlight.get(dedupeKey);
      if (existing) {
        return existing;
      }
    }

    const ret = fetcher(
      endpoint,
      merge(options.context, {
        method: "POST",
        headers,
        body: isFormData ? body : serialisedBody,
        timeout: options.timeout,
        signal: options.signal,
      }),
    ).then(async (res) => {
      if (res.headers.get("content-type")?.startsWith("application/json")) {
        const result = (await res.json()) as ExecutionResult;
        if (res.status >= 400 || result.errors) {
          if (result.errors && result.errors.length > 0) {
            // throw the first error is enough
            const firstError = result.errors[0];
            throw new GraphQLError(firstError.message, firstError);
          } else {
            throw new GraphQLError("Empty GraphQL error body");
          }
        } else if (result.data) {
          // we have to cast here because the type of result.data is a union type
          return result.data as any;
        }
      }

      throw new GraphQLError(
        "GraphQL query responds unexpected result, query " + options.query.op,
      );
    });

    // Register in in-flight map and clean up on settlement.
    if (dedupeEligible) {
      const dedupeKey = options.query.op + ":" + serialisedBody;
      inFlight.set(dedupeKey, ret);
      ret.then(
        () => {
          inFlight.delete(dedupeKey);
        },
        () => {
          inFlight.delete(dedupeKey);
        },
      );
    }

    return ret;
  };

  return gqlFetch;
};
