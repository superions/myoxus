// SPDX-License-Identifier: AGPL-3.0-or-later
/** @vitest-environment happy-dom */

import { MyoxusUIProvider } from "@myoxus/ui-facade/provider";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  withView: true,
  closeDialog: vi.fn(),
  jumpToIndex: vi.fn(),
  openDialog: vi.fn(() => "dialog-id"),
}));

vi.mock("./components/app-container", () => ({
  AppContainer: ({ children }: { children: ReactNode }) => (
    <section data-testid="desktop-app-container">{children}</section>
  ),
}));

vi.mock("@myoxus/i18n", () => ({
  ...(() => {
    const translations = new Proxy(
      { language: "en" },
      {
        get(target, property) {
          if (property in target) return target[property as "language"];
          const copy: Record<string, string> = {
            "Go Back": "Go Back",
            Retry: "Retry",
            "com.myoxus.import-template.route.invalid.description":
              "Open a complete template link.",
            "com.myoxus.import-template.route.invalid.title":
              "Template link is incomplete",
            "com.myoxus.import-template.route.preparing.description":
              "Review the import task in the dialog.",
            "com.myoxus.import-template.route.preparing.title":
              "Preparing template import",
            "com.myoxus.no-permission": "Access denied",
            "com.myoxus.notFoundPage.backButton": "Back home",
            "com.myoxus.notFoundPage.title": "Page not found",
            "com.myoxus.open-app.invalid.description":
              "Open a valid Myoxus app link.",
            "com.myoxus.open-app.invalid.title": "App link is invalid",
            "com.myoxus.workbench.route.access-denied.description":
              "This account cannot open the item.",
            "com.myoxus.workbench.route.not-found.description":
              "This item is no longer available.",
            "com.myoxus.workspace.chat.unavailable.description":
              "This workspace does not allow Intelligence.",
            "com.myoxus.workspace.chat.unavailable.title":
              "Intelligence is unavailable",
          };
          return () => copy[String(property)] ?? String(property);
        },
      },
    );
    return {
      I18n: translations,
      useI18n: () => translations,
    };
  })(),
}));

vi.mock("@myoxus/core/components/hooks/use-navigate-helper", () => ({
  RouteLogic: { PUSH: "push", REPLACE: "replace" },
  useNavigateHelper: () => ({ jumpToIndex: mocks.jumpToIndex }),
}));

vi.mock("@myoxus/core/modules/workbench/view/view-islands", () => ({
  ViewBody: ({ children }: { children: ReactNode }) => (
    <section data-testid="view-body">{children}</section>
  ),
  ViewHeader: ({ children }: { children: ReactNode }) => (
    <header data-testid="view-header">{children}</header>
  ),
}));

vi.mock("@myoxus/core/modules/workbench/view/view-meta", () => ({
  ViewIcon: () => null,
  ViewTitle: () => null,
}));

vi.mock("@myoxus/core/modules/workbench", async () => ({
  ...(await import("@myoxus/core/modules/workbench/view/view-islands")),
  ...(await import("@myoxus/core/modules/workbench/view/view-meta")),
  ViewService: Symbol("ViewService"),
  WorkbenchService: Symbol("WorkbenchService"),
}));

vi.mock("@myoxus/infra", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@myoxus/infra")>();
  return {
    ...actual,
    useService: () => ({
      close: mocks.closeDialog,
      open: mocks.openDialog,
    }),
    useServiceOptional: () => (mocks.withView ? { view: {} } : undefined),
  };
});

import {
  Component as WorkbenchWildcardRoute,
  WorkbenchRouteAccessDenied,
  WorkbenchRouteNotFound,
} from "./pages/404";
import {
  Component as TemplateImportRoute,
  parseTemplateImportRequest,
} from "./pages/import-template";
import { Component as OpenAppRoute, parseOpenAppUrl } from "./pages/open-app";
import { WorkspaceChatAvailabilityGate } from "./pages/workspace/chat";
import { workbenchRoutes } from "./workbench-router";

const renderWithProviders = (ui: ReactNode, route = "/") =>
  render(
    <MyoxusUIProvider>
      <MemoryRouter initialEntries={[route]}>{ui}</MemoryRouter>
    </MyoxusUIProvider>,
  );

