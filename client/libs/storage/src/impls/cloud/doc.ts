import { DebugLogger } from "@myoxus/debug";
import type { Socket } from "socket.io-client";

import {
  type DocClock,
  type DocClocks,
  DocStorageBase,
  type DocStorageOptions,
  type DocUpdate,
  type InitialDocumentProvenance,
} from "../../storage";
import { DocSyncProtocolError } from "../../sync/doc/error";
import { getIdConverter, type IdConverter } from "../../utils/id-converter";
import type { SpaceType } from "../../utils/universal-id";
import { throwIfAborted } from "../../utils/throw-if-aborted";
import { acquireCloudSpaceRoom } from "./space-room";
import {
  getMyoxusStorageClientContext,
  withMyoxusStorageSocketClientContext,
} from "./client-context";
import {
  base64ToUint8Array,
  type ServerEventsMap,
  SocketConnection,
  uint8ArrayToBase64,
} from "./socket";

const logger = new DebugLogger("myoxus:storage:cloud-doc");

function protocolError(error: {
  name: string;
  message: string;
  retryable?: boolean;
  retryAfterMs?: number;
}) {
  const result = new DocSyncProtocolError(
    error.name,
    error.message,
    error.retryable === true,
    typeof error.retryAfterMs === "number" ? error.retryAfterMs : undefined,
  );
  if (error.name === "DOC_MOVED") result.pageRegistration = "moved";
  return result;
}

interface CloudDocStorageOptions extends DocStorageOptions {
  serverBaseUrl: string;
  serverId?: string;
  isSelfHosted: boolean;
  type: SpaceType;
}

export function shouldSyncCloudDoc(docId: string): boolean {
  return (
    docId !== "db$docProperties" &&
    !/^userdata\$[^$]+\$documentMetadataCache$/.test(docId)
  );
}

export class CloudDocStorage extends DocStorageBase<CloudDocStorageOptions> {
  static readonly identifier = "CloudDocStorage";

  /**
   * Native clients consume canonical metadata from the server API. Syncing the
   * retired helper documents would recreate a second metadata truth locally.
   * Match only normalized client IDs; wire-ID conversion remains independent.
   */
  override shouldSyncDoc(docId: string): boolean {
    return shouldSyncCloudDoc(docId);
  }

  get socket() {
    return this.connection.inner.socket;
  }
  get idConverter() {
    if (!this.connection.idConverter) {
      throw new Error("Id converter not initialized");
    }
    return this.connection.idConverter;
  }
  readonly spaceType = this.options.type;

  onServerUpdate: ServerEventsMap["space:broadcast-doc-update"] = (message) => {
    if (
      this.spaceType !== message.spaceType ||
      this.spaceId !== message.spaceId
    ) {
      return;
    }

    this.emit("update", {
      docId: this.idConverter.oldIdToNewId(message.docId),
      bin: base64ToUint8Array(message.update),
      timestamp: new Date(message.timestamp),
      editor: message.editor,
    });
  };

  onServerUpdates: ServerEventsMap["space:broadcast-doc-updates"] = (
    message,
  ) => {
    if (
      this.spaceType !== message.spaceType ||
      this.spaceId !== message.spaceId
    ) {
      return;
    }

    for (const update of message.updates) {
      this.emit("update", {
        docId: this.idConverter.oldIdToNewId(message.docId),
        bin: base64ToUint8Array(update),
        timestamp: new Date(message.timestamp),
        editor: message.editor,
      });
    }
  };

  onServerDocDelete: ServerEventsMap["space:doc-delete"] = (message) => {
    if (
      (message.spaceId && message.spaceId !== this.spaceId) ||
      (message.spaceType && message.spaceType !== this.spaceType)
    )
      return;
    this.emitDocDelete(this.idConverter.oldIdToNewId(message.docId));
  };

  readonly connection = new CloudDocStorageConnection(
    this.options,
    this.onServerUpdate,
    this.onServerUpdates,
    this.onServerDocDelete,
  );

