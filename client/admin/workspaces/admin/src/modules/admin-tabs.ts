// SPDX-License-Identifier: AGPL-3.0-or-later
import { useCallback, useEffect, useState } from "react";

/**
 * Syncs validated top-level tabs with bookmarks and browser history, preserving
 * unrelated query parameters and anchors. Re-selecting a tab adds no history.
 */
export function useUrlSyncedAdminTab<T extends string>(
  tabIds: readonly T[],
  fallback: T,
): [T, (next: string) => void] {
  const resolve = useCallback(
    (candidate: string | null | undefined): T => {
      if (candidate && tabIds.includes(candidate as T)) {
        return candidate as T;
      }
      return fallback;
    },
    [fallback, tabIds],
  );

  const [activeTab, setActiveTab] = useState<T>(() => {
    if (typeof window === "undefined") return fallback;
    return resolve(new URLSearchParams(window.location.search).get("tab"));
  });

  useEffect(() => {
    if (typeof window === "undefined") return;
    const syncFromUrl = () =>
      setActiveTab(
        resolve(new URLSearchParams(window.location.search).get("tab")),
      );
    // A retained panel can reactivate after history changed while it was hidden.
    syncFromUrl();
    window.addEventListener("popstate", syncFromUrl);
    return () => window.removeEventListener("popstate", syncFromUrl);
  }, [resolve]);

  const setSyncedTab = useCallback(
    (next: string) => {
      const resolved = resolve(next);
      setActiveTab(resolved);
      if (typeof window === "undefined") return;
      const url = new URL(window.location.href);
      if (resolved === fallback) {
        url.searchParams.delete("tab");
      } else {
        url.searchParams.set("tab", resolved);
      }
      if (url.href !== window.location.href) {
        window.history.pushState(
          window.history.state,
          "",
          `${url.pathname}${url.search}${url.hash}`,
        );
      }
    },
    [fallback, resolve],
  );

  return [activeTab, setSyncedTab];
}
