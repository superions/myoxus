import { pick } from "lodash-es";
import {
  defer,
  finalize,
  from,
  fromEvent,
  Observable,
  of,
  Subject,
  take,
  takeUntil,
} from "rxjs";

import { MANUALLY_STOP, subscribeSynchronousEvents } from "../utils";
import {
  AutoMessageHandler,
  type CallMessage,
  fetchTransferables,
  type MessageHandlers,
  type ReturnMessage,
  type SubscribeMessage,
  type SubscriptionCompleteMessage,
  type SubscriptionErrorMessage,
  type SubscriptionNextMessage,
} from "./message";
import type { OpInput, OpNames, OpOutput, OpSchema } from "./types";

interface OpCallContext {
  signal: AbortSignal;
}

export type OpHandler<Ops extends OpSchema, Op extends OpNames<Ops>> = (
  payload: OpInput<Ops, Op>[0],
  ctx: OpCallContext,
) =>
  | OpOutput<Ops, Op>
  | Promise<OpOutput<Ops, Op>>
  | Observable<OpOutput<Ops, Op>>;

export class OpConsumer<Ops extends OpSchema> extends AutoMessageHandler {
  private readonly events = new Subject<{
    phase: "before" | "after";
    name: string;
    args: any[];
  }>();

  private readonly registeredOpHandlers = new Map<
    OpNames<Ops>,
    OpHandler<Ops, any>
  >();

  private readonly processing = new Map<string, AbortController>();

  override get handlers() {
    return {
      call: this.handleCallMessage,
      cancel: this.handleCancelMessage,
      subscribe: this.handleSubscribeMessage,
      unsubscribe: this.handleCancelMessage,
    };
  }

  private readonly handleCallMessage: MessageHandlers["call"] = (msg) => {
    const abortController = new AbortController();
    this.processing.set(msg.id, abortController);

    try {
      this.events.next({
        phase: "before",
        name: msg.name,
        args: [msg.payload],
      });
    } catch (error) {
      this.processing.delete(msg.id);
      abortController.abort(MANUALLY_STOP);
      throw error;
    }
    this.ob$(msg, abortController.signal)
      .pipe(
        take(1),
        finalize(() => this.processing.delete(msg.id)),
      )
      .subscribe({
        next: (data) => {
          this.events.next({
            phase: "after",
            name: msg.name,
            args: [msg.payload, data],
          });
          const transferables = fetchTransferables(data);
          this.port.postMessage(
            {
              type: "return",
              id: msg.id,
              data,
            } satisfies ReturnMessage,
            { transfer: transferables },
          );
        },
        error: (error) => {
          this.port.postMessage({
            type: "return",
            id: msg.id,
            error: pick(error, [
              "name",
              "message",
              "code",
              "type",
              "status",
              "data",
              "stacktrace",
            ]),
          } satisfies ReturnMessage);
        },
      });
  };

  private readonly handleSubscribeMessage: MessageHandlers["subscribe"] = (
    msg,
  ) => {
    const abortController = new AbortController();
    this.processing.set(msg.id, abortController);

    this.ob$(msg, abortController.signal)
      .pipe(finalize(() => this.processing.delete(msg.id)))
      .subscribe({
        next: (data) => {
          const transferables = fetchTransferables(data);
          this.port.postMessage(
            {
              type: "next",
              id: msg.id,
              data,
            } satisfies SubscriptionNextMessage,
            { transfer: transferables },
          );
        },
        error: (error) => {
          this.port.postMessage({
            type: "error",
            id: msg.id,
            error: pick(error, [
              "name",
              "message",
              "code",
              "type",
              "status",
              "data",
              "stacktrace",
            ]),
          } satisfies SubscriptionErrorMessage);
        },
        complete: () => {
          this.port.postMessage({
            type: "complete",
            id: msg.id,
          } satisfies SubscriptionCompleteMessage);
        },
      });
  };

  private readonly handleCancelMessage: MessageHandlers["cancel"] &
    MessageHandlers["unsubscribe"] = (msg) => {
    const abortController = this.processing.get(msg.id);
    if (!abortController) {
      return;
    }

    abortController.abort(MANUALLY_STOP);
  };

  register<Op extends OpNames<Ops>>(op: Op, handler: OpHandler<Ops, Op>) {
    this.registeredOpHandlers.set(op, handler);
  }

  registerAll(
    handlers: OpNames<Ops> extends string
      ? { [K in OpNames<Ops>]: OpHandler<Ops, K> }
      : never,
  ) {
    for (const [op, handler] of Object.entries(handlers)) {
      this.register(op as any, handler as any);
    }
  }

  before<Op extends OpNames<Ops>>(
    op: Op,
    handler: (...input: OpInput<Ops, Op>) => void,
  ) {
    subscribeSynchronousEvents(this.events, (event) => {
      if (event.phase === "before" && event.name === op)
        handler(...(event.args as OpInput<Ops, Op>));
    });
  }

  after<Op extends OpNames<Ops>>(
    op: Op,
    handler: (...args: [...OpInput<Ops, Op>, OpOutput<Ops, Op>]) => void,
  ) {
    subscribeSynchronousEvents(this.events, (event) => {
      if (event.phase === "after" && event.name === op)
        handler(...(event.args as [...OpInput<Ops, Op>, OpOutput<Ops, Op>]));
    });
  }

  /**
   * @internal
   */
  ob$(op: CallMessage | SubscribeMessage, signal: AbortSignal) {
    return defer(() => {
      const handler = this.registeredOpHandlers.get(op.name as any);
      if (!handler) {
        throw new Error(
          `Handler for operation [${op.name}] is not registered.`,
        );
      }

      const ret$ = handler(op.payload, { signal });

      let ob$: Observable<any>;
      if (ret$ instanceof Promise) {
        ob$ = from(ret$);
      } else if (ret$ instanceof Observable) {
        ob$ = ret$;
      } else {
        ob$ = of(ret$);
      }

      return ob$.pipe(takeUntil(fromEvent(signal, "abort")));
    });
  }

  destroy() {
    super.close();
    this.registeredOpHandlers.clear();
    this.processing.forEach((controller) => {
      controller.abort(MANUALLY_STOP);
    });
    this.processing.clear();
    this.events.complete();
  }
}
