// SPDX-License-Identifier: AGPL-3.0-or-later

import { atom } from "jotai";
import { nanoid } from "nanoid";

export type GlobalLoadingEvent = {
  key?: string;
};

const globalLoadingEventsBaseAtom = atom<GlobalLoadingEvent[]>([]);

/**
 * Shared command store for app-wide blocking activity indicators.
 *
 * Rendering belongs to the consuming UI layer; this package intentionally owns
 * only queue state so global loading can be used without importing the retired
 * shared component package.
 */
export const globalLoadingEventsAtom = atom<GlobalLoadingEvent[]>((get) =>
  get(globalLoadingEventsBaseAtom),
);

export const resolveGlobalLoadingEventAtom = atom(
  null,
  (_, set, key: string) => {
    set(globalLoadingEventsBaseAtom, (globalLoadingEvents) =>
      globalLoadingEvents.filter((notification) => notification.key !== key),
    );
  },
);

export const pushGlobalLoadingEventAtom = atom<
  null,
  [GlobalLoadingEvent],
  void
>(null, (_, set, newGlobalLoadingEvent) => {
  const event = {
    ...newGlobalLoadingEvent,
    key: newGlobalLoadingEvent.key || nanoid(),
  };

  set(globalLoadingEventsBaseAtom, (globalLoadingEvents) => [
    event,
    ...globalLoadingEvents,
  ]);
});
