import { ErrorCode, VirgultumError } from "@virgultum/global/exceptions";
import { remapAnnotationIdentities } from "@virgultum/model";
import { remapDocumentFieldIdentities } from "../../types";
import {
  BaseAdapter,
  nanoid,
  type BlockSnapshot,
  type DocSnapshot,
  type FromBlockSnapshotPayload,
  type FromBlockSnapshotResult,
  type FromDocSnapshotPayload,
  type FromDocSnapshotResult,
  type FromSliceSnapshotPayload,
  type FromSliceSnapshotResult,
  type SliceSnapshot,
  type ToBlockSnapshotPayload,
  type ToDocSnapshotPayload,
  type ToSliceSnapshotPayload,
  type Store,
} from "@virgultum/store";
import { prepareLocalFootnoteImport } from "../markdown/local-footnote-import.js";

import { NotificationProvider } from "../../services/notification-service.js";
import { decodeClipboardBlobs, encodeClipboardBlobs } from "./utils.js";

export type FileSnapshot = {
  name: string;
  type: string;
  content: string;
};

export class ClipboardAdapter extends BaseAdapter<string> {
  static MIME = "VIRGULTUM/SNAPSHOT";
  private _assertFootnotesCurrent?: () => void;

  override async prepareSliceSnapshot(
    payload: ToBlockSnapshotPayload<string>,
    doc: Store,
  ) {
    const snapshot = await super.prepareSliceSnapshot(payload, doc);
    this._assertFootnotesCurrent = snapshot
      ? prepareLocalFootnoteImport(snapshot, doc, this.job)
      : undefined;
    return snapshot;
  }

  override assertPreparedSliceCurrent() {
    this._assertFootnotesCurrent?.();
  }

  private readonly _onError = (message: string) => {
    const notification = this.provider.getOptional(NotificationProvider);
    if (!notification) return;

    notification.toast(message);
  };

  override fromBlockSnapshot(
    _payload: FromBlockSnapshotPayload,
  ): Promise<FromBlockSnapshotResult<string>> {
    throw new VirgultumError(
      ErrorCode.TransformerNotImplementedError,
      "ClipboardAdapter.fromBlockSnapshot is not implemented",
    );
  }

  override fromDocSnapshot(
    _payload: FromDocSnapshotPayload,
  ): Promise<FromDocSnapshotResult<string>> {
    throw new VirgultumError(
      ErrorCode.TransformerNotImplementedError,
      "ClipboardAdapter.fromDocSnapshot is not implemented",
    );
  }

  override async fromSliceSnapshot(
    payload: FromSliceSnapshotPayload,
  ): Promise<FromSliceSnapshotResult<string>> {
    const snapshot = payload.snapshot;
    const assets = payload.assets;
    if (!assets) {
      throw new VirgultumError(
        ErrorCode.ValueNotExists,
        "ClipboardAdapter.fromSliceSnapshot: assets is not found",
      );
    }
    const map = assets.getAssets();
    const blobs: Record<string, FileSnapshot> = await encodeClipboardBlobs(
      map,
      this._onError,
    );
    const assertBodyAssets = (
      block: BlockSnapshot,
      insideDefinition = false,
    ) => {
      insideDefinition ||= block.flavour === "myoxus:footnote-definition";
      if (
        insideDefinition &&
        block.flavour === "myoxus:image" &&
        (typeof block.props.sourceId !== "string" ||
          !Object.hasOwn(blobs, block.props.sourceId))
      )
        throw new Error(
          "Footnote clipboard image unavailable within existing clipboard limits",
        );
      block.children.forEach((child) =>
        assertBodyAssets(child, insideDefinition),
      );
    };
    snapshot.content.forEach((block) => assertBodyAssets(block));
    return {
      file: JSON.stringify({
        snapshot,
        blobs,
      }),
      assetsIds: [],
    };
  }

  override toBlockSnapshot(
    _payload: ToBlockSnapshotPayload<string>,
  ): Promise<BlockSnapshot> {
    throw new VirgultumError(
      ErrorCode.TransformerNotImplementedError,
      "ClipboardAdapter.toBlockSnapshot is not implemented",
    );
  }

  override toDocSnapshot(
    _payload: ToDocSnapshotPayload<string>,
  ): Promise<DocSnapshot> {
    throw new VirgultumError(
      ErrorCode.TransformerNotImplementedError,
      "ClipboardAdapter.toDocSnapshot is not implemented",
    );
  }

  override toSliceSnapshot(
    payload: ToSliceSnapshotPayload<string>,
  ): Promise<SliceSnapshot> {
    const json = JSON.parse(payload.file);
    const { blobs, snapshot } = json;
    remapAnnotationIdentities(snapshot, nanoid);
    remapDocumentFieldIdentities(snapshot, nanoid);
    const map = payload.assets?.getAssets();
    decodeClipboardBlobs(blobs, map);
    return Promise.resolve(snapshot);
  }
}
