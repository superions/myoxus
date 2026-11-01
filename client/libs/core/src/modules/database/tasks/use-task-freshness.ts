// SPDX-License-Identifier: AGPL-3.0-or-later

import { ServerDeploymentType } from "@myoxus/graphql";
import {
  acquireCloudSpaceRoom,
  SocketConnection,
  type ServerEventsMap,
} from "@myoxus/storage/cloud";
import { useEffect, useRef, useState } from "react";

import type { useTaskIdentity } from "./use-workspace-tasks";

/** Shared hint/reconnect lease for bounded Task projections. The returned
 * disposer owns its socket, room, scheduled reads and delayed completions.
 */
export function subscribeTaskFreshness(
  owner: ReturnType<typeof useTaskIdentity>,
  refresh: () => Promise<unknown>,
  onLive: (live: boolean) => void,
  acceptsHint?: (
    message: Parameters<ServerEventsMap["database:tasks-changed"]>[0],
  ) => boolean,
) {
  const { identity, server, workspace, availability } = owner;
  if (!identity || !server || availability.status !== "available")
    return () => {};
  let disposed = false;
  let scope: AbortController | undefined;
  let acknowledged: AbortController | undefined;
  let cleanupRoom: (() => void) | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let running = false;
  let again = false;
  const mark = (live: boolean) => {
    if (!disposed) onLive(live);
  };
  const schedule = () => {
    if (disposed || !navigator.onLine) return;
    if (running) {
      again = true;
      return;
    }
    if (timer !== undefined) return;
    timer = setTimeout(async () => {
      timer = undefined;
      if (disposed || !navigator.onLine) return;
      running = true;
      // A previous room's slow completion must not overwrite a newer ACK.
      // Current successful reads also recover a transient refresh failure.
      const refreshing = scope;
      const currentAcknowledgedRoom = () =>
        refreshing &&
        scope === refreshing &&
        acknowledged === refreshing &&
        !refreshing.signal.aborted &&
        navigator.onLine;
      try {
        await refresh();
        if (currentAcknowledgedRoom()) mark(true);
      } catch {
        if (currentAcknowledgedRoom()) mark(false);
      } finally {
        // Canonical query owns visible read errors/retry.
        running = false;
        if (again) {
          again = false;
          schedule();
        }
      }
    }, 0);
  };
  const connection = new SocketConnection(
    server.baseUrl,
    server.config$.value.type === ServerDeploymentType.Standalone,
    server.id,
  );
  const stopRoom = () => {
    acknowledged = undefined;
    scope?.abort();
    scope = undefined;
    cleanupRoom?.();
    cleanupRoom = undefined;
    mark(false);
  };
  const connected = () => {
    stopRoom();
    if (disposed || !navigator.onLine) return;
    const socket = connection.maybeConnection?.socket;
    if (!socket?.connected) return;
    const owned = new AbortController();
    scope = owned;
    const hint: ServerEventsMap["database:tasks-changed"] = (message) => {
      if (
        !owned.signal.aborted &&
        message.workspaceId === workspace.id &&
        (!acceptsHint || acceptsHint(message))
      )
        schedule();
    };
    socket.on("database:tasks-changed", hint);
    const lease = acquireCloudSpaceRoom(
      socket,
      "workspace",
      workspace.id,
      owned.signal,
    );
    cleanupRoom = () => {
      socket.off("database:tasks-changed", hint);
      lease.release();
    };
    void lease.ready.then(
      () => {
        if (
          owned.signal.aborted ||
          disposed ||
          scope !== owned ||
          !navigator.onLine
        )
          return;
        acknowledged = owned;
        schedule(); // Reconcile writes missed before join or during disconnect.
      },
      () => {
        if (!owned.signal.aborted) mark(false);
      },
    );
  };
  const unsubscribe = connection.onStatusChanged((value) => {
    if (value === "connected") connected();
    else stopRoom();
  });
  const focus = () => {
    if (connection.status === "connected") connected();
  };
  const visible = () => {
    if (document.visibilityState === "visible") focus();
  };
  // Browser offline does not necessarily disconnect an existing WebSocket.
  // Reacquire its room online and reconcile before advertising Live again.
  const offline = () => stopRoom();
  window.addEventListener("offline", offline);
  window.addEventListener("online", focus);
  window.addEventListener("focus", focus);
  document.addEventListener("visibilitychange", visible);
  connection.connect();
  if (connection.status === "connected") connected();
  return () => {
    disposed = true;
    if (timer !== undefined) clearTimeout(timer);
    window.removeEventListener("offline", offline);
    window.removeEventListener("online", focus);
    window.removeEventListener("focus", focus);
    document.removeEventListener("visibilitychange", visible);
    stopRoom();
    unsubscribe();
    connection.disconnect();
  };
}

/** Hints never patch copied Tasks. Coalesced reads retain the existing SWR and
 * detail draft owners; an ACKed room, rather than transport alone, means live.
 */
export function useTaskFreshness(
  owner: ReturnType<typeof useTaskIdentity>,
  refresh: () => Promise<unknown>,
  acceptsHint?: (
    message: Parameters<ServerEventsMap["database:tasks-changed"]>[0],
  ) => boolean,
  enabled = true,
) {
  const { identity, server, workspace, availability } = owner;
  const latestRefresh = useRef(refresh);
  latestRefresh.current = refresh;
  const latestAcceptsHint = useRef(acceptsHint);
  latestAcceptsHint.current = acceptsHint;
  const [status, setStatus] = useState({ identity, live: false });
  const [attempt, setAttempt] = useState(0);
  useEffect(
    () =>
      enabled
        ? subscribeTaskFreshness(
            owner,
            () => latestRefresh.current(),
            (live) => setStatus({ identity, live }),
            (message) => latestAcceptsHint.current?.(message) ?? true,
          )
        : undefined,
    [
      identity,
      server?.id,
      server?.baseUrl,
      workspace.id,
      availability.status,
      attempt,
      enabled,
    ],
  );
  return {
    live:
      enabled &&
      availability.status === "available" &&
      status.identity === identity &&
      status.live,
    retryLive: () => setAttempt((value) => value + 1),
  };
}
