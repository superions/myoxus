/** @vitest-environment happy-dom */
/**
 * Unit tests for the browser→view synchronization decision in
 * `useBindWorkbenchToBrowserRouter`.
 *
 * Regression target (2026-04-24 Journal-2nd-visit blank page):
 *   When an existing journal doc is opened via `workbench.openDoc(...,
 *   replaceHistory: true)` from `JournalsPageWithConfirmation`'s
 *   `useLayoutEffect`, the view history performs PUSH(/journals) followed
 *   by REPLACE(/:docid) in the same render. After React commits, the
 *   browser-adapter browser→view effect observes `browserLocation=/journals`
 *   with state `fromView,KEY_J`. That key is neither the current
 *   view.location.key (now KEY_D from the REPLACE) nor present in
 *   `view.history.entries` (the REPLACE overwrote it). The pre-fix behavior
 *   fell through to `view.history.push(/journals, 'fromBrowser')`, which
 *   triggered the view→browser listener to emit `replaceState /journals`,
 *   reverting the URL back to `/journals`. The resulting page was blank
 *   (neither placeholder nor editor rendered).
 *
 * Invariants:
 *   INV-BA-01: state `fromView,<currentKey>`  → decision `match`.
 *   INV-BA-02: state `fromView,<pastKey>`    → decision `go` with the right delta.
 *   INV-BA-03: state `fromView,<unknownKey>` in an established View history
 *             → decision `stale-from-view` (does not push).
 *   INV-BA-04: state is null / not 'fromView' → decision `push`.
 *   INV-BA-05: stale `fromView` state after reload plus pristine View history
 *             → decision `push` so the browser URL initializes the Workbench.
 */
import { Framework, MemoryMemento } from "@myoxus/infra";
import { act, cleanup, renderHook } from "@testing-library/react";
import { createElement, useState, type PropsWithChildren } from "react";
import {
  createMemoryRouter,
  RouterProvider,
  useLocation,
  useNavigate,
  type Location,
  type InitialEntry,
} from "react-router";
import { describe, expect, it, vi } from "vitest";

import { GlobalState } from "../../../storage";
import { ContextSurface } from "../../entities/context-surface";
import { View } from "../../entities/view";
import { Workbench } from "../../entities/workbench";
import { ViewScope } from "../../scopes/view";
import { WorkbenchNewTabHandler } from "../../services/workbench-new-tab-handler";
import { WorkbenchDefaultState } from "../../services/workbench-view-state";
import {
  decideBrowserLocationSync,
  useBindWorkbenchToBrowserRouter,
} from "../browser-adapter";

function dataRouterWrapper(initialEntries: InitialEntry[]) {
  return function Wrapper({ children }: PropsWithChildren) {
    // Use the same data-router blocker contract as production, not a legacy
    // MemoryRouter which can synchronize locations but cannot veto browser POP.
    const [router] = useState(() =>
      createMemoryRouter([{ path: "*", element: children }], {
        initialEntries,
      }),
    );
    return createElement(RouterProvider, { router });
  };
}

it("opens a tail pane at its own route without copying the previous browser route", async () => {
  const framework = new Framework();
  framework
    .impl(GlobalState, new MemoryMemento())
    .impl(WorkbenchDefaultState, {
      activeViewIndex: 0,
      basename: "/workspace/workspace-a",
      views: [{ id: "databases", path: { pathname: "/databases" } }],
    })
    .impl(WorkbenchNewTabHandler, { handle: vi.fn() })
    .entity(View)
    .entity(Workbench, [
      WorkbenchDefaultState,
      WorkbenchNewTabHandler,
      GlobalState,
    ])
    .scope(ViewScope)
    .entity(ContextSurface);
  const workbench = framework.provider().get(Workbench);
  const original = workbench.activeView$.value;
  const wrapper = dataRouterWrapper(["/workspace/workspace-a/databases"]);
  const hook = renderHook(
    () => {
      useBindWorkbenchToBrowserRouter(workbench, "/workspace/workspace-a");
      return { location: useLocation(), navigate: useNavigate() };
    },
    { wrapper },
  );
  try {
    await act(async () =>
      workbench.open(
        "/templates?assistantStep=details&assistantGroup=identity#source",
        { at: "tail" },
      ),
    );
    expect(workbench.views$.value).toHaveLength(2);
    const opened = workbench.activeView$.value;
    expect(opened).not.toBe(original);
    expect(opened.location$.value).toMatchObject({
      pathname: "/templates",
      search: "?assistantStep=details&assistantGroup=identity",
      hash: "#source",
    });
    expect(hook.result.current.location).toMatchObject({
      pathname: "/workspace/workspace-a/templates",
      search: "?assistantStep=details&assistantGroup=identity",
      hash: "#source",
    });
    expect(original.history.location.pathname).toBe("/databases");
    await act(async () => hook.result.current.navigate(-1));
    expect(hook.result.current.location.pathname).toBe(
      "/workspace/workspace-a/databases",
    );
    expect(original.history.location.pathname).toBe("/databases");
    await act(async () => hook.result.current.navigate(1));
    expect(hook.result.current.location).toMatchObject({
      pathname: "/workspace/workspace-a/templates",
      search: "?assistantStep=details&assistantGroup=identity",
      hash: "#source",
    });
    await act(async () => workbench.active(original));
    expect(hook.result.current.location.pathname).toBe(
      "/workspace/workspace-a/databases",
    );
    expect(opened.history.location.pathname).toBe("/templates");
  } finally {
    hook.unmount();
    cleanup();
  }
});

