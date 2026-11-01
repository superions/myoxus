import { useLiveData } from "@myoxus/infra";
import type { Location } from "react-router";
import { useEffect, useRef } from "react";
import {
  useBlocker,
  useLocation,
  useNavigate,
  useNavigationType,
} from "react-router";

import type { Workbench } from "../entities/workbench";

/**
 * This hook binds the workbench to the browser router.
 * It listens to the active view and updates the browser location accordingly.
 * It also listens to the browser location and updates the active view accordingly.
 *
 * The history of the active view and the browser are two different stacks.
 *
 * In the browser, we use browser history as the criterion, and view history is not very important.
 * So our synchronization strategy is as follows:
 *
 * 1. When the active view history changed, we update the browser history, based on the update action.
 *    - If the update action is PUSH, we navigate to the new location.
 *    - If the update action is REPLACE, we replace the current location.
 * 2. When the browser location changed, we update the active view history just in PUSH action.
 * 3. To avoid infinite loop, we add a state to the location to indicate the source of the change.
 */
export function useBindWorkbenchToBrowserRouter(
  workbench: Workbench,
  basename: string,
) {
  const navigate = useNavigate();
  const browserLocation = useLocation();
  const browserAction = useNavigationType();
  const lastBrowserKey = useRef(browserLocation.key);

  const view = useLiveData(workbench.activeView$);
  const previousBinding = useRef({ workbench, view });
  // A pane blocker runs after browser POP and cannot restore the browser's own
  // index. The data router owns that reversal; do not let its location reach
  // the browser→pane binding until every leased close participant accepts.
  const blocker = useBlocker(
    ({ currentLocation, nextLocation }) =>
      (currentLocation.pathname !== nextLocation.pathname ||
        currentLocation.search !== nextLocation.search ||
        currentLocation.hash !== nextLocation.hash) &&
      workbench.views$.value.some(
        (candidate) => candidate.hasCloseGuards$.value,
      ),
  );
  useEffect(() => {
    if (blocker.state !== "blocked") return;
    let current = true;
    const proceed = (allowed: boolean) => {
      if (!current) return;
      if (allowed) blocker.proceed();
      else blocker.reset();
    };
    const decision = workbench.requestCloseGuards();
    if (typeof decision === "boolean") proceed(decision);
    else void decision.then(proceed);
    return () => {
      current = false;
    };
  }, [blocker, workbench]);

  useEffect(() => {
    return view.history.listen((update) => {
      if (update.action === "POP") {
        // This is because the history of view and browser are two different stacks,
        // the POP action cannot be synchronized.
        return;
      }

      const newBrowserLocation = viewLocationToBrowserLocation(
        update.location,
        basename,
      );

      navigate(newBrowserLocation, {
        state: "fromView," + newBrowserLocation.key,
        replace:
          update.action === "REPLACE" ||
          newBrowserLocation.state === "fromBrowser",
      });
    });
  }, [basename, browserLocation, navigate, view]);

  useEffect(() => {
    // React Router labels the initial load POP too. Only a changed browser
    // entry is an actual Back/Forward operation, not a bootstrap redirect.
    const browserPop =
      browserAction === "POP" && lastBrowserKey.current !== browserLocation.key;
    lastBrowserKey.current = browserLocation.key;
    const workbenchChanged = previousBinding.current.workbench !== workbench;
    const paneChanged =
      previousBinding.current.workbench === workbench &&
      previousBinding.current.view !== view;
    previousBinding.current = { workbench, view };
    if (paneChanged) {
      // A pane switch selects its retained route. The old browser location
      // belongs to the previous pane and must not overwrite this history.
      const target = viewLocationToBrowserLocation(
        view.history.location,
        basename,
      );
      navigate(target, { state: "fromView," + target.key });
      return;
    }
    // A different Workspace owns a different Workbench. Its default pane must
    // adopt the explicit browser destination, not redirect it to /all.
    const newLocation = browserLocationToViewLocation(
      browserLocation,
      basename,
    );
    if (newLocation === null) {
      return;
    }
    const decision = decideBrowserLocationSync(
      newLocation,
      view.location$.value.key,
      view.history.entries,
      view.history.index,
      // The old scope may already have observed this browser key while the
      // destination workspace was loading. Its retained Workbench must still
      // adopt the explicit route, even with a non-pristine pane history.
      browserPop || workbenchChanged ? "POP" : "PUSH",
    );
    switch (decision.kind) {
      case "match":
      case "stale-from-view":
        return;
      case "go":
        view.history.go(decision.delta);
        return;
      case "push":
        view.history.push(newLocation, "fromBrowser");
        return;
    }
  }, [basename, browserAction, browserLocation, navigate, view, workbench]);
}

/**
 * Pure decision function for the browser→view synchronization step. Split out
 * from the effect body so the race-condition regression can be covered by a
 * unit test without mounting React.
 *
 * Returns one of:
 *  - `match`            — browserLocation already matches view.location; do nothing.
 *  - `go(delta)`        — browserLocation is an older entry still in view.history;
 *                         move view.history to that index.
 *  - `stale-from-view`  — browserLocation has a `fromView` state whose key is
 *                         neither current nor present in entries. This happens
 *                         when a view-history REPLACE has already overwritten
 *                         the entry produced by an earlier PUSH in the same
 *                         React render (e.g. /journals → /:docid). The REPLACE
 *                         target is the authoritative state; pushing the stale
 *                         browserLocation back would flip the URL. Do nothing.
 *  - `push`             — browserLocation did not originate from view.history,
 *                         or carries a key from a previous page lifecycle while
 *                         the new View still has only its initial entry, or an
 *                         actual browser POP selects a retained pre-reload entry. Push it
 *                         into view.history tagged `fromBrowser` so the
 *                         view→browser listener does not echo back as PUSH.
 */
export type BrowserSyncDecision =
  | { kind: "match" }
  | { kind: "go"; delta: number }
  | { kind: "stale-from-view" }
  | { kind: "push" };

export function decideBrowserLocationSync(
  newLocation: Location,
  currentViewKey: string,
  entries: readonly Location[],
  index: number,
  browserAction: "POP" | "PUSH" | "REPLACE" = "PUSH",
): BrowserSyncDecision {
  if (
    typeof newLocation.state === "string" &&
    newLocation.state.startsWith("fromView")
  ) {
    const fromViewKey = newLocation.state.substring("fromView,".length);
    if (fromViewKey === currentViewKey) {
      return { kind: "match" };
    }
    const target = entries.findIndex((entry) => entry.key === fromViewKey);
    if (target !== -1) {
      return { kind: "go", delta: target - index };
    }
    // Browser history state survives a full reload, but Workbench View history
    // does not. A pristine View therefore cannot be racing an in-session
    // REPLACE; its visible browser route is the authoritative initial route.
    // Back/Forward may select an entry from before a reload even after this
    // View has acquired new entries. Unlike a stale PUSH/REPLACE effect, POP
    // is an explicit browser journey: its complete route must become visible.
    if (browserAction === "POP" || (entries.length === 1 && index === 0)) {
      return { kind: "push" };
    }
    return { kind: "stale-from-view" };
  }
  return { kind: "push" };
}

function browserLocationToViewLocation(
  location: Location,
  basename: string,
): Location | null {
  if (!location.pathname.startsWith(basename)) {
    return null;
  }
  return {
    ...location,
    pathname: location.pathname.slice(basename.length),
  };
}

function viewLocationToBrowserLocation(
  location: Location,
  basename: string,
): Location {
  return {
    ...location,
    pathname: `${basename}${location.pathname}`,
  };
}
