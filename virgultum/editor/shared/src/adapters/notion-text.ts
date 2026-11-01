import { ErrorCode, VirgultumError } from "@virgultum/global/exceptions";
import { DefaultTheme } from "@virgultum/model";
import {
  type AssetsManager,
  BaseAdapter,
  type BlockSnapshot,
  type DeltaInsert,
  type DocSnapshot,
  type ExtensionType,
  type FromBlockSnapshotResult,
  type FromDocSnapshotResult,
  type FromSliceSnapshotResult,
  nanoid,
  type SliceSnapshot,
  type Transformer,
} from "@virgultum/store";

import type { MyoxusTextAttributes } from "../types";
import { AdapterFactoryIdentifier } from "./types/adapter";

type NotionEditingStyle = {
  0: string;
};

type NotionEditing = {
  0: string;
  1: Array<NotionEditingStyle>;
};

export type NotionTextSerialized = {
  blockType: string;
  editing: Array<NotionEditing>;
};

export type NotionText = string;

type NotionHtmlToSliceSnapshotPayload = {
  file: NotionText;
  assets?: AssetsManager;
  workspaceId: string;
  pageId: string;
};

export class NotionTextAdapter extends BaseAdapter<NotionText> {
  override fromBlockSnapshot():
    | FromBlockSnapshotResult<NotionText>
    | Promise<FromBlockSnapshotResult<NotionText>> {
    throw new VirgultumError(
      ErrorCode.TransformerNotImplementedError,
      "NotionTextAdapter.fromBlockSnapshot is not implemented.",
    );
  }

  override fromDocSnapshot():
    | FromDocSnapshotResult<NotionText>
    | Promise<FromDocSnapshotResult<NotionText>> {
    throw new VirgultumError(
      ErrorCode.TransformerNotImplementedError,
      "NotionTextAdapter.fromDocSnapshot is not implemented.",
    );
  }

  override fromSliceSnapshot():
    | FromSliceSnapshotResult<NotionText>
    | Promise<FromSliceSnapshotResult<NotionText>> {
    return {
      file: JSON.stringify({
        blockType: "text",
        editing: [
          ["Notion Text is not supported to be exported from Virgultum", []],
        ],
      }),
      assetsIds: [],
    };
  }

  override toBlockSnapshot(): Promise<BlockSnapshot> | BlockSnapshot {
    throw new VirgultumError(
      ErrorCode.TransformerNotImplementedError,
      "NotionTextAdapter.toBlockSnapshot is not implemented.",
    );
  }

  override toDocSnapshot(): Promise<DocSnapshot> | DocSnapshot {
    throw new VirgultumError(
      ErrorCode.TransformerNotImplementedError,
      "NotionTextAdapter.toDocSnapshot is not implemented.",
    );
  }

  override toSliceSnapshot(
    payload: NotionHtmlToSliceSnapshotPayload,
  ): SliceSnapshot | null {
    const notionText = JSON.parse(payload.file) as NotionTextSerialized;
    const content: SliceSnapshot["content"] = [];
    const deltas: DeltaInsert<MyoxusTextAttributes>[] = [];

    // Check if the notionText.editing is an array
    if (!Array.isArray(notionText.editing)) {
      return null;
    }

    for (const editing of notionText.editing) {
      const delta: DeltaInsert<MyoxusTextAttributes> = {
        insert: editing[0],
      };

      // Check if the stylesArray of editing[1] is an array
      const stylesArray = editing[1];
      if (Array.isArray(stylesArray)) {
        for (const styleElement of stylesArray) {
          // Skip invalid style entries
          if (!styleElement || typeof styleElement[0] !== "string") {
            continue;
          }

          // Check if the delta.attributes exists, if not, create a new object
          if (!delta.attributes) {
            delta.attributes = Object.create(null);
          }

          // Add the style to the delta.attributes
          switch (styleElement[0]) {
            case "b":
              delta.attributes!.bold = true;
              break;
            case "i":
              delta.attributes!.italic = true;
              break;
            case "_":
              delta.attributes!.underline = true;
              break;
            case "c":
              delta.attributes!.code = true;
              break;
            case "s":
              delta.attributes!.strike = true;
              break;
          }
        }
      }
      deltas.push(delta);
    }

    content.push({
      type: "block",
      id: nanoid(),
      flavour: "myoxus:note",
      props: {
        xywh: "[0,0,800,95]",
        background: DefaultTheme.noteBackgrounColor,
        index: "a0",
        hidden: false,
        displayMode: "both",
      },
      children: [
        {
          type: "block",
          id: nanoid(),
          flavour: "myoxus:paragraph",
          props: {
            type: "text",
            text: {
              "$virgultum:internal:text$": true,
              delta: deltas,
            },
          },
          children: [],
        },
      ],
    });

    return {
      type: "slice",
      content,
      workspaceId: payload.workspaceId,
      pageId: payload.pageId,
    };
  }
}

export const NotionTextAdapterFactoryIdentifier =
  AdapterFactoryIdentifier("NotionText");

export const NotionTextAdapterFactoryExtension: ExtensionType = {
  setup: (di) => {
    di.addImpl(NotionTextAdapterFactoryIdentifier, (provider) => ({
      get: (job: Transformer) => new NotionTextAdapter(job, provider),
    }));
  },
};
