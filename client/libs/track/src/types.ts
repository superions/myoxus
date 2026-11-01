/**
 * @file types.ts — @myoxus/track
 *
 * TypeScript type infrastructure for the four-level event hierarchy used by
 * the telemetry/analytics system.
 *
 * The event taxonomy is: `page > segment > module > [events]`.
 * Every leaf of the {@link Events} tree must be an array of event name strings
 * at exactly depth 4.  The compile-time assertion
 * {@link _assertIsAllEventsDefinedInFourLevels} enforces this invariant.
 *
 * Consumers: `client/admin`, `client/web` — via the `track` proxy object
 * exported from `@myoxus/track`.
 */

import type { EventArgs, Events } from "./events";

/**
 * Optional overrides that can accompany any track call to re-contextualise
 * an event's location metadata.
 *
 * These fields take precedence over the page/segment/module inferred from the
 * `track` proxy chain, allowing a shared component to report events under a
 * caller-supplied context.
 */
type EventPropsOverride = {
  page?: keyof Events;
  segment?: string;
  module?: string;
  control?: string;
};

/**
 * The statically-typed call signature for every event in the {@link Events}
 * tree.
 *
 * Navigating the `track` proxy (`track.myPage.mySegment.myModule.myEvent(...)`)
 * produces a function whose argument type is either:
 *  - `Partial<EventArgs[Event]> & EventPropsOverride` when the event has
 *    registered argument types in {@link EventArgs}.
 *  - `EventPropsOverride` otherwise (the event takes no custom arguments).
 *
 * All arguments are optional to simplify call-sites where some fields are not
 * yet known.
 */
export type CallableEventsChain = {
  [Page in keyof Events]: {
    [Segment in keyof Events[Page]]: {
      [Module in keyof Events[Page][Segment]]: {
        [
          Event in Events[Page][Segment][Module][number]
        ]: Event extends keyof EventArgs
          ? (
              // we make all args partial to simply satisfies nullish type checking
              args?: Partial<EventArgs[Event]> & EventPropsOverride,
            ) => void
          : (args?: EventPropsOverride) => void;
      };
    };
  };
};

/**
 * A union of all dot-separated event path strings in the form
 * `"page.segment.module.event"`.
 *
 * Used to type the `data-event-props` HTML attribute declared in the React
 * module augmentation in `auto.ts`, enabling compile-time validation of
 * declarative event annotations in JSX.
 */
export type EventsUnion = {
  [Page in Extract<keyof Events, string>]: {
    [Segment in Extract<keyof Events[Page], string>]: {
      [Module in Extract<keyof Events[Page][Segment], string>]: {
        [
          Event in Extract<Events[Page][Segment][Module][number], string>
        ]: `${Page}.${Segment}.${Module}.${Event}`;
      }[Extract<Events[Page][Segment][Module][number], string>];
    }[Extract<keyof Events[Page][Segment], string>];
  }[Extract<keyof Events[Page], string>];
}[Extract<keyof Events, string>];

/**
 * Compile-time check that the {@link Events} tree is exactly four levels deep
 * (`page > segment > module > string[]`).
 *
 * @internal The value is always `true`; assigning it triggers a type error
 * during compilation when any branch of Events violates the depth constraint.
 */
// page > segment > module > [events]
type IsFourLevelsDeep<
  T,
  Depth extends number[] = [],
> = Depth["length"] extends 3
  ? T extends Array<any>
    ? true
    : false
  : T extends object
    ? {
        [K in keyof T]: IsFourLevelsDeep<T[K], [...Depth, 0]>;
      }[keyof T] extends true
      ? true
      : false
    : false;

// for type checking
export const _assertIsAllEventsDefinedInFourLevels: IsFourLevelsDeep<Events> = true;

/**
 * Contextual metadata attached to every tracked event describing where within
 * the UI the interaction occurred and which entity it concerned.
 *
 * Fields are loosely grouped:
 *  - **Location**: `page`, `segment`, `module`, `control`, `arg` — identify the
 *    four-level hierarchy position and the specific UI control.
 *  - **Entity**: `type`, `category`, `id` — identify the data object acted upon
 *    (e.g. a workspace, document, or team).
 */
export interface EventProps {
  // location
  /** The top-level page context for this event. */
  page?: keyof Events;
  /** Sub-section of the page (e.g. sidebar, toolbar). */
  segment?: string;
  /** Feature module that owns the control (e.g. "editor", "sharing"). */
  module?: string;
  /** Specific UI control that was interacted with. */
  control?: string;
  /** Freeform argument string accompanying the control action. */
  arg?: string;

  // entity
  /** Entity type acted upon (e.g. "workspace", "doc", "team"). */
  type?: string;
  /** Category of the entity (e.g. "personal", "shared"). */
  category?: string;
  /** Unique ID of the entity. */
  id?: string;
}
