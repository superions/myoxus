// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** @vitest-environment happy-dom */
import { MyoxusUIProvider } from "@myoxus/ui-facade/provider";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import enJson from "../../../../../../../libs/i18n/src/resources/en.json";

const en: Record<string, string> = enJson;
const mutateManyMock = vi.fn();
const sendTestEmailMock = vi.fn();

vi.mock("@myoxus/i18n", () => ({
  useI18n: () => ({ t: (key: string) => en[key] ?? key }),
}));

vi.mock("@myoxus/admin/use-mutation", () => ({
  useMutation: () => ({ trigger: sendTestEmailMock }),
}));

vi.mock("../../../hooks/use-admin-update-config", () => ({
  useAdminUpdateConfig: () => ({
    mutateMany: mutateManyMock,
    isLoading: false,
  }),
}));

import { SmtpStep } from "./smtp";

function renderStep(onNext = vi.fn(), onBusyChange = vi.fn()) {
  return render(
    <MyoxusUIProvider>
      <SmtpStep onNext={onNext} onBusyChange={onBusyChange} />
    </MyoxusUIProvider>,
  );
}

describe("SmtpStep", () => {
  beforeEach(() => {
    mutateManyMock.mockReset();
    mutateManyMock.mockResolvedValue({ applied: true });
    sendTestEmailMock.mockReset();
    sendTestEmailMock.mockResolvedValue({ admin: { sendTestEmail: true } });
  });

  afterEach(() => {
    cleanup();
  });

  test("tests and persists an explicit unauthenticated SMTP relay", async () => {
    renderStep();

    fireEvent.change(screen.getByPlaceholderText("smtp.gmail.com"), {
      target: { value: "mx.example.test" },
    });
    fireEvent.click(
      screen.getByRole("combobox", { name: /Transport security/ }),
    );
    fireEvent.click(
      await screen.findByRole("option", { name: "Implicit TLS" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Send test email" }));

    await waitFor(() => {
      expect(sendTestEmailMock).toHaveBeenCalledWith({
        host: "mx.example.test",
        port: 465,
        sender: "noreply@myoxus.local",
        username: null,
        password: null,
        transport: "implicit_tls",
        verifyCertificate: true,
      });
    });

    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    await waitFor(() => {
      expect(mutateManyMock).toHaveBeenCalledTimes(1);
    });
    expect(mutateManyMock).toHaveBeenCalledWith([
      { module: "mail", key: "smtp_host", value: "mx.example.test" },
      { module: "mail", key: "smtp_port", value: 465 },
      { module: "mail", key: "smtp_user", value: null },
      { module: "mail", key: "smtp_pass", value: null },
      {
        module: "mail",
        key: "sender",
        value: "noreply@myoxus.local",
      },
      {
        module: "mail",
        key: "smtp_transport",
        value: "implicit_tls",
      },
      {
        module: "mail",
        key: "smtp_verify_certificate",
        value: true,
      },
    ]);
  });

  test("rejects a partial credential pair before test or persistence", async () => {
    renderStep();

    fireEvent.change(screen.getByPlaceholderText("smtp.gmail.com"), {
      target: { value: "mx.example.test" },
    });
    fireEvent.change(screen.getByPlaceholderText("user@gmail.com"), {
      target: { value: "relay-user" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Send test email" }));

    expect(
      await screen.findByText(
        "Provide both username and password, or leave both empty.",
      ),
    ).not.toBeNull();
    expect(sendTestEmailMock).not.toHaveBeenCalled();
    expect(mutateManyMock).not.toHaveBeenCalled();
  });
});
