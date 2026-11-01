// SPDX-License-Identifier: AGPL-3.0-or-later
//
// P-DB-29B-D: Database collaboration React hook.
//
// Wraps `DatabasePresenceService` so each open view (Table, Kanban,
// List, Gallery, Calendar, Timeline) can subscribe with one line:
//
//     const { collaborators, updateFocus } = useDatabasePresence({
//       socket,
//       workspaceId,
//       databaseId,
//     });
//
// The hook owns the service: it calls `acquire()` on mount, `dispose()`
// on unmount. The service itself deduplicates joins so multiple views
// (e.g. the same Database rendered both as Table and as Kanban in
// different tabs) never trigger redundant `database:join` round-trips.
//
// The hook also exposes two derived selectors:
//   * `presenceByRowId` — rows currently focused by at least one other
//     collaborator (string → array of records);
//   * `presenceByFieldId` — fields currently being edited by at least
//     one other collaborator.
//
// The component surface uses the selectors to render focused-cell
// indicators without each surface re-deriving the rule.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Socket } from "socket.io-client";

import {
  type DatabaseChangeEventPayload,
  type DatabasePresenceRecord,
  DatabasePresenceService,
  type DatabasePresenceServiceOptions,
  type DatabasePresenceUpdateInput,
} from "./service";

export interface UseDatabasePresenceOptions extends Omit<
  DatabasePresenceServiceOptions,
  "onChange" | "socket"
> {
  socket: Socket | null;
  /**
   * Whether the local user should appear in the presence stream.
   * Defaults to `true`. Pass `false` for read-only views (e.g. a
   * snapped Database Link picker that polls the snapshot but does not
   * need to advertise its own focus).
   */
  publishLocal?: boolean;
  /**
   * Optional change-stream callback that runs in addition to the
   * service's own listener so React components can hook invalidation
   * without wrapping the service.
   */
  onChange?: (event: DatabaseChangeEventPayload) => void;
}

export interface UseDatabasePresenceResult {
  collaborators: DatabasePresenceRecord[];
  connected: boolean;
  localSocketId: string | null;
  presenceByRowId: Map<string, DatabasePresenceRecord[]>;
  presenceByFieldId: Map<string, DatabasePresenceRecord[]>;
  draggingUserIds: string[];
  updateFocus: (
    focus: Omit<DatabasePresenceUpdateInput, "workspaceId" | "databaseId">,
  ) => void;
  refresh: () => Promise<DatabasePresenceRecord[]>;
}

const EMPTY_PRESENCE_BY_ROW_ID = new Map<string, DatabasePresenceRecord[]>();
const EMPTY_PRESENCE_BY_FIELD_ID = new Map<string, DatabasePresenceRecord[]>();

function indexPresenceByRowId(
  records: DatabasePresenceRecord[],
): Map<string, DatabasePresenceRecord[]> {
  const out = new Map<string, DatabasePresenceRecord[]>();
  for (const record of records) {
    if (!record.rowId) continue;
    const list = out.get(record.rowId);
    if (list) {
      list.push(record);
    } else {
      out.set(record.rowId, [record]);
    }
  }
  return out;
}

function indexPresenceByFieldId(
  records: DatabasePresenceRecord[],
): Map<string, DatabasePresenceRecord[]> {
  const out = new Map<string, DatabasePresenceRecord[]>();
  for (const record of records) {
    if (!record.fieldId) continue;
    const list = out.get(record.fieldId);
    if (list) {
      list.push(record);
    } else {
      out.set(record.fieldId, [record]);
    }
  }
  return out;
}

/**
 * Subscribe to the per-database presence stream for the lifetime of
 * the calling component.
 *
 * The hook is purely declarative: it never throws. Socket errors
 * surface through `connected = false` and (optionally) `onJoinError`.
 */
export function useDatabasePresence(
  options: UseDatabasePresenceOptions,
): UseDatabasePresenceResult {
  const {
    socket,
    workspaceId,
    databaseId,
    publishLocal,
    onChange,
    onJoinError,
  } = options;

  const serviceRef = useRef<DatabasePresenceService | null>(null);
  const onChangeRef =
    useRef<DatabasePresenceServiceOptions["onChange"]>(undefined);
  const onJoinErrorRef =
    useRef<DatabasePresenceServiceOptions["onJoinError"]>(undefined);

  const [presence, setPresence] = useState<DatabasePresenceRecord[]>([]);
  const [connected, setConnected] = useState<boolean>(false);

  // Keep latest callback refs so the service stays stable across renders.
  useEffect(() => {
    onChangeRef.current = onChange;
  }, [onChange]);
  useEffect(() => {
    onJoinErrorRef.current = onJoinError;
  }, [onJoinError]);

  useEffect(() => {
    if (!socket) {
      serviceRef.current = null;
      setPresence([]);
      setConnected(false);
      return;
    }
    const service = new DatabasePresenceService({
      socket,
      workspaceId,
      databaseId,
      onChange: (event) => onChangeRef.current?.(event),
      onJoinError: (error) => onJoinErrorRef.current?.(error),
    });
    serviceRef.current = service;

    const unsubscribePresence = service.subscribePresence((snapshot) => {
      setPresence(snapshot);
    });
    const unsubscribeConnection = service.subscribeConnection((state) => {
      setConnected(state);
    });
    service.acquire();

    return () => {
      unsubscribePresence();
      unsubscribeConnection();
      service.dispose();
      serviceRef.current = null;
    };
  }, [socket, workspaceId, databaseId]);

  const updateFocus = useCallback(
    (
      focus: Omit<DatabasePresenceUpdateInput, "workspaceId" | "databaseId">,
    ) => {
      if (publishLocal === false) return;
      serviceRef.current?.updateFocus(focus);
    },
    [publishLocal],
  );

  const refresh = useCallback(() => {
    if (!serviceRef.current)
      return Promise.resolve<DatabasePresenceRecord[]>([]);
    return serviceRef.current.refresh();
  }, []);

  const presenceByRowId = useMemo(
    () =>
      presence.length === 0
        ? EMPTY_PRESENCE_BY_ROW_ID
        : indexPresenceByRowId(presence),
    [presence],
  );

  const presenceByFieldId = useMemo(
    () =>
      presence.length === 0
        ? EMPTY_PRESENCE_BY_FIELD_ID
        : indexPresenceByFieldId(presence),
    [presence],
  );

  const draggingUserIds = useMemo(() => {
    const ids: string[] = [];
    for (const record of presence) {
      if (record.dragging) ids.push(record.userId);
    }
    return ids;
  }, [presence]);

  return {
    collaborators: presence,
    connected,
    localSocketId: socket?.id ?? null,
    presenceByRowId,
    presenceByFieldId,
    draggingUserIds,
    updateFocus,
    refresh,
  };
}
