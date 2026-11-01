import { Subject, Subscriber, type Subscription } from "rxjs";

/** Subscribe imperative callbacks without RxJS's asynchronous error reporting.
 * Subject owns ordering and listener storage. A callback failure escapes next()
 * and stops that emission, as required by storage writes and operation hooks.
 * Unsubscription affects future emissions; the current snapshot still runs. */
export function subscribeSynchronousEvents<T>(
  events: Subject<T>,
  callback: (event: T) => void,
): Subscription {
  class EventSubscriber extends Subscriber<T> {
    override next(event: T): void {
      callback(event);
    }
  }
  return events.subscribe(new EventSubscriber());
}
