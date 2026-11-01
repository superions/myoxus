import {
  type AwarenessRecord,
  AwarenessStorageBase,
} from "../../storage/awareness";
import type { SpaceType } from "../../utils/universal-id";
import { withMyoxusStorageSocketClientContext } from "./client-context";
import {
  base64ToUint8Array,
  SocketConnection,
  type Socket,
  uint8ArrayToBase64,
} from "./socket";

interface CloudAwarenessStorageOptions {
  isSelfHosted: boolean;
  serverBaseUrl: string;
  serverId?: string;
  type: SpaceType;
  id: string;
}

export class CloudAwarenessStorage extends AwarenessStorageBase {
  static readonly identifier = "CloudAwarenessStorage";
  // Multiple renderer subscriptions share one socket membership per document.
  private readonly subscribers = new Map<string, number>();

  constructor(private readonly options: CloudAwarenessStorageOptions) {
    super();
  }

  connection = new SocketConnection(
    this.options.serverBaseUrl,
    this.options.isSelfHosted,
    this.options.serverId,
  );

  private get socket() {
    return this.connection.inner.socket;
  }

  override async update(record: AwarenessRecord): Promise<void> {
    const socket = this.socket;
    const encodedUpdate = await uint8ArrayToBase64(record.bin);
    if (this.connection.status !== "connected" || this.socket !== socket)
      return;
    socket.emit(
      "space:update-awareness",
      withMyoxusStorageSocketClientContext({
        spaceType: this.options.type,
        spaceId: this.options.id,
        docId: record.docId,
        awarenessUpdate: encodedUpdate,
      }),
    );
  }

  override subscribeUpdate(
    id: string,
    onUpdate: (update: AwarenessRecord, origin?: string) => void,
    onCollect: () => Promise<AwarenessRecord | null>,
  ): () => void {
    this.subscribers.set(id, (this.subscribers.get(id) ?? 0) + 1);
    let disposed = false;
    let generation = 0;
    let subscribedSocket: Socket | undefined;
    const scope = withMyoxusStorageSocketClientContext({
      spaceType: this.options.type,
      spaceId: this.options.id,
      docId: id,
    });
    // Detach from the saved socket even when connection.inner is unavailable.
    const detach = () => {
      subscribedSocket?.off("space:collect-awareness", handleCollectAwareness);
      subscribedSocket?.off(
        "space:broadcast-awareness-update",
        handleBroadcastAwarenessUpdate,
      );
      subscribedSocket = undefined;
    };

    // join awareness, and collect awareness from others
    const joinAndCollect = async () => {
      if (disposed) return;
      const attempt = ++generation;
      detach();
      const socket = this.socket;
      subscribedSocket = socket;
      socket.on("space:collect-awareness", handleCollectAwareness);
      socket.on(
        "space:broadcast-awareness-update",
        handleBroadcastAwarenessUpdate,
      );
      const response = await socket.emitWithAck(
        "space:join-awareness",
        withMyoxusStorageSocketClientContext({
          spaceType: this.options.type,
          spaceId: this.options.id,
          docId: id,
          clientVersion: BUILD_CONFIG.appVersion,
        }),
      );
      // A late join ACK cannot start collection for a closed subscription.
      if (disposed) {
        if (socket.connected && !this.subscribers.has(id))
          socket.emit("space:leave-awareness", scope);
        return;
      }
      if (attempt !== generation || subscribedSocket !== socket) return;
      if ("error" in response || !response.data.success) {
        ++generation;
        detach();
        throw new Error(
          "error" in response
            ? response.error.message
            : "Awareness join denied",
        );
      }
      socket.emit("space:load-awarenesses", scope);
    };

    const handleCollectAwareness = ({
      spaceId,
      spaceType,
      docId,
    }: {
      spaceId: string;
      spaceType: string;
      docId: string;
    }) => {
      if (
        spaceId === this.options.id &&
        spaceType === this.options.type &&
        docId === id
      ) {
        (async () => {
          const attempt = generation;
          const socket = subscribedSocket;
          const record = await onCollect();
          if (record) {
            const encodedUpdate = await uint8ArrayToBase64(record.bin);
            if (
              disposed ||
              attempt !== generation ||
              !socket ||
              subscribedSocket !== socket
            )
              return;
            socket.emit(
              "space:update-awareness",
              withMyoxusStorageSocketClientContext({
                spaceType: this.options.type,
                spaceId: this.options.id,
                docId: record.docId,
                awarenessUpdate: encodedUpdate,
              }),
            );
          }
        })().catch((err) => console.error("awareness upload failed", err));
      }
    };

    const handleBroadcastAwarenessUpdate = ({
      spaceType,
      spaceId,
      docId,
      awarenessUpdate,
    }: {
      spaceType: string;
      spaceId: string;
      docId: string;
      awarenessUpdate: string;
    }) => {
      if (
        spaceId === this.options.id &&
        spaceType === this.options.type &&
        docId === id
      ) {
        onUpdate({
          bin: base64ToUint8Array(awarenessUpdate),
          docId: id,
        });
      }
    };

    if (this.connection.status === "connected") {
      joinAndCollect().catch((err) =>
        console.error("awareness join failed", err),
      );
    }

    const unsubscribeConnectionStatusChanged = this.connection.onStatusChanged(
      (status) => {
        if (status === "connected") {
          joinAndCollect().catch((err) =>
            console.error("awareness join failed", err),
          );
        } else {
          ++generation;
          detach();
        }
      },
    );

    return () => {
      if (disposed) return;
      disposed = true;
      const remaining = this.subscribers.get(id)! - 1;
      if (remaining) this.subscribers.set(id, remaining);
      else this.subscribers.delete(id);
      ++generation;
      const socket = subscribedSocket;
      detach();
      if (socket?.connected && !remaining)
        socket.emit("space:leave-awareness", scope);
      unsubscribeConnectionStatusChanged();
    };
  }
}
