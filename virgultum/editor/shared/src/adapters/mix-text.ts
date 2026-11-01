import type { ServiceProvider } from "@virgultum/global/di";
import { DefaultTheme, NoteDisplayMode } from "@virgultum/model";
import {
  type AssetsManager,
  ASTWalker,
  BaseAdapter,
  type BlockSnapshot,
  BlockSnapshotSchema,
  type DeltaInsert,
  type DocSnapshot,
  type ExtensionType,
  type FromBlockSnapshotPayload,
  type FromBlockSnapshotResult,
  type FromDocSnapshotPayload,
  type FromDocSnapshotResult,
  type FromSliceSnapshotPayload,
  type FromSliceSnapshotResult,
  nanoid,
  type SliceSnapshot,
  type Store,
  type ToBlockSnapshotPayload,
  type ToDocSnapshotPayload,
  type Transformer,
} from "@virgultum/store";

import { MarkdownAdapter } from "./markdown/markdown";
import { AdapterFactoryIdentifier } from "./types/adapter";
import { hasMarkdownImportDiagnostics } from "./markdown/type";
import { NotificationProvider } from "../services/notification-service";
import { serializeAnnotationBody } from "./markdown/annotation-syntax";
import { serializeAnnotationDeltas } from "./markdown/annotation-deltas";
import type { MyoxusTextAttributes } from "../types";

export type MixText = string;

type MixTextToSliceSnapshotPayload = {
  file: MixText;
  assets?: AssetsManager;
  workspaceId: string;
  pageId: string;
};

const withoutMarkdownAnchors = (snapshot: BlockSnapshot): BlockSnapshot => ({
  ...snapshot,
  props: { ...snapshot.props, markdownAnchor: undefined },
  children: snapshot.children.map(withoutMarkdownAnchors),
});

export class MixTextAdapter extends BaseAdapter<MixText> {
  private readonly _markdownAdapter: MarkdownAdapter;

  private readonly _scopeProvider: ServiceProvider;

  constructor(
    job: Transformer,
    provider: ServiceProvider,
    scopeProvider: ServiceProvider = provider,
  ) {
    super(job, provider);
    this._markdownAdapter = new MarkdownAdapter(job, provider, scopeProvider);
    this._scopeProvider = scopeProvider;
  }

  private async _traverseSnapshot(
    snapshot: BlockSnapshot,
  ): Promise<{ mixtext: string }> {
    let buffer = "";
    const walker = new ASTWalker<BlockSnapshot, never>();
    walker.setONodeTypeGuard(
      (node): node is BlockSnapshot =>
        BlockSnapshotSchema.safeParse(node).success,
    );
    walker.setEnter(async (o, context) => {
      const text = (o.node.props.text ?? { delta: [] }) as {
        delta: DeltaInsert<MyoxusTextAttributes>[];
      };
      if (buffer.length > 0) {
        buffer += "\n";
      }
      switch (o.node.flavour) {
        case "myoxus:callout":
        case "myoxus:table": {
          // These blocks own text outside the normal paragraph/list traversal.
          // Keep native references and nested callout structure through the same
          // Markdown writer. Its subtree is already serialized; do not walk it
          // again or introduce duplicate source anchors in clipboard content.
          const result = await this._markdownAdapter.fromBlockSnapshot({
            snapshot: withoutMarkdownAnchors(o.node),
          });
          // Preserve the writer's terminator: the next block needs a blank line
          // or GFM treats an adjacent table as a lazy callout paragraph.
          buffer += result.file;
          context.skipAllChildren();
          break;
        }
        case "myoxus:embed-synced-doc": {
          const result = await this._markdownAdapter.fromBlockSnapshot({
            snapshot: o.node,
          });
          buffer += result.file;
          break;
        }
        case "myoxus:code": {
          buffer += text.delta.map((delta) => delta.insert).join("");
          break;
        }
        case "myoxus:paragraph":
        case "myoxus:list": {
          if (
            text.delta.some(
              ({ attributes }) =>
                attributes?.reference &&
                !attributes.annotation &&
                !attributes.code &&
                !attributes.latex,
            )
          ) {
            // Mixed text already accepts Markdown on paste. Reuse its native
            // reference writer instead of copying the invisible placeholder.
            const result = await this._markdownAdapter.fromBlockSnapshot({
              snapshot: {
                ...o.node,
                props: { ...o.node.props, markdownAnchor: undefined },
                children: [],
              },
            });
            buffer += result.file.replace(/\n+$/, "");
          } else buffer += serializeAnnotationDeltas(text.delta);
          break;
        }
        case "myoxus:annotation": {
          buffer += serializeAnnotationBody(
            text.delta.map((delta) => delta.insert).join(""),
          );
          break;
        }
        case "myoxus:divider": {
          buffer += "---";
          break;
        }
      }
    });
    await walker.walkONode(snapshot);
    return {
      mixtext: buffer,
    };
  }

