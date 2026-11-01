import { reserveAutomaticRetry } from "@myoxus/infra/retry";

import { SocketConnection } from "../impls/cloud/socket";
import { desktopServerRequestUrl } from "@myoxus/desktop-api-contract";
import { TelemetryQueue } from "./queue";
import type {
  TelemetryAck,
  TelemetryBatch,
  TelemetryContext,
  TelemetryEvent,
} from "./types";

const DEFAULT_MAX_QUEUE_ENTRIES = 2000;
const DEFAULT_MAX_QUEUE_BYTES = 2 * 1024 * 1024;
const DEFAULT_MAX_BATCH_EVENTS = 25;
const DEFAULT_RETRY_BASE_MS = 1000;
const DEFAULT_RETRY_MAX_MS = 5 * 60 * 1000;

type TelemetryManagerOptions = {
  maxQueueEntries?: number;
  maxQueueBytes?: number;
  maxBatchEvents?: number;
  retryBaseMs?: number;
  retryMaxMs?: number;
};

export class TelemetryManager {
  private context: TelemetryContext = {
    isAuthed: false,
    isSelfHosted: false,
    channel: "stable",
    serverBaseUrl: "",
  };

  private readonly queue: TelemetryQueue;
  private readonly maxBatchEvents: number;
  private readonly retryBaseMs: number;
  private readonly retryMaxMs: number;

  private retryAttempt = 0;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private nextRetryAt?: number;
  private lastError?: string;
  private flushPromise?: Promise<TelemetryAck>;

  private socketConnection?: SocketConnection;
  private socketEndpoint?: string;

  constructor(options: TelemetryManagerOptions = {}) {
    const maxQueueEntries =
      options.maxQueueEntries ?? DEFAULT_MAX_QUEUE_ENTRIES;
    const maxQueueBytes = options.maxQueueBytes ?? DEFAULT_MAX_QUEUE_BYTES;
    this.queue = new TelemetryQueue(maxQueueEntries, maxQueueBytes);
    this.maxBatchEvents = options.maxBatchEvents ?? DEFAULT_MAX_BATCH_EVENTS;
    this.retryBaseMs = options.retryBaseMs ?? DEFAULT_RETRY_BASE_MS;
    this.retryMaxMs = options.retryMaxMs ?? DEFAULT_RETRY_MAX_MS;
  }

  async setContext(context: TelemetryContext) {
    this.context = { ...context };
    this.updateSocketConnection();
    this.scheduleFlush(true);
  }

  async track(event: TelemetryEvent, context = this.context) {
    // Stamp owner and identity at enqueue time. Rebinding the active tab must
    // never relabel already queued events as belonging to another server/user.
    if (!context.serverBaseUrl) return { queued: false };
    await this.queue.enqueue(
      this.mergeContext(event, context),
      context.serverBaseUrl,
    );
    this.scheduleFlush(false);
    return { queued: true };
  }

  async pageview(event: TelemetryEvent, context = this.context) {
    return this.track(event, context);
  }

  async flush(): Promise<TelemetryAck> {
    if (this.flushPromise) {
      return this.flushPromise;
    }

    const context = this.context;
    this.flushPromise = this.flushInternal().finally(() => {
      this.flushPromise = undefined;
      if (context !== this.context) this.scheduleFlush(true);
    });

    return this.flushPromise;
  }

  getQueueState() {
    return {
      size: this.queue.size,
      lastError: this.lastError,
      nextRetryAt: this.nextRetryAt,
    };
  }

  async dispose() {
    this.clearRetry();
    this.socketConnection?.disconnect(true);
    await this.queue.close();
  }

  private async flushInternal(): Promise<TelemetryAck> {
    const context = this.context;
    if (!this.context.serverBaseUrl) {
      return {
        ok: false,
        error: {
          name: "TelemetryEndpointMissing",
          message: "Telemetry server endpoint is not configured",
        },
      };
    }

    let accepted = 0;
    let dropped = 0;

    while (true) {
      if (context !== this.context) {
        return { ok: true, accepted, dropped };
      }
      const items = await this.queue.peek(this.maxBatchEvents);
      if (!items.length) {
        this.resetRetry();
        return { ok: true, accepted, dropped };
      }

      // Unowned historical entries and another server's queued telemetry are
      // disposable diagnostics, never candidates for cross-server delivery.
      const owned = items.filter(
        (item) => item.serverBaseUrl === context.serverBaseUrl,
      );
      const foreign = items.filter(
        (item) => item.serverBaseUrl !== context.serverBaseUrl,
      );
      await this.queue.remove(foreign.map((item) => item.id));
      dropped += foreign.length;
      if (!owned.length) continue;
      if (context !== this.context) return { ok: true, accepted, dropped };
      const ack = await this.sendBatch(
        owned.map((item) => item.event),
        context,
      );
      if (!ack.ok) {
        this.recordFailure(ack.error.message);
        return ack;
      }

      accepted += ack.accepted;
      dropped += ack.dropped;
      await this.queue.remove(owned.map((item) => item.id));
    }
  }

