import { DebugLogger } from "@myoxus/debug";
import { reserveAutomaticRetry } from "@myoxus/infra/retry";
import { subscribeSynchronousEvents } from "@myoxus/infra/utils";
import { Subject } from "rxjs";

import { MANUALLY_STOP } from "../utils/throw-if-aborted";

const logger = new DebugLogger("myoxus:storage:connection");

export type ConnectionStatus =
  "idle" | "connecting" | "connected" | "error" | "closed";

export interface Connection<T = any> {
  readonly status: ConnectionStatus;
  readonly error?: Error;
  readonly inner: T;
  connect(): void;
  disconnect(): void;
  waitForConnected(signal?: AbortSignal): Promise<void>;
  onStatusChanged(
    cb: (status: ConnectionStatus, error?: Error) => void,
  ): () => void;
}

export abstract class AutoReconnectConnection<
  T = any,
> implements Connection<T> {
  private readonly statusChanges = new Subject<[ConnectionStatus, Error?]>();
  private _inner: T | undefined = undefined;
  private _status: ConnectionStatus = "idle";
  private _error: Error | undefined = undefined;
  retryDelay = 3000;
  connectingTimeout = 15000;
  protected retryAttempt = 0;
  private refCount = 0;
  private connectingAbort?: AbortController;
  private reconnectingAbort?: AbortController;

  constructor() {}

  get shareId(): string | undefined {
    return undefined;
  }

  get maybeConnection() {
    return this._inner;
  }

  get inner(): T {
    if (this._inner === undefined) {
      throw new Error(
        `Connection ${this.constructor.name} has not been established.`,
      );
    }

    return this._inner;
  }

  private set inner(inner: T | undefined) {
    this._inner = inner;
  }

  get status() {
    return this._status;
  }

  get error() {
    return this._error;
  }

  protected set error(error: Error | undefined) {
    this.handleError(error);
  }

  private setStatus(status: ConnectionStatus, error?: Error) {
    const shouldEmit = status !== this._status || error !== this._error;
    this._status = status;
    // we only clear-up error when status is connected
    if (error || status === "connected") {
      this._error = error;
    }
    if (shouldEmit) {
      this.emitStatusChanged(status, this._error);
    }
  }

  protected abstract doConnect(signal?: AbortSignal): Promise<T>;
  protected abstract doDisconnect(conn: T): void;

  private innerConnect() {
    if (this.status !== "connecting") {
      this.setStatus("connecting");
      const connectingAbort = new AbortController();
      this.connectingAbort = connectingAbort;
      const signal = connectingAbort.signal;
      const timeout = setTimeout(() => {
        if (!signal.aborted) {
          this.handleError(new Error("connecting timeout"));
        }
      }, this.connectingTimeout);
      this.doConnect(signal)
        .then((value) => {
          clearTimeout(timeout);
          if (!signal.aborted) {
            this._inner = value;
            this.retryAttempt = 0;
            this.setStatus("connected");
          } else {
            try {
              this.doDisconnect(value);
            } catch (error) {
              logger.error(
                "Failed to disconnect",
                error instanceof Error
                  ? error.message
                  : "Unknown connection error",
              );
            }
          }
        })
        .catch((error) => {
          if (!signal.aborted) {
            clearTimeout(timeout);
            this.handleError(error as any);
          }
        });
    }
  }

  private innerDisconnect() {
    this.connectingAbort?.abort(MANUALLY_STOP);
    this.reconnectingAbort?.abort(MANUALLY_STOP);
    try {
      if (this._inner) {
        this.doDisconnect(this._inner);
      }
    } catch (error) {
      logger.error(
        "Failed to disconnect",
        error instanceof Error ? error.message : "Unknown connection error",
      );
    }
    this.reconnectingAbort = undefined;
    this.connectingAbort = undefined;
    this._inner = undefined;
  }

  /** Returns the delay before the next reconnection attempt.
   * Subclasses may override for exponential backoff or custom strategies. */
  protected nextRetryDelay(): number {
    return this.retryDelay;
  }

  /** Whether the given error is transient and the connection should retry.
   * Subclasses may override to classify certain errors as permanent (e.g.
   * authentication failures) so the reconnection loop stops immediately. */
  protected isRetriableError(_error?: Error): boolean {
    return true;
  }

  private handleError(reason?: Error) {
    this.innerDisconnect();
    // if the connection is closed, do not reconnect
    if (this.status === "closed") {
      this.retryAttempt = 0;
      return;
    }

    // permanent errors: stop retrying, stay in error state
    if (!this.isRetriableError(reason)) {
      logger.error("Connection will not reconnect", reason?.message);
      this.setStatus("error", reason);
      return;
    }

    // Offline/reconnecting state remains observable. Expected retry attempts
    // use the same debug logger as the other storage paths.
    logger.debug("Connection will reconnect", reason?.message);
    this.setStatus("error", reason);

    const delay = this.nextRetryDelay();
    this.retryAttempt++;

    this.reconnectingAbort = new AbortController();
    const signal = this.reconnectingAbort.signal;
    const timeout = setTimeout(() => {
      if (!signal.aborted && reserveAutomaticRetry("connection")) {
        this.innerConnect();
      }
    }, delay);
    signal.addEventListener("abort", () => {
      clearTimeout(timeout);
    });
  }

  connect() {
    this.refCount++;
    if (this.refCount === 1) {
      this.innerConnect();
    }
  }

  disconnect(force?: boolean) {
    if (force) {
      this.refCount = 0;
    } else {
      this.refCount = Math.max(this.refCount - 1, 0);
    }
    if (this.refCount === 0) {
      this.innerDisconnect();
      this.retryAttempt = 0;
      this.setStatus("closed");
    }
  }

  waitForConnected(signal?: AbortSignal) {
    return new Promise<void>((resolve, reject) => {
      if (this.status === "connected") {
        resolve();
        return;
      }

      const onAbort = () => {
        reject(signal?.reason);
        off();
      };
      const off = this.onStatusChanged((status) => {
        if (status === "connected") {
          signal?.removeEventListener("abort", onAbort);
          resolve();
          off();
        }
      });

      if (signal?.aborted) {
        onAbort();
      } else {
        signal?.addEventListener("abort", onAbort, { once: true });
      }
    });
  }

  onStatusChanged(
    cb: (status: ConnectionStatus, error?: Error) => void,
  ): () => void {
    const subscription = subscribeSynchronousEvents(
      this.statusChanges,
      ([status, error]) => cb(status, error),
    );
    return () => subscription.unsubscribe();
  }

  private readonly emitStatusChanged = (
    status: ConnectionStatus,
    error?: Error,
  ) => {
    this.statusChanges.next([status, error]);
  };
}

export class DummyConnection implements Connection<undefined> {
  readonly status: ConnectionStatus = "connected";
  readonly inner: undefined;

  connect(): void {
    return;
  }
  disconnect(): void {
    return;
  }
  waitForConnected(_signal?: AbortSignal): Promise<void> {
    return Promise.resolve();
  }
  onStatusChanged(
    _cb: (status: ConnectionStatus, error?: Error) => void,
  ): () => void {
    return () => {};
  }
}
