// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * @vitest-environment happy-dom
 */

import type { Member } from "@myoxus/core/modules/permissions";
import { I18n } from "@myoxus/i18n";
import { MyoxusUIProvider } from "@myoxus/ui-facade/provider";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const infraMocks = vi.hoisted(() => ({
  useLiveData: vi.fn(),
  useService: vi.fn(),
}));

vi.mock("@myoxus/infra", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@myoxus/infra")>();
  return {
    ...actual,
    useLiveData: infraMocks.useLiveData,
    useService: infraMocks.useService,
  };
});

vi.mock("../mobile", () => ({
  ConfigModal: ({ children, open }: { children: ReactNode; open: boolean }) =>
    open ? <div data-testid="config-modal">{children}</div> : null,
}));

import { MemberSelector } from "./index";

const members = [
  {
    avatarUrl: "",
    email: "alice@myoxus.local",
    id: "alice-id",
    name: "Alice",
  },
  {
    avatarUrl: "",
    email: "bob@myoxus.local",
    id: "bob-id",
    name: "Bob",
  },
] as Member[];

const memberSearchService = {
  loadMore: vi.fn(),
  reset: vi.fn(),
  result$: Symbol("member-search-results"),
  search: vi.fn(),
};

function renderWithProvider(ui: ReactNode) {
  return render(<MyoxusUIProvider>{ui}</MyoxusUIProvider>);
}

describe("MemberSelector facade migration", () => {
  beforeEach(() => {
    vi.stubGlobal("BUILD_CONFIG", { isMobileEdition: false });
    infraMocks.useService.mockReturnValue(memberSearchService);
    infraMocks.useLiveData.mockImplementation((source) =>
      source === memberSearchService.result$ ? members : null,
    );
    memberSearchService.loadMore.mockClear();
    memberSearchService.reset.mockClear();
    memberSearchService.search.mockClear();
    if (!Element.prototype.scrollIntoView) {
      Element.prototype.scrollIntoView = vi.fn();
    }
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    infraMocks.useLiveData.mockReset();
    infraMocks.useService.mockReset();
  });

  test("renders selector chrome through facade menu badge and avatar primitives", () => {
    const onChange = vi.fn();

    renderWithProvider(<MemberSelector selected={[]} onChange={onChange} />);

    const panel = screen.getByTestId("tags-editor-popup");
    expect(panel.dataset.myoxusUiRole).toBe("member-selector-panel");
    expect(memberSearchService.reset).toHaveBeenCalledTimes(1);
    expect(memberSearchService.loadMore).toHaveBeenCalledTimes(1);
    expect(
      panel.querySelector("[data-myoxus-ui-role='member-selector-input-slot']"),
    ).toBeTruthy();

    const alice = screen.getByRole("menuitem", { name: /alice/i });
    expect(alice.dataset.myoxusUiRole).toBe("menu-item");
    expect(
      alice.querySelector("[data-myoxus-ui-role='avatar:user']"),
    ).toBeTruthy();

    fireEvent.click(alice);
    expect(onChange).toHaveBeenCalledWith(["alice-id"]);
  });

  test("keeps keyboard search selection functional without CSS class queries", () => {
    const onChange = vi.fn();

    renderWithProvider(<MemberSelector selected={[]} onChange={onChange} />);

    const input = screen.getByPlaceholderText(
      I18n[
        "com.myoxus.settings.workspace.organization.members.user-search-placeholder"
      ](),
    );
    fireEvent.keyDown(input, { key: "ArrowDown" });

    const alice = screen.getByRole("menuitem", { name: /alice/i });
    expect(alice.dataset.active).toBe("true");

    fireEvent.keyDown(input, { key: "Enter" });
    expect(onChange).toHaveBeenCalledWith(["alice-id"]);
  });
});
