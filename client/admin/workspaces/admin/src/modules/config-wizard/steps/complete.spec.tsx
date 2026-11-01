// SPDX-License-Identifier: AGPL-3.0-or-later
/** @vitest-environment happy-dom */
import { MyoxusUIProvider } from "@myoxus/ui-facade/provider";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import enJson from "../../../../../../../libs/i18n/src/resources/en.json";

const en: Record<string, string> = enJson;
const updateConfigMock = vi.fn();
const refetchSetupStatusMock = vi.fn();

vi.mock("@myoxus/i18n", () => ({
  useI18n: () => ({ t: (key: string) => en[key] ?? key }),
}));

vi.mock("../../../hooks/use-admin-update-config", () => ({
  useAdminUpdateConfig: () => ({ mutate: updateConfigMock }),
}));

vi.mock("../../../hooks/use-server-setup-status", () => ({
  useServerSetupStatus: () => ({ refetch: refetchSetupStatusMock }),
}));

import { CompleteStep } from "./complete";

function renderStep() {
  return render(
    <MyoxusUIProvider>
      <MemoryRouter>
        <CompleteStep />
      </MemoryRouter>
    </MyoxusUIProvider>,
  );
}

describe("CompleteStep", () => {
  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    updateConfigMock.mockReset();
    refetchSetupStatusMock.mockReset();
    updateConfigMock.mockResolvedValue({ applied: true });
    refetchSetupStatusMock.mockResolvedValue({ setupCompleted: true });
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  test("shows completion only after the server confirms persisted state", async () => {
    renderStep();

    expect(
      (await screen.findByRole("button", { name: "Go to dashboard" }))
        .textContent,
    ).toBe("Go to dashboard");
    expect(updateConfigMock).toHaveBeenCalledWith({
      module: "system",
      key: "setupCompleted",
      value: true,
    });
    expect(refetchSetupStatusMock).toHaveBeenCalledTimes(1);
  });

  test("does not fake completion when persistence fails", async () => {
    updateConfigMock.mockRejectedValue(new Error("storage unavailable"));
    renderStep();

    expect(
      await screen.findByText(
        "Setup completion could not be saved. Review the server response and try again.",
      ),
    ).not.toBeNull();
    expect(screen.getByRole("button", { name: "Retry" }).textContent).toBe(
      "Retry",
    );
    expect(console.error).toHaveBeenCalledWith(
      "config_wizard.setup_completion_failed",
      expect.any(Error),
    );
    expect(
      screen.queryByRole("button", { name: "Go to dashboard" }),
    ).toBeNull();
    expect(refetchSetupStatusMock).not.toHaveBeenCalled();
  });

  test("rejects a successful mutation without fresh completion confirmation", async () => {
    refetchSetupStatusMock.mockResolvedValue({ setupCompleted: false });
    renderStep();

    expect(
      await screen.findByText(
        "The server did not confirm setup completion. Try again before leaving this page.",
      ),
    ).not.toBeNull();
    expect(
      screen.queryByRole("button", { name: "Go to dashboard" }),
    ).toBeNull();
  });

  test("retries verification without writing completion a second time", async () => {
    refetchSetupStatusMock
      .mockResolvedValueOnce({ setupCompleted: false })
      .mockResolvedValueOnce({ setupCompleted: true });
    renderStep();

    const retry = await screen.findByRole("button", { name: "Retry" });
    fireEvent.click(retry);

    expect(
      (await screen.findByRole("button", { name: "Go to dashboard" }))
        .textContent,
    ).toBe("Go to dashboard");
    expect(updateConfigMock).toHaveBeenCalledTimes(1);
    expect(refetchSetupStatusMock).toHaveBeenCalledTimes(2);
  });
});
