// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, test, vi } from "vitest";

vi.mock("electron", () => ({
  ipcRenderer: { on: vi.fn() },
}));

import { createMessagePortChannel } from "../../src/preload/message-port-channel";

class TestMessagePort extends EventTarget {
  readonly postMessage = vi.fn();
  readonly start = vi.fn();
  readonly close = vi.fn();
}

describe("Helper MessagePort channel", () => {
  test("uses the renderer MessagePort API and forwards only event payloads", () => {
    const port = new TestMessagePort();
    const channel = createMessagePortChannel(port as unknown as MessagePort);
    const listener = vi.fn();
    const unsubscribe = channel.on(listener);

    port.dispatchEvent(new MessageEvent("message", { data: { ready: true } }));
    void channel.send({ command: "ping" });
    expect(listener).toHaveBeenCalledWith({ ready: true });
    expect(port.start).toHaveBeenCalledOnce();
    expect(port.postMessage).toHaveBeenCalledWith({ command: "ping" });

    unsubscribe();
    port.dispatchEvent(new MessageEvent("message", { data: "late" }));
    expect(listener).toHaveBeenCalledOnce();
    expect(port.close).toHaveBeenCalledOnce();
  });
});
