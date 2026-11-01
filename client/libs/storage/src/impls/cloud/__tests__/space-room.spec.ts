// SPDX-License-Identifier: AGPL-3.0-or-later

import type { Socket } from "socket.io-client";
import { describe, expect, test, vi } from "vitest";

import { acquireCloudSpaceRoom } from "../space-room";

function transport() {
  let acknowledge!: (response: {
    data: { clientId: string; success: boolean };
  }) => void;
  const socket = {
    id: "generation-a",
    connected: true,
    emit: vi.fn(),
    emitWithAck: vi.fn(
      () =>
        new Promise<{ data: { clientId: string; success: boolean } }>(
          (resolve) => {
            acknowledge = resolve;
          },
        ),
    ),
  };
  return {
    socket,
    asSocket: socket as unknown as Socket,
    get ack() {
      const resolve = acknowledge;
      return () => resolve({ data: { clientId: socket.id, success: true } });
    },
  };
}

describe("shared cloud space room ownership", () => {
  test("clientId with success false is denied and can be retried", async () => {
    const t = transport();
    t.socket.emitWithAck.mockResolvedValueOnce({
      data: { clientId: "denied", success: false },
    });
    const denied = acquireCloudSpaceRoom(t.asSocket, "workspace", "alpha");
    await expect(denied.ready).rejects.toThrow("Workspace room join denied");
    denied.release();
    expect(t.socket.emit).not.toHaveBeenCalled();
    const retry = acquireCloudSpaceRoom(t.asSocket, "workspace", "alpha");
    t.ack();
    await retry.ready;
    retry.release();
    expect(t.socket.emitWithAck).toHaveBeenCalledTimes(2);
    expect(t.socket.emit).toHaveBeenCalledTimes(1);
  });

  test("Doc and Tasks share one ACK and only the final consumer leaves", async () => {
    const t = transport();
    const doc = acquireCloudSpaceRoom(t.asSocket, "workspace", "alpha");
    const tasks = acquireCloudSpaceRoom(t.asSocket, "workspace", "alpha");
    expect(t.socket.emitWithAck).toHaveBeenCalledTimes(1);
    t.ack();
    await Promise.all([doc.ready, tasks.ready]);
    doc.release();
    expect(t.socket.emit).not.toHaveBeenCalled();
    tasks.release();
    tasks.release();
    expect(t.socket.emit).toHaveBeenCalledTimes(1);
    expect(t.socket.emit).toHaveBeenCalledWith(
      "space:leave",
      expect.objectContaining({ spaceId: "alpha", spaceType: "workspace" }),
    );
  });

  test("late ACK cleans a released room but cannot leave a reacquired owner", async () => {
    const t = transport();
    const abort = new AbortController();
    const old = acquireCloudSpaceRoom(
      t.asSocket,
      "workspace",
      "alpha",
      abort.signal,
    );
    const rejected = expect(old.ready).rejects.toBeDefined();
    abort.abort();
    await rejected;
    expect(t.socket.emit).not.toHaveBeenCalled();
    const current = acquireCloudSpaceRoom(t.asSocket, "workspace", "alpha");
    t.ack();
    await current.ready;
    expect(t.socket.emit).not.toHaveBeenCalled();
    current.release();
    expect(t.socket.emit).toHaveBeenCalledTimes(1);
    const abandoned = acquireCloudSpaceRoom(t.asSocket, "workspace", "beta");
    const abandonedRejection = expect(abandoned.ready).rejects.toBeDefined();
    abandoned.release();
    await abandonedRejection;
    t.ack();
    await Promise.resolve();
    await Promise.resolve();
    expect(t.socket.emit).toHaveBeenCalledTimes(2);
  });

  test("a prior SID ACK/release cannot leave the reconnected workspace", async () => {
    const t = transport();
    const old = acquireCloudSpaceRoom(t.asSocket, "workspace", "alpha");
    const oldAck = t.ack;
    t.socket.id = "generation-b";
    const current = acquireCloudSpaceRoom(t.asSocket, "workspace", "alpha");
    const oldRejection = expect(old.ready).rejects.toBeDefined();
    old.release();
    await oldRejection;
    t.ack();
    await current.ready;
    expect(t.socket.emit).not.toHaveBeenCalled();
    current.release();
    expect(t.socket.emit).toHaveBeenCalledTimes(1);
    oldAck();
    await Promise.resolve();
    await Promise.resolve();
    expect(t.socket.emit).toHaveBeenCalledTimes(1);
    // A second independent socket proves late resolution cleanup on disconnect.
    const other = transport();
    const pending = acquireCloudSpaceRoom(other.asSocket, "workspace", "alpha");
    const pendingRejection = expect(pending.ready).rejects.toBeDefined();
    pending.release();
    await pendingRejection;
    other.socket.id = "new-sid";
    other.ack();
    await Promise.resolve();
    await Promise.resolve();
    expect(other.socket.emit).not.toHaveBeenCalled();
  });
});
