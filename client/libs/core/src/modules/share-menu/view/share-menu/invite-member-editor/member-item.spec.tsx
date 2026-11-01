// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * @vitest-environment happy-dom
 */

import type { Member } from "@myoxus/core/modules/permissions";
import { MyoxusUIProvider } from "@myoxus/ui-facade/provider";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, test, vi } from "vitest";

import { MemberItem } from "./member-item";
import { SelectedMemberItem } from "./selected-member-item";

const member = {
  avatarUrl: "",
  email: "alice@myoxus.local",
  id: "alice-id",
  name: "Alice",
} as Member;

function renderWithProvider(ui: ReactNode) {
  return render(<MyoxusUIProvider>{ui}</MyoxusUIProvider>);
}

describe("share menu invite member facade rows", () => {
  afterEach(() => {
    cleanup();
  });

  test("renders invite search results with existing facade row primitives", () => {
    const onSelect = vi.fn();

    renderWithProvider(<MemberItem member={member} onSelect={onSelect} />);

    const row = screen.getByRole("button", { name: /alice/i });
    expect(row.dataset.myoxusUiRole).toBe("share-menu-member-search-result");
    expect(screen.getByText("alice@myoxus.local")).toBeTruthy();

    fireEvent.click(row);
    expect(onSelect).toHaveBeenCalledWith(member);
  });

  test("renders selected invite members as facade removable badges", () => {
    const onRemoved = vi.fn();

    renderWithProvider(
      <SelectedMemberItem member={member} idx={0} onRemoved={onRemoved} />,
    );

    expect(screen.getByText("Alice")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /remove alice/i }));
    expect(onRemoved).toHaveBeenCalledTimes(1);
  });
});
