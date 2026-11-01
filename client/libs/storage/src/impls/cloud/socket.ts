import {
  Manager as SocketIOManager,
  type Socket as SocketIO,
} from "socket.io-client";

import { AutoReconnectConnection } from "../../connection";
import type {
  InitialDocumentProvenance,
  PageRegistrationState,
} from "../../storage";
import type { TelemetryAck, TelemetryBatch } from "../../telemetry/types";
import { throwIfAborted } from "../../utils/throw-if-aborted";

// TODO(@forehalo): use [UserFriendlyError]
interface EventError {
  name: string;
  message: string;
  retryable?: boolean;
  retryAfterMs?: number;
}

type WebsocketResponse<T> =
  | {
      error: EventError;
    }
  | {
      data: T;
    };

export type NotificationChangeType =
  "notification_new" | "notification_read" | "notification_read_all";

type NotificationPushEnvelope = {
  eventId: string;
  eventType: NotificationChangeType | "calendar_reminder_due";
  payload: Record<string, unknown>;
};

interface ServerEvents {
  /** Committed workspace invalidation only; consumers reread authorized Tasks. */
  "database:tasks-changed": {
    workspaceId: string;
    databaseId: string;
    eventId: string;
  };
  /** Policy wake-up only. Clients always reread the authoritative GraphQL state. */
  "client:update-control-changed": Record<string, never>;
  "space:broadcast-doc-update": {
    spaceType: string;
    spaceId: string;
    docId: string;
    update: string;
    timestamp: number;
    editor: string;
  };
  "space:broadcast-doc-updates": {
    spaceType: string;
    spaceId: string;
    docId: string;
    updates: string[];
    timestamp: number;
    editor?: string;
    compressed?: boolean;
  };

  "space:collect-awareness": {
    spaceType: string;
    spaceId: string;
    docId: string;
  };

  "space:broadcast-awareness-update": {
    spaceType: string;
    spaceId: string;
    docId: string;
    awarenessUpdate: string;
  };
  /** P103-B-03: Server broadcasts this after a hard-delete so all connected clients
   * can purge the doc from their local store without waiting for a reconnect. */
  "space:doc-delete": {
    spaceId?: string;
    spaceType?: string;
    docId: string;
  };
  "notification:push": NotificationPushEnvelope;
  /** P-JCAL-SERVER-04: Broadcast when a native calendar event is created/updated/deleted. */
  "calendar:event_changed": {
    workspaceId: string;
    eventId: string;
    op: "created" | "updated" | "deleted";
  };
  /** P125-TPL-W: Server pushes this after a builder_version bump so connected
   * clients with active workspaces re-run reconcile and pick up the new build. */
  "template:reconcile-needed": {
    workspaceId: string;
    slug: string;
    builderVersion: number;
  };
  /**
   * P-DB-29B-D: per-database presence change broadcast.
   * Emitted when a collaborator joins, leaves, or moves focus inside the
   * database room `database:{databaseId}`.
   */
  "database:presence-update": {
    workspaceId: string;
    databaseId: string;
    socketId: string;
    viewId?: string | null;
    rowId?: string | null;
    fieldId?: string | null;
    dragging?: boolean;
    left?: boolean;
  };
  /**
   * P-DB-29B-D: per-database committed change broadcast.
   * Emitted after every committed cell/row/field/view/bulk mutation so
   * client cache layers can apply targeted invalidation.
   */
  "database:change": {
    workspaceId: string;
    databaseId: string;
    kind: string;
    actorUserId: string;
    eventId: string;
    committedAt: string;
    target?: {
      rowId?: string;
      fieldId?: string;
      viewId?: string;
    } | null;
  };
}

type SocketClientContext = {
  client: string;
  clientFormat: string;
  clientCapabilities: string;
};

type WithSocketClientContext<Payload> = Payload & SocketClientContext;

interface ClientEvents {
  "notification:subscribe": Record<string, never>;
  "notification:ack": { eventId: string };
  "space:join": [
    WithSocketClientContext<{
      spaceType: string;
      spaceId: string;
      clientVersion: string;
    }>,
    { clientId: string; success: boolean },
  ];
  "space:leave": WithSocketClientContext<{
    spaceType: string;
    spaceId: string;
  }>;
  "space:join-awareness": [
    WithSocketClientContext<{
      spaceType: string;
      spaceId: string;
      docId: string;
      clientVersion: string;
    }>,
    { clientId: string; success: boolean },
  ];
  "space:leave-awareness": WithSocketClientContext<{
    spaceType: string;
    spaceId: string;
    docId: string;
  }>;