  override async getDocSnapshot(docId: string) {
    const response = await this.socket.emitWithAck(
      "space:load-doc",
      withMyoxusStorageSocketClientContext({
        spaceType: this.spaceType,
        spaceId: this.spaceId,
        docId: this.idConverter.newIdToOldId(docId),
      }),
    );

    if ("error" in response) {
      if (response.error.name === "DOC_NOT_FOUND") {
        return null;
      }
      // TODO: use [UserFriendlyError]
      throw protocolError(response.error);
    }

    return {
      docId,
      bin: base64ToUint8Array(response.data.missing),
      timestamp: new Date(response.data.timestamp),
    };
  }

  override async getDocDiff(docId: string, state?: Uint8Array) {
    const response = await this.socket.emitWithAck(
      "space:load-doc",
      withMyoxusStorageSocketClientContext({
        spaceType: this.spaceType,
        spaceId: this.spaceId,
        docId: this.idConverter.newIdToOldId(docId),
        stateVector: state ? await uint8ArrayToBase64(state) : void 0,
      }),
    );

    if ("error" in response) {
      if (response.error.name === "DOC_NOT_FOUND") {
        logger.debug("doc_sync.load.completed", { outcome: "not_found" });
        return null;
      }
      logger.warn("doc_sync.load.rejected", {
        outcome: response.error.name,
        retryable: response.error.retryable ?? false,
        retryAfterMs: response.error.retryAfterMs,
      });
      throw protocolError(response.error);
    }

    const missing = base64ToUint8Array(response.data.missing);
    logger.debug("doc_sync.load.completed", {
      outcome: "success",
      outputBytes: missing.length,
    });
    return {
      docId,
      missing,
      state: base64ToUint8Array(response.data.state),
      timestamp: new Date(response.data.timestamp),
      pageRegistration: response.data.pageRegistration,
    };
  }

  override async pushDocUpdate(update: DocUpdate) {
    const serverDocId = this.idConverter.newIdToOldId(update.docId);
    const initialDocumentProvenance =
      this.buildInitialDocumentProvenance(update);
    const response = await this.socket.emitWithAck(
      "space:push-doc-update",
      withMyoxusStorageSocketClientContext({
        spaceType: this.spaceType,
        spaceId: this.spaceId,
        docId: serverDocId,
        update: await uint8ArrayToBase64(update.bin),
        ...(initialDocumentProvenance ? { initialDocumentProvenance } : {}),
      }),
    );

    if ("error" in response) {
      const error = protocolError(response.error);
      if (
        this.spaceType === "workspace" &&
        update.docId !== this.spaceId &&
        !update.docId.startsWith("db$") &&
        !update.docId.startsWith("userdata$") &&
        ["NOT_FOUND", "DOC_NOT_FOUND"].includes(error.protocolName)
      ) {
        // A rejected push must retain recovery feedback as well as its bytes.
        // This grants no creation authority and never retries with a new ID.
        error.pageRegistration = "unresolved";
      }
      throw error;
    }

    return {
      docId: update.docId,
      timestamp: new Date(response.data.timestamp),
      pageRegistration: response.data.pageRegistration,
    };
  }

  private buildInitialDocumentProvenance(
    update: DocUpdate,
  ): InitialDocumentProvenance | undefined {
    if (this.spaceType !== "workspace") {
      return undefined;
    }

    const provided = update.initialDocumentProvenance;
    if (!provided) {
      return undefined;
    }

    // The storage boundary may identify the client family/version, but it may
    // not infer offline origin, timestamps, client instance or idempotency.
    // Those values must already have been persisted by an explicit rich-client
    // workflow before they reach this transport.
    return {
      ...provided,
      clientFamily:
        provided.clientFamily ?? getMyoxusStorageClientContext().client,
      clientVersion: provided.clientVersion ?? BUILD_CONFIG.appVersion,
    };
  }

