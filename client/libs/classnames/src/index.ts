// SPDX-License-Identifier: AGPL-3.0-or-later

export type ClassValue =
  | string
  | number
  | false
  | null
  | undefined
  | ClassValue[]
  | Record<string, unknown>;

function appendClassValue(output: string[], value: ClassValue) {
  if (!value) return;

  if (typeof value === "string" || typeof value === "number") {
    output.push(String(value));
    return;
  }

  if (Array.isArray(value)) {
    value.forEach((item) => appendClassValue(output, item));
    return;
  }

  Object.entries(value).forEach(([className, enabled]) => {
    if (enabled) output.push(className);
  });
}

/**
 * Small owned class-name composer for product UI code.
 *
 * It intentionally covers the tiny `clsx` contract used by Myoxus Core without
 * keeping `clsx` as a visible UI dependency: strings/numbers, nested arrays and
 * object maps with truthy guards.
 */
export function classNames(...values: ClassValue[]) {
  const output: string[] = [];
  values.forEach((value) => appendClassValue(output, value));
  return output.join(" ");
}