it("initializes a recovered Workspace's Workbench from its explicit Home route", async () => {
  const createWorkbench = (workspace: string, pathname: string) => {
    const framework = new Framework();
    framework
      .impl(GlobalState, new MemoryMemento())
      .impl(WorkbenchDefaultState, {
        activeViewIndex: 0,
        basename: `/workspace/${workspace}`,
        views: [{ id: `${workspace}-initial`, path: { pathname } }],
      })
      .impl(WorkbenchNewTabHandler, { handle: vi.fn() })
      .entity(View)
      .entity(Workbench, [
        WorkbenchDefaultState,
        WorkbenchNewTabHandler,
        GlobalState,
      ])
      .scope(ViewScope)
      .entity(ContextSurface);
    return framework.provider().get(Workbench);
  };
  const original = createWorkbench("original", "/databases");
  const recovered = createWorkbench("recovered", "/all");
  // A retained destination may already have history when its scope is revived.
  // The outgoing workspace can observe the router key before this one binds.
  recovered.open("/home");
  recovered.open("/all");
  const wrapper = dataRouterWrapper(["/workspace/original/databases"]);
  const hook = renderHook(
    () => {
      const location = useLocation();
      const basename = location.pathname.match(/^\/workspace\/[^/]+/)![0];
      const workbench =
        basename === "/workspace/recovered" ? recovered : original;
      useBindWorkbenchToBrowserRouter(workbench, basename);
      return { location, navigate: useNavigate() };
    },
    { wrapper },
  );
  const originalEntries = [...original.activeView$.value.history.entries];
  try {
    await act(async () => {
      await hook.result.current.navigate(
        "/workspace/recovered/home?from=recovery#ready",
        { state: "fromView,prior-workspace-lifecycle" },
      );
    });
    expect(hook.result.current.location).toMatchObject({
      pathname: "/workspace/recovered/home",
      search: "?from=recovery",
      hash: "#ready",
    });
    expect(recovered.activeView$.value.history.location).toMatchObject({
      pathname: "/home",
      search: "?from=recovery",
      hash: "#ready",
    });
    expect(original.activeView$.value.history.entries).toEqual(originalEntries);
    await act(async () => recovered.open("/tasks"));
    expect(hook.result.current.location.pathname).toBe(
      "/workspace/recovered/tasks",
    );
    expect(original.activeView$.value.history.entries).toEqual(originalEntries);
  } finally {
    hook.unmount();
    cleanup();
  }
});

it("keeps the data router and pane stacks unchanged on a canceled guarded POP, then proceeds once", async () => {
  const framework = new Framework();
  framework
    .impl(GlobalState, new MemoryMemento())
    .impl(WorkbenchDefaultState, {
      activeViewIndex: 0,
      basename: "/workspace/guarded",
      views: [{ id: "guarded", path: { pathname: "/all" } }],
    })
    .impl(WorkbenchNewTabHandler, { handle: vi.fn() })
    .entity(View)
    .entity(Workbench, [
      WorkbenchDefaultState,
      WorkbenchNewTabHandler,
      GlobalState,
    ])
    .scope(ViewScope)
    .entity(ContextSurface);
  const workbench = framework.provider().get(Workbench),
    view = workbench.activeView$.value;
  view.history.push("/doc");
  const before = [...view.history.entries];
  let decision = Promise.withResolvers<boolean>();
  const remove = view.registerCloseGuard(() =>
    decision.promise.then((allowed) => {
      if (allowed) remove();
      return allowed;
    }),
  );
  const hook = renderHook(
    () => {
      useBindWorkbenchToBrowserRouter(workbench, "/workspace/guarded");
      return { location: useLocation(), navigate: useNavigate() };
    },
    {
      wrapper: dataRouterWrapper(
        before.map((entry) => ({
          pathname: `/workspace/guarded${entry.pathname}`,
          state: `fromView,${entry.key}`,
        })),
      ),
    },
  );
  try {
    await act(async () => hook.result.current.navigate(-1));
    expect(hook.result.current.location.pathname).toBe(
      "/workspace/guarded/doc",
    );
    expect(view.history.index).toBe(1);
    await act(async () => decision.resolve(false));
    expect(view.history.entries).toEqual(before);
    expect(hook.result.current.location.pathname).toBe(
      "/workspace/guarded/doc",
    );
    decision = Promise.withResolvers<boolean>();
    await act(async () => hook.result.current.navigate(-1));
    await act(async () => decision.resolve(true));
    expect(hook.result.current.location.pathname).toBe(
      "/workspace/guarded/all",
    );
    expect(view.history.index).toBe(0);
    await act(async () => hook.result.current.navigate(1));
    expect(hook.result.current.location.pathname).toBe(
      "/workspace/guarded/doc",
    );
    expect(view.history.entries).toEqual(before);
    expect(view.history.index).toBe(1);
  } finally {
    remove();
    hook.unmount();
    cleanup();
    workbench.dispose();
  }
});

