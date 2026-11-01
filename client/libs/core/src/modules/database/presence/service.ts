// SPDX-License-Identifier: AGPL-3.0-or-later
//
// P-DB-29B-D: Database collaboration presence service.
//
// Owns the client-side lifecycle for `database:join` / `database:leave` /
// `database:load-presence` / `database:update-presence` / `database:change`
// Socket.IO events. Consumers (Table, Kanban, List, Gallery, Calendar,
// Timeline) subscribe to the presence stream and the change stream and
// update their local UI without touching the underlying socket.
//
// The service is intentionally transport-agnostic: the only
// Socket.IO dependency is `socket.io-client` already loaded by the
// core storage layer; we accept any `Socket`-like object that exposes
// `.emit(name, payload, ack?)` and `.on(name, handler)` so the
// service is testable with a fake.
//
// Scope:
//   * one `DatabasePresenceService` per open Database view;
//   * the service joins on first subscriber, leaves on last
//     unsubscribe so transient popovers do not pollute presence;
//   * the change broadcast triggers a query invalidation callback
//     supplied by the consumer (the consumer decides which Apollo/
//     react-query cache key to bust).

import type { Socket } from "socket.io-client";

import type { DatabaseActivityEventType } from "../database-activity-types";

export type DatabaseInteractionMode =
  "viewing" | "editing" | "selecting" | "dragging";

export interface DatabasePresenceRecord {
  /** Stable identifier the server hands out at `database:join`. */
  socketId: string;
  userId: string;
  displayName: string;
  viewId: string | null;
  rowId: string | null;
  fieldId: string | null;
  dragging: boolean;
  /** ISO-8601 string; the server stamps this on every snapshot rebuild. */
  lastActiveAt: string;
}

export interface DatabasePresenceJoinAck {
  workspaceId: string;
  databaseId: string;
  presence: DatabasePresenceRecord[];
}

export interface DatabaseChangeEventPayload {
  workspaceId: string;
  databaseId: string;
  /** Snake-case change kind, e.g. `cell_updated`. */
  kind: string;
  actorUserId: string | null;
  /** Unique identity used to deduplicate a retried fanout delivery. */
  eventId: string;
  committedAt: string;
  target?: {
    rowId?: string;
    fieldId?: string;
    viewId?: string;
  } | null;
}

export interface DatabasePresenceUpdate {
  workspaceId: string;
  databaseId: string;
  socketId: string;
  userId?: string;
  displayName?: string;
  viewId?: string | null;
  rowId?: string | null;
  fieldId?: string | null;
  dragging?: boolean;
  left?: boolean;
  lastActiveAt?: string;
}

export interface DatabasePresenceUpdateInput {
  workspaceId: string;
  databaseId: string;
  viewId?: string | null;
  rowId?: string | null;
  fieldId?: string | null;
  dragging?: boolean;
}

export interface DatabasePresenceServiceOptions {
  socket: Socket;
  workspaceId: string;
  databaseId: string;
  /**
   * Called when a `database:change` event arrives. Receives the raw
   * payload so the consumer can decide which queries to invalidate.
   * P-DB-29B-D: the consumer must apply targeted invalidation by
   * entity kind + ids instead of blowing away the whole Database.
   */
  onChange?: (event: DatabaseChangeEventPayload) => void;
  /**
   * Optional fallback when the socket transport refuses to ACK the
   * join (e.g. permission denial). The handler must not throw.
   */
  onJoinError?: (error: { name: string; message: string }) => void;
}

type PresenceListener = (presence: DatabasePresenceRecord[]) => void;
type UpdateListener = (update: DatabasePresenceUpdate) => void;
type ConnectionListener = (connected: boolean) => void;

type DatabaseRoomLease = {
  consumers: number;
  acknowledged: boolean;
  joined: boolean;
  released: boolean;
  callbacks: Set<(response: unknown) => void>;
};

