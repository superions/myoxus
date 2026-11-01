// @vitest-environment happy-dom

import { type ClientUpdateControl, ClientUpdateGate } from "@myoxus/storage";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { ClientUpdateSurface } from "./surface";

const notification = vi.hoisted(() => ({
  dismiss: vi.fn(),
  warning: vi.fn(),
}));
const cacheReset = vi.hoisted(() => {
  const listeners = new Set<() => void>();
  let snapshot = { status: "idle" } as
    { status: "idle" } | { status: "failed" };
  return {
    getSnapshot: () => snapshot,
    retry: vi.fn(),
    setSnapshot(next: typeof snapshot) {
      snapshot = next;
      for (const listener of listeners) listener();
    },
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
});

vi.mock("@myoxus/i18n", () => ({
  useI18n: () =>
    new Proxy(
      {},
      {
        get: (_target, key) => (values?: Record<string, unknown>) =>
          `${String(key)}${values ? `:${JSON.stringify(values)}` : ""}`,
      },
    ),
}));

vi.mock("@myoxus/ui-facade", async () => {
  const React = await import("react");
  const element =
    (name: string) =>
    ({
      children,
      ...props
    }: React.PropsWithChildren<Record<string, unknown>>) =>
      React.createElement(name, props, children);
  return {
    ExceptionBoundaryFrame: element("main"),
    ExceptionBoundarySurface: element("section"),
    SettingsSectionDescription: element("p"),
    SettingsSectionHeading: element("h1"),
    MyoxusButton: element("button"),
    notify: notification,
  };
});

vi.mock("./cache-reset", () => ({
  clientUpdateCacheResetStore: cacheReset,
}));

function control(
  phase: ClientUpdateControl["phase"],
  overrides: Partial<ClientUpdateControl> = {},
): ClientUpdateControl {
  return {
    schemaVersion: 1,
    stateId: `state-${phase}`,
    phase,
    operationId: phase === "normal" ? null : "operation-a",
    maxAttempts: phase === "limited" ? 2 : null,
    retryAfterMs: null,
    completion: null,
    requiredWebBuildId: null,
    cacheEpoch: 0,
    updatedAt: "2026-07-26T00:00:00Z",
    ...overrides,
  };
}

async function apply(
  gate: ClientUpdateGate,
  next: ClientUpdateControl,
): Promise<void> {
  await act(() => gate.read(async () => next));
}

describe("ClientUpdateSurface", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    cacheReset.setSnapshot({ status: "idle" });
  });
  afterEach(cleanup);

  test("keeps normal mode chrome-free and exposes the limited budget", async () => {
    const gate = new ClientUpdateGate();
    render(
      <ClientUpdateSurface gate={gate}>
        <div>Workspace</div>
      </ClientUpdateSurface>,
    );
    expect(
      screen.getByText("com.myoxus.clientUpdate.loading.title"),
    ).not.toBeNull();

    await apply(gate, control("normal"));
    expect(screen.getByText("Workspace")).not.toBeNull();

    await apply(gate, control("limited"));
    expect(screen.getByText("Workspace")).not.toBeNull();
    expect(notification.warning).toHaveBeenLastCalledWith(
      expect.objectContaining({
        message: expect.stringContaining('"remaining":"2"'),
      }),
      expect.objectContaining({ duration: 0 }),
    );

    act(() => {
      gate.reserveAutomaticRetry("swr");
    });
    expect(notification.warning).toHaveBeenLastCalledWith(
      expect.objectContaining({
        message: expect.stringContaining('"remaining":"1"'),
      }),
      expect.anything(),
    );
  });

  test.each(["suspended", "failed"] as const)(
    "replaces product routes with the %s boundary",
    async (phase) => {
      const gate = new ClientUpdateGate();
      render(
        <ClientUpdateSurface gate={gate}>
          <div>Workspace</div>
        </ClientUpdateSurface>,
      );
      await apply(gate, control(phase));

      expect(screen.queryByText("Workspace")).toBeNull();
      expect(
        screen.getByText(`com.myoxus.clientUpdate.${phase}.title`),
      ).not.toBeNull();
    },
  );

  test("offers an explicit reread only after a local control error", async () => {
    const gate = new ClientUpdateGate();
    const reread = vi.fn(async () => control("normal"));
    render(
      <ClientUpdateSurface gate={gate} reread={reread}>
        <div>Workspace</div>
      </ClientUpdateSurface>,
    );
    await act(async () => {
      await gate
        .read(async () => {
          throw new Error("offline");
        })
        .catch(() => undefined);
    });

    fireEvent.click(screen.getByTestId("client-update-control-retry"));
    expect(reread).toHaveBeenCalledOnce();
  });

  test("replaces routes with a retryable cache-reset failure", async () => {
    const gate = new ClientUpdateGate();
    render(
      <ClientUpdateSurface gate={gate}>
        <div>Workspace</div>
      </ClientUpdateSurface>,
    );

    act(() => cacheReset.setSnapshot({ status: "failed" }));

    expect(screen.queryByText("Workspace")).toBeNull();
    expect(
      screen.getByText("com.myoxus.clientUpdate.cacheReset.failed"),
    ).not.toBeNull();
    fireEvent.click(screen.getByText("Retry"));
    expect(cacheReset.retry).toHaveBeenCalledOnce();
  });
});