  "space:update-awareness": WithSocketClientContext<{
    spaceType: string;
    spaceId: string;
    docId: string;
    awarenessUpdate: string;
  }>;

  "space:load-awarenesses": WithSocketClientContext<{
    spaceType: string;
    spaceId: string;
    docId: string;
  }>;

  "space:push-doc-update": [
    WithSocketClientContext<{
      spaceType: string;
      spaceId: string;
      docId: string;
      update: string;
      initialDocumentProvenance?: InitialDocumentProvenance;
    }>,
    { timestamp: number; pageRegistration?: PageRegistrationState | null },
  ];
  "space:load-doc-timestamps": [
    WithSocketClientContext<{
      spaceType: string;
      spaceId: string;
      timestamp?: number;
    }>,
    Record<string, number>,
  ];
  "space:load-doc": [
    WithSocketClientContext<{
      spaceType: string;
      spaceId: string;
      docId: string;
      stateVector?: string;
    }>,
    {
      missing: string;
      state: string;
      timestamp: number;
      pageRegistration?: PageRegistrationState | null;
    },
  ];
  "space:delete-doc": WithSocketClientContext<{
    spaceType: string;
    spaceId: string;
    docId: string;
  }>;

  /**
   * P-DB-29B-D: open a presence room for a single database. Returns the
   * current presence snapshot in the ack.
   */
  "database:join": [
    {
      workspaceId: string;
      databaseId: string;
    },
    WebsocketResponse<{
      workspaceId: string;
      databaseId: string;
      presence: Array<{
        socketId: string;
        userId: string;
        displayName: string;
        viewId: string | null;
        rowId: string | null;
        fieldId: string | null;
        dragging: boolean;
        lastActiveAt: string;
      }>;
    }>,
  ];
  /**
   * P-DB-29B-D: leave the per-database presence room. Fire-and-forget.
   */
  "database:leave": {
    workspaceId: string;
    databaseId: string;
  };
  /**
   * P-DB-29B-D: pull the latest presence snapshot. Useful after a reconnect.
   */
  "database:load-presence": [
    {
      workspaceId: string;
      databaseId: string;
    },
    WebsocketResponse<{
      workspaceId: string;
      databaseId: string;
      presence: Array<{
        socketId: string;
        userId: string;
        displayName: string;
        viewId: string | null;
        rowId: string | null;
        fieldId: string | null;
        dragging: boolean;
        lastActiveAt: string;
      }>;
    }>,
  ];
  /**
   * P-DB-29B-D: broadcast the local user's focus (current view, row, field,
   * or dragging boolean) to the rest of the room.
   */
  "database:update-presence": {
    workspaceId: string;
    databaseId: string;
    viewId?: string | null;
    rowId?: string | null;
    fieldId?: string | null;
    dragging?: boolean;
  };

  "telemetry:batch": [TelemetryBatch, TelemetryAck];
}

export type ServerEventsMap = {
  [Key in keyof ServerEvents]: (data: ServerEvents[Key]) => void;
};

export type ClientEventsMap = {
  [Key in keyof ClientEvents]: ClientEvents[Key] extends Array<any>
    ? (
        data: ClientEvents[Key][0],
        ack: (res: WebsocketResponse<ClientEvents[Key][1]>) => void,
      ) => void
    : (data: ClientEvents[Key]) => void;
};

export type Socket = SocketIO<ServerEventsMap, ClientEventsMap>;

type BufferConstructorLike = {
  from(
    data: Uint8Array | string,
    encoding?: string,
  ): Uint8Array & {
    toString(encoding: string): string;
  };
};

const BufferCtor = (globalThis as { Buffer?: BufferConstructorLike }).Buffer;
const CHUNK_SIZE = 0x8000;

export async function uint8ArrayToBase64(array: Uint8Array): Promise<string> {
  if (BufferCtor) {
    return BufferCtor.from(array).toString("base64");
  }

  let binary = "";
  for (let i = 0; i < array.length; i += CHUNK_SIZE) {
    const chunk = array.subarray(i, i + CHUNK_SIZE);
    binary += String.fromCharCode(...chunk);
  }
  return btoa(binary);
}

