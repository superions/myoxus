// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { DebugLogger } from "@myoxus/debug";
import { useEffect, useSyncExternalStore } from "react";
import { useSWRConfig } from "swr";

import { isProtectedAdminQueryKey } from "./query-cache";

export type AdminSessionInvalidationReason =
  "logout" | "rest-unauthorized" | "graphql-unauthorized" | "session-expired";

export type AdminTransportChannel =
  | "auth"
  | "download"
  | "graphql"
  | "health"
  | "runtime-theme"
  | "setup"
  | "technical-http";

export interface AdminSessionInvalidationContext {
  reason: AdminSessionInvalidationReason;
  channel?: AdminTransportChannel;
  operationName?: string;
  source?: string;
  status?: number;
}

export interface AdminSessionSnapshot {
  invalidated: boolean;
  version: number;
  context?: Readonly<AdminSessionInvalidationContext>;
}

const logger = new DebugLogger("AdminSession");
const listeners = new Set<() => void>();

let snapshot: AdminSessionSnapshot = Object.freeze({
  invalidated: false,
  version: 0,
});

function emit() {
  for (const listener of listeners) {
    listener();
  }
}

function publicContext(context: AdminSessionInvalidationContext) {
  return {
    reason: context.reason,
    channel: context.channel,
    operationName: context.operationName,
    source: context.source,
    status: context.status,
  };
}

export function getAdminSessionSnapshot(): AdminSessionSnapshot {
  return snapshot;
}

export function subscribeAdminSession(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useAdminSessionSnapshot() {
  return useSyncExternalStore(
    subscribeAdminSession,
    getAdminSessionSnapshot,
    getAdminSessionSnapshot,
  );
}

export function invalidateAdminSession(
  context: AdminSessionInvalidationContext,
): AdminSessionSnapshot {
  snapshot = Object.freeze({
    invalidated: true,
    version: snapshot.version + 1,
    context: Object.freeze({ ...context }),
  });
  logger.warn("admin session invalidated", publicContext(context));
  emit();
  return snapshot;
}

export function resetAdminSessionInvalidation(): AdminSessionSnapshot {
  snapshot = Object.freeze({
    invalidated: false,
    version: snapshot.version + 1,
  });
  logger.debug("admin session invalidation reset");
  emit();
  return snapshot;
}

/**
 * Bridges transport-level auth failures into SWR cache invalidation.
 * The transport cannot import React state, so it updates the small external
 * session store; this root component owns the SWR-side cache cleanup.
 */
export function AdminSessionInvalidationBridge() {
  const { mutate } = useSWRConfig();

  useEffect(() => {
    return subscribeAdminSession(() => {
      const current = getAdminSessionSnapshot();
      if (!current.invalidated) return;

      void mutate(isProtectedAdminQueryKey, undefined, { revalidate: false });
    });
  }, [mutate]);

  return null;
}
