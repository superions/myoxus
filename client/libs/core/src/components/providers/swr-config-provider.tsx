import { UserFriendlyError } from "@myoxus/error";
import { reserveAutomaticRetry } from "@myoxus/infra";
import { notify } from "@myoxus/ui-facade";
import { type PropsWithChildren, type ReactNode, useCallback } from "react";
import { SWRConfig, type SWRConfiguration } from "swr";
import { defaultConfig } from "swr/_internal";

/** Provider-owned options also apply to SWR Infinite, which forwards its
 * configuration through the same notification middleware. */
export type SWRFailureNotificationOptions = {
  suppressErrorNotification?: boolean;
};

const swrConfig: SWRConfiguration = {
  suspense: true,
  onErrorRetry(error, key, config, revalidate, options) {
    defaultConfig.onErrorRetry(
      error,
      key,
      config,
      (nextOptions) => {
        if (reserveAutomaticRetry("swr")) {
          revalidate(nextOptions);
        }
      },
      options,
    );
  },
  use: [
    (useSWRNext) => (key, fetcher, config) => {
      const fetcherWrapper = useCallback(
        async (...args: any[]) => {
          if (!fetcher) {
            throw new Error("fetcher is not found");
          }
          const d = fetcher(...args);
          if (d instanceof Promise) {
            return d.catch((e) => {
              const error = UserFriendlyError.fromAny(e);

              if (shouldNotifySWRFailure(error, config)) {
                notify.error({
                  title: error.name,
                  message: error.message,
                });
              }

              throw e;
            });
          }
          return d;
        },
        [fetcher],
      );
      return useSWRNext(key, fetcher ? fetcherWrapper : fetcher, config);
    },
  ],
};

/**
 * Expected stale-write conflicts are rendered by the Database conflict modal.
 * Emitting the generic transport notification as well would expose a raw error
 * code and leave two competing error surfaces on screen. All other failures
 * retain the shared notification behavior unless the caller explicitly opts
 * out for a route-owned error state.
 */
export function shouldNotifySWRFailure(
  error: UserFriendlyError,
  config: SWRConfiguration & SWRFailureNotificationOptions,
): boolean {
  return !config.suppressErrorNotification && !error.isDatabaseConflict();
}

export const SWRConfigProvider = (props: PropsWithChildren): ReactNode => {
  return <SWRConfig value={swrConfig}>{props.children}</SWRConfig>;
};
