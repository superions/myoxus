// SPDX-License-Identifier: AGPL-3.0-or-later
/** @vitest-environment happy-dom */

import { render, screen } from "@testing-library/react";
import { createElement, isValidElement } from "react";
import { matchRoutes, MemoryRouter, type RouteObject } from "react-router";
import { describe, expect, test, vi } from "vitest";

const createBrowserRouter = vi.hoisted(() => vi.fn(() => ({})));

vi.mock("react-router", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-router")>();
  return { ...actual, createBrowserRouter };
});

vi.mock("@sentry/react", () => ({
  wrapCreateBrowserRouterV7: () => createBrowserRouter,
}));

vi.mock("./pages/root", () => ({
  RootWrapper: () =>
    createElement("main", { "data-testid": "desktop-root" }, "Desktop root"),
}));

import { topLevelRoutes as mobileTopLevelRoutes } from "../mobile/router";
import { workbenchRootRoutes } from "../modules/workbench/view/workbench-root";
import { RootRouter, topLevelRoutes } from "./router";

describe("router hydration fallback contract", () => {
  test("retired import URLs use ordinary unknown-route recovery", () => {
    const matches = matchRoutes<RouteObject>(topLevelRoutes, "/clipper/import");
    expect(matches?.at(-1)?.route.path).toBe("*");
    expect(matches?.at(-1)?.route).toBe(
      matchRoutes(topLevelRoutes, "/unknown-retired-route")?.at(-1)?.route,
    );
  });

  test("desktop renders its root content on the first render", () => {
    render(createElement(MemoryRouter, null, createElement(RootRouter)));

    expect(screen.getByTestId("desktop-root")).toBeTruthy();
  });

  test("desktop, workbench, and mobile route objects own nonempty fallbacks", () => {
    for (const route of [
      topLevelRoutes[0],
      workbenchRootRoutes[0],
      mobileTopLevelRoutes[0],
    ]) {
      expect(route.hydrateFallbackElement).not.toBeNull();
      expect(isValidElement(route.hydrateFallbackElement)).toBe(true);
    }

    expect(workbenchRootRoutes[0].errorElement).not.toBeNull();
    expect(isValidElement(workbenchRootRoutes[0].errorElement)).toBe(true);
  });
});
