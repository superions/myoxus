/**
 * @vitest-environment happy-dom
 */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ReactElement } from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const { jumpToPage, optionalService } = vi.hoisted(() => ({
  jumpToPage: vi.fn(),
  optionalService: {
    value: undefined as
      | undefined
      | {
          workspace?: {
            id: string;
            meta: { id: string; flavour: string };
          };
        },
  },
}));

vi.mock("@myoxus/core/components/hooks/use-navigate-helper", () => ({
  useNavigateHelper: () => ({ jumpToPage }),
}));

vi.mock("@myoxus/core/components/hooks/use-workspace-info", () => ({
  useWorkspaceInfo: () => ({ name: "Mobile Workspace" }),
}));

vi.mock("@myoxus/core/components/workspace-avatar", () => ({
  WorkspaceAvatar: ({ name }: { name?: string }) => (
    <span data-testid="workspace-avatar">{name}</span>
  ),
}));

vi.mock(
  "@myoxus/core/components/workspace-selector/user-with-workspace-list/workspace-list",
  () => ({
    MyoxusWorkspaceList: ({
      onClickWorkspace,
      onEventEnd,
    }: {
      onClickWorkspace?: (workspace: { id: string; flavour: string }) => void;
      onEventEnd?: () => void;
    }) => (
      <div data-testid="shared-workspace-list">
        <button
          type="button"
          onClick={() => {
            onClickWorkspace?.({
              id: "workspace-next",
              flavour: "myoxus-cloud",
            });
            onEventEnd?.();
          }}
        >
          Open next workspace
        </button>
        <button
          type="button"
          onClick={() => {
            onClickWorkspace?.({
              id: "workspace-current",
              flavour: "myoxus-cloud",
            });
            onEventEnd?.();
          }}
        >
          Open current workspace
        </button>
      </div>
    ),
  }),
);

vi.mock("@myoxus/core/modules/workspace", () => ({
  WorkspaceService: class WorkspaceService {},
}));

vi.mock("@myoxus/infra", () => ({
  useServiceOptional: () => optionalService.value,
}));

import { MyoxusUIProvider } from "@myoxus/ui-facade/provider";

import { CurrentWorkspaceCard } from "./current-card";
import { SelectorMenu } from "./menu";

function renderWithProvider(ui: ReactElement) {
  return render(<MyoxusUIProvider>{ui}</MyoxusUIProvider>);
}

describe("mobile workspace selector facade migration", () => {
  beforeEach(() => {
    jumpToPage.mockReset();
    optionalService.value = {
      workspace: {
        id: "workspace-current",
        meta: { id: "workspace-current", flavour: "myoxus-cloud" },
      },
    };
  });

  afterEach(() => {
    cleanup();
  });

  test("renders the trigger through sidebar facade roles", () => {
    const { container } = renderWithProvider(<CurrentWorkspaceCard />);

    expect(
      container.querySelector(
        '[data-myoxus-ui-role="mobile-workspace-trigger"]',
      ),
    ).toBeTruthy();
    expect(
      container.querySelector(
        '[data-myoxus-ui-role="mobile-workspace-trigger-title"]',
      )?.textContent,
    ).toBe("Mobile Workspace");
    expect(
      container.querySelector(
        '[data-myoxus-ui-role="mobile-workspace-trigger-disclosure"]',
      ),
    ).toBeTruthy();
  });

  test("renders the menu through facade menu roles and shared workspace list", () => {
    const onClose = vi.fn();
    const { container } = renderWithProvider(
      <SelectorMenu onClose={onClose} />,
    );

    expect(
      container.querySelector(
        '[data-myoxus-ui-role="mobile-workspace-selector-menu"]',
      ),
    ).toBeTruthy();
    expect(
      container.querySelector(
        '[data-myoxus-ui-role="mobile-workspace-selector-scroll"]',
      ),
    ).toBeTruthy();
    expect(screen.getByTestId("shared-workspace-list")).toBeTruthy();

    fireEvent.click(screen.getByText("Open next workspace"));
    expect(jumpToPage).toHaveBeenCalledWith("workspace-next", "home");
    expect(onClose).toHaveBeenCalledTimes(1);

    jumpToPage.mockReset();
    onClose.mockReset();
    fireEvent.click(screen.getByText("Open current workspace"));
    expect(jumpToPage).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
