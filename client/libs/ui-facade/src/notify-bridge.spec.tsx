// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Runtime contract tests for the Facade `notify` bridge.
 *
 * These tests run under `@vitest-environment happy-dom` because they call
 * Mantine's notification store. The single-mount assertion remains here;
 * provider theme projection and import boundaries are owned by their focused
 * provider and notification-service contracts.
 *
 * @vitest-environment happy-dom
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { I18n } from "@myoxus/i18n";
import { notifications } from "@mantine/notifications";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { cleanup } from "@testing-library/react";

import { notify } from "./index";

type Call = Parameters<typeof notifications.show>[0];

const collectedCalls: Call[] = [];

let restoreShow: (() => void) | undefined;

beforeEach(() => {
  collectedCalls.length = 0;
  const original = notifications.show.bind(notifications);
  const spy = (payload: Parameters<typeof original>[0]) => {
    collectedCalls.push({ ...payload });
    return original(payload);
  };
  // Mantine types its `notifications` object as readonly; cast through
  // `unknown` so the spy can be installed in tests. Production code
  // never mutates the store directly.
  (notifications as unknown as { show: typeof original }).show = spy;
  restoreShow = () => {
    (notifications as unknown as { show: typeof original }).show = original;
    restoreShow = undefined;
  };
});

afterEach(() => {
  cleanup();
  restoreShow?.();
  notifications.clean();
});

