import { type Container, createIdentifier } from "../primitives/di/index";
import { StdIdentifier } from "../runtime/identifier";
import type { BlockStdScope } from "../runtime/scope/std-scope";
import { Extension, Slice, type SliceSnapshot } from "../store/index";

export const DndApiExtensionIdentifier = createIdentifier<DNDAPIExtension>(
  "MyoxusDndApiIdentifier",
);

export class DNDAPIExtension extends Extension {
  mimeType = "application/x-virgultum-dnd";

  constructor(private readonly source: Pick<BlockStdScope, "store">) {
    super();
  }

  static override setup(di: Container) {
    di.add(this, [StdIdentifier]);

    di.addImpl(DndApiExtensionIdentifier, (provider) => provider.get(this));
  }

  decodeSnapshot(data: string): SliceSnapshot {
    return JSON.parse(decodeURIComponent(data));
  }

  encodeSnapshot(json: SliceSnapshot) {
    const snapshot = JSON.stringify(json);
    return encodeURIComponent(snapshot);
  }

  fromEntity(options: {
    docId: string;
    flavour?: string;
    blockId?: string;
    props?: Record<string, unknown>;
  }): SliceSnapshot | null {
    const { docId, flavour = "myoxus:embed-linked-doc", blockId } = options;

    const slice = Slice.fromModels(this.source.store, []);
    const job = this.source.store.getTransformer();
    const snapshot = job.sliceToSnapshot(slice);
    if (!snapshot) {
      console.error("Failed to convert slice to snapshot");
      return null;
    }
    const props = {
      ...options.props,
      ...(blockId ? { blockId } : {}),
      pageId: docId,
      style: flavour === "myoxus:embed-synced-doc" ? "syncedDoc" : "vertical",
    };
    return {
      ...snapshot,
      content: [
        {
          id: this.source.store.workspace.idGenerator(),
          type: "block",
          flavour,
          props,
          children: [],
        },
      ],
    };
  }
}