export function base64ToUint8Array(base64: string) {
  if (BufferCtor) {
    return new Uint8Array(BufferCtor.from(base64, "base64"));
  }

  const binaryString = atob(base64);
  const bytes = new Uint8Array(binaryString.length);
  for (let i = 0; i < binaryString.length; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  return bytes;
}

let authMethod:
  ((endpoint: string, cb: (data: object) => void) => void) | undefined;

export function configureSocketAuthMethod(
  cb: (endpoint: string, cb: (data: object) => void) => void,
) {
  authMethod = cb;
}

class SocketManager {
  private readonly socketIOManager: SocketIOManager;
  socket: Socket;
  refCount = 0;
  private readonly notificationIds = new Set<string>();

  private readonly receiveNotification = (value: unknown) => {
    const envelope = decodeNotificationPush(value);
    if (!envelope) return;
    if (!this.notificationIds.has(envelope.eventId)) {
      this.notificationIds.add(envelope.eventId);
      // Bounded replay protection covers outbox retries without retaining a feed.
      if (this.notificationIds.size > 256) {
        this.notificationIds.delete(
          this.notificationIds.values().next().value!,
        );
      }
      if (envelope.eventType === "calendar_reminder_due") {
        dispatchCalendarReminderDue(
          envelope.payload as CalendarReminderDuePayload,
        );
        dispatchNotificationChanged("notification_new");
      } else {
        dispatchNotificationChanged(envelope.eventType);
      }
    }
    this.socket.emit("notification:ack", { eventId: envelope.eventId });
  };

  constructor(endpoint: string, isSelfHosted: boolean, serverId?: string) {
    if (BUILD_CONFIG.isElectron && !serverId)
      throw new Error("Desktop socket requires a server ID");
    this.socketIOManager = new SocketIOManager(endpoint, {
      // WebSocket cannot use assets://. Main validates this opaque identity
      // against the registered origin before attaching partitioned cookies.
      query: BUILD_CONFIG.isElectron ? { myoxusServerId: serverId } : undefined,
      autoConnect: false,
      transports: isSelfHosted ? ["polling", "websocket"] : ["websocket"], // self-hosted server may not support websocket
      secure: new URL(endpoint).protocol === "https:",
      // we will handle reconnection by ourselves
      reconnection: false,
    });
    this.socket = this.socketIOManager.socket("/", {
      auth(cb) {
        if (authMethod) {
          authMethod(endpoint, cb);
        } else {
          cb({});
        }
      },
    });
    // The cached manager owns listeners, so multiple storage connections never
    // multiply subscriptions, dispatches or reminder toasts on this socket.
    this.socket.on("notification:push", this.receiveNotification);
    this.socket.on("connect", () => {
      this.socket.emit("notification:subscribe", {});
      dispatchNotificationChanged("notification_new");
    });
    this.socket.on("calendar:event_changed", dispatchCalendarEventChanged);
    this.socket.on(
      "template:reconcile-needed",
      dispatchTemplateReconcileNeeded,
    );
    this.socket.on(
      "client:update-control-changed",
      dispatchClientUpdateControlChanged,
    );
  }

  connect() {
    let disconnected = false;
    this.refCount++;
    this.socket.connect();
    return {
      socket: this.socket,
      disconnect: () => {
        if (disconnected) {
          return;
        }
        disconnected = true;
        this.refCount--;
        if (this.refCount === 0) {
          this.socket.disconnect();
        }
      },
    };
  }
}

const notificationChangeListeners = new Set<
  (eventType: NotificationChangeType) => void
>();

/** One local invalidation channel for persisted Inbox and unread-count changes. */
export function onNotificationChanged(
  cb: (eventType: NotificationChangeType) => void,
): () => void {
  notificationChangeListeners.add(cb);
  return () => notificationChangeListeners.delete(cb);
}

function dispatchNotificationChanged(eventType: NotificationChangeType) {
  for (const listener of notificationChangeListeners) {
    try {
      listener(eventType);
    } catch {
      // A failed consumer must not prevent other caches from reconciling.
    }
  }
}

/** Invalid envelopes must neither reach consumers nor acknowledge delivery. */
export function decodeNotificationPush(
  value: unknown,
): NotificationPushEnvelope | null {
  if (!value || typeof value !== "object") return null;
  const { eventId, eventType, payload } = value as Record<string, unknown>;
  if (
    typeof eventId !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      eventId,
    ) ||
    !payload ||
    typeof payload !== "object" ||
    Array.isArray(payload)
  )
    return null;
  if (
    eventType !== "notification_new" &&
    eventType !== "notification_read" &&
    eventType !== "notification_read_all" &&
    eventType !== "calendar_reminder_due"
  )
    return null;
  const data = payload as Record<string, unknown>;
  if (
    eventType === "calendar_reminder_due" &&
    (typeof data.eventId !== "string" || typeof data.scheduledFor !== "string")
  )
    return null;
  return { eventId, eventType, payload: data };
}

