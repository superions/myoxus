// SPDX-License-Identifier: AGPL-3.0-or-later
import { documentFieldOutputQuery } from "@myoxus/graphql";
import type { DocumentFieldOutputProvider } from "@virgultum/editor/shared/services";
import type { DocumentField } from "@virgultum/editor/shared/types";
import type { GraphQLService } from "../../server/services/graphql";

/** No field cache: each adapter operation resolves its captured descriptors
 * through the server's current metadata/identity/regional owners. This capability
 * does not authorize an embed; its guarded native loader remains responsible.
 */
export class CoreDocumentFieldOutputProvider implements DocumentFieldOutputProvider {
  constructor(
    private readonly graphql: GraphQLService | undefined,
    readonly workspaceId: string,
    readonly docId?: string,
  ) {}

  async resolve(
    workspaceId: string,
    docId: string,
    fields: readonly DocumentField[],
  ) {
    if (!this.graphql)
      throw new Error("Native field output context unavailable");
    const result = await this.graphql.gql({
      query: documentFieldOutputQuery,
      variables: { workspaceId, docId, fields },
      context: { signal: AbortSignal.timeout(30_000) },
    });
    return result.documentFieldOutput;
  }
}
