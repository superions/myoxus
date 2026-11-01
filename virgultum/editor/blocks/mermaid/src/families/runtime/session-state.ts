// SPDX-License-Identifier: AGPL-3.0-or-later

function sessionKey(storeId: string, ownerId: string, key: string) {
  return `virgultum:${storeId}:${ownerId}:mermaid:${key}`;
}

export function readMermaidSessionState(
  storeId: string,
  ownerId: string,
  key: string,
): unknown {
  if (typeof sessionStorage === "undefined") return undefined;
  try {
    const value = sessionStorage.getItem(sessionKey(storeId, ownerId, key));
    return value === null ? undefined : JSON.parse(value);
  } catch {
    return undefined;
  }
}

/** Session-local UI state must never block document editing or write Source. */
export function writeMermaidSessionState(
  storeId: string,
  ownerId: string,
  key: string,
  value: unknown,
) {
  if (typeof sessionStorage === "undefined") return;
  try {
    const storageKey = sessionKey(storeId, ownerId, key);
    if (value === undefined) sessionStorage.removeItem(storageKey);
    else sessionStorage.setItem(storageKey, JSON.stringify(value));
  } catch {
    /* Storage denial leaves the ordinary live editor fully usable. */
  }
}
