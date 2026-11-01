/**
 * @file event.ts — @myoxus/infra (framework/core)
 *
 * Typed event bus system for cross-component communication within the DI framework.
 *
 * The event system consists of three cooperating parts:
 *
 * 1. {@link FrameworkEvent} — a typed token identifying a specific event.
 *    Created with {@link createEvent}.
 * 2. {@link EventBus} — the pub/sub bus used inside a provider scope.  Each
 *    scope has its own `EventBus`; subscriptions propagate up to the root bus so
 *    that parents always receive events emitted in child scopes.
 * 3. {@link OnEvent} — a class decorator that declaratively registers a method
 *    on a {@link Service} as a handler for a specific {@link FrameworkEvent},
 *    wired automatically when the service is created.
 *
 * Usage:
 * ```ts
 * // 1. Declare an event type
 * const WorkspaceSwitched = createEvent<{ workspaceId: string }>('WorkspaceSwitched');
 *
 * // 2. Subscribe in a service using the decorator
 * @OnEvent(WorkspaceSwitched, svc => svc.onWorkspaceSwitched)
 * class SyncService extends Service {
 *   onWorkspaceSwitched({ workspaceId }: { workspaceId: string }) { ... }
 * }
 *
 * // 3. Emit from anywhere in the same provider scope
 * provider.emitEvent(WorkspaceSwitched, { workspaceId: 'ws-1' });
 * ```
 *
 * Consumers: all service and feature modules in `client/web` and `client/admin`.
 */

import { DebugLogger } from "@myoxus/debug";

import { stableHash } from "../../utils";
import type { FrameworkProvider } from ".";
import type { Service } from "./components/service";
import { SUB_COMPONENTS } from "./consts";
import { createIdentifier } from "./identifier";
import type { SubComponent } from "./types";

/**
 * A typed event descriptor created with {@link createEvent}.
 *
 * The phantom `_type` field carries the payload type at compile time;
 * it is never populated at runtime.
 *
 * @template T - The shape of the event payload.
 */
export interface FrameworkEvent<T> {
  /** Unique string identifier for this event. */
  id: string;
  /** Phantom field carrying the payload type. Never set at runtime. */
  _type: T;
}

/**
 * Creates a typed {@link FrameworkEvent} descriptor.
 *
 * @param id - A unique string identifier for this event (e.g. `'WorkspaceSwitched'`).
 * @returns A typed event descriptor to use with {@link EventBus.emit},
 *   {@link EventBus.on}, and {@link OnEvent}.
 *
 * @example
 * ```ts
 * const DocSaved = createEvent<{ docId: string }>('DocSaved');
 * ```
 */
export function createEvent<T>(id: string): FrameworkEvent<T> {
  return { id, _type: {} as T };
}

/**
 * Extracts the payload type from a {@link FrameworkEvent}.
 *
 * @example
 * ```ts
 * const DocSaved = createEvent<{ docId: string }>('DocSaved');
 * type Payload = FrameworkEventType<typeof DocSaved>; // { docId: string }
 * ```
 */
export type FrameworkEventType<T> =
  T extends FrameworkEvent<infer E> ? E : never;

const logger = new DebugLogger("myoxus:event-bus");

/**
 * A hierarchical pub/sub event bus tied to a single {@link FrameworkProvider} scope.
 *
 * When a child scope emits an event, the event propagates upward through the
 * `parent` chain so that root-level subscribers also receive it.  Similarly,
 * when a listener is registered on a child bus, it is forwarded to the parent
 * so that root emitters reach child listeners.
 *
 * Each bus is disposed together with its provider scope.
 */
export class EventBus {
  private listeners: Record<string, Array<(payload: any) => void>> = {};

  /**
   * @param provider - The provider whose {@link EventHandler} registrations
   *   should be wired as listeners on this bus at construction time.
   * @param parent   - The parent bus, if any.  Subscriptions and emissions
   *   propagate up to the root.
   */
  constructor(
    provider: FrameworkProvider,
    private readonly parent?: EventBus,
  ) {
    const handlers = provider.getAll(EventHandler, {
      sameScope: true,
    });

    for (const handler of handlers.values()) {
      this.on(handler.event, handler.handler);
    }
  }

