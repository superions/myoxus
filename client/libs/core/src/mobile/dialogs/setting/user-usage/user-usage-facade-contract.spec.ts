// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * @vitest-environment happy-dom
 */

import { MyoxusUIProvider } from "@myoxus/ui-facade/provider";
import { cleanup, render, screen } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, test, vi } from "vitest";

import { UserUsage } from "./index";

const serviceMocks = vi.hoisted(() => ({
  authSession: {
    status$: "authenticated",
    account$: {
      avatar: null,
      email: "admin@myoxus.local",
      label: "Myoxus Admin",
    },
    revalidate: vi.fn(),
  },
  server: {
    server: {
      features$: { copilot: true },
    },
  },
  quota: {
    quota: {
      color$: "var(--myoxus-primary-color)",
      usedFormatted$: "4 GB",
      maxFormatted$: "10 GB",
      percent$: 40,
      error$: null,
      revalidate: vi.fn(),
    },
  },
  copilot: {
    copilotQuota: {
      copilotActionLimit$: 100,
      copilotActionUsed$: 85,
      error$: null,
      revalidate: vi.fn(),
    },
  },
}));

vi.mock("@myoxus/infra", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@myoxus/infra")>();
  return {
    ...actual,
    useLiveData: (value: unknown) => value,
    useService: (token: { name?: string }) => {
      switch (token.name) {
        case "AuthService":
          return { session: serviceMocks.authSession };
        case "ServerService":
          return serviceMocks.server;
        case "UserQuotaService":
          return serviceMocks.quota;
        case "UserCopilotQuotaService":
          return serviceMocks.copilot;
        default:
          throw new Error(`Unexpected service token in user usage test`);
      }
    },
  };
});

afterEach(() => cleanup());

describe("mobile user usage facade contract", () => {
  test("projects mobile usage meters to accessible facade progress DOM", () => {
    render(createElement(MyoxusUIProvider, null, createElement(UserUsage)));

    expect(screen.getByText("Cloud")).toBeTruthy();
    expect(screen.getByText("4 GB/10 GB")).toBeTruthy();
    expect(screen.getByText("AI")).toBeTruthy();
    expect(screen.getByText("85/100")).toBeTruthy();
    expect(screen.getByLabelText("Cloud storage used")).toBeTruthy();
    expect(screen.getByLabelText("AI usage")).toBeTruthy();
    expect(
      document.querySelectorAll(
        '[data-myoxus-ui-role="mobile-user-usage-progress-meter"]',
      ),
    ).toHaveLength(2);
    expect(
      document.querySelectorAll('[data-myoxus-ui-role="progress"]'),
    ).toHaveLength(2);
    expect(serviceMocks.quota.quota.revalidate).toHaveBeenCalledOnce();
    expect(serviceMocks.copilot.copilotQuota.revalidate).toHaveBeenCalledOnce();
  });
});
