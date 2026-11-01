/**
 * Hook to fetch the server setup status.
 *
 * Uses the `serverSetupStatusQuery` from @myoxus/graphql to check:
 * - persisted wizard completion independently from operational readiness;
 * - server-owned authentication method capabilities;
 * - locale-neutral critical and warning findings.
 */
import useSWR from "swr";

import { fetchServerSetupStatus } from "../api/setup-bootstrap-api";

export function useServerSetupStatus() {
  const { data, error, isLoading, mutate } = useSWR(
    ["serverSetupStatus"],
    fetchServerSetupStatus,
    {
      revalidateOnFocus: false,
      revalidateOnMount: true,
      dedupingInterval: 0, // Always fetch fresh
    },
  );

  return {
    data,
    isLoading,
    error,
    refetch: mutate,
  };
}
