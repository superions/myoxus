/**
 * @file telemetry.ts — @myoxus/track
 *
 * Low-level telemetry transport abstraction.
 *
 * Decouples the application from any specific analytics backend: consumers
 * call {@link sendTelemetryEvent} without knowing where events go.  The actual
 * destination is injected at runtime via {@link setTelemetryTransport}.
 *
 * Events sent before a transport is registered are buffered (up to
 * `PENDING_LIMIT` entries) and flushed automatically when a transport is set.
 *
 * Consumers: `tracker.ts` (the public-facing tracker API).
 */

import { DebugLogger } from "@myoxus/debug";

/** A single telemetry event as sent over the wire. */
export type TelemetryEvent = {
  schemaVersion: 1;
  eventName: string;
  params?: Record<string, unknown>;
  userProperties?: Record<string, unknown>;
  userId?: string;
  clientId: string;
  sessionId?: string;
  eventId: string;
  timestampMicros?: number;
  context?: {
    appVersion?: string;
    editorVersion?: string;
    environment?: string;
    distribution?: string;
    channel?: "stable" | "beta" | "internal";
    isDesktop?: boolean;
    isMobile?: boolean;
    locale?: string;
    timezone?: string;
    url?: string;
    referrer?: string;
  };
};

/** Ambient context sent alongside every event to describe the current session. */
export type TelemetryContext = {
  isAuthed: boolean;
  isSelfHosted: boolean;
  channel: "stable" | "beta" | "internal";
  userId?: string;
  userProperties?: Record<string, unknown>;
  serverBaseUrl: string;
  serverId?: string;
};

/** Result returned by a transport's `flush` call. */
export type TelemetryAck =
  | { ok: true; accepted: number; dropped: number }
  | { ok: false; error: { name: string; message: string } };

/**
 * Interface that a telemetry backend must implement.
 *
 * Implement this interface and pass the instance to {@link setTelemetryTransport}
 * to connect the tracker to a concrete analytics provider (e.g. Mixpanel,
 * PostHog, a custom endpoint).
 */
export type TelemetryTransport = {
  setContext: (context: TelemetryContext) => Promise<void> | void;
  track: (event: TelemetryEvent) => Promise<{ queued: boolean }> | void;
  pageview?: (event: TelemetryEvent) => Promise<{ queued: boolean }> | void;
  flush?: () => Promise<TelemetryAck> | void;
};

type TelemetryContextUpdate = Partial<TelemetryContext> & {
  userProperties?: Record<string, unknown>;
};

type TelemetryContextUpdateOptions = {
  replaceUserProperties?: boolean;
};

const logger = new DebugLogger("telemetry");
const pendingEvents: TelemetryEvent[] = [];
const PENDING_LIMIT = 500;

const defaultChannel =
  BUILD_CONFIG.appBuildType === "beta" ||
  BUILD_CONFIG.appBuildType === "internal" ||
  BUILD_CONFIG.appBuildType === "stable"
    ? BUILD_CONFIG.appBuildType
    : "stable";

let context: TelemetryContext = {
  isAuthed: false,
  isSelfHosted: false,
  channel: defaultChannel,
  serverBaseUrl: "",
  userProperties: {},
};

let transport: TelemetryTransport | null = null;

/**
 * Sets (or clears) the active telemetry transport.
 *
 * When a transport is set, any events buffered while no transport was active
 * are flushed immediately.  Pass `null` to disable forwarding (events will be
 * buffered again up to `PENDING_LIMIT`).
 */
export function setTelemetryTransport(next: TelemetryTransport | null) {
  transport = next;
  if (!transport) {
    return;
  }

  applyTransportContext(context);
  flushPending().catch((error) => {
    logger.error("failed to flush pending telemetry events", error);
  });
}

/**
 * Updates the ambient telemetry context (e.g. after login, auth state change).
 *
 * @param update  - Partial context fields to merge in.
 * @param options - When `replaceUserProperties` is `true`, existing user
 *                  properties are discarded rather than merged.
 */
export function setTelemetryContext(
  update: TelemetryContextUpdate,
  options: TelemetryContextUpdateOptions = {},
) {
  if (
    update.serverBaseUrl !== undefined &&
    update.serverBaseUrl !== context.serverBaseUrl
  ) {
    // Pending pre-transport events have no server owner. They must not cross
    // the boundary when a configured server is selected or removed.
    pendingEvents.length = 0;
  }
  const nextUserProps = options.replaceUserProperties
    ? (update.userProperties ?? {})
    : {
        ...context.userProperties,
        ...update.userProperties,
      };

  context = {
    ...context,
    ...update,
    userProperties: nextUserProps,
  };

  applyTransportContext(context);
}

/** Returns the current telemetry context snapshot. */
export function getTelemetryContext() {
  return context;
}

/**
 * Sends a single telemetry event via the active transport.
 *
 * If no transport is registered the event is enqueued.  Returns
 * `{ queued: true }` in that case, or the transport's return value otherwise.
 */
export async function sendTelemetryEvent(event: TelemetryEvent) {
  if (!context.serverBaseUrl) return { queued: false };
  if (!transport) {
    enqueuePending(event);
    return { queued: true };
  }

  return await transport.track(event);
}

/**
 * Asks the active transport to flush any internally buffered events.
 *
 * Returns a no-op ack when no transport is registered or the transport has no
 * `flush` method.
 */
export async function flushTelemetry() {
  if (!transport?.flush) {
    return { ok: true, accepted: 0, dropped: 0 } as const;
  }
  return await transport.flush();
}

async function flushPending() {
  if (!transport || pendingEvents.length === 0) {
    return;
  }

  const events = pendingEvents.splice(0, pendingEvents.length);
  for (const event of events) {
    await transport.track(event);
  }
}

function enqueuePending(event: TelemetryEvent) {
  if (pendingEvents.length >= PENDING_LIMIT) {
    pendingEvents.shift();
  }
  pendingEvents.push(event);
}

function applyTransportContext(next: TelemetryContext) {
  if (!transport) {
    return;
  }
  void Promise.resolve(transport.setContext(next)).catch((error) => {
    logger.error("failed to set telemetry context", error);
  });
}
