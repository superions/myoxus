// SPDX-License-Identifier: AGPL-3.0-or-later

import type { Socket } from "./socket";

import type { SpaceType } from "../../utils/universal-id";
import { withMyoxusStorageSocketClientContext } from "./client-context";

type JoinAck = { clientId: string };
type RoomLease = { ready: Promise<JoinAck>; release: () => void };
type Room = { consumers: number; joined: boolean; ready: Promise<JoinAck> };
const rooms = new WeakMap<Socket, Map<string, Room>>();

/** Share the acknowledged room with document sync without loading documents.
 * The socket SID fences late ACK/release from a previous reconnect generation.
 * Releasing cancels this consumer immediately; the shared join still drains its
 * late ACK before the final owner leaves that same room.
 */
export function acquireCloudSpaceRoom(
  socket: Socket,
  spaceType: SpaceType,
  spaceId: string,
  signal?: AbortSignal,
): RoomLease {
  const sid = socket.id;
  if (!socket.connected || !sid) {
    throw new Error("Workspace room requires a connected socket");
  }
  const key = JSON.stringify([sid, spaceType, spaceId]);
  let scoped = rooms.get(socket);
  if (!scoped) {
    scoped = new Map();
    rooms.set(socket, scoped);
  }
  const registry = scoped;
  const finish = (room: Room) => {
    if (room.consumers || !room.joined) return;
    if (socket.connected && socket.id === sid) {
      socket.emit(
        "space:leave",
        withMyoxusStorageSocketClientContext({ spaceType, spaceId }),
      );
    }
    if (registry.get(key) === room) registry.delete(key);
  };
  let room = registry.get(key);
  if (!room) {
    const created: Room = {
      consumers: 0,
      joined: false,
      ready: Promise.resolve({ clientId: "" }),
    };
    registry.set(key, created);
    created.ready = socket
      .emitWithAck(
        "space:join",
        withMyoxusStorageSocketClientContext({
          spaceType,
          spaceId,
          clientVersion: BUILD_CONFIG.appVersion,
        }),
      )
      .then((response) => {
        if ("error" in response) throw new Error(response.error.message);
        if (response.data?.success !== true) {
          throw new Error("Workspace room join denied");
        }
        if (
          typeof response.data?.clientId !== "string" ||
          !response.data.clientId
        ) {
          throw new Error("Workspace room acknowledgement is invalid");
        }
        created.joined = true;
        finish(created);
        return response.data;
      })
      .catch((error) => {
        if (registry.get(key) === created) registry.delete(key);
        throw error;
      });
    room = created;
  }
  const owned = room;
  owned.consumers++;
  let released = false;
  let rejectReady!: (reason: unknown) => void;
  const ready = new Promise<JoinAck>((resolve, reject) => {
    rejectReady = reject;
    owned.ready.then(resolve, reject);
  });
  const release = () => {
    if (released) return;
    released = true;
    signal?.removeEventListener("abort", release);
    owned.consumers--;
    rejectReady(
      signal?.reason ?? new DOMException("Room lease released", "AbortError"),
    );
    finish(owned);
  };
  signal?.addEventListener("abort", release, { once: true });
  if (signal?.aborted) release();
  return { ready, release };
}