describe("workbench route recovery", () => {
  beforeEach(() => {
    mocks.withView = true;
    // The Facade provider requests the server-owned theme projection on mount.
    // Keep this route contract isolated from a live API without hiding product
    // requests made by the route components themselves.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("", { status: 200 })),
    );
  });

  test("top-level recovery uses the Electron shell and keeps its return action", async () => {
    mocks.withView = false;
    vi.stubGlobal("BUILD_CONFIG", { ...BUILD_CONFIG, isElectron: true });
    renderWithProviders(<WorkbenchRouteNotFound />);
    expect(
      (await screen.findByTestId("desktop-app-container")).contains(
        screen.getByTestId("workbench-route-not-found"),
      ),
    ).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Back home" }));
    expect(mocks.jumpToIndex).toHaveBeenCalledWith("replace");
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    mocks.closeDialog.mockClear();
    mocks.jumpToIndex.mockClear();
    mocks.openDialog.mockClear();
  });

  test("not-found and denied states use View islands and a safe return", () => {
    const view = renderWithProviders(<WorkbenchRouteNotFound />);

    expect(screen.getByTestId("view-header").textContent).toContain(
      "Page not found",
    );
    expect(screen.getByTestId("workbench-route-not-found")).toBeTruthy();
    expect(document.body.textContent).not.toContain("Download app");
    fireEvent.click(screen.getByRole("button", { name: "Back home" }));
    expect(mocks.jumpToIndex).toHaveBeenCalledWith("replace");

    view.rerender(
      <MyoxusUIProvider>
        <MemoryRouter>
          <WorkbenchRouteAccessDenied />
        </MemoryRouter>
      </MyoxusUIProvider>,
    );
    expect(screen.getByTestId("workbench-route-access-denied")).toBeTruthy();
    expect(screen.getByTestId("view-header").textContent).toContain(
      "Access denied",
    );
  });

  test("the terminal wildcard renders the Workbench recovery surface", () => {
    renderWithProviders(<WorkbenchWildcardRoute />);

    expect(screen.getByTestId("workbench-route-not-found")).toBeTruthy();
    expect(screen.getByTestId("view-header").textContent).toContain(
      "Page not found",
    );
    expect(document.body.textContent).not.toContain("Download app");
  });

  test("unavailable chat does not mount its content child", () => {
    const content = <div data-testid="chat-content">Chat content</div>;
    const view = renderWithProviders(
      <WorkspaceChatAvailabilityGate available={false}>
        {content}
      </WorkspaceChatAvailabilityGate>,
    );

    expect(screen.getByTestId("workbench-route-access-denied")).toBeTruthy();
    expect(screen.queryByTestId("chat-content")).toBeNull();

    view.rerender(
      <MyoxusUIProvider>
        <MemoryRouter>
          <WorkspaceChatAvailabilityGate available>
            {content}
          </WorkspaceChatAvailabilityGate>
        </MemoryRouter>
      </MyoxusUIProvider>,
    );
    expect(screen.getByTestId("chat-content")).toBeTruthy();
    expect(screen.queryByTestId("workbench-route-access-denied")).toBeNull();
  });

  test("template parsing requires a named HTTP snapshot", () => {
    expect(
      parseTemplateImportRequest(
        new URLSearchParams({
          name: "Project",
          mode: "edgeless",
          snapshotUrl: "https://example.test/project.snapshot",
        }),
      ),
    ).toEqual({
      templateName: "Project",
      templateMode: "edgeless",
      snapshotUrl: "https://example.test/project.snapshot",
    });
    expect(parseTemplateImportRequest(new URLSearchParams())).toBeNull();
    expect(
      parseTemplateImportRequest(
        new URLSearchParams({
          name: "Project",
          mode: "page",
          snapshotUrl: "file:///tmp/project.snapshot",
        }),
      ),
    ).toBeNull();
  });

  test("invalid template route stays recoverable and never opens the dialog", () => {
    renderWithProviders(<TemplateImportRoute />, "/template/import");

    expect(screen.getByTestId("template-import-invalid")).toBeTruthy();
    expect(mocks.openDialog).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Go Back" }));
    expect(mocks.jumpToIndex).toHaveBeenCalledWith("replace");
  });

  test("valid template route opens exactly one productive task dialog", () => {
    renderWithProviders(
      <TemplateImportRoute />,
      "/template/import?name=Project&mode=page&snapshotUrl=https%3A%2F%2Fexample.test%2Fproject.snapshot",
    );

    expect(mocks.openDialog).toHaveBeenCalledTimes(1);
    expect(mocks.openDialog).toHaveBeenCalledWith("import-template", {
      templateName: "Project",
      templateMode: "page",
      snapshotUrl: "https://example.test/project.snapshot",
    });
    expect(screen.getByTestId("template-import-preparing")).toBeTruthy();
  });

  test("open-app parser and invalid action terminate without console errors", () => {
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});
    expect(parseOpenAppUrl("myoxus://workspace/example")).toBe(
      "myoxus://workspace/example",
    );
    expect(parseOpenAppUrl("https://example.test")).toBeNull();

    renderWithProviders(<OpenAppRoute />, "/open-app/unknown");
    expect(screen.getByTestId("open-app-invalid")).toBeTruthy();
    expect(consoleError).not.toHaveBeenCalled();
    consoleError.mockRestore();
  });

  test("route manifest keeps specific recovery routes and a terminal wildcard", () => {
    expect(workbenchRoutes.map((route) => route.path)).toEqual(
      expect.arrayContaining([
        "/",
        "/chat",
        "/home",
        "/tag/:tagId",
        "/:pageId",
        "/:pageId/attachments/:attachmentId",
        "*",
      ]),
    );
    expect(
      workbenchRoutes.findIndex((route) => route.path === "/"),
    ).toBeLessThan(
      workbenchRoutes.findIndex((route) => route.path === "/:pageId"),
    );
    expect(workbenchRoutes.at(-1)?.path).toBe("*");
  });
});