// P-JCAL-CORE-02: Global calendar:event_changed subscription (workspace-scoped realtime).
type CalendarEventChangedPayload = ServerEvents["calendar:event_changed"];
const calendarEventChangedListeners = new Set<
  (payload: CalendarEventChangedPayload) => void
>();

/** Subscribe to calendar:event_changed events from any open socket connection.
 *  Returns an unsubscribe function. P-JCAL-CORE-02. */
export function onCalendarEventChanged(
  cb: (payload: CalendarEventChangedPayload) => void,
): () => void {
  calendarEventChangedListeners.add(cb);
  return () => calendarEventChangedListeners.delete(cb);
}

function dispatchCalendarEventChanged(payload: CalendarEventChangedPayload) {
  for (const cb of calendarEventChangedListeners) {
    try {
      cb(payload);
    } catch {
      // swallow subscriber errors
    }
  }
}

// P-JCAL-CORE-02: Global calendar_reminder_due subscription (user-specific realtime).
type CalendarReminderDuePayload = {
  eventId: string;
  scheduledFor: string;
};
const calendarReminderDueListeners = new Set<
  (payload: CalendarReminderDuePayload) => void
>();

/** Subscribe to calendar_reminder_due events from any open socket connection.
 *  Returns an unsubscribe function. P-JCAL-CORE-02. */
export function onCalendarReminderDue(
  cb: (payload: CalendarReminderDuePayload) => void,
): () => void {
  calendarReminderDueListeners.add(cb);
  return () => calendarReminderDueListeners.delete(cb);
}

function dispatchCalendarReminderDue(payload: CalendarReminderDuePayload) {
  for (const cb of calendarReminderDueListeners) {
    try {
      cb(payload);
    } catch {
      // swallow subscriber errors
    }
  }
}

// P125-TPL-W: Global template:reconcile-needed subscription (workspace-scoped realtime).
type TemplateReconcileNeededPayload = ServerEvents["template:reconcile-needed"];
const templateReconcileNeededListeners = new Set<
  (payload: TemplateReconcileNeededPayload) => void
>();

/** Subscribe to `template:reconcile-needed` events from any open socket
 *  connection. Returns an unsubscribe function. P125-TPL-W. */
export function onTemplateReconcileNeeded(
  cb: (payload: TemplateReconcileNeededPayload) => void,
): () => void {
  templateReconcileNeededListeners.add(cb);
  return () => templateReconcileNeededListeners.delete(cb);
}

function dispatchTemplateReconcileNeeded(
  payload: TemplateReconcileNeededPayload,
) {
  for (const cb of templateReconcileNeededListeners) {
    try {
      cb(payload);
    } catch {
      // swallow subscriber errors
    }
  }
}

const clientUpdateControlChangedListeners = new Set<() => void>();

/** Subscribes to cache-free client-update control wake-ups from any Web socket. */
export function onClientUpdateControlChanged(listener: () => void): () => void {
  clientUpdateControlChangedListeners.add(listener);
  return () => clientUpdateControlChangedListeners.delete(listener);
}

function dispatchClientUpdateControlChanged(
  _payload: ServerEvents["client:update-control-changed"],
) {
  for (const listener of clientUpdateControlChangedListeners) {
    try {
      listener();
    } catch {
      // A consumer failure must not break socket event dispatch.
    }
  }
}

const SOCKET_MANAGER_CACHE = new Map<string, SocketManager>();
function getSocketManager(
  endpoint: string,
  isSelfHosted: boolean,
  serverId?: string,
) {
  const key = BUILD_CONFIG.isElectron ? `${serverId}:${endpoint}` : endpoint;
  let manager = SOCKET_MANAGER_CACHE.get(key);
  if (!manager) {
    manager = new SocketManager(endpoint, isSelfHosted, serverId);
    SOCKET_MANAGER_CACHE.set(key, manager);
  }
  return manager;
}

export type SocketConnectError = Error & {
  code?: string;
  retryAfterMs?: number;
};

const MAX_SERVER_RETRY_AFTER_MS = 60_000;
const MAX_CONNECTION_RETRY_DELAY_MS = 72_000;

