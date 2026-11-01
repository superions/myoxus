// SPDX-License-Identifier: AGPL-3.0-or-later
/** @vitest-environment happy-dom */
import { MyoxusUIProvider } from "@myoxus/ui-facade/provider";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import enJson from "../../../../../libs/i18n/src/resources/en.json";

const en: Record<string, string> = enJson;
const setupStatusMock = vi.fn();

vi.mock("@myoxus/i18n", () => ({
  useI18n: () => ({
    t: (key: string, vars?: Record<string, string>) =>
      (en[key] ?? key).replace("{{code}}", vars?.code ?? ""),
  }),
}));

vi.mock("../hooks/use-server-setup-status", () => ({
  useServerSetupStatus: () => ({ data: setupStatusMock() }),
}));

import { OperationalReadinessNotice } from "./operational-readiness-notice";

function renderNotice() {
  return render(
    <MyoxusUIProvider>
      <OperationalReadinessNotice />
    </MyoxusUIProvider>,
  );
}

describe("OperationalReadinessNotice", () => {
  beforeEach(() => {
    setupStatusMock.mockReset();
  });

  afterEach(() => cleanup());

  test("keeps critical and warning findings visible after wizard completion", () => {
    setupStatusMock.mockReturnValue({
      setupCompleted: true,
      operationalReady: false,
      findings: [
        { code: "AUTH_METHOD_UNAVAILABLE", severity: "critical" },
        { code: "SMTP_UNAVAILABLE", severity: "warning" },
      ],
    });

    renderNotice();

    expect(
      screen.getByText("Operational readiness requires attention").textContent,
    ).toBe("Operational readiness requires attention");
    expect(
      screen.getByText(
        "No configured authentication method can currently sign users in.",
      ).textContent,
    ).toBe("No configured authentication method can currently sign users in.");
    expect(screen.getByText("Operational recommendations").textContent).toBe(
      "Operational recommendations",
    );
    expect(
      screen.getByText(
        "Email delivery is unavailable, so magic links and email notifications cannot be sent.",
      ).textContent,
    ).toBe(
      "Email delivery is unavailable, so magic links and email notifications cannot be sent.",
    );
  });

  test("does not duplicate wizard findings before setup is completed", () => {
    setupStatusMock.mockReturnValue({
      setupCompleted: false,
      operationalReady: false,
      findings: [{ code: "CRYPTO_UNSAFE", severity: "critical" }],
    });

    renderNotice();
    expect(screen.queryByTestId("operational-readiness-notices")).toBeNull();
  });
});
