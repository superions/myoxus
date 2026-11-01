// SPDX-License-Identifier: AGPL-3.0-or-later
/** @vitest-environment happy-dom */
import { MyoxusUIProvider } from "@myoxus/ui-facade/provider";
import { clearBrandIdentityCache } from "@myoxus/ui-facade";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { SignInWithPasswordStep } from "./sign-in-with-password";

const auth = vi.hoisted(() => ({
  signInPassword: vi.fn().mockResolvedValue(undefined),
  session: { status$: "unauthenticated" },
}));
vi.mock("@myoxus/core/modules/server", () => ({
  AuthService: "auth",
  CaptchaService: "captcha",
  ServerService: "server",
}));
vi.mock("@myoxus/infra", () => ({
  useLiveData: (value: unknown) => value,
  useService: (service: string) =>
    service === "auth"
      ? auth
      : service === "captcha"
        ? {
            verifyToken$: null,
            needCaptcha$: false,
            isLoading$: false,
            hasResolved$: true,
            revalidate: vi.fn(),
          }
        : {
            server: {
              config$: {
                selector: (select: (config: unknown) => unknown) =>
                  select({ type: "Standalone", serverName: "Test server" }),
              },
            },
          },
}));
vi.mock("@myoxus/i18n", () => ({
  useI18n: () => new Proxy({}, { get: (_target, key) => () => String(key) }),
}));
vi.mock("./captcha", () => ({ Captcha: () => null }));

describe("password sign-in semantics", () => {
  beforeEach(() => {
    clearBrandIdentityCache();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("{}", { status: 404 })),
    );
  });
  afterEach(() => {
    cleanup();
    auth.signInPassword.mockClear();
    vi.unstubAllGlobals();
    clearBrandIdentityCache();
  });

  test("keeps the real username eligible for autofill and forwards the bot trap unchanged", async () => {
    const { container } = render(
      <MyoxusUIProvider>
        <SignInWithPasswordStep
          state={{
            step: "signInWithPassword",
            email: "admin@myoxus.local",
            authContext: "admin",
          }}
          changeState={vi.fn()}
        />
      </MyoxusUIProvider>,
    );
    const username = screen.getByLabelText(
      "com.myoxus.settings.email",
    ) as HTMLInputElement;
    expect(username.value).toBe("admin@myoxus.local");
    expect(username.readOnly).toBe(true);
    expect(username.disabled).toBe(false);
    expect(username.name).toBe("username");
    expect(username.autocomplete).toBe("username");
    const password = screen.getByLabelText(
      "com.myoxus.auth.password",
    ) as HTMLInputElement;
    expect(password.autocomplete).toBe("current-password");
    expect(password.name).toBe("password");
    const trap = container.querySelector(
      '[data-myoxus-ui-role="auth-hidden-input"]',
    ) as HTMLInputElement;
    expect(trap.tabIndex).toBe(-1);
    expect(trap.autocomplete).toBe("off");
    expect(trap.value).toBe("");
    fireEvent.change(password, { target: { value: "test-only-password" } });
    fireEvent.click(screen.getByTestId("sign-in-button"));
    await waitFor(() =>
      expect(auth.signInPassword).toHaveBeenCalledWith({
        email: "admin@myoxus.local",
        password: "test-only-password",
        verifyToken: null,
        honeypot: "",
      }),
    );
    fireEvent.change(trap, { target: { value: "filled-by-bot" } });
    fireEvent.click(screen.getByTestId("sign-in-button"));
    await waitFor(() =>
      expect(auth.signInPassword).toHaveBeenLastCalledWith({
        email: "admin@myoxus.local",
        password: "test-only-password",
        verifyToken: null,
        honeypot: "filled-by-bot",
      }),
    );
  });
});