  /**
   * Just a rough implementation, cloud doc storage should not need this method.
   */
  override async getDocTimestamp(docId: string): Promise<DocClock | null> {
    const response = await this.socket.emitWithAck(
      "space:load-doc",
      withMyoxusStorageSocketClientContext({
        spaceType: this.spaceType,
        spaceId: this.spaceId,
        docId: this.idConverter.newIdToOldId(docId),
      }),
    );

    if ("error" in response) {
      // TODO: use [UserFriendlyError]
      throw new Error(response.error.message);
    }

    return {
      docId,
      timestamp: new Date(response.data.timestamp),
    };
  }

  override async getDocTimestamps(after?: Date) {
    const response = await this.socket.emitWithAck(
      "space:load-doc-timestamps",
      withMyoxusStorageSocketClientContext({
        spaceType: this.spaceType,
        spaceId: this.spaceId,
        timestamp: after ? after.getTime() : undefined,
      }),
    );

    if ("error" in response) {
      // TODO(@forehalo): use [UserFriendlyError]
      throw new Error(response.error.message);
    }

    return Object.entries(response.data).reduce((ret, [docId, timestamp]) => {
      ret[this.idConverter.oldIdToNewId(docId)] = new Date(timestamp);
      return ret;
    }, {} as DocClocks);
  }

  override async deleteDoc(docId: string) {
    this.socket.emit(
      "space:delete-doc",
      withMyoxusStorageSocketClientContext({
        spaceType: this.spaceType,
        spaceId: this.spaceId,
        docId: this.idConverter.newIdToOldId(docId),
      }),
    );
  }

  protected async setDocSnapshot() {
    return false;
  }
  protected async getDocUpdates() {
    return [];
  }
  protected async markUpdatesMerged() {
    return 0;
  }
}

class CloudDocStorageConnection extends SocketConnection {
  constructor(
    private readonly options: CloudDocStorageOptions,
    private readonly onServerUpdate: ServerEventsMap["space:broadcast-doc-update"],
    private readonly onServerUpdates: ServerEventsMap["space:broadcast-doc-updates"],
    private readonly onServerDocDelete: ServerEventsMap["space:doc-delete"],
  ) {
    super(options.serverBaseUrl, options.isSelfHosted, options.serverId);
  }

  idConverter: IdConverter | null = null;

  override async doConnect(signal?: AbortSignal) {
    const { socket, disconnect } = await super.doConnect(signal);
    let room: ReturnType<typeof acquireCloudSpaceRoom> | undefined;
    try {
      room = acquireCloudSpaceRoom(
        socket,
        this.options.type,
        this.options.id,
        signal,
      );
      await room.ready;
      throwIfAborted(signal);

      if (!this.idConverter) {
        this.idConverter = await this.getIdConverter(socket);
      }

      throwIfAborted(signal);
      socket.on("space:broadcast-doc-update", this.onServerUpdate);
      socket.on("space:broadcast-doc-updates", this.onServerUpdates);
      socket.on("space:doc-delete", this.onServerDocDelete);

      return {
        socket,
        disconnect: () => {
          room?.release();
          disconnect();
        },
      };
    } catch (e) {
      room?.release();
      super.doDisconnect({ socket, disconnect });
      throw e;
    }
  }

  override doDisconnect({
    socket,
    disconnect,
  }: {
    socket: Socket;
    disconnect: () => void;
  }) {
    socket.off("space:broadcast-doc-update", this.onServerUpdate);
    socket.off("space:broadcast-doc-updates", this.onServerUpdates);
    socket.off("space:doc-delete", this.onServerDocDelete);
    super.doDisconnect({ socket, disconnect });
  }

  async getIdConverter(socket: Socket) {
    return getIdConverter(
      {
        getDocBuffer: async (id) => {
          const response = await socket.emitWithAck(
            "space:load-doc",
            withMyoxusStorageSocketClientContext({
              spaceType: this.options.type,
              spaceId: this.options.id,
              docId: id,
            }),
          );

          if ("error" in response) {
            if (response.error.name === "DOC_NOT_FOUND") {
              return null;
            }
            // TODO: use [UserFriendlyError]
            throw new Error(response.error.message);
          }

          return base64ToUint8Array(response.data.missing);
        },
      },
      this.options.id,
    );
  }
}