  private mergeContext(
    event: TelemetryEvent,
    context: TelemetryContext,
  ): TelemetryEvent {
    const mergedUserProps = {
      ...context.userProperties,
      ...event.userProperties,
    };

    const mergedContext = {
      ...event.context,
      channel: event.context?.channel ?? context.channel,
    };

    return {
      ...event,
      schemaVersion: 1,
      userId: event.userId ?? context.userId,
      userProperties: mergedUserProps,
      context: mergedContext,
    };
  }

  private async sendBatch(
    events: TelemetryEvent[],
    context: TelemetryContext,
  ): Promise<TelemetryAck> {
    const useWebsocket = context.isAuthed && !context.isSelfHosted;
    const transport = useWebsocket ? "ws" : "http";
    const batch: TelemetryBatch = {
      schemaVersion: 1,
      transport,
      sentAt: Date.now(),
      events,
    };

    try {
      if (useWebsocket) {
        return await this.sendWs(batch, context);
      }
      return await this.sendHttp(batch, context);
    } catch (error) {
      const err = error as Error;
      return {
        ok: false,
        error: {
          name: err?.name ?? "TelemetrySendError",
          message: err?.message ?? "Telemetry send failed",
        },
      };
    }
  }

  private async sendHttp(
    batch: TelemetryBatch,
    context: TelemetryContext,
  ): Promise<TelemetryAck> {
    const url = BUILD_CONFIG.isElectron
      ? desktopServerRequestUrl(
          context.serverId ?? "",
          "/api/telemetry/collect",
        )
      : new URL("/api/telemetry/collect", context.serverBaseUrl);
    const abortController = new AbortController();
    const timeoutId = setTimeout(() => {
      abortController.abort();
    }, 10000);
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-myoxus-version": BUILD_CONFIG.appVersion,
        },
        body: JSON.stringify(batch),
        signal: abortController.signal,
      });

      if (!response.ok) {
        throw new Error(`Telemetry HTTP failed with ${response.status}`);
      }

      const payload = (await response.json()) as TelemetryAck;
      if (!payload || typeof payload.ok !== "boolean") {
        throw new Error("Invalid telemetry response");
      }
      return payload;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  private async sendWs(
    batch: TelemetryBatch,
    context: TelemetryContext,
  ): Promise<TelemetryAck> {
    const socketConnection = this.ensureSocketConnection(context);
    socketConnection.connect();
    await socketConnection.waitForConnected();

    const res = await socketConnection.inner.socket.emitWithAck(
      "telemetry:batch",
      batch,
    );

    if ("error" in res) {
      return {
        ok: false,
        error: {
          name: res.error.name ?? "TelemetryWebsocketError",
          message: res.error.message ?? "Telemetry websocket error",
        },
      };
    }

    return res.data as TelemetryAck;
  }

  private scheduleFlush(force: boolean) {
    if (force) {
      this.clearRetry();
    }
    if (this.retryTimer && !force) {
      return;
    }

    queueMicrotask(() => {
      this.flush().catch(() => {
        return;
      });
    });
  }

  private recordFailure(message: string) {
    this.lastError = message;
    const delay = this.nextBackoffDelay();
    this.retryAttempt += 1;
    this.nextRetryAt = Date.now() + delay;

    this.clearRetry();
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      if (reserveAutomaticRetry("telemetry")) {
        this.flush().catch(() => {
          return;
        });
      }
    }, delay);
  }

  private resetRetry() {
    this.retryAttempt = 0;
    this.nextRetryAt = undefined;
    this.lastError = undefined;
    this.clearRetry();
  }

  private clearRetry() {
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
  }

  private nextBackoffDelay() {
    const exp = Math.min(this.retryAttempt, 10);
    const base = this.retryBaseMs * Math.pow(2, exp);
    const delay = Math.min(this.retryMaxMs, base);
    const jitter = Math.random() * delay * 0.2;
    return delay + jitter;
  }

  private ensureSocketConnection(context = this.context) {
    if (
      this.socketConnection &&
      this.socketEndpoint === `${context.serverId}:${context.serverBaseUrl}`
    ) {
      return this.socketConnection;
    }

    if (this.socketConnection) {
      this.socketConnection.disconnect(true);
    }

    this.socketEndpoint = `${context.serverId}:${context.serverBaseUrl}`;
    this.socketConnection = new SocketConnection(
      context.serverBaseUrl,
      context.isSelfHosted,
      context.serverId,
    );
    return this.socketConnection;
  }

  private updateSocketConnection() {
    const useWebsocket = this.context.isAuthed && !this.context.isSelfHosted;
    if (!useWebsocket) {
      if (this.socketConnection) {
        this.socketConnection.disconnect(true);
      }
      this.socketConnection = undefined;
      this.socketEndpoint = undefined;
      return;
    }

    this.ensureSocketConnection();
  }
}
