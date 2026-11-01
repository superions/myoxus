import {
  createMcpApiKeyMutation,
  generateUserAccessTokenMutation,
  type ListMcpApiKeysQuery,
  listMcpApiKeysQuery,
  type ListUserAccessTokensQuery,
  listUserAccessTokensQuery,
  revokeMcpApiKeyMutation,
  revokeUserAccessTokenMutation,
} from "@myoxus/graphql";
import { Store } from "@myoxus/infra";

import type { GraphQLService } from "../services/graphql";

export type AccessToken = NonNullable<
  ListUserAccessTokensQuery["currentUser"]
>["revealedAccessTokens"][number];

export type McpApiKey =
  ListMcpApiKeysQuery["apiKeys"]["listApiKeys"][number] & {
    key?: string;
  };

export class AccessTokenStore extends Store {
  constructor(private readonly gqlService: GraphQLService) {
    super();
  }

  async listUserAccessTokens(signal?: AbortSignal): Promise<AccessToken[]> {
    const data = await this.gqlService.gql({
      query: listUserAccessTokensQuery,
      context: { signal },
    });

    return data.currentUser?.revealedAccessTokens ?? [];
  }

  async generateUserAccessToken(
    name: string,
    expiresAt?: string,
    signal?: AbortSignal,
  ) {
    const data = await this.gqlService.gql({
      query: generateUserAccessTokenMutation,
      variables: { input: { name, expiresAt } },
      context: { signal },
    });

    return data.generateUserAccessToken;
  }

  async revokeUserAccessToken(id: string, signal?: AbortSignal) {
    const data = await this.gqlService.gql({
      query: revokeUserAccessTokenMutation,
      variables: { id },
      context: { signal },
    });

    return data.revokeUserAccessToken;
  }

  async listMcpApiKeys(signal?: AbortSignal): Promise<McpApiKey[]> {
    const data = await this.gqlService.gql({
      query: listMcpApiKeysQuery,
      context: { signal },
    });

    return data.apiKeys.listApiKeys;
  }

  async createMcpApiKey(
    name: string,
    scopes: string[],
    expiresInDays?: number,
    signal?: AbortSignal,
  ): Promise<McpApiKey> {
    const data = await this.gqlService.gql({
      query: createMcpApiKeyMutation,
      variables: { name, scopes, expiresInDays },
      context: { signal },
    });

    const created = data.apiKeys.createApiKey;
    return {
      ...created,
      key: created.key,
      createdAt: new Date().toISOString(),
      lastUsedAt: null,
    };
  }

  async revokeMcpApiKey(id: string, signal?: AbortSignal) {
    const data = await this.gqlService.gql({
      query: revokeMcpApiKeyMutation,
      variables: { id },
      context: { signal },
    });

    return data.apiKeys.revokeApiKey;
  }
}