function loc(pathname: string, key: string, state: unknown = null): Location {
  return {
    pathname,
    search: "",
    hash: "",
    state,
    key,
  };
}

describe("decideBrowserLocationSync", () => {
  it("INV-BA-01: fromView key matches current view key → match", () => {
    const entries = [loc("/all", "k-all"), loc("/:docid", "k-doc")];
    const newLocation = loc("/:docid", "k-browser", "fromView,k-doc");
    expect(decideBrowserLocationSync(newLocation, "k-doc", entries, 1)).toEqual(
      { kind: "match" },
    );
  });

  it("INV-BA-02: fromView key points to older entry → go with correct delta", () => {
    const entries = [
      loc("/all", "k-all"),
      loc("/:docid", "k-doc"),
      loc("/other", "k-other"),
    ];
    const newLocation = loc("/all", "k-browser", "fromView,k-all");
    expect(
      decideBrowserLocationSync(newLocation, "k-other", entries, 2),
    ).toEqual({ kind: "go", delta: -2 });
  });

  it(
    "INV-BA-03 (regression, journal-2nd-visit): fromView key not in entries " +
      "(REPLACE overwrote the earlier PUSH) → stale-from-view, NOT push",
    () => {
      // Simulates the exact post-condition of:
      //   view.history.push('/journals') → key=KEY_J pushed at index 2
      //   view.history.replace('/:docid') → overwrites index 2 with key=KEY_D
      // A browser-adapter effect runs later with the stale pre-REPLACE
      // browserLocation (/journals, state=fromView,KEY_J).
      const entries = [
        loc("/all", "k-all-0"),
        loc("/all", "k-all-1"),
        loc("/:docid", "KEY_D"), // REPLACE wrote this over KEY_J
      ];
      const newLocation = loc("/journals", "k-browser-stale", "fromView,KEY_J");
      expect(
        decideBrowserLocationSync(newLocation, "KEY_D", entries, 2),
      ).toEqual({ kind: "stale-from-view" });
    },
  );

  it("INV-BA-04: null state (browser-driven navigation) → push", () => {
    const entries = [loc("/all", "k-all")];
    const newLocation = loc("/new", "k-browser", null);
    expect(decideBrowserLocationSync(newLocation, "k-all", entries, 0)).toEqual(
      { kind: "push" },
    );
  });

  it("INV-BA-04: fromBrowser state → push (treated as external nav)", () => {
    const entries = [loc("/all", "k-all")];
    const newLocation = loc("/new", "k-browser", "fromBrowser");
    expect(decideBrowserLocationSync(newLocation, "k-all", entries, 0)).toEqual(
      { kind: "push" },
    );
  });

  it("INV-BA-05: stale fromView state initializes a pristine reloaded View", () => {
    const entries = [loc("/all", "k-new-workbench")];
    const newLocation = loc(
      "/databases/database-1",
      "k-browser",
      "fromView,k-previous-lifecycle",
    );
    expect(
      decideBrowserLocationSync(newLocation, "k-new-workbench", entries, 0),
    ).toEqual({ kind: "push" });
  });

  it.each(["PUSH"] as const)(
    "same-render stale %s still cannot revert the current route",
    (action) => {
      const entries = [loc("/all", "all"), loc("/target", "target")];
      expect(
        decideBrowserLocationSync(
          loc("/source", "browser", "fromView,overwritten"),
          "target",
          entries,
          1,
          action,
        ),
      ).toEqual({ kind: "stale-from-view" });
    },
  );

  it("browser Back after reload restores the precise route even when its old View key is no longer retained", () => {
    const entries = [loc("/all", "new-all"), loc("/target", "new-target")];
    const previous = {
      ...loc("/source", "browser", "fromView,previous-lifecycle"),
      search: "?mode=page&blockIds=instruction",
      hash: "#selection",
    };
    expect(
      decideBrowserLocationSync(previous, "new-target", entries, 1, "POP"),
    ).toEqual({ kind: "push" });
    // Retained in-session entries still use the existing view history owner.
    expect(
      decideBrowserLocationSync(
        { ...previous, state: "fromView,new-all" },
        "new-target",
        entries,
        1,
        "POP",
      ),
    ).toEqual({ kind: "go", delta: -1 });
  });
});
