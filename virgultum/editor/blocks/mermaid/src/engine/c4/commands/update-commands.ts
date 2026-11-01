// SPDX-License-Identifier: AGPL-3.0-or-later

import type { MermaidC4Argument } from "../model.js";

export function updateMermaidC4ArgumentValue(
  args: readonly MermaidC4Argument[],
  index: number,
  names: readonly string[],
  value: string,
) {
  const next = args.map((argument) => ({ ...argument }));
  setArgumentValue(next, index, names, value);
  return next;
}

export function clearMermaidC4ArgumentValue(
  args: readonly MermaidC4Argument[],
  index: number,
  names: readonly string[],
) {
  const next = args.map((argument) => ({ ...argument }));
  const argument = next[index];
  if (
    argument &&
    ((!argument.named && !argument.key) || argument.key === names[0])
  ) {
    next[index] = { ...argument, value: "" };
  }
  return trimTrailingEmptyArguments(next, args.length);
}

export function setArgumentValue(
  args: MermaidC4Argument[],
  index: number,
  names: readonly string[],
  value: string,
) {
  if (index < 0) return;
  while (args.length <= index) args.push({ key: "", value: "" });
  const argument = args[index];
  // Never splice a named optional value: that would change all later DB slots.
  if ((!argument.named && !argument.key) || argument.key === names[0]) {
    args[index] =
      argument.named || argument.key
        ? { ...argument, value }
        : { key: "", value };
  }
}

export function trimTrailingEmptyArguments(
  args: MermaidC4Argument[],
  minimumLength = 0,
) {
  while (
    args.length > minimumLength &&
    !args.at(-1)?.named &&
    args.at(-1)?.key === "" &&
    args.at(-1)?.value === ""
  )
    args.pop();
  return args;
}
