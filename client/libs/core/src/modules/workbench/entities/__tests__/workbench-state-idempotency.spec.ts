/**
 * @vitest-environment happy-dom
 */

import { Framework, MemoryMemento } from "@myoxus/infra";
import { describe, expect, test, vi } from "vitest";

import { GlobalState } from "../../../storage";
import { ViewScope } from "../../scopes/view";
import { WorkbenchNewTabHandler } from "../../services/workbench-new-tab-handler";
import { WorkbenchDefaultState } from "../../services/workbench-view-state";
import { ContextSurface } from "../context-surface";
import { View } from "../view";
import { Workbench } from "../workbench";

function createWorkbench() {
  const framework = new Framework();
  const globalState = new MemoryMemento();

  framework
    .impl(GlobalState, globalState)
    .impl(WorkbenchDefaultState, {
      activeViewIndex: 0,
      basename: "/",
      views: [{ id: "view-1", path: { pathname: "/all" } }],
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

  return {
    globalState,
    workbench: framework.provider().get(Workbench),
  };
}

describe("Workbench state idempotency", () => {
  test("vetoes guarded history, activation and pane closure without replaying a stale accepted intent", async () => {
    const { workbench } = createWorkbench();
    const view = workbench.activeView$.value;
    const before = [...view.history.entries];
    const closed = vi.fn();
    let remove = view.registerCloseGuard(() => false);
    try {
      view.history.push("/denied");
      view.requestClose(closed);
      expect(workbench.createView("head", "/denied-pane")).toBeUndefined();
      expect(view.history.entries).toEqual(before);
      expect(workbench.views$.value).toEqual([view]);
      expect(closed).not.toHaveBeenCalled();
      remove();
      const decision = Promise.withResolvers<boolean>();
      remove = view.registerCloseGuard(() => decision.promise);
      view.history.push("/accepted-first");
      view.history.replace("/stale-second");
      decision.resolve(true);
      await decision.promise;
      await Promise.resolve();
      expect(view.history.location.pathname).toBe("/accepted-first");
      expect(view.history.entries).toHaveLength(2);
      remove();
      workbench.createView("tail", "/other", false);
      remove = view.registerCloseGuard(() => false);
      workbench.active(1);
      workbench.close(view);
      expect(workbench.activeView$.value).toBe(view);
      expect(workbench.views$.value).toHaveLength(2);
      remove();
      workbench.active(1);
      const active = workbench.activeView$.value;
      const unrelatedGuard = vi.fn(() => false);
      remove = active.registerCloseGuard(unrelatedGuard);
      workbench.close(view);
      expect(workbench.views$.value).toEqual([active]);
      expect(workbench.activeView$.value).toBe(active);
      expect(unrelatedGuard).not.toHaveBeenCalled();
    } finally {
      remove();
      workbench.dispose();
    }
  });
  test("keeps context-panel visibility transient and idempotent", () => {
    const { globalState, workbench } = createWorkbench();
    const setSpy = vi.spyOn(globalState, "set");
    const observed: boolean[] = [];
    const subscription = workbench.contextPanelOpen$.subscribe((value) => {
      observed.push(value);
    });

    try {
      workbench.openContextPanel();
      workbench.openContextPanel();
      workbench.closeContextPanel();
      workbench.closeContextPanel();
    } finally {
      subscription.unsubscribe();
    }

    expect(observed).toEqual([false, true, false]);
    expect(setSpy).not.toHaveBeenCalledWith(
      expect.stringMatching(/^workbenchContextPanel/),
      expect.anything(),
    );
  });

  test("persists tool commands once and keeps subset invariants", () => {
    const framework = new Framework();
    framework.entity(View).scope(ViewScope).entity(ContextSurface);
    const view = framework.provider().createEntity(View, {
      id: "view-sidebar-idempotency",
    });
    const persist = vi.fn();
    const openToolHost = vi.fn();
    const closeToolHost = vi.fn();
    view.addContextSurface({ id: "outline", order: 10 });
    view.addContextSurface({ id: "activity", order: 20 });
    view.bindToolLayout({
      workspaceId: "workspace-a",
      viewFamily: "document-page",
      override: {
        workspaceId: "workspace-a",
        viewFamily: "document-page",
        orderedToolIds: ["outline", "activity", "graph-details"],
        visibleToolIds: ["outline", "graph-details"],
        collapsedToolIds: [],
      },
      persist,
      openToolHost,
      closeToolHost,
    });

    view.showTool("activity");
    view.showTool("activity");
    view.toggleToolCollapsed("activity");
    view.hideTool("activity");

    expect(openToolHost).toHaveBeenCalledTimes(2);
    expect(persist).toHaveBeenCalledTimes(3);
    expect(persist.mock.lastCall?.[0]).toMatchObject({
      orderedToolIds: ["outline", "activity", "graph-details"],
      visibleToolIds: ["outline", "graph-details"],
      collapsedToolIds: [],
    });
    expect(view.toolHeaderFocusRequest$.value?.id).toBe("outline");
    view.hideTool("outline");
    expect(closeToolHost).toHaveBeenCalledOnce();
  });

  test("opens a product default without overriding an explicit hidden layout", () => {
    const framework = new Framework();
    framework.entity(View).scope(ViewScope).entity(ContextSurface);
    const view = framework.provider().createEntity(View, {
      id: "view-graph-default",
    });
    const persist = vi.fn();
    const openToolHost = vi.fn();
    const unbind = view.bindToolLayout({
      workspaceId: "workspace-a",
      viewFamily: "graph",
      override: null,
      persist,
      openToolHost,
      closeToolHost: vi.fn(),
    });
    view.addContextSurface({ id: "graph-details", viewFamilies: ["graph"] });

    view.showDefaultTool("graph-details");
    expect(openToolHost).toHaveBeenCalledTimes(1);
    expect(persist).not.toHaveBeenCalled();

    unbind();
    view.bindToolLayout({
      workspaceId: "workspace-a",
      viewFamily: "graph",
      override: {
        workspaceId: "workspace-a",
        viewFamily: "graph",
        orderedToolIds: ["graph-details"],
        visibleToolIds: [],
        collapsedToolIds: [],
      },
      persist,
      openToolHost,
      closeToolHost: vi.fn(),
    });
    view.showDefaultTool("graph-details");

    expect(openToolHost).toHaveBeenCalledTimes(1);
    expect(persist).not.toHaveBeenCalled();
  });

  test("orders context capabilities and resolves the family default", () => {
    const framework = new Framework();
    framework.entity(View).scope(ViewScope).entity(ContextSurface);
    const view = framework.provider().createEntity(View, {
      id: "view-sidebar-order",
    });

    view.addContextSurface({
      id: "chat",
      label: "AI chat",
      order: 90,
    });
    view.addContextSurface({
      id: "activity",
      label: "Activity",
      order: 20,
    });
    view.addContextSurface({
      id: "tags",
      label: "Tags",
      order: 15,
    });
    view.addContextSurface({
      id: "outline",
      label: "Outline",
      order: 10,
    });
    view.addContextSurface({
      id: "document-info",
      label: "Info",
      order: 30,
    });

    expect(view.contextSurfaces$.value.map((surface) => surface.id)).toEqual([
      "outline",
      "tags",
      "activity",
      "document-info",
      "chat",
    ]);
    expect(view.toolLayout$.value.visibleToolIds).toEqual(["outline", "tags"]);

    view.removeContextSurface("chat");
    expect(view.toolLayout$.value.orderedToolIds).toEqual([
      "outline",
      "tags",
      "activity",
      "document-info",
    ]);
  });

  test("persists Tags hide, show, collapse and reorder without changing its default registration", () => {
    const framework = new Framework();
    framework.entity(View).scope(ViewScope).entity(ContextSurface);
    const view = framework.provider().createEntity(View, {
      id: "view-tags-layout",
    });
    const persist = vi.fn();
    const openToolHost = vi.fn();
    view.addContextSurface({ id: "activity", order: 50 });
    view.addContextSurface({ id: "tags", order: 15 });
    view.addContextSurface({ id: "outline", order: 10 });
    view.bindToolLayout({
      workspaceId: "workspace-a",
      viewFamily: "document-page",
      override: null,
      persist,
      openToolHost,
      closeToolHost: vi.fn(),
    });

    expect(view.toolLayout$.value).toEqual({
      orderedToolIds: ["outline", "tags", "activity"],
      visibleToolIds: ["outline", "tags"],
      collapsedToolIds: [],
    });

    view.hideTool("tags");
    view.showTool("tags");
    view.toggleToolCollapsed("tags");
    view.moveTool("tags", 0);

    expect(openToolHost).toHaveBeenCalledTimes(1);
    expect(persist).toHaveBeenCalledTimes(4);
    expect(persist.mock.lastCall?.[0]).toMatchObject({
      orderedToolIds: ["tags", "outline", "activity"],
      visibleToolIds: ["tags", "outline"],
      collapsedToolIds: ["tags"],
    });
  });

  test("updates existing context descriptors without duplicate ids", () => {
    const framework = new Framework();
    framework.entity(View).scope(ViewScope).entity(ContextSurface);
    const view = framework.provider().createEntity(View, {
      id: "view-sidebar-descriptor-update",
    });

    view.addContextSurface({ id: "calendar", label: "Journal", order: 20 });
    view.addContextSurface({
      id: "calendar",
      label: "Journal calendar",
      tooltip: "Journal calendar and activity",
      order: 10,
    });

    expect(view.contextSurfaces$.value).toHaveLength(1);
    expect(view.contextSurfaces$.value[0]?.label).toBe("Journal calendar");
    expect(view.contextSurfaces$.value[0]?.tooltip).toBe(
      "Journal calendar and activity",
    );
    expect(view.contextSurfaces$.value[0]?.order).toBe(10);
  });
});