/**
 * Socketioxide transports middleware failures through `connect_error.message`.
 * Admission failures use a small JSON contract inside that string; all legacy
 * plain-text errors remain unchanged for authentication compatibility.
 */
export function normalizeSocketConnectError(
  error: unknown,
): SocketConnectError {
  const normalized = error instanceof Error ? error : new Error(String(error));
  try {
    const payload = JSON.parse(normalized.message) as unknown;
    if (!payload || typeof payload !== "object") {
      return normalized;
    }
    const record = payload as Record<string, unknown>;
    if (typeof record.code === "string") {
      (normalized as SocketConnectError).code = record.code;
    }
    if (
      typeof record.retryAfterMs === "number" &&
      Number.isFinite(record.retryAfterMs) &&
      record.retryAfterMs >= 0
    ) {
      (normalized as SocketConnectError).retryAfterMs = Math.min(
        record.retryAfterMs,
        MAX_SERVER_RETRY_AFTER_MS,
      );
    }
  } catch {
    // Legacy authentication and transport failures are intentionally plain text.
  }
  return normalized;
}

export function connectionRetryDelay(
  retryAttempt: number,
  retryAfterMs: number | undefined,
  random: () => number = Math.random,
): number {
  const exponential =
    Math.min(1000 * Math.pow(2, retryAttempt), 30_000) * (0.8 + random() * 0.4);
  const serverFloor = Math.min(
    Math.max(retryAfterMs ?? 0, 0),
    MAX_SERVER_RETRY_AFTER_MS,
  );
  const jitteredServerFloor = serverFloor * (1 + random() * 0.2);
  return Math.min(
    Math.max(exponential, jitteredServerFloor),
    MAX_CONNECTION_RETRY_DELAY_MS,
  );
}

export class SocketConnection extends AutoReconnectConnection<{
  socket: Socket;
  disconnect: () => void;
}> {
  manager = getSocketManager(this.endpoint, this.isSelfHosted, this.serverId);
  private serverRetryAfterMs: number | undefined;

  constructor(
    private readonly endpoint: string,
    private readonly isSelfHosted: boolean,
    private readonly serverId?: string,
  ) {
    super();
  }

  override async doConnect(signal?: AbortSignal) {
    const { socket, disconnect } = this.manager.connect();
    try {
      throwIfAborted(signal);
      if (!socket.connected) {
        // Every attempt owns its listeners, including the losing error/abort
        // branches. Reconnect must not accumulate callbacks on the shared socket.
        let onConnect: () => void;
        let onError: (error: Error) => void;
        let onAbort: () => void;
        try {
          await new Promise<void>((resolve, reject) => {
            onConnect = resolve;
            onError = reject;
            onAbort = () => reject(signal?.reason);
            socket.once("connect", onConnect);
            socket.once("connect_error", onError);
            signal?.addEventListener("abort", onAbort, { once: true });
          });
        } finally {
          socket.off("connect", onConnect!);
          socket.off("connect_error", onError!);
          signal?.removeEventListener("abort", onAbort!);
        }
      }
      throwIfAborted(signal);
    } catch (err) {
      disconnect();
      throw normalizeSocketConnectError(err);
    }

    socket.on("disconnect", this.handleDisconnect);

    return {
      socket,
      disconnect,
    };
  }

  override doDisconnect(conn: { socket: Socket; disconnect: () => void }) {
    conn.socket.off("disconnect", this.handleDisconnect);
    conn.disconnect();
  }

  /** Exponential backoff with ±20% jitter: 1s, 2s, 4s, 8s, …, capped at 30s.
   * Prevents reconnect-flood after a server restart. */
  protected override nextRetryDelay(): number {
    return connectionRetryDelay(this.retryAttempt, this.serverRetryAfterMs);
  }

  /** Authentication errors are permanent — the session cookie is stale or
   * missing. Retrying with the same cookie will never succeed; the user must
   * re-authenticate via the sign-in flow. */
  protected override isRetriableError(error?: Error): boolean {
    this.serverRetryAfterMs = (error as SocketConnectError | undefined)
      ?.retryAfterMs;
    const msg = error?.message ?? "";
    if (
      msg.includes("AUTHENTICATION_REQUIRED") ||
      msg.includes("You must sign in first")
    ) {
      return false;
    }
    return true;
  }

  handleDisconnect = (reason: SocketIO.DisconnectReason) => {
    this.error = new Error(reason);
  };
}
