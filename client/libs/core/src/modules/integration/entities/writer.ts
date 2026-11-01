import { getStoreManager } from "@myoxus/core/editor/manager/store";
import { Entity } from "@myoxus/infra";
import { MarkdownTransformer } from "@virgultum/editor/widgets/linked-doc";
import { CoreDocEmbedProvider, DocsService } from "../../doc";
import { GuardService } from "../../permissions";
import { createSignalFromObservable } from "@virgultum/editor/shared/utils";

import type { TagService } from "../../tag";
import {
  getMyoxusWorkspaceSchema,
  type WorkspaceService,
} from "../../workspace";

export class IntegrationWriter extends Entity {
  constructor(
    private readonly workspaceService: WorkspaceService,
    private readonly tagService: TagService,
  ) {
    super();
  }

  public async writeDoc(options: {
    /**
     * Title of the doc
     */
    title?: string;
    /**
     * Markdown string
     */
    content: string;
    /**
     * Comment of the markdown content
     */
    comment?: string | null;
    /**
     * Doc id, if not provided, a new doc will be created
     */
    docId?: string;
    /**
     * Update strategy, default is `override`
     */
    updateStrategy?: "override" | "append";
    /**
     * Tags to apply to the doc
     */
    tags?: string[];
  }) {
    const {
      title,
      content,
      comment,
      docId,
      tags,
      updateStrategy = "override",
    } = options;

    const workspace = this.workspaceService.workspace;
    let markdown = comment ? `${content}\n\n---\n\n${comment}` : content;

    let finalDocId: string;
    if (!docId) {
      const access = new CoreDocEmbedProvider(
        workspace.scope.get(GuardService),
        workspace.scope.get(DocsService),
        workspace,
      );
      let newDocId: string | undefined;
      try {
        ({ docId: newDocId } = await MarkdownTransformer.importMarkdownToDoc({
          collection: workspace.docCollection,
          schema: getMyoxusWorkspaceSchema(),
          markdown,
          fileName: title,
          extensions: getStoreManager().config.init().value.get("store"),
          access,
        }));
      } finally {
        access.dispose();
      }

      if (!newDocId) throw new Error("Failed to create a new doc");
      finalDocId = newDocId;
    } else {
      const collection = workspace.docCollection;
      const guard = workspace.scope.get(GuardService);
      const doc = collection.getDoc(docId)?.getStore();
      if (!doc) throw new Error("Doc not found");
      if (!(await guard.can("Doc_Update", docId)))
        throw new Error("Document update denied");
      if (updateStrategy !== "override" && updateStrategy !== "append")
        throw new Error("Invalid update strategy");
      const access = new CoreDocEmbedProvider(
        guard,
        workspace.scope.get(DocsService),
        workspace,
      );
      const { signal: writable, cleanup } = createSignalFromObservable(
        guard.can$("Doc_Update", docId),
        undefined,
      );
      try {
        await access.waitForLoaded(docId, AbortSignal.timeout(30_000));
        const root = doc.root;
        if (!root) throw new Error("Document root missing");
        // Reserve an identity, not a live note. Parser/load failures must leave
        // the original tree intact, especially for an override operation.
        const blockId = collection.idGenerator();
        if (doc.hasBlock(blockId))
          throw new Error("Markdown import block ID collision");
        await MarkdownTransformer.importMarkdownToBlock({
          doc,
          blockId,
          markdown: updateStrategy === "append" ? `---\n${markdown}` : markdown,
          extensions: getStoreManager().config.init().value.get("store"),
          access,
          replaceExistingTargets: updateStrategy === "override",
          beforeInsert: () => {
            if (doc.hasBlock(blockId))
              throw new Error("Markdown import block ID collision");
            if (updateStrategy === "override")
              [...root.children].forEach((child) => doc.deleteBlock(child));
            doc.addBlock("myoxus:note", { id: blockId }, root.id);
          },
          operation: {
            write: (write) => {
              if (
                writable.value !== true ||
                doc.readonly ||
                doc.root?.id !== root.id ||
                !collection.meta.getDocMeta(docId)
              )
                throw new Error("Document update no longer available");
              write();
            },
          },
        });
      } finally {
        cleanup();
        access.dispose();
      }
      finalDocId = doc.id;
    }
    await this.applyTags(finalDocId, tags);
    return finalDocId;
  }

  public async applyTags(docId: string, tags?: string[]) {
    if (!tags?.length) return;
    await Promise.all(
      tags.map((tag) =>
        this.tagService.tagList.tagByTagId$(tag).value?.tag(docId),
      ),
    );
  }
}
