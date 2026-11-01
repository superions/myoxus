import { UserFriendlyError } from "@myoxus/error";
import {
  gqlFetcherFactory,
  type GraphQLQuery,
  type QueryOptions,
  type QueryResponse,
} from "@myoxus/graphql";
import { fromPromise, Service } from "@myoxus/infra";
import type { Observable } from "rxjs";

import { AuthService } from "./auth";
import type { FetchService } from "./fetch";

export interface MyoxusGraphQLClientContext {
  client: string;
  clientFormat: string;
  clientCapabilities: string;
}

const DEFAULT_GRAPHQL_CLIENT_CONTEXT: MyoxusGraphQLClientContext = {
  client: "core",
  clientFormat: "myoxus-native",
  clientCapabilities: "document-metadata",
};

let graphqlClientContext: MyoxusGraphQLClientContext = {
  ...DEFAULT_GRAPHQL_CLIENT_CONTEXT,
};

export function configureMyoxusGraphQLClientContext(
  context: Partial<MyoxusGraphQLClientContext>,
): () => void {
  const previous = graphqlClientContext;
  graphqlClientContext = {
    ...DEFAULT_GRAPHQL_CLIENT_CONTEXT,
    ...context,
  };
  return () => {
    graphqlClientContext = previous;
  };
}

export function resetMyoxusGraphQLClientContext() {
  graphqlClientContext = { ...DEFAULT_GRAPHQL_CLIENT_CONTEXT };
}

function currentClientContextHeaders() {
  return {
    "x-myoxus-client": graphqlClientContext.client,
    "x-myoxus-client-format": graphqlClientContext.clientFormat,
    "x-myoxus-client-capabilities": graphqlClientContext.clientCapabilities,
  } as const;
}

function headersToRecord(headers: Headers): Record<string, string> {
  return Object.fromEntries(headers.entries());
}

export function withMyoxusClientContextHeaders<Query extends GraphQLQuery>(
  context: QueryOptions<Query>["context"],
): QueryOptions<Query>["context"] {
  const headers = new Headers(context?.headers);
  for (const [key, value] of Object.entries(currentClientContextHeaders())) {
    if (!headers.has(key)) {
      headers.set(key, value);
    }
  }
  return {
    ...context,
    // FetchService and the shared GraphQL fetcher both merge/spread headers.
    // Return a plain record so native client-context headers survive that path.
    headers: headersToRecord(headers),
  };
}

export class GraphQLService extends Service {
  constructor(private readonly fetcher: FetchService) {
    super();
  }

  private readonly rawGql = gqlFetcherFactory("/graphql", this.fetcher.fetch);

  rxGql = <Query extends GraphQLQuery>(
    options: QueryOptions<Query>,
  ): Observable<QueryResponse<Query>> => {
    return fromPromise((signal) => {
      return this.gql({
        ...options,
        context: {
          signal,
          ...options.context,
        },
      } as any);
    });
  };

  gql = async <Query extends GraphQLQuery>(
    options: QueryOptions<Query>,
  ): Promise<QueryResponse<Query>> => {
    try {
      return await this.rawGql({
        ...options,
        context: withMyoxusClientContextHeaders(options.context),
      } as unknown as QueryOptions<Query>);
    } catch (anyError) {
      const error = UserFriendlyError.fromAny(anyError);

      if (error.isStatus(401)) {
        this.framework.get(AuthService).session.revalidate();
      }

      throw error;
    }
  };
}
