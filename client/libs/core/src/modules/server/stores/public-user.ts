import { getPublicUserByIdQuery } from "@myoxus/graphql";
import { Store } from "@myoxus/infra";

import type { GraphQLService } from "../services/graphql";

export class PublicUserStore extends Store {
  constructor(private readonly gqlService: GraphQLService) {
    super();
  }

  async getPublicUserById(id: string, signal?: AbortSignal) {
    const result = await this.gqlService.gql({
      query: getPublicUserByIdQuery,
      variables: {
        id,
      },
      context: {
        signal,
      },
    });

    return result.publicUserById;
  }
}
