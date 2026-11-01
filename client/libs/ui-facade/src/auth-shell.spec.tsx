// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * @vitest-environment happy-dom
 */

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ReactElement } from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import {
  AuthActionStack,
  AuthCaptchaFallback,
  AuthCaptchaFallbackButton,
  AuthCaptchaFallbackStatus,
  AuthContainer,
  AuthDivider,
  AuthFooter,
  AuthHeader,
  AuthHiddenInput,
  AuthInlineActionButton,
  AuthInput,
  AuthNotice,
  AuthPanelFrame,
  AuthStatusText,
  clearBrandIdentityCache,
  ErrorMessage,
  OnboardingFieldErrorSlot,
  SignInPageContainer,
} from "./index";
import { MyoxusUIProvider } from "./provider";

function renderWithProvider(ui: ReactElement) {
  return render(<MyoxusUIProvider>{ui}</MyoxusUIProvider>);
}

describe("facade auth form primitives", () => {
  beforeEach(() => {
    clearBrandIdentityCache();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("{}", { status: 404 })),
    );
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    clearBrandIdentityCache();
  });

  test("links auth input label and validation hint accessibly", () => {
    renderWithProvider(
      <AuthInput
        label="Email"
        value=""
        error
        errorHint="Email is required"
        onChange={() => {}}
      />,
    );

    const input = screen.getByLabelText("Email");
    const error = screen.getByText("Email is required");
    const label = screen.getByText("Email").closest("label");

    expect(input.getAttribute("aria-invalid")).toBe("true");
    expect(input.getAttribute("aria-describedby")).toBe(error.id);
    expect(label?.dataset.myoxusUiRole).toBe("form-label");
  });

  test("keeps the legacy auth enter contract while rendering through facade input", () => {
    const onEnter = vi.fn();
    renderWithProvider(
      <AuthInput label="Code" value="123456" onEnter={onEnter} />,
    );

    fireEvent.keyDown(screen.getByLabelText("Code"), { key: "Enter" });

    expect(onEnter).toHaveBeenCalledTimes(1);
  });

  test("renders password fields through the Mantine-backed auth password primitive", () => {
    renderWithProvider(
      <AuthInput
        label="Password"
        type="password"
        value=""
        onChange={() => {}}
      />,
    );

    const input = screen.getByLabelText("Password");

    expect(input.getAttribute("type")).toBe("password");
    expect(input.id).not.toBe("");
  });

  test("owns hidden auth trap, status text and action stack roles in the facade", () => {
    const onChange = vi.fn();
    const { container } = renderWithProvider(
      <>
        <AuthHiddenInput value="" onChange={onChange} />
        <AuthStatusText state="error">Invalid</AuthStatusText>
        <AuthActionStack>
          <span>Action</span>
        </AuthActionStack>
      </>,
    );

    expect(
      container.querySelector('[data-myoxus-ui-role="auth-hidden-input"]'),
    ).not.toBeNull();
    expect(screen.getByText("Invalid").dataset.state).toBe("error");
    expect(screen.getByText("Action").parentElement?.dataset.myoxusUiRole).toBe(
      "auth-action-stack",
    );
  });

  test("owns auth notice, divider, captcha fallback and inline action chrome in the facade", () => {
    renderWithProvider(
      <>
        <AuthNotice data-testid="auth-notice">Admin context</AuthNotice>
        <AuthDivider label="or" />
        <AuthCaptchaFallback>
          <AuthCaptchaFallbackButton solving>
            Verify that you are human
          </AuthCaptchaFallbackButton>
          <AuthCaptchaFallbackStatus progress={45}>
            Solving 45%
          </AuthCaptchaFallbackStatus>
          <AuthInlineActionButton>Try again</AuthInlineActionButton>
        </AuthCaptchaFallback>
      </>,
    );

    expect(screen.getByTestId("auth-notice").dataset.myoxusUiRole).toBe(
      "auth-notice",
    );
    expect(screen.getByText("or").parentElement?.dataset.myoxusUiRole).toBe(
      "auth-divider",
    );
    expect(
      screen.getByText("Verify that you are human").closest("button")?.dataset
        .myoxusUiRole,
    ).toBe("auth-captcha-fallback-button");
    const fallbackStatus = screen
      .getByText("Solving 45%")
      .closest('[data-myoxus-ui-role="auth-status-text"]') as HTMLElement;
    expect(fallbackStatus.dataset.state).toBe("neutral");
    expect(
      screen.getByText("Try again").closest("button")?.dataset.myoxusUiRole,
    ).toBe("auth-inline-action");
  });

  test("hides onboarding field errors until validation marks the slot visible", () => {
    const { rerender } = renderWithProvider(
      <OnboardingFieldErrorSlot visible={false}>
        <span>Email</span>
        <ErrorMessage>Email is invalid</ErrorMessage>
      </OnboardingFieldErrorSlot>,
    );

    expect(screen.getByText("Email is invalid").style.visibility).toBe(
      "hidden",
    );

    rerender(
      <MyoxusUIProvider>
        <OnboardingFieldErrorSlot visible>
          <span>Email</span>
          <ErrorMessage>Email is invalid</ErrorMessage>
        </OnboardingFieldErrorSlot>
      </MyoxusUIProvider>,
    );
    expect(screen.getByText("Email is invalid").style.visibility).not.toBe(
      "hidden",
    );
  });

  test("renders footer content through the shared auth footer role", () => {
    renderWithProvider(
      <AuthFooter>
        <span>Footer action</span>
      </AuthFooter>,
    );

    expect(
      screen.getByText("Footer action").closest("footer")?.dataset.myoxusUiRole,
    ).toBe("auth-footer");
    expect(screen.getByText("Footer action")).not.toBeNull();
  });

  test("renders the centered login frame with the wordmark and product-mark fallback", async () => {
    const { container } = renderWithProvider(
      <SignInPageContainer>
        <AuthPanelFrame>
          <AuthContainer>
            <AuthHeader title="Sign in" subTitle="Local server" />
            <AuthInput label="Email" value="" onChange={() => {}} />
          </AuthContainer>
        </AuthPanelFrame>
      </SignInPageContainer>,
    );

    const page = container.querySelector(
      '[data-myoxus-ui-role="sign-in-page-container"]',
    );
    const panel = container.querySelector(
      '[data-myoxus-ui-role="auth-panel-frame"]',
    );
    const logo = screen.getByRole("img", { name: "Myoxus Logo" });
    const formPaper = container.querySelector(
      '[data-myoxus-ui-role="auth-form-paper"]',
    );
    const formBody = container.querySelector(
      '[data-myoxus-ui-role="auth-form-body"]',
    );

    expect(page).not.toBeNull();
    expect(page?.getAttribute("data-myoxus-ui-role")).toBe(
      "sign-in-page-container",
    );
    expect(panel?.getAttribute("data-myoxus-ui-role")).toBe("auth-panel-frame");
    expect(formPaper).not.toBeNull();
    expect(formBody).not.toBeNull();
    expect(formPaper?.contains(formBody)).toBe(true);
    expect(logo.getAttribute("src")).toBe("/style/logo.svg");
    fireEvent.error(logo);
    expect(
      (
        await screen.findByRole("img", { name: "Myoxus Product Mark" })
      ).getAttribute("src"),
    ).toBe("/style/product-mark.svg");
    expect(
      container.querySelector('[data-myoxus-ui-role="auth-header"]')
        ?.textContent,
    ).toBe("Sign inLocal server");
    expect(
      container
        .querySelector('[data-myoxus-ui-role="auth-header"]')
        ?.closest('[data-myoxus-ui-role="auth-form-paper"]'),
    ).toBeNull();
  });
});