describe("facade notify bridge", () => {
  // Mantine's notification store ticks a queue; some test setups need a
  // little more headroom than the default 5s when the React tree is
  // partially mounted.
  vi.setConfig({ testTimeout: 15_000 });

  test("maps theme and duration to Mantine notification data", async () => {
    notify.success({ title: "saved-theme" });
    notify.error({ title: "boom-theme" });
    notify.warning({ title: "watch-theme" });
    notify({ title: "info-theme" });
    notify({ title: "sticky-theme" }, { duration: 0, position: "top-center" });
    notify({ title: "explicit-theme" }, { duration: 2500 });

    expect(collectedCalls.some((c) => c.color === "myoxusSuccess")).toBe(true);
    expect(collectedCalls.some((c) => c.color === "myoxusError")).toBe(true);
    expect(collectedCalls.some((c) => c.color === "myoxusWarning")).toBe(true);
    expect(collectedCalls.some((c) => c.color === "myoxusInfo")).toBe(true);
    expect(collectedCalls.some((c) => c.autoClose === false)).toBe(true);
    expect(collectedCalls.some((c) => c.autoClose === 2500)).toBe(true);
    expect(
      collectedCalls.find((c) => c.title === "sticky-theme")?.position,
    ).toBe("top-center");
    expect(
      collectedCalls.find((c) => c.title === "explicit-theme")?.position,
    ).toBeUndefined();
    expect(
      collectedCalls.every(
        (call) =>
          call.closeButtonProps?.["aria-label"] ===
          I18n["com.myoxus.toast.dismiss"](),
      ),
    ).toBe(true);
  }, 10_000);

  test("Error objects render with their message text as title", async () => {
    notify.error(new Error("boom-text"));

    const call = collectedCalls.find((c) => c.color === "myoxusError");
    expect(call, "error call must exist").toBeDefined();
    expect(call?.title).toBe("boom-text");
  });

  test("plain ReactNode arguments render as the title", async () => {
    notify("plain-string-title");

    const call = collectedCalls.find((c) => c.id);
    expect(call, "call must exist").toBeDefined();
    expect(call?.title).toBe("plain-string-title");
  });

  test("actions are rendered as buttons inside the message body", async () => {
    notify.success({
      title: "saved",
      message: "your changes are persisted",
      actions: [
        {
          key: "undo",
          label: "Undo",
          onClick: () => {
            /* test-only */
          },
        },
      ],
    });

    const call = collectedCalls.find((c) => c.title === "saved");
    expect(call, "saved call must exist").toBeDefined();
    // The message body is a ReactNode fragment containing the description
    // and a Mantine Group/Button action row owned by the Facade bridge.
    const messageNode = call?.message as
      React.ReactElement<{ children?: React.ReactNode }> | undefined;
    const fragmentChildren = messageNode
      ? Array.isArray(
          (messageNode as { props: { children?: unknown[] } }).props.children,
        )
        ? (messageNode as unknown as { props: { children: unknown[] } }).props
            .children
        : []
      : [];
    const actionRow = fragmentChildren.find(
      (child) =>
        typeof child === "object" &&
        child !== null &&
        "props" in (child as object) &&
        (child as { props?: { "data-myoxus-ui-role"?: string } }).props?.[
          "data-myoxus-ui-role"
        ] === "notification-actions",
    );
    expect(
      actionRow,
      "notification-actions row must be in message body",
    ).toBeDefined();
    const rowProps = (actionRow as { props?: Record<string, unknown> })?.props;
    expect(rowProps?.className, "row must not need custom CSS").toBeUndefined();
    expect(rowProps?.style, "row must not need inline styles").toBeUndefined();
    expect(rowProps?.gap).toBe("xs");
    expect(rowProps?.mt).toBe("xs");
    expect(rowProps?.wrap).toBe("wrap");

    const rowChildren = Array.isArray(rowProps?.children)
      ? rowProps.children
      : rowProps?.children
        ? [rowProps.children]
        : [];
    const actionButton = rowChildren.find(
      (child) =>
        typeof child === "object" &&
        child !== null &&
        "props" in (child as object) &&
        (child as { props?: { "data-testid"?: string } }).props?.[
          "data-testid"
        ] === "undo",
    );
    const actionButtonProps = (
      actionButton as { props?: Record<string, unknown> } | undefined
    )?.props;
    expect(actionButtonProps, "action button must be rendered").toBeDefined();
    expect(actionButtonProps?.className).toBeUndefined();
    expect(actionButtonProps?.style).toBeUndefined();
    expect(actionButtonProps?.size).toBe("xs");
    expect(actionButtonProps?.variant).toBe("filled");
    expect(actionButtonProps?.["data-myoxus-ui-role"]).toBe("button:compact");
  });

  test("legacy style fields are silently ignored without warnings", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    // The legacy fields are still part of the input type for source
    // compatibility; they are silently dropped at the bridge level. The
    // test deliberately uses non-color placeholder strings here so it
    // never introduces a raw color literal — color values are owned by
    // the Myoxus theme and the Mantine color scales, never by callers.
    // The exact strings are irrelevant; what matters is that the bridge
    // strips these fields from the Mantine payload without warnings.
    notify({
      title: "ignored",
      style: "alert",
      alignMessage: "icon",
      borderColor: "x",
      background: "x",
      foreground: "x",
      iconColor: "x",
    });

    const call = collectedCalls.find((c) => c.title === "ignored");
    expect(call, "call must exist").toBeDefined();
    const payload = call as unknown as Record<string, unknown>;
    expect(payload.style).toBeUndefined();
    expect(payload.alignMessage).toBeUndefined();
    expect(payload.borderColor).toBeUndefined();
    expect(payload.background).toBeUndefined();
    expect(payload.foreground).toBeUndefined();
    expect(payload.iconColor).toBeUndefined();
    expect(warnSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  test("notify.dismiss hides a previously shown notification", async () => {
    const id = notify({ title: "dismissable" });
    expect(id, "notify returns an id").toBeTypeOf("string");

    const hideSpy = vi.spyOn(notifications, "hide");
    try {
      notify.dismiss(id);
      expect(hideSpy, "hide was called for the id").toHaveBeenCalledWith(id);
    } finally {
      hideSpy.mockRestore();
    }
  });

  test("notify.dismiss with no id clears all notifications", async () => {
    notify({ title: "a" });
    notify({ title: "b" });

    const cleanSpy = vi.spyOn(notifications, "clean");
    try {
      notify.dismiss();
      expect(cleanSpy, "clean was called when no id").toHaveBeenCalled();
    } finally {
      cleanSpy.mockRestore();
    }
  });

  test("single-mount invariant: provider source has exactly one <Notifications />", () => {
    const providerSource = readFileSync(
      join(__dirname, "provider.tsx"),
      "utf8",
    );
    // Strip block comments so the inline documentation that mentions
    // `<Notifications />` does not count as a mount.
    const stripped = providerSource
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");
    const mountCount = (stripped.match(/<Notifications\b/g) ?? []).length;
    expect(mountCount, "exactly one <Notifications /> mount").toBe(1);
    expect(
      providerSource,
      "transient notifications should appear as a centered bottom surface",
    ).toContain('position="bottom-center"');
    expect(providerSource).not.toContain('position="bottom-right"');
    expect(
      providerSource,
      "Mantine Notification typography must be owned by the Facade theme",
    ).toContain("Notification: Notification.extend");
    expect(providerSource).toContain("title: controlTypographyStyle");
    expect(providerSource).toContain("description: controlTypographyStyle");
  });
});
