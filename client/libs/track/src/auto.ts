/**
 * @file auto.ts — @myoxus/track
 *
 * Declarative / automatic tracking utilities.
 *
 * Two mechanisms:
 *
 * 1. {@link makeTracker} — builds a typed proxy chain that turns dot-notation
 *    access into analytics events:
 *    `tracker.$.cmdk.settings.changeLanguage('cn')` emits an event named
 *    `changeLanguage` with `{ page: undefined, segment: 'cmdk', module: 'settings', arg: 'cn' }`.
 *
 * 2. {@link enableAutoTrack} — attaches a delegated click listener on a root
 *    element that reads `data-event-props` attributes from clicked elements
 *    and fires the corresponding event without any imperative call-sites.
 *
 * The `data-event-props` attribute format is `{page}.{segment}.{module}.{event}`.
 * Use `$` as a wildcard (excluded from the emitted properties).
 *
 * Consumers: `client/admin`, `client/web`.
 */

import { DebugLogger } from "@myoxus/debug";

import type { CallableEventsChain, EventsUnion } from "./types";

const logger = new DebugLogger("mixpanel");

interface TrackFn {
  (event: string, props: Record<string, any>): void;
}

const levels = ["page", "segment", "module", "event"] as const;

/**
 * Creates a typed proxy chain for ergonomic analytics event dispatch.
 *
 * Access the chain using dot notation: each level corresponds to a tracking
 * dimension (`page`, `segment`, `module`), and the final call emits the event.
 *
 * @param trackFn - The underlying function that sends the event (e.g. `tracker.track`).
 *
 * @example
 * ```ts
 * const t = makeTracker(tracker.track.bind(tracker));
 * t.$.settings.general.saveSettings({ success: true });
 * // fires: track('saveSettings', { segment: 'settings', module: 'general', success: true })
 * ```
 */
export function makeTracker(trackFn: TrackFn): CallableEventsChain {
  function makeTrackerInner(level: number, info: Record<string, string>) {
    const proxy = new Proxy({} as Record<string, any>, {
      get(target, prop) {
        if (
          typeof prop !== "string" ||
          prop === "$$typeof" /* webpack hot-reload reads this prop */
        ) {
          return undefined;
        }

        if (levels[level] === "event") {
          return (arg: string | Record<string, any>) => {
            trackFn(prop, {
              ...info,
              ...(typeof arg === "string" ? { arg } : arg),
            });
          };
        } else {
          let levelProxy = target[prop];
          if (levelProxy) {
            return levelProxy;
          }

          levelProxy = makeTrackerInner(
            level + 1,
            prop === "$" ? { ...info } : { ...info, [levels[level]]: prop },
          );
          target[prop] = levelProxy;
          return levelProxy;
        }
      },
    });

    return proxy;
  }

  return makeTrackerInner(0, {}) as CallableEventsChain;
}

/**
 * Attaches a delegated click listener to `root` that reads `data-event-props`
 * attributes from clicked elements and fires the corresponding analytics event.
 *
 * This enables purely declarative tracking without any imperative call-sites
 * in component code.  The attribute format is a dot-separated four-level path:
 * `{page}.{segment}.{module}.{event}`.  Use `$` for any level to omit that
 * dimension from the emitted properties.
 *
 * Additional event arguments can be supplied via:
 *  - `data-event-arg="value"` → emitted as `{ arg: "value" }`
 *  - `data-event-args-foo="bar"` → emitted as `{ foo: "bar" }`
 *
 * @param root    - The container element to listen on (typically `document.body`
 *                  or the React root element).
 * @param trackFn - The underlying track function to call for each matched event.
 * @returns A cleanup function that removes the listener.
 *
 * @example
 * ```html
 * <button
 *   data-event-props="$.cmdk.settings.changeLanguage"
 *   data-event-arg="cn"
 * />
 * <!-- or named args: -->
 * <button
 *   data-event-props="dashboard.sidebar.navigation.openPage"
 *   data-event-args-control="page-title"
 * />
 * ```
 */
export function enableAutoTrack(root: HTMLElement, trackFn: TrackFn) {
  const listener = (e: Event) => {
    const el = e.target as HTMLElement | null;
    if (!el) {
      return;
    }
    const dataset = el.dataset;

    if (dataset["eventProps"]) {
      const args: Record<string, any> = {};
      if (dataset["eventArg"] !== undefined) {
        args["arg"] = dataset["eventArg"];
      } else {
        for (const argName of Object.keys(dataset)) {
          if (argName.startsWith("eventArgs")) {
            args[argName.slice(9).toLowerCase()] = dataset[argName];
          }
        }
      }

      const props = dataset["eventProps"]
        .split(".")
        .map((name) => (name === "$" ? undefined : name));
      if (props.length !== levels.length) {
        logger.error("Invalid event props on element", el);
        return;
      }

      const event = props[3];

      if (!event) {
        logger.error("Invalid event props on element", el);
        return;
      }

      trackFn(event, {
        page: props[0] as any,
        segment: props[1],
        module: props[2],
        ...args,
      });
    }
  };

  root.addEventListener("click", listener, {});
  return () => {
    root.removeEventListener("click", listener);
  };
}

/**
 * React module augmentation — adds declarative tracking attributes to all
 * HTML elements in JSX.
 *
 * `data-event-props` is typed as {@link EventsUnion} so TypeScript will
 * reject unknown event paths at compile time.
 */
declare module "react" {
  //  we have to declare `T` but it's actually not used

  // oxlint-disable-next-line no-unused-vars
  interface HTMLAttributes<T> {
    /** Dot-separated four-level event path (page.segment.module.event). */
    "data-event-props"?: EventsUnion;
    /** Single freeform argument value for the event. */
    "data-event-arg"?: string;
    /** Named argument: `control` dimension value for the event. */
    "data-event-args-control"?: string;
  }
}
