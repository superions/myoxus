// SPDX-License-Identifier: AGPL-3.0-or-later

import type { EventBasedChannel } from "async-call-rpc";

type RendererMessageEvent = Readonly<{ data: unknown }>;

export interface RendererMessagePort {
  addEventListener(
    type: "message",
    listener: (event: RendererMessageEvent) => void,
  ): void;
  removeEventListener(
    type: "message",
    listener: (event: RendererMessageEvent) => void,
  ): void;
  start(): void;
  close(): void;
  postMessage(data: unknown): void;
}

export function createMessagePortChannel(
  port: RendererMessagePort,
): EventBasedChannel {
  return {
    on(listener) {
      const listen = (event: RendererMessageEvent) => listener(event.data);
      port.addEventListener("message", listen);
      port.start();
      return () => {
        port.removeEventListener("message", listen);
        try {
          port.close();
        } catch (error) {
          console.error("[helper] close port error", error);
        }
      };
    },
    send(data) {
      port.postMessage(data);
    },
  };
}
