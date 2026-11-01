// SPDX-License-Identifier: AGPL-3.0-or-later

export type TaskCreationOrigin = "tasks" | "home";
export const TASK_CREATION_RETURN_FOCUS = "task-create";
export const TASK_HOME_ROW_RETURN_FOCUS = "task-row";

/** Home return facts select a focus target, never a Task identity or permission. */
export function taskHomeReturnIntent(params: URLSearchParams) {
  if (params.get("origin") !== "home") return null;
  const requestedReturn = params.get("returnTo");
  const returnTo =
    requestedReturn === "/home" || requestedReturn?.startsWith("/home?")
      ? requestedReturn
      : "/home";
  const requestedScroll = params.get("returnScroll");
  const returnScroll =
    requestedScroll &&
    /^\d+(?:\.\d+)?$/.test(requestedScroll) &&
    Number.isFinite(Number(requestedScroll))
      ? requestedScroll
      : null;
  return {
    returnTo,
    returnScroll,
    returnRowId: params.get("returnRowId") || null,
  };
}

/** Consume a known creation command once while preserving ordinary filter and
 * unrelated query state. Home owns only the entry and its return-focus target.
 */
export function consumeTaskCreationIntent(params: URLSearchParams) {
  if (params.get("create") !== "task") return null;
  const remaining = new URLSearchParams(params);
  remaining.delete("create");
  const home = taskHomeReturnIntent(params);
  const origin: TaskCreationOrigin = home ? "home" : "tasks";
  const { returnTo, returnScroll } = home ?? {
    returnTo: "/home",
    returnScroll: null,
  };
  if (origin === "home") {
    remaining.delete("origin");
    remaining.delete("returnTo");
    remaining.delete("returnScroll");
    remaining.delete("returnRowId");
  }
  return { origin, returnTo, returnScroll, remaining };
}

export function taskCreationReturnRoute(
  returnTo: string,
  returnScroll: string | null,
  returnRowId?: string | null,
) {
  const separator = returnTo.indexOf("?");
  const path = separator < 0 ? returnTo : returnTo.slice(0, separator);
  const params = new URLSearchParams(
    separator < 0 ? "" : returnTo.slice(separator + 1),
  );
  params.set(
    "focus",
    returnRowId ? TASK_HOME_ROW_RETURN_FOCUS : TASK_CREATION_RETURN_FOCUS,
  );
  if (returnRowId) params.set("returnRowId", returnRowId);
  if (returnScroll) params.set("taskReturnScroll", returnScroll);
  return `${path}?${params}`;
}