  async fromBlockSnapshot({
    snapshot,
  }: FromBlockSnapshotPayload): Promise<FromBlockSnapshotResult<MixText>> {
    const { mixtext } = await this._traverseSnapshot(snapshot);
    return {
      file: mixtext,
      assetsIds: [],
    };
  }

  async fromDocSnapshot({
    snapshot,
    assets,
  }: FromDocSnapshotPayload): Promise<FromDocSnapshotResult<MixText>> {
    let buffer = "";
    if (snapshot.meta.title) {
      buffer += `${snapshot.meta.title}\n\n`;
    }
    const { file, assetsIds } = await this.fromBlockSnapshot({
      snapshot: snapshot.blocks,
      assets,
    });
    buffer += file;
    return {
      file: buffer,
      assetsIds,
    };
  }

  async fromSliceSnapshot({
    snapshot,
    assets,
  }: FromSliceSnapshotPayload): Promise<FromSliceSnapshotResult<MixText>> {
    const hasLocalDefinition = (block: BlockSnapshot): boolean =>
      block.flavour === "myoxus:footnote-definition" ||
      block.children.some(hasLocalDefinition);
    if (snapshot.content.some(hasLocalDefinition)) {
      // A completed marker slice needs the normal rich-body writer, including
      // continuation indentation and fences, rather than mixed-text flattening.
      const result = await this._markdownAdapter.fromSliceSnapshot({
        snapshot: {
          ...snapshot,
          content: snapshot.content.map(withoutMarkdownAnchors),
        },
        assets,
        inlineFootnoteAssets: true,
      });
      // Native/HTML clipboard data preserves placement; its Markdown text
      // fallback cannot. Report that loss through the existing copy consumer.
      const diagnostics = this._markdownAdapter.exportDiagnostics;
      if (diagnostics.normalizedEndnotes)
        this._scopeProvider
          .getOptional(NotificationProvider)
          ?.notifyMarkdownImportDiagnostics(diagnostics);
      return result;
    }
    let buffer = "";
    const sliceAssetsIds: string[] = [];
    for (const contentSlice of snapshot.content) {
      const { mixtext } = await this._traverseSnapshot(contentSlice);
      if (buffer && mixtext) buffer += "\n\n";
      buffer += mixtext;
    }
    const mixtext =
      buffer.match(/\n/g)?.length === 1 ? buffer.trimEnd() : buffer;
    return {
      file: mixtext,
      assetsIds: sliceAssetsIds,
    };
  }

  toBlockSnapshot(payload: ToBlockSnapshotPayload<MixText>): BlockSnapshot {
    payload.file = payload.file.replaceAll("\r", "");
    return {
      type: "block",
      id: nanoid(),
      flavour: "myoxus:note",
      props: {
        xywh: "[0,0,800,95]",
        background: DefaultTheme.noteBackgrounColor,
        index: "a0",
        hidden: false,
        displayMode: NoteDisplayMode.DocAndEdgeless,
      },
      children: payload.file.split("\n").map((line): BlockSnapshot => {
        return {
          type: "block",
          id: nanoid(),
          flavour: "myoxus:paragraph",
          props: {
            type: "text",
            text: {
              "$virgultum:internal:text$": true,
              delta: [
                {
                  insert: line,
                },
              ],
            },
          },
          children: [],
        };
      }),
    };
  }

