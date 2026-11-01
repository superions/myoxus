import { clientUpdateControlQuery, gqlFetcherFactory } from "@myoxus/graphql";
import {
  type AutomaticRetryProducer,
  configureAutomaticRetryAdmission,
} from "@myoxus/infra/retry";

export type ClientUpdatePhase = "normal" | "limited" | "suspended" | "failed";

export interface ClientUpdateControl {
  schemaVersion: number;
  stateId: string;
  phase: ClientUpdatePhase;
  operationId: string | null;
  maxAttempts: number | null;
  retryAfterMs: number | null;
  completion: {
    operationId: string;
    action: "none" | "reload" | "reset_local_cache";
  } | null;
  requiredWebBuildId: string | null;
  cacheEpoch: number;
  updatedAt: string;
}

export type ClientUpdateGateSnapshot =
  | { status: "loading"; control: null; remainingAttempts: 0 }
  | { status: "error"; control: null; remainingAttempts: 0 }
  | {
      status: "ready";
      control: ClientUpdateControl;
      remainingAttempts: number | null;
    };

export type ClientUpdateControlReader = () => Promise<ClientUpdateControl>;

/**
 * Creates the cache-free Web reader used by both the window and storage-worker
 * runtimes. Explicit Web headers preserve the server's client-kind contract.
 */
export function createClientUpdateControlReader(
  endpoint: string,
): ClientUpdateControlReader {
  const gql = gqlFetcherFactory(endpoint, (input, init) => {
    const headers = new Headers(init?.headers);
    headers.set("x-myoxus-client", "web");
    headers.set("x-myoxus-client-format", "myoxus-native");
    headers.set("x-myoxus-client-capabilities", "document-metadata");
    return fetch(input, {
      ...init,
      credentials: "include",
      cache: "no-store",
      headers,
    });
  });
  return async () => {
    const result = await gql({ query: clientUpdateControlQuery });
    return result.clientUpdateControl as ClientUpdateControl;
  };
}

const INITIAL_SNAPSHOT: ClientUpdateGateSnapshot = {
  status: "loading",
  control: null,
  remainingAttempts: 0,
};

/**
 * Browser-runtime authority for update state and automatic retry admission.
 *
 * Budgets are tied to the server operation ID, not the transient state ID.
 * Consequently, a new notification or policy revision cannot replenish retries
 * for an operation that already consumed its allowance.
 */
export class ClientUpdateGate {
  private snapshot: ClientUpdateGateSnapshot = INITIAL_SNAPSHOT;
  private inFlightRead: Promise<ClientUpdateControl> | null = null;
  private readonly consumedAttempts = new Map<string, number>();
  private readonly listeners = new Set<() => void>();

  getSnapshot = (): ClientUpdateGateSnapshot => this.snapshot;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  private emit() {
    for (const listener of this.listeners) {
      listener();
    }
  }

  private apply(control: ClientUpdateControl) {
    if (control.schemaVersion !== 1) {
      throw new Error("Unsupported client update control schema");
    }
    if (control.phase !== "normal" && !control.operationId) {
      throw new Error("Active client update control requires an operation ID");
    }
    if (
      control.phase === "limited" &&
      (control.maxAttempts === null ||
        !Number.isInteger(control.maxAttempts) ||
        control.maxAttempts < 0)
    ) {
      throw new Error("Limited client update control requires maxAttempts");
    }

    const consumed = control.operationId
      ? (this.consumedAttempts.get(control.operationId) ?? 0)
      : 0;

    this.snapshot = {
      status: "ready",
      control,
      remainingAttempts:
        control.phase === "limited"
          ? Math.max(0, control.maxAttempts! - consumed)
          : control.phase === "normal"
            ? null
            : 0,
    };
    this.emit();
  }

  /**
   * Coalesces startup, reconnect, polling and socket wake-ups into one
   * authoritative read. A failed read is fail-closed until an explicit reread.
   */
  read(reader: ClientUpdateControlReader): Promise<ClientUpdateControl> {
    if (this.inFlightRead) {
      return this.inFlightRead;
    }

    const read = reader()
      .then((control) => {
        this.apply(control);
        return control;
      })
      .catch((error) => {
        this.snapshot = {
          status: "error",
          control: null,
          remainingAttempts: 0,
        };
        this.emit();
        throw error;
      })
      .finally(() => {
        if (this.inFlightRead === read) {
          this.inFlightRead = null;
        }
      });
    this.inFlightRead = read;
    return read;
  }

