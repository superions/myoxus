// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors

const setViewTransitionScope = (scope: string) => {
  document.body.setAttribute(`data-${scope}`, "");
};

const removeViewTransitionScope = (scope: string) => {
  document.body.removeAttribute(`data-${scope}`);
};

export function startScopedViewTransition(
  scope: string | string[],
  cb: () => Promise<void> | void,
  options?: { timeout?: number },
) {
  if (typeof document === "undefined") return;

  if (typeof document.startViewTransition !== "function") {
    cb()?.catch(console.error);
    return;
  }

  const scopes = Array.isArray(scope) ? scope : [scope];
  const timeout = options?.timeout ?? 2000;
  scopes.forEach(setViewTransitionScope);

  const viewTransition = document.startViewTransition(cb);
  const timeoutPromise = new Promise<void>((_, reject) => {
    window.setTimeout(
      () => reject(new Error("View transition timeout")),
      timeout,
    );
  });

  Promise.race([viewTransition.finished, timeoutPromise])
    .catch((error) => {
      console.error(`View transition[${scope}] failed: ${error}`);
    })
    .finally(() => scopes.forEach(removeViewTransitionScope));
}
