// SPDX-License-Identifier: AGPL-3.0-or-later

export function shallowEqual(objA: unknown, objB: unknown): boolean {
  if (Object.is(objA, objB)) {
    return true;
  }

  if (
    typeof objA !== "object" ||
    objA === null ||
    typeof objB !== "object" ||
    objB === null
  ) {
    return false;
  }

  const recordA = objA as Record<PropertyKey, unknown>;
  const recordB = objB as Record<PropertyKey, unknown>;
  const keysA = Object.keys(recordA);
  const keysB = Object.keys(recordB);

  if (keysA.length !== keysB.length) {
    return false;
  }

  for (const key of keysA) {
    if (
      !Object.prototype.hasOwnProperty.call(recordB, key) ||
      !Object.is(recordA[key], recordB[key])
    ) {
      return false;
    }
  }

  return true;
}

export const shallowUpdater =
  <T>(newState: T) =>
  (state: T | null): T => {
    if (state && shallowEqual(state, newState)) {
      return state;
    }
    return newState;
  };
