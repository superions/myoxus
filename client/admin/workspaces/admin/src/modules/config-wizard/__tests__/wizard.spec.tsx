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

const tMock = vi.fn((key: string, fallback?: string): string => {
  return en[key] ?? fallback ?? key;
});

vi.mock("@myoxus/i18n", () => ({
  useI18n: () => ({
    t: tMock,
    exists: (key: string) => key in en,
    language: "en",
    changeLanguage: () => Promise.resolve(),
  }),
}));

vi.mock("../steps/external-url", () => ({
  ExternalUrlStep: ({ onNext }: { onNext: () => void }) => (
    <div data-testid="step-external-url">
      <p>External URL Step</p>
      <input aria-label="External URL draft" defaultValue="" />
      <button onClick={onNext} data-testid="external-url-next">
        Save external URL
      </button>
    </div>
  ),
}));

vi.mock("../steps/crypto-key", () => ({
  CryptoKeyStep: ({ onNext }: { onNext: () => void }) => (
    <div data-testid="step-crypto-key">
      <p>Crypto Key Step</p>
      <button onClick={onNext} data-testid="crypto-key-next">
        Save crypto key
      </button>
    </div>
  ),
}));

vi.mock("../steps/smtp", () => ({
  SmtpStep: ({
    onNext,
    onBusyChange,
  }: {
    onNext: () => void;
    onBusyChange: (busy: boolean) => void;
  }) => (
    <div data-testid="step-smtp">
      <p>SMTP Step</p>
      <button onClick={() => onBusyChange(true)}>Start SMTP request</button>
      <button onClick={onNext} data-testid="smtp-next">
        Save SMTP
      </button>
    </div>
  ),
}));

vi.mock("../steps/auth-method", () => ({
  AuthMethodStep: ({ onNext }: { onNext: () => void }) => (
    <div data-testid="step-auth-method">
      <p>Auth Method Step</p>
      <button onClick={onNext} data-testid="auth-method-next">
        Save auth method
      </button>
    </div>
  ),
}));

vi.mock("../steps/complete", () => ({
  CompleteStep: () => (
    <div data-testid="step-complete">
      <p>Complete Step</p>
    </div>
  ),
}));

import { Wizard } from "../wizard";

function renderWizard() {
  return render(
    <MyoxusUIProvider>
      <Wizard />
    </MyoxusUIProvider>,
  );
}

describe("SetupWizard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    cleanup();
  });

  test("advances only when the active step reports completion", async () => {
    renderWizard();

    fireEvent.click(screen.getByTestId("external-url-next"));
    await waitFor(() => {
      expect(screen.getByTestId("step-crypto-key").style.display).not.toBe(
        "none",
      );
    });
    expect(screen.getByTestId("step-external-url").style.display).toBe("none");

    fireEvent.click(screen.getByTestId("crypto-key-next"));
    await waitFor(() => {
      expect(screen.getByTestId("step-smtp").style.display).not.toBe("none");
    });

    fireEvent.click(screen.getByRole("button", { name: "Start SMTP request" }));
    expect(
      screen.getByRole("button", { name: "Back" }).hasAttribute("disabled"),
    ).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    expect(screen.getByTestId("step-smtp").style.display).not.toBe("none");
    fireEvent.click(screen.getByTestId("smtp-next"));
    await waitFor(() => {
      expect(screen.getByTestId("step-auth-method").style.display).not.toBe(
        "none",
      );
    });

    expect(
      screen.getByRole("button", { name: "Back" }).hasAttribute("disabled"),
    ).toBe(false);
    fireEvent.click(screen.getByTestId("auth-method-next"));
    await waitFor(() => {
      expect(screen.getByTestId("step-complete").style.display).not.toBe(
        "none",
      );
    });
    expect(
      screen.getByRole("button", { name: "Back" }).hasAttribute("disabled"),
    ).toBe(true);
  });

  test("disables back at the first step and supports stateful back navigation", async () => {
    renderWizard();

    const backButton = screen.getByRole("button", { name: "Back" });
    expect(backButton.hasAttribute("disabled")).toBe(true);

    fireEvent.change(screen.getByLabelText("External URL draft"), {
      target: { value: "https://myoxus.example.test" },
    });
    fireEvent.click(screen.getByTestId("external-url-next"));
    await waitFor(() => {
      expect(screen.getByTestId("step-crypto-key").style.display).not.toBe(
        "none",
      );
    });

    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    await waitFor(() => {
      expect(screen.getByTestId("step-external-url").style.display).not.toBe(
        "none",
      );
    });
    expect(
      (screen.getByLabelText("External URL draft") as HTMLInputElement).value,
    ).toBe("https://myoxus.example.test");
  });
});
