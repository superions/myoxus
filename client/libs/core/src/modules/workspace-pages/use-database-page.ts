// SPDX-License-Identifier: AGPL-3.0-or-later

import { GraphQLService } from "@myoxus/core/modules/server";
import { databaseSummaryQuery } from "@myoxus/graphql";
import { useService } from "@myoxus/infra";
import { useCallback, useEffect, useRef, useState } from "react";

import {
  type DatabasePageRecord,
  projectDatabasePage,
} from "./database-page-loader";

export type DatabasePageState = DatabasePageRecord | null | undefined;

/**
 * Resolve one authorized Database Page for persisted navigation projections.
 * `undefined` is loading and `null` deliberately covers missing, forbidden and
 * stale links so structure trees never expose a dead route or log query noise.
 */
export function useDatabasePage(
  workspaceId: string | null,
  databaseId: string,
) {
  const graphqlService = useService(GraphQLService);
  const generation = useRef(0);
  const [reloadToken, setReloadToken] = useState(0);
  const [record, setRecord] = useState<DatabasePageState>(undefined);

  useEffect(() => {
    const activeGeneration = ++generation.current;
    setRecord(undefined);

    if (!workspaceId) {
      setRecord(null);
      return;
    }

    // Do not pass an AbortSignal here. The shared GraphQL transport de-duplicates
    // identical in-flight requests, so aborting React StrictMode's probe mount
    // would also reject the replacement mount's request. The generation guard
    // below still prevents stale or unmounted consumers from observing results.
    void graphqlService
      .gql({
        query: databaseSummaryQuery,
        variables: { workspaceId, databaseId },
      })
      .then((response) => {
        if (generation.current !== activeGeneration) return;
        const database = response.workspace?.databaseSummary;
        setRecord(database ? projectDatabasePage(database) : null);
      })
      .catch(() => {
        if (generation.current === activeGeneration) {
          setRecord(null);
        }
      });

    return () => {
      if (generation.current === activeGeneration) generation.current += 1;
    };
  }, [databaseId, graphqlService, reloadToken, workspaceId]);

  const reload = useCallback(() => setReloadToken((token) => token + 1), []);
  return { record, reload };
}