  reserveAutomaticRetry(_producer: AutomaticRetryProducer): boolean {
    if (this.snapshot.status !== "ready") {
      return false;
    }

    const { control } = this.snapshot;
    if (control.phase === "normal") {
      return true;
    }
    if (control.phase !== "limited") {
      return false;
    }

    const operationId = control.operationId!;
    const consumed = this.consumedAttempts.get(operationId) ?? 0;
    const maximum = control.maxAttempts ?? 0;
    if (consumed >= maximum) {
      return false;
    }
    const nextConsumed = consumed + 1;
    this.consumedAttempts.set(operationId, nextConsumed);
    this.snapshot = {
      ...this.snapshot,
      remainingAttempts: Math.max(0, maximum - nextConsumed),
    };
    this.emit();
    return true;
  }
}

export interface ClientUpdateControlRuntimeOptions {
  gate: ClientUpdateGate;
  read: ClientUpdateControlReader;
  subscribeWakeup?: (listener: () => void) => () => void;
  addOnlineListener?: (listener: () => void) => void;
  removeOnlineListener?: (listener: () => void) => void;
  createBroadcastChannel?: (name: string) => BroadcastChannel;
  setTimeout?: typeof globalThis.setTimeout;
  clearTimeout?: typeof globalThis.clearTimeout;
}

const BROADCAST_CHANNEL = "myoxus-client-update-control";
const MIN_POLL_MS = 5_000;
const MAX_POLL_MS = 60_000;

/**
 * Starts the Web-only control loop. PostgreSQL/socket notifications are
 * wake-ups only; every transition is resolved by a fresh GraphQL read.
 */
export function startClientUpdateControlRuntime({
  gate,
  read,
  subscribeWakeup,
  addOnlineListener,
  removeOnlineListener,
  createBroadcastChannel,
  setTimeout: schedule = globalThis.setTimeout,
  clearTimeout: cancel = globalThis.clearTimeout,
}: ClientUpdateControlRuntimeOptions): () => void {
  let stopped = false;
  let pollTimer: ReturnType<typeof globalThis.setTimeout> | null = null;
  const restoreAdmission = configureAutomaticRetryAdmission((producer) =>
    gate.reserveAutomaticRetry(producer),
  );
  const channel = createBroadcastChannel?.(BROADCAST_CHANNEL);

  const clearPoll = () => {
    if (pollTimer !== null) {
      cancel(pollTimer);
      pollTimer = null;
    }
  };

  const reread = () => {
    if (stopped) return;
    void gate.read(read).catch(() => {
      // The blocking UI owns recovery for local control-read failures.
    });
  };

  const schedulePoll = () => {
    clearPoll();
    const snapshot = gate.getSnapshot();
    if (
      snapshot.status !== "ready" ||
      (snapshot.control.phase !== "limited" &&
        snapshot.control.phase !== "suspended" &&
        snapshot.control.phase !== "failed")
    ) {
      return;
    }
    const delay = Math.min(
      Math.max(snapshot.control.retryAfterMs ?? 15_000, MIN_POLL_MS),
      MAX_POLL_MS,
    );
    pollTimer = schedule(() => {
      pollTimer = null;
      reread();
    }, delay);
  };

  const onWakeup = () => {
    channel?.postMessage({});
    reread();
  };
  const onBroadcast = () => reread();
  const unsubscribeGate = gate.subscribe(schedulePoll);
  const unsubscribeWakeup = subscribeWakeup?.(onWakeup);
  channel?.addEventListener("message", onBroadcast);
  addOnlineListener?.(reread);
  reread();

  return () => {
    stopped = true;
    clearPoll();
    unsubscribeGate();
    unsubscribeWakeup?.();
    removeOnlineListener?.(reread);
    channel?.removeEventListener("message", onBroadcast);
    channel?.close();
    restoreAdmission();
  };
}