  /**
   * Returns the root-most `EventBus` in the parent chain.
   * Emitting on the root reaches all subscribers in the entire scope tree.
   */
  get root(): EventBus {
    return this.parent?.root ?? this;
  }

  /**
   * Subscribes `listener` to `event` on this bus and all ancestor buses.
   *
   * @param event    - The typed event descriptor.
   * @param listener - The callback invoked with the event payload.
   * @returns An unsubscribe function.  Call it to remove the listener from
   *   all buses it was registered on.
   */
  on<T>(event: FrameworkEvent<T>, listener: (event: T) => void) {
    if (!this.listeners[event.id]) {
      this.listeners[event.id] = [];
    }
    this.listeners[event.id].push(listener);
    const off = this.parent?.on(event, listener);
    return () => {
      off?.();
      this.off(event.id, listener);
    };
  }

  /** Removes a specific listener from this bus only. */
  private off(eventId: string, listener: (event: any) => void) {
    if (!this.listeners[eventId]) {
      return;
    }
    this.listeners[eventId] = this.listeners[eventId].filter(
      (l) => l !== listener,
    );
  }

  /**
   * Emits `event` with `payload` to all listeners registered on this bus.
   *
   * Errors thrown by individual listeners are caught and logged; they do not
   * prevent other listeners from receiving the event.
   *
   * Note: emission does NOT propagate upward — use {@link root}.emit to
   * broadcast from the root bus.
   *
   * @param event   - The typed event descriptor.
   * @param payload - The event payload.
   */
  emit<T>(event: FrameworkEvent<T>, payload: T) {
    logger.debug("Emitting event", event.id, payload);
    const listeners = this.listeners[event.id];
    if (!listeners) {
      return;
    }
    listeners.forEach((listener) => {
      try {
        listener(payload);
      } catch (e) {
        console.error(e);
      }
    });
  }

  /**
   * Removes all listeners from this bus and de-registers them from the parent.
   * Called automatically when the owning scope is disposed.
   */
  dispose(): void {
    for (const eventId of Object.keys(this.listeners)) {
      for (const listener of this.listeners[eventId]) {
        this.parent?.off(eventId, listener);
      }
    }
    this.listeners = {};
  }
}

/**
 * An internal record pairing a {@link FrameworkEvent} with its handler function.
 * Registered as a sub-component by the {@link OnEvent} decorator.
 */
interface EventHandler {
  event: FrameworkEvent<any>;
  handler: (payload: any) => void;
}

/** DI identifier for {@link EventHandler} sub-components. */
export const EventHandler = createIdentifier<EventHandler>("EventHandler");

/**
 * Class decorator that registers a method of a {@link Service} as an event
 * handler for a specific {@link FrameworkEvent}.
 *
 * The handler is wired at service instantiation time — no manual `on()` call
 * is required in the constructor.
 *
 * @param e    - The event to listen to.
 * @param pick - A function that receives the service instance and returns the
 *               method to call on each event.  Must be a method that accepts
 *               the event payload type.
 *
 * @example
 * ```ts
 * const DocClosed = createEvent<{ docId: string }>('DocClosed');
 *
 * @OnEvent(DocClosed, svc => svc.handleDocClosed)
 * class CleanupService extends Service {
 *   handleDocClosed({ docId }: { docId: string }) {
 *     this.cache.delete(docId);
 *   }
 * }
 * ```
 */
export const OnEvent = <
  E extends FrameworkEvent<any>,
  C extends abstract new (...args: any) => any,
  I = InstanceType<C>,
>(
  e: E,
  pick: I extends Service
    ? (i: I) => (e: FrameworkEventType<E>) => void
    : never,
) => {
  return (target: C): C => {
    const handlers = (target as any)[SUB_COMPONENTS] ?? [];
    (target as any)[SUB_COMPONENTS] = [
      ...handlers,
      {
        identifier: EventHandler(
          target.name + stableHash(e) + stableHash(pick),
        ),
        factory: (provider) => {
          return {
            event: e,
            handler: (payload: any) => {
              const i = provider.get(target);
              pick(i).apply(i, [payload]);
            },
          } satisfies EventHandler;
        },
      } satisfies SubComponent,
    ];
    return target;
  };
};
