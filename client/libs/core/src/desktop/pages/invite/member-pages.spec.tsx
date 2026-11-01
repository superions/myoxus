// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * @vitest-environment happy-dom
 */

import { WorkspaceMemberStatus } from "@myoxus/graphql";
import { MyoxusUIProvider } from "@myoxus/ui-facade/provider";
import { cleanup, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { RequestToJoinPage } from "./member-pages";

const messages: Record<string, () => string> = {
  "404.signOut": () => "Sign out",
  "admin.common.unknown": () => "Unknown",
  "com.myoxus.auth.open.myoxus.download-app": () => "Download app",
  "com.myoxus.notification.invitation.accept": () => "Accept invitation",
  "com.myoxus.request-to-join-workspace.button": () => "Request to join",
  "invited you to join": () => "invited you to join",
};

vi.mock("@myoxus/i18n", () => ({
  Trans: ({ children }: { children?: ReactNode }) => children,
  useI18n: () =>
    new Proxy(messages, {
      get: (target, property) => {
        if (typeof property !== "string") return undefined;
        return target[property] ?? (() => property);
      },
    }),
}));

describe("invite member pages", () => {
  beforeEach(() => {
    vi.stubGlobal("BUILD_CONFIG", {
      downloadUrl: "https://example.invalid/download",
      isElectron: false,
    });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
      }),
    );
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  test("renders request-to-join chrome through facade roles", () => {
    const { container } = render(
      <MyoxusUIProvider>
        <RequestToJoinPage
          inviteInfo={
            {
              status: WorkspaceMemberStatus.Pending,
              user: { avatarUrl: "", name: "Ada Lovelace" },
              workspace: {
                avatar: null,
                name: "Research Workspace",
              },
            } as any
          }
          requestToJoin={vi.fn()}
          onSignOut={vi.fn()}
          user={{
            avatar: null,
            email: "ada@example.test",
            id: "user-1",
            image: null,
            label: "Ada Lovelace",
          }}
        />
      </MyoxusUIProvider>,
    );

    expect(
      container.querySelector('[data-myoxus-ui-role="invite-summary"]'),
    ).toBeTruthy();
    expect(screen.getByText("Ada Lovelace")).toBeTruthy();
    expect(screen.getByText("Research Workspace")).toBeTruthy();
    expect(screen.getByText("ada@example.test")).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Accept invitation" }),
    ).toBeTruthy();
    expect(screen.getByLabelText("Sign out")).toBeTruthy();
    expect(container.querySelector("[class*='myoxus-member-page']")).toBeNull();
  });
});