// Socket.IO rooms belong to the shared transport, not an individual view.
// A second embed must not leave a room still used by the first embed.
const databaseRooms = new WeakMap<Socket, Map<string, DatabaseRoomLease>>();

function discardRoomLease(
  socket: Socket,
  rooms: Map<string, DatabaseRoomLease>,
  key: string,
  lease: DatabaseRoomLease,
) {
  if (rooms.get(key) !== lease) return;
  rooms.delete(key);
  if (!rooms.size) databaseRooms.delete(socket);
}

function releaseUnusedRoom(
  socket: Socket,
  rooms: Map<string, DatabaseRoomLease>,
  key: string,
  lease: DatabaseRoomLease,
  payload: { workspaceId: string; databaseId: string },
) {
  if (!lease.consumers && socket.connected === false) {
    // Disconnect already removes the server memberships. Do not carry an
    // unacknowledged join or queued leave into a new socket connection.
    lease.released = true;
    discardRoomLease(socket, rooms, key, lease);
    return;
  }
  // Join is asynchronous. If the last view closes before its ACK, wait for
  // that ACK before leaving, otherwise a late join creates orphan presence.
  if (lease.consumers || !lease.acknowledged || lease.released) return;
  lease.released = true;
  if (lease.joined) socket.emit("database:leave", payload);
  discardRoomLease(socket, rooms, key, lease);
}

/**
 * Tracks who is currently in a Database view and broadcasts the local
 * user's interaction state. Backed by the five Socket.IO events defined
 * in `server/crates/api/src/websocket/handlers/database.rs`.
 */
export class DatabasePresenceService {
  private readonly socket: Socket;
  private readonly workspaceId: string;
  private readonly databaseId: string;
  private readonly onChange?: (event: DatabaseChangeEventPayload) => void;
  private readonly onJoinError?: (error: {
    name: string;
    message: string;
  }) => void;

  private presence = new Map<string, DatabasePresenceRecord>();
  private presenceListeners = new Set<PresenceListener>();
  private updateListeners = new Set<UpdateListener>();
  private connectionListeners = new Set<ConnectionListener>();
  private deliveredEventIds = new Set<string>();
  private refCount = 0;
  private joined = false;
  private disposed = false;
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  private currentFocus: DatabasePresenceUpdateInput;
  private roomSubscription: {
    lease: DatabaseRoomLease;
    rooms: Map<string, DatabaseRoomLease>;
    key: string;
    callback: (response: unknown) => void;
  } | null = null;
  private joinSequence = 0;

  constructor(options: DatabasePresenceServiceOptions) {
    this.socket = options.socket;
    this.workspaceId = options.workspaceId;
    this.databaseId = options.databaseId;
    this.currentFocus = {
      workspaceId: this.workspaceId,
      databaseId: this.databaseId,
    };
    this.onChange = options.onChange;
    this.onJoinError = options.onJoinError;
    this.socket.on("database:presence-update", this.handlePresenceUpdate);
    this.socket.on("database:change", this.handleChange);
  }

  /**
   * Increment the consumer ref-count. The first caller acquires the shared
   * socket/Database room lease; subsequent callers observe its presence stream.
   */
  acquire(): void {
    if (this.disposed) return;
    this.refCount += 1;
    if (this.refCount === 1) {
      this.join();
    } else {
      // already joined — emit current snapshot immediately
      this.notifyPresence();
    }
  }

  /**
   * Decrement the consumer ref-count. The last caller releases this service's
   * room lease. The socket leaves only when no other live view holds that room.
   */
  release(): void {
    if (this.refCount === 0) return;
    this.refCount -= 1;
    if (this.refCount === 0) {
      this.leave();
    }
  }

  /**
   * Push the local user's current focus state to the server so other
   * collaborators can render the focused row / field / view.
   */
  updateFocus(
    focus: Omit<DatabasePresenceUpdateInput, "workspaceId" | "databaseId">,
  ): void {
    this.currentFocus = {
      workspaceId: this.workspaceId,
      databaseId: this.databaseId,
      ...focus,
    };
    if (!this.joined) return;
    this.socket.emit("database:update-presence", this.currentFocus);
  }

