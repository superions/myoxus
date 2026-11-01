/**
 * @vitest-environment happy-dom
 */
import { ServerFeature } from "@myoxus/graphql";
import { renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

// mocks
const signOutFn = vi.fn();
const jumpToIndex = vi.fn();
const jumpToSignIn = vi.fn();
const requestCloseGuards = vi.fn(() => true as boolean | Promise<boolean>);
let allowGuestDemo: boolean | undefined = true;

vi.mock("@myoxus/core/modules/server", () => ({
  AuthService: class {},
  DefaultServerService: class {},
}));
vi.mock("@myoxus/core/modules/workbench/services/workbench", () => ({
  WorkbenchService: class {},
}));

vi.mock("@myoxus/infra", () => {
  return {
    useService: () => ({ signOut: signOutFn }),
    useServiceOptional: () => ({ workbench: { requestCloseGuards } }),
    useServices: () => ({
      defaultServerService: {
        server: {
          config$: {
            value: {
              get features() {
                return allowGuestDemo !== false
                  ? [ServerFeature.LocalWorkspace]
                  : [];
              },
            },
          },
        },
      },
    }),
  };
});

vi.mock("@myoxus/ui-facade", () => {
  return {
    useConfirmModal: () => ({
      openConfirmModal: ({ onConfirm }: { onConfirm?: () => unknown }) => {
        return Promise.resolve(onConfirm?.());
      },
    }),
    notify: { error: vi.fn() },
  };
});

vi.mock("@myoxus/i18n", () => ({
  useI18n: () => new Proxy({}, { get: () => () => "" }),
}));

vi.mock("../../use-navigate-helper", () => ({
  useNavigateHelper: () => ({ jumpToIndex, jumpToSignIn }),
}));

import { useSignOut } from "../use-sign-out";

describe("useSignOut", () => {
  beforeEach(() => {
    signOutFn.mockClear();
    requestCloseGuards.mockReset().mockReturnValue(true);
    jumpToIndex.mockClear();
    jumpToSignIn.mockClear();
    vi.stubGlobal("BUILD_CONFIG", {
      isElectron: true,
      isNative: true,
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  test("redirects to index when guest demo allowed in Electron", async () => {
    allowGuestDemo = true;
    const { result } = renderHook(() => useSignOut());
    result.current();
    await waitFor(() => expect(signOutFn).toHaveBeenCalled());
    expect(jumpToIndex).toHaveBeenCalled();
    expect(jumpToSignIn).not.toHaveBeenCalled();
  });

  test("redirects to index when guest demo config not provided in Electron", async () => {
    allowGuestDemo = undefined;
    const { result } = renderHook(() => useSignOut());
    result.current();
    await waitFor(() => expect(signOutFn).toHaveBeenCalled());
    expect(jumpToIndex).toHaveBeenCalled();
    expect(jumpToSignIn).not.toHaveBeenCalled();
  });

  test("redirects to index in Electron even when server local feature is disabled", async () => {
    allowGuestDemo = false;
    const { result } = renderHook(() => useSignOut());
    result.current();
    await waitFor(() => expect(signOutFn).toHaveBeenCalled());
    expect(jumpToIndex).toHaveBeenCalled();
    expect(jumpToSignIn).not.toHaveBeenCalled();
  });

  test("redirects to sign in in browser web even when server advertises local workspaces", async () => {
    vi.stubGlobal("BUILD_CONFIG", {
      isElectron: false,
      isNative: false,
    });
    allowGuestDemo = true;

    const { result } = renderHook(() => useSignOut());
    result.current();

    await waitFor(() => expect(signOutFn).toHaveBeenCalled());
    expect(jumpToSignIn).toHaveBeenCalled();
    expect(jumpToIndex).not.toHaveBeenCalled();
  });
  test("admits pane close before auth and awaits the caller without bypassing a later veto", async () => {
    const decision = Promise.withResolvers<boolean>();
    requestCloseGuards.mockReturnValueOnce(decision.promise);
    const callback = vi.fn();
    const hook = renderHook(() => useSignOut({ onConfirm: callback }));
    hook.result.current();
    expect(signOutFn).not.toHaveBeenCalled();
    expect(callback).not.toHaveBeenCalled();
    decision.resolve(false);
    await waitFor(() => expect(requestCloseGuards).toHaveBeenCalledOnce());
    await Promise.resolve();
    expect(callback).not.toHaveBeenCalled();
    expect(signOutFn).not.toHaveBeenCalled();
    hook.unmount();
    const caller = Promise.withResolvers<void>();
    requestCloseGuards
      .mockClear()
      .mockReturnValueOnce(true)
      .mockReturnValueOnce(false);
    const waiting = renderHook(() =>
      useSignOut({ onConfirm: () => caller.promise }),
    );
    waiting.result.current();
    await waitFor(() => expect(requestCloseGuards).toHaveBeenCalledOnce());
    expect(signOutFn).not.toHaveBeenCalled();
    caller.resolve();
    await waitFor(() => expect(requestCloseGuards).toHaveBeenCalledTimes(2));
    expect(signOutFn).not.toHaveBeenCalled();
    expect(jumpToSignIn).not.toHaveBeenCalled();
    expect(jumpToIndex).not.toHaveBeenCalled();
    waiting.unmount();
  });
});