  toDocSnapshot(payload: ToDocSnapshotPayload<MixText>): DocSnapshot {
    payload.file = payload.file.replaceAll("\r", "");
    return {
      type: "page",
      meta: {
        id: nanoid(),
        title: "Untitled",
        createDate: Date.now(),
        tags: [],
      },
      blocks: {
        type: "block",
        id: nanoid(),
        flavour: "myoxus:page",
        props: {
          title: {
            "$virgultum:internal:text$": true,
            delta: [
              {
                insert: "Untitled",
              },
            ],
          },
        },
        children: [
          {
            type: "block",
            id: nanoid(),
            flavour: "myoxus:surface",
            props: {
              elements: {},
            },
            children: [],
          },
          {
            type: "block",
            id: nanoid(),
            flavour: "myoxus:note",
            props: {
              xywh: "[0,0,800,95]",
              background: DefaultTheme.noteBackgrounColor,
              index: "a0",
              hidden: false,
              displayMode: NoteDisplayMode.DocAndEdgeless,
            },
            children: payload.file.split("\n").map((line): BlockSnapshot => {
              return {
                type: "block",
                id: nanoid(),
                flavour: "myoxus:paragraph",
                props: {
                  type: "text",
                  text: {
                    "$virgultum:internal:text$": true,
                    delta: [
                      {
                        insert: line,
                      },
                    ],
                  },
                },
                children: [],
              };
            }),
          },
        ],
      },
    };
  }

  override prepareSliceSnapshot(
    payload: ToBlockSnapshotPayload<MixText>,
    doc: Store,
  ) {
    return this.toSliceSnapshot(
      { ...payload, workspaceId: doc.workspace.id, pageId: doc.id },
      doc,
    );
  }

  override assertPreparedSliceCurrent() {
    this._markdownAdapter.assertPreparedSliceCurrent();
  }

  async toSliceSnapshot(
    payload: MixTextToSliceSnapshotPayload,
    referenceStore?: Store,
  ): Promise<SliceSnapshot | null> {
    if (payload.file.trim().length === 0) {
      return null;
    }
    payload.file = payload.file.replaceAll("\r", "");
    const markdownPayload = {
      file: payload.file,
      assets: payload.assets,
      workspaceId: payload.workspaceId,
      pageId: payload.pageId,
    };
    const sliceSnapshot = referenceStore
      ? await this._markdownAdapter.toSliceSnapshotWithReferences(
          markdownPayload,
          referenceStore,
        )
      : await this._markdownAdapter.toSliceSnapshot(markdownPayload);
    if (!sliceSnapshot) {
      return null;
    }
    const diagnostics = this._markdownAdapter.importDiagnostics;
    if (hasMarkdownImportDiagnostics(diagnostics)) {
      this._scopeProvider
        .getOptional(NotificationProvider)
        ?.notifyMarkdownImportDiagnostics(diagnostics);
    }
    for (const contentSlice of sliceSnapshot.content) {
      const blockSnapshotRoot = {
        type: "block",
        id: nanoid(),
        flavour: "myoxus:note",
        props: {
          xywh: "[0,0,800,95]",
          background: DefaultTheme.noteBackgrounColor,
          index: "a0",
          hidden: false,
          displayMode: NoteDisplayMode.DocAndEdgeless,
        },
        children: [],
      } as BlockSnapshot;
      const walker = new ASTWalker<BlockSnapshot, BlockSnapshot>();
      walker.setONodeTypeGuard(
        (node): node is BlockSnapshot =>
          BlockSnapshotSchema.safeParse(node).success,
      );
      walker.setEnter((o, context) => {
        switch (o.node.flavour) {
          case "myoxus:note": {
            break;
          }
          default: {
            context.openNode({ ...o.node, children: [] });
          }
        }
      });
      walker.setLeave((o, context) => {
        switch (o.node.flavour) {
          case "myoxus:note": {
            break;
          }
          default: {
            context.closeNode();
          }
        }
      });
      await walker.walk(contentSlice, blockSnapshotRoot);
      contentSlice.children = blockSnapshotRoot.children;
    }
    return sliceSnapshot;
  }
}

export const MixTextAdapterFactoryIdentifier =
  AdapterFactoryIdentifier("MixText");

export const MixTextAdapterFactoryExtension: ExtensionType = {
  setup: (di) => {
    di.addImpl(MixTextAdapterFactoryIdentifier, (provider) => ({
      get: (job: Transformer) => new MixTextAdapter(job, provider),
    }));
  },
};
