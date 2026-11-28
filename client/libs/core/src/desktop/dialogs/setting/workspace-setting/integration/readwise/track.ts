// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors

import track from "@myoxus/track";

/**
 * Attaches default Readwise integration telemetry attributes to events emitted
 * through the integration list tracker.
 */
export const readwiseTrack = new Proxy(track.$.settingsPanel.integrationList, {
  get(target, property, receiver) {
    const value = Reflect.get(target, property, receiver);
    if (typeof value !== "function") return value;

    return function (this: unknown, ...args: unknown[]) {
      if (args.length > 0 && typeof args[0] === "object" && args[0] !== null) {
        args[0] = {
          type: "readwise",
          control: "Readwise Card",
          ...args[0],
        };
      }
      return value.apply(this, args);
    };
  },
});
