// SPDX-License-Identifier: AGPL-3.0-or-later
import { UserFriendlyError } from "@myoxus/error";
import {
  adminOidcGroupDirectoryQuery,
  type AdminOidcGroupDirectoryQuery,
} from "@myoxus/graphql";
import { useCallback, useEffect, useRef, useState } from "react";

import { gqlFetcher } from "../../use-query";

export type OidcDirectoryEntry =
  AdminOidcGroupDirectoryQuery["admin"]["oidcGroupDirectory"]["entries"][number];
export type OidcDirectoryState =
  | { kind: "idle" | "loading" }
  | { kind: "error"; message: string }
  | { kind: "loaded"; entries: OidcDirectoryEntry[] };

/** One explicit read of the saved connection. Never share an older in-flight
 * request: a replacement credential has the same masked configuration identity.
 */
export function useOidcGroupDirectory(identity: string, blocked: boolean) {
  const active = useRef<AbortController | null>(null);
  const [result, setResult] = useState<{
    identity: string;
    state: OidcDirectoryState;
  } | null>(null);
  const invalidate = useCallback(() => {
    active.current?.abort();
    active.current = null;
    setResult(null);
  }, []);

  useEffect(() => {
    invalidate();
    return () => {
      active.current?.abort();
      active.current = null;
    };
  }, [identity, blocked, invalidate]);

  const load = async () => {
    if (blocked || active.current) return;
    const controller = new AbortController();
    active.current = controller;
    setResult({ identity, state: { kind: "loading" } });
    try {
      const response = await gqlFetcher({
        query: adminOidcGroupDirectoryQuery,
        signal: controller.signal,
        timeout: 20_000,
      });
      if (active.current !== controller || controller.signal.aborted) return;
      setResult({
        identity,
        state: {
          kind: "loaded",
          entries: response.admin.oidcGroupDirectory.entries,
        },
      });
    } catch (error) {
      if (active.current !== controller || controller.signal.aborted) return;
      setResult({
        identity,
        state: {
          kind: "error",
          message: UserFriendlyError.fromAny(error).message,
        },
      });
    } finally {
      if (active.current === controller) active.current = null;
    }
  };

  // Hide retired data in the render that changes ownership, before effects run.
  const state: OidcDirectoryState =
    !blocked && result?.identity === identity ? result.state : { kind: "idle" };
  return { state, load, invalidate };
}
