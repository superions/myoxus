import { getCurrentUserProfileQuery } from "@myoxus/graphql";
import { Store } from "@myoxus/infra";

import type { GraphQLService } from "../services/graphql";

export class UserCopilotQuotaStore extends Store {
  constructor(private readonly graphqlService: GraphQLService) {
    super();
  }

  async fetchUserCopilotQuota(abortSignal?: AbortSignal) {
    const data = await this.graphqlService.gql({
      query: getCurrentUserProfileQuery,
      context: {
        signal: abortSignal,
      },
    });

    if (!data.currentUser) {
      throw new Error("No logged in");
    }

    return data.currentUser.copilot.quota;
  }
}
