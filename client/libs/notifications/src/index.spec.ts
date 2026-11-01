// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, test, vi } from "vitest";

import { notifications } from "./index";

describe("@myoxus/notifications compatibility boundary", () => {
  test("re-exports the Mantine notifications store", () => {
    expect(notifications).toBeDefined();
    expect(typeof notifications.show).toBe("function");
    expect(typeof notifications.hide).toBe("function");
    expect(typeof notifications.clean).toBe("function");
  });

  test("routes show() into the Mantine notification store", () => {
    const showSpy = vi.spyOn(notifications, "show");
    try {
      notifications.show({
        id: "boundary-test",
        title: "compatibility",
        message: "via re-export",
        color: "blue",
      });
      expect(showSpy).toHaveBeenCalledTimes(1);
      expect(showSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          id: "boundary-test",
          title: "compatibility",
        }),
      );
    } finally {
      showSpy.mockRestore();
      notifications.clean();
    }
  });

  test("does not own a queue, timers or subscribers of its own", async () => {
    // The legacy store exposed `subscribeNotifications` and a `setTimeout`
    // auto-close. The thin re-export must not carry those; the package
    // exists only as a compatibility/export boundary. `import()` returns a
    // Promise, so we must `await` it before checking the resolved module
    // namespace — otherwise the `in` check runs on the Promise object
    // itself and the assertion is vacuously true.
    const pkg = await import("./index");
    expect("subscribeNotifications" in pkg).toBe(false);
    expect("dismissNotification" in pkg).toBe(false);
    expect("NotificationRecord" in pkg).toBe(false);
    expect(typeof pkg.notifications.show).toBe("function");
    expect(typeof pkg.notifications.hide).toBe("function");
    expect(pkg.notifications).toBe(notifications);
  });
});