  /**
   * Force a snapshot refresh. Useful after reconnect or when the
   * consumer wants to rehydrate the avatar group.
   */
  async refresh(): Promise<DatabasePresenceRecord[]> {
    if (!this.joined) return [];
    // A late heartbeat snapshot belongs to the lease that requested it.
    const sequence = this.joinSequence;
    return new Promise<DatabasePresenceRecord[]>((resolve) => {
      this.socket.emit(
        "database:load-presence",
        {
          workspaceId: this.workspaceId,
          databaseId: this.databaseId,
        },
        (response: unknown) => {
          if (this.disposed || !this.joined || sequence !== this.joinSequence) {
            resolve([]);
            return;
          }
          const records = extractPresence(response);
          this.presence = new Map(records.map((r) => [r.socketId, r]));
          this.notifyPresence();
          resolve(records);
        },
      );
    });
  }

  /**
   * Snapshot of the current presence list. Mostly used by tests and
   * for synchronous rendering of avatars before the next snapshot
   * arrives.
   */
  listPresence(): DatabasePresenceRecord[] {
    return Array.from(this.presence.values());
  }

  subscribePresence(listener: PresenceListener): () => void {
    this.presenceListeners.add(listener);
    return () => {
      this.presenceListeners.delete(listener);
    };
  }

  subscribeUpdates(listener: UpdateListener): () => void {
    this.updateListeners.add(listener);
    return () => {
      this.updateListeners.delete(listener);
    };
  }

  subscribeConnection(listener: ConnectionListener): () => void {
    this.connectionListeners.add(listener);
    return () => {
      this.connectionListeners.delete(listener);
    };
  }

  dispose(): void {
    this.disposed = true;
    this.refCount = 0;
    this.leave();
    this.socket.off("database:presence-update", this.handlePresenceUpdate);
    this.socket.off("database:change", this.handleChange);
    this.presenceListeners.clear();
    this.updateListeners.clear();
    this.connectionListeners.clear();
    this.presence.clear();
    this.deliveredEventIds.clear();
  }

  private join(): void {
    const payload = {
      workspaceId: this.workspaceId,
      databaseId: this.databaseId,
    };
    const key = JSON.stringify([this.workspaceId, this.databaseId]);
    let rooms = databaseRooms.get(this.socket);
    if (!rooms) {
      rooms = new Map();
      databaseRooms.set(this.socket, rooms);
    }
    const existing = rooms.get(key);
    const lease = existing ?? {
      consumers: 0,
      acknowledged: false,
      joined: false,
      released: false,
      callbacks: new Set<(response: unknown) => void>(),
    };
    if (!existing) rooms.set(key, lease);
    lease.consumers += 1;
    const sequence = ++this.joinSequence;
    const callback = (response: unknown) => {
      if (
        this.disposed ||
        this.refCount === 0 ||
        sequence !== this.joinSequence
      )
        return;
      const records = extractJoinAck(response, this.onJoinError);
      if (records === null) {
        this.notifyConnection(false);
        return;
      }
      this.presence = new Map(records.map((r) => [r.socketId, r]));
      this.joined = true;
      this.startHeartbeat();
      this.notifyConnection(true);
      this.notifyPresence();
      // Re-broadcast the last known focus so the server has it.
      if (
        this.currentFocus.rowId ||
        this.currentFocus.viewId ||
        this.currentFocus.dragging
      ) {
        this.socket.emit("database:update-presence", this.currentFocus);
      }
    };
    this.roomSubscription = { lease, rooms, key, callback };
    if (lease.acknowledged) {
      // A later consumer reads the current snapshot instead of replaying the
      // old join ACK or issuing a second join that resets the server focus.
      this.socket.emit("database:load-presence", payload, callback);
      return;
    }
    lease.callbacks.add(callback);
    if (existing) return;
    const roomRegistry = rooms;
    this.socket.emit("database:join", payload, (response: unknown) => {
      lease.acknowledged = true;
      lease.joined = extractJoinAck(response) !== null;
      if (!lease.joined)
        discardRoomLease(this.socket, roomRegistry, key, lease);
      const callbacks = [...lease.callbacks];
      lease.callbacks.clear();
      for (const notify of callbacks) notify(response);
      releaseUnusedRoom(this.socket, roomRegistry, key, lease, payload);
    });
  }

