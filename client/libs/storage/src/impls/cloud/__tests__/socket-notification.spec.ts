import { describe, expect, test, vi } from "vitest";

const transport = vi.hoisted(() => {
  const listeners = new Map<string, Set<(value?: unknown) => void>>();
  let autoConnect = true;
  const socket = {
    connected: false,
    emit: vi.fn(),
    on: vi.fn((name: string, cb: (value?: unknown) => void) => {
      let handlers = listeners.get(name);
      if (!handlers) listeners.set(name, (handlers = new Set()));
      handlers.add(cb);
    }),
    off: vi.fn((name: string, cb: (value?: unknown) => void) => {
      for (const handler of listeners.get(name) ?? []) {
        if (
          handler === cb ||
          (handler as typeof cb & { original?: typeof cb }).original === cb
        ) {
          listeners.get(name)?.delete(handler);
        }
      }
    }),
    once(name: string, cb: (value?: unknown) => void) {
      const handler = (value?: unknown) => {
        socket.off(name, handler);
        cb(value);
      };
      // Match Socket.IO's removal by original callback as well as wrapper.
      Object.assign(handler, { original: cb });
      socket.on(name, handler);
    },
    connect: vi.fn(() => {
      if (socket.connected || !autoConnect) return;
      socket.connected = true;
      for (const cb of listeners.get("connect") ?? []) cb();
    }),
    disconnect: vi.fn(() => {
      socket.connected = false;
    }),
  };
  return {
    socket,
    setAutoConnect(value: boolean) {
      autoConnect = value;
    },
    count(name: string) {
      return listeners.get(name)?.size ?? 0;
    },
    receive(name: string, value: unknown) {
      for (const cb of listeners.get(name) ?? []) cb(value);
    },
  };
});
vi.mock("socket.io-client", () => ({
  Manager: class {
    socket() {
      return transport.socket;
    }
  },
}));

import {
  SocketConnection,
  onCalendarReminderDue,
  onNotificationChanged,
} from "../socket";

describe("shared notification Subscribe/Push/ACK consumer", () => {
  test("subscribes once, dispatches all persisted changes, ACKs and resubscribes", () => {
    const connection = new SocketConnection(
      "http://notification-contract.test",
      true,
    );
    const other = new SocketConnection(
      "http://notification-contract.test",
      true,
    );
    const changes = vi.fn();
    const reminder = vi.fn();
    const unsubscribe = onNotificationChanged(changes);
    const stopReminder = onCalendarReminderDue(reminder);
    const first = connection.manager.connect();
    const second = other.manager.connect();
    expect(transport.socket.emit).toHaveBeenCalledTimes(1);
    expect(transport.socket.emit).toHaveBeenCalledWith(
      "notification:subscribe",
      {},
    );
    changes.mockClear();
    const events = [
      "notification_new",
      "notification_read",
      "notification_read_all",
      "calendar_reminder_due",
    ];
    const ids = events.map((_, i) => `00000000-0000-4000-8000-00000000000${i}`);
    events.forEach((eventType, i) => {
      const payload =
        eventType === "calendar_reminder_due"
          ? { eventId: "event", scheduledFor: "2026-10-04T15:00:00Z" }
          : { notificationId: "notification" };
      const envelope = { eventId: ids[i], eventType, payload };
      transport.receive("notification:push", envelope);
      transport.receive("notification:push", envelope);
      expect(transport.socket.emit).toHaveBeenCalledWith("notification:ack", {
        eventId: ids[i],
      });
    });
    expect(changes.mock.calls).toEqual(
      [...events.slice(0, 3), "notification_new"].map((type) => [type]),
    );
    expect(reminder).toHaveBeenCalledTimes(1);
    const calls = transport.socket.emit.mock.calls.length;
    transport.receive("notification:push", {
      eventId: ids[0],
      eventType: "injected",
      payload: {},
    });
    transport.receive("notification:push", {
      eventId: "",
      eventType: "notification_new",
      payload: {},
    });
    expect(transport.socket.emit).toHaveBeenCalledTimes(calls);
    first.disconnect();
    expect(transport.socket.disconnect).not.toHaveBeenCalled();
    second.disconnect();
    const reconnected = connection.manager.connect();
    expect(
      transport.socket.emit.mock.calls.filter(
        ([type]) => type === "notification:subscribe",
      ),
    ).toHaveLength(2);
    reconnected.disconnect();
    unsubscribe();
    stopReminder();
    changes.mockClear();
    transport.receive("notification:push", {
      eventId: "00000000-0000-4000-8000-000000000009",
      eventType: "notification_read",
      payload: {},
    });
    expect(changes).not.toHaveBeenCalled();
  });

  test("connection attempts remove losing listeners on success, error and abort", async () => {
    transport.setAutoConnect(false);
    const connection = new SocketConnection(
      "http://attempt-lifetime.test",
      true,
    );
    const baseline = transport.count("connect");
    for (const outcome of ["connect", "connect_error", "abort"]) {
      const controller = new AbortController();
      const remove = vi.spyOn(controller.signal, "removeEventListener");
      const attempt = connection.doConnect(controller.signal);
      expect(transport.count("connect")).toBe(baseline + 1);
      expect(transport.count("connect_error")).toBe(1);
      const reason = new Error(outcome);
      if (outcome === "connect") {
        transport.socket.connected = true;
        transport.receive("connect", undefined);
        const opened = await attempt;
        connection.doDisconnect(opened);
      } else {
        const rejected = expect(attempt).rejects.toBe(reason);
        if (outcome === "abort") controller.abort(reason);
        else transport.receive(outcome, reason);
        await rejected;
      }
      expect(transport.count("connect")).toBe(baseline);
      expect(transport.count("connect_error")).toBe(0);
      expect(transport.count("disconnect")).toBe(0);
      expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));
      expect(connection.manager.refCount).toBe(0);
    }
    transport.setAutoConnect(true);
    const controller = new AbortController();
    const add = vi.spyOn(controller.signal, "addEventListener");
    const opened = await connection.doConnect(controller.signal);
    expect(add).not.toHaveBeenCalled();
    connection.doDisconnect(opened);
  });
});
