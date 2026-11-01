/**
 * Hook to update admin configuration via the `adminUpdateConfig` mutation.
 *
 * Saves configuration changes to the database (hot-reload enabled).
 * Returns loading state and error handling.
 */
import {
  type AdminConfigUpdateResultType,
  adminUpdateConfigMutation,
} from "@myoxus/graphql";
import { useI18n } from "@myoxus/i18n";
import { notify } from "@myoxus/ui-facade";
import { useCallback, useState } from "react";

import { useMutation } from "../use-mutation";

interface UpdateConfigParams {
  module: string;
  key: string;
  value: unknown;
}

export function useAdminUpdateConfig() {
  const i18n = useI18n();
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { trigger } = useMutation({ mutation: adminUpdateConfigMutation });

  const mutateMany = useCallback(
    async (updates: UpdateConfigParams[]) => {
      setIsLoading(true);
      setError(null);

      try {
        const envelope = (await trigger({
          updates,
        })) as {
          admin?: { adminUpdateConfig?: AdminConfigUpdateResultType };
        };
        const result = envelope.admin?.adminUpdateConfig;
        if (!result) {
          throw new Error("No response from server");
        }

        if (!result.applied || result.fieldErrors?.length > 0) {
          throw new Error(
            result.fieldErrors[0]?.message ??
              i18n.t("admin.common.save-failed"),
          );
        }

        if (result.writeback === "failed") {
          // Persistence succeeded; report only the recoverable optional-mirror
          // failure and leave callers free to continue their successful flow.
          notify.warning({
            title: i18n.t("admin.config.saved-mirror-warning"),
            message: i18n.t("admin.config.saved-mirror-warning-description"),
          });
        }

        return result;
      } catch (err) {
        const message = err instanceof Error ? err.message : "Unknown error";
        setError(message);
        throw err;
      } finally {
        setIsLoading(false);
      }
    },
    [i18n, trigger],
  );

  const mutate = useCallback(
    (params: UpdateConfigParams) => mutateMany([params]),
    [mutateMany],
  );

  return { mutate, mutateMany, isLoading, error };
}