  private leave(): void {
    this.joinSequence += 1;
    const subscription = this.roomSubscription;
    this.roomSubscription = null;
    if (subscription) {
      const { lease, rooms, key, callback } = subscription;
      lease.callbacks.delete(callback);
      lease.consumers -= 1;
      releaseUnusedRoom(this.socket, rooms, key, lease, {
        workspaceId: this.workspaceId,
        databaseId: this.databaseId,
      });
    }
    this.joined = false;
    this.stopHeartbeat();
    this.presence.clear();
    this.notifyConnection(false);
    this.notifyPresence();
  }

  private handlePresenceUpdate = (
    payload: DatabasePresenceUpdate | unknown,
  ) => {
    if (this.disposed || this.refCount === 0) return;
    if (!isPresenceUpdate(payload)) return;
    if (
      payload.workspaceId !== this.workspaceId ||
      payload.databaseId !== this.databaseId
    ) {
      return;
    }
    for (const listener of this.updateListeners) {
      listener(payload);
    }
    if (payload.left) {
      this.presence.delete(payload.socketId);
      this.notifyPresence();
      return;
    }
    const existing = this.presence.get(payload.socketId);
    if (!existing) {
      if (!payload.userId || !payload.displayName) return;
      this.presence.set(payload.socketId, {
        socketId: payload.socketId,
        userId: payload.userId,
        displayName: payload.displayName,
        viewId: payload.viewId ?? null,
        rowId: payload.rowId ?? null,
        fieldId: payload.fieldId ?? null,
        dragging: payload.dragging ?? false,
        lastActiveAt: payload.lastActiveAt ?? new Date().toISOString(),
      });
      this.notifyPresence();
      return;
    }
    const merged: DatabasePresenceRecord = {
      ...existing,
      // Null clears focus; an omitted field preserves the prior projection.
      viewId: payload.viewId === undefined ? existing.viewId : payload.viewId,
      rowId: payload.rowId === undefined ? existing.rowId : payload.rowId,
      fieldId:
        payload.fieldId === undefined ? existing.fieldId : payload.fieldId,
      dragging: payload.dragging ?? existing.dragging,
      lastActiveAt: payload.lastActiveAt ?? new Date().toISOString(),
    };
    this.presence.set(payload.socketId, merged);
    this.notifyPresence();
  };

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.heartbeat = setInterval(() => {
      if (this.joined) {
        this.socket.emit("database:update-presence", this.currentFocus);
        void this.refresh();
      }
    }, 30_000);
  }

  private stopHeartbeat(): void {
    if (this.heartbeat !== null) {
      clearInterval(this.heartbeat);
      this.heartbeat = null;
    }
  }

  private handleChange = (payload: DatabaseChangeEventPayload | unknown) => {
    if (this.disposed || this.refCount === 0) return;
    if (!isChangeEvent(payload)) return;
    if (
      payload.workspaceId !== this.workspaceId ||
      payload.databaseId !== this.databaseId
    ) {
      return;
    }
    if (this.deliveredEventIds.has(payload.eventId)) return;
    this.deliveredEventIds.add(payload.eventId);
    // Keep deduplication bounded for long-lived Database tabs. Insertion order
    // is stable for Set, so the oldest delivery identity is evicted first.
    if (this.deliveredEventIds.size > 512) {
      const oldest = this.deliveredEventIds.values().next().value;
      if (oldest) this.deliveredEventIds.delete(oldest);
    }
    if (this.onChange) this.onChange(payload);
  };

  private notifyPresence(): void {
    const snapshot = Array.from(this.presence.values());
    for (const listener of this.presenceListeners) listener(snapshot);
  }

  private notifyConnection(connected: boolean): void {
    for (const listener of this.connectionListeners) listener(connected);
  }
}

