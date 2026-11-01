// SPDX-License-Identifier: AGPL-3.0-or-later
import { EventEmitter } from "node:events";
import type { RendererCloseRequest } from "@myoxus/desktop-api-contract";
import { afterEach, expect, test, vi } from "vitest";
import { RendererCloseAdmission } from "../../src/main/close-admission";

function renderer(id: number) {
  const emitter = new EventEmitter();
  let destroyed = false;
  return {
    sender: Object.assign(emitter, {
      id,
      isDestroyed: () => destroyed,
    }) as unknown as Parameters<RendererCloseAdmission["register"]>[0],
    destroy: () => {
      destroyed = true;
      emitter.emit("destroyed");
    },
    listenerCount: () => emitter.listenerCount("destroyed"),
  };
}
afterEach(() => vi.useRealTimers());

test("correlates trusted replies, shares an intent and vetoes a newly added participant", async () => {
  const requests: RendererCloseRequest[] = [],
    sender = renderer(7);
  const admission = new RendererCloseAdmission((request) =>
    requests.push(request),
  );
  const reveal = vi.fn(async () => {});
  admission.register(sender.sender, "origin", reveal);
  const first = admission.request(7);
  expect(admission.request(7)).toBe(first);
  await vi.waitFor(() => expect(requests).toHaveLength(1));
  const request = requests[0];
  expect(
    admission.answer(8, request.requestId, request.participantId, true),
  ).toBe(false);
  expect(admission.answer(7, request.requestId, "another-owner", true)).toBe(
    false,
  );
  admission.register(sender.sender, "new-owner", reveal);
  expect(
    admission.answer(7, request.requestId, request.participantId, true),
  ).toBe(true);
  await expect(first).resolves.toBe(false);
  expect(
    admission.answer(7, request.requestId, request.participantId, true),
  ).toBe(false);
  admission.unregister(7, "new-owner");
  const canceled = admission.request();
  await vi.waitFor(() => expect(requests).toHaveLength(2));
  admission.answer(7, requests[1].requestId, "origin", false);
  await expect(canceled).resolves.toBe(false);
  const accepted = admission.request();
  await vi.waitFor(() => expect(requests).toHaveLength(3));
  admission.answer(7, requests[2].requestId, "origin", true);
  await expect(accepted).resolves.toBe(true);
  admission.unregister(7, "origin");
  admission.register(sender.sender, "remounted", reveal);
  expect(sender.listenerCount()).toBe(1);
  sender.destroy();
});

test("bounds reveal/reply failures and releases pending decisions on renderer destruction", async () => {
  vi.useFakeTimers();
  const sender = renderer(11),
    reveal = Promise.withResolvers<void>();
  const requests: RendererCloseRequest[] = [];
  const admission = new RendererCloseAdmission(
    (request) => requests.push(request),
    50,
  );
  admission.register(sender.sender, "waiting", () => reveal.promise);
  const stalledReveal = admission.request();
  await vi.advanceTimersByTimeAsync(50);
  await expect(stalledReveal).resolves.toBe(false);
  reveal.resolve();
  await vi.advanceTimersByTimeAsync(0);
  expect(requests).toHaveLength(0);
  admission.unregister(11, "waiting");
  admission.register(sender.sender, "ready", async () => {});
  const stalledReply = admission.request();
  await vi.advanceTimersByTimeAsync(0);
  expect(requests).toHaveLength(1);
  await vi.advanceTimersByTimeAsync(50);
  await expect(stalledReply).resolves.toBe(false);
  expect(admission.answer(11, requests[0].requestId, "ready", true)).toBe(
    false,
  );
  const destroyed = admission.request();
  await vi.advanceTimersByTimeAsync(0);
  sender.destroy();
  await expect(destroyed).resolves.toBe(false);
  expect(vi.getTimerCount()).toBe(0);
  const failed = new RendererCloseAdmission(() => {
    throw new Error("transport failed");
  }, 50);
  const other = renderer(12);
  failed.register(other.sender, "transport", async () => {});
  await expect(failed.request()).resolves.toBe(false);
  expect(vi.getTimerCount()).toBe(0);
  other.destroy();
});
