// SPDX-License-Identifier: AGPL-3.0-or-later

import { getHotkeyHandler } from "@mantine/hooks";

export type MyoxusHotkey = readonly [
  binding: string,
  handler: (event: KeyboardEvent) => void,
];

const physicalKeyPattern = /(?:^|\+)Key[A-Z]$/i;

/**
 * Creates a non-React keyboard handler through Mantine's hotkey parser.
 *
 * Myoxus command declarations use `$mod` for the platform's primary modifier
 * and may name a physical `KeyX`. Mantine uses `Mod` for either Ctrl or Meta,
 * so the adapter resolves `$mod` first to retain the existing platform-exact
 * behavior and enables physical matching only when the declaration requests it.
 */
export function createMyoxusHotkeyHandler(hotkeys: MyoxusHotkey[]) {
  const platform = typeof navigator === "object" ? navigator.platform : "";
  const primaryModifier = /Mac|iPod|iPhone|iPad/.test(platform)
    ? "Meta"
    : "Ctrl";

  const handleHotkey = getHotkeyHandler(
    hotkeys.map(([binding, handler]) => {
      const usePhysicalKeys = physicalKeyPattern.test(binding);
      const normalizedBinding = binding
        .replaceAll("$mod", primaryModifier)
        // Mantine selects the physical matcher through the option and expects
        // the remaining key name without the DOM `Key` code prefix.
        .replace(/(^|\+)Key([A-Z])$/i, "$1$2");

      return [
        normalizedBinding,
        handler,
        { preventDefault: false, usePhysicalKeys },
      ];
    }),
  );

  return (event: KeyboardEvent) => handleHotkey(event);
}