// ─── Wire format helpers ──────────────────────────────────────────────────────

interface AckEnvelope<T> {
  data?: T;
  error?: { name: string; message: string };
}

function extractPresence(response: unknown): DatabasePresenceRecord[] {
  if (!response || typeof response !== "object") return [];
  const envelope = response as AckEnvelope<{
    presence?: DatabasePresenceRecord[];
  }>;
  const presence = envelope.data?.presence;
  if (!Array.isArray(presence)) return [];
  return presence.filter(isPresenceRecord);
}

function extractJoinAck(
  response: unknown,
  onJoinError?: (error: { name: string; message: string }) => void,
): DatabasePresenceRecord[] | null {
  if (!response || typeof response !== "object") return [];
  const envelope = response as AckEnvelope<{
    workspaceId: string;
    databaseId: string;
    presence: DatabasePresenceRecord[];
  }>;
  if (envelope.error) {
    if (onJoinError) onJoinError(envelope.error);
    return null;
  }
  return extractPresence(envelope);
}

function isPresenceUpdate(payload: unknown): payload is DatabasePresenceUpdate {
  if (!payload || typeof payload !== "object") return false;
  const candidate = payload as Record<string, unknown>;
  return (
    typeof candidate.socketId === "string" &&
    typeof candidate.workspaceId === "string" &&
    typeof candidate.databaseId === "string"
  );
}

function isChangeEvent(
  payload: unknown,
): payload is DatabaseChangeEventPayload {
  if (!payload || typeof payload !== "object") return false;
  const candidate = payload as Record<string, unknown>;
  return (
    typeof candidate.workspaceId === "string" &&
    typeof candidate.databaseId === "string" &&
    typeof candidate.kind === "string" &&
    typeof candidate.eventId === "string"
  );
}

function isPresenceRecord(value: unknown): value is DatabasePresenceRecord {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.socketId === "string" &&
    typeof candidate.userId === "string" &&
    typeof candidate.displayName === "string"
  );
}

/**
 * Convenience helper that derives a presence mode from the latest local
 * focus update. The visual surfaces (Table/Kanban/...) use this to
 * differentiate "viewing" vs. "editing" vs. "dragging" without each
 * surface re-implementing the rule.
 */
export function deriveInteractionMode(
  focus: Pick<
    DatabasePresenceUpdateInput,
    "dragging" | "fieldId" | "rowId"
  > | null,
): DatabaseInteractionMode {
  if (!focus) return "viewing";
  if (focus.dragging) return "dragging";
  if (focus.fieldId) return "editing";
  if (focus.rowId) return "selecting";
  return "viewing";
}

/**
 * Stable lookup: does this change-event payload affect a particular
 * row / field / view that the local user is currently rendering?
 */
export function changeEventAffectsLocalTarget(
  event: DatabaseChangeEventPayload,
  target: {
    rowId?: string | null;
    fieldId?: string | null;
    viewId?: string | null;
  },
): boolean {
  if (!event.target) return true; // server-side bulk changes always revalidate
  const { rowId, fieldId, viewId } = event.target;
  if (rowId && target.rowId && rowId === target.rowId) return true;
  if (fieldId && target.fieldId && fieldId === target.fieldId) return true;
  if (viewId && target.viewId && viewId === target.viewId) return true;
  return false;
}

/**
 * P-DB-29B-D exports the activity-event kind union so downstream
 * consumers do not have to chase the type through `database-activity-types`.
 */
export type { DatabaseActivityEventType };
