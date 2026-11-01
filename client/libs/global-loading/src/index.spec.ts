// SPDX-License-Identifier: AGPL-3.0-or-later

import { createStore } from "jotai";
import { describe, expect, test } from "vitest";

import {
  type GlobalLoadingEvent,
  globalLoadingEventsAtom,
  pushGlobalLoadingEventAtom,
  resolveGlobalLoadingEventAtom,
} from "./index";

type GlobalLoadingStore = ReturnType<typeof createStore>;

function pushEvent(store: GlobalLoadingStore, event: GlobalLoadingEvent) {
  store.set(pushGlobalLoadingEventAtom, event);
}

describe("global loading command store", () => {
  test("pushes newest events first and resolves by key", () => {
    const store = createStore();

    pushEvent(store, { key: "export" });
    pushEvent(store, { key: "sync" });

    expect(
      store.get(globalLoadingEventsAtom).map((event) => event.key),
    ).toEqual(["sync", "export"]);

    store.set(resolveGlobalLoadingEventAtom, "sync");

    expect(
      store.get(globalLoadingEventsAtom).map((event) => event.key),
    ).toEqual(["export"]);
  });

  test("assigns a generated key without mutating the caller object", () => {
    const store = createStore();
    const event = {};

    pushEvent(store, event);

    const [stored] = store.get(globalLoadingEventsAtom);
    expect(stored.key).toMatch(/^[\w-]+$/);
    expect(event).toEqual({});
  });
});
