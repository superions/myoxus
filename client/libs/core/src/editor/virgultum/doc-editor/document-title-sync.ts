// SPDX-License-Identifier: AGPL-3.0-or-later

import type {
  BpmnBlockModel,
  MermaidBlockModel,
  RootBlockModel,
} from "@virgultum/core/models";
import type { Store } from "@virgultum/core/store";
import { debounce } from "lodash-es";
import type { Text as YText, Transaction, YTextEvent } from "yjs";
import { DIAGRAM_DOC_KIND } from "../../../modules/mermaid-diagrams";

export interface DocumentTitleSyncOwner {
  beginDocTitleIntent(docId: string, title: string): number;
  acknowledgeInlineDocTitle(
    docId: string,
    title: string,
    generation: number,
  ): Promise<void>;
}

export interface DiagramDocumentTitleSyncOwner {
  beginDocTitleIntent(docId: string, title: string): number;
  commitDocTitleIntent(
    docId: string,
    title: string,
    generation: number,
  ): Promise<void>;
}

export function effectiveDocumentTitle(
  projectedTitle: string | undefined,
  previewTitle: string | undefined,
) {
  return previewTitle ?? projectedTitle ?? "";
}

/**
 * Observes title edits that originate in this client.
 *
 * Remote Yjs updates still update the editor, but they must not be promoted
 * back into authoritative workspace metadata as if they were a new local
 * rename. The originating client owns that metadata commit.
 */
export function observeDocumentTitle(
  title: YText,
  onChange: (title: string, local: boolean) => void,
) {
  const observer = (_event: YTextEvent, transaction: Transaction) => {
    // Capture the value inside the originating transaction. Remote changes
    // advance the same intent generation as local input, but only local input
    // owns a persistence acknowledgement.
    onChange(title.toString(), transaction.local);
  };

  title.observe(observer);
  return () => title.unobserve(observer);
}

/** Connect the editor leaf to the long-lived title owner without a rename replay. */
export function bindDocumentTitleSync(
  docId: string,
  title: YText,
  owner: DocumentTitleSyncOwner,
  onError: (error: unknown) => void,
) {
  return observeDocumentTitle(title, (value, local) => {
    const generation = owner.beginDocTitleIntent(docId, value);
    if (local) {
      void owner
        .acknowledgeInlineDocTitle(docId, value, generation)
        .catch(onError);
    }
  });
}

/**
 * Sync the single Mermaid or BPMN block title of an explicitly classified
 * dedicated diagram document back to authoritative document metadata.
 * Inline diagram blocks in ordinary documents never rename their parent doc.
 */
export function bindDiagramDocumentTitleSync(
  page: Store,
  docsService: DiagramDocumentTitleSyncOwner,
) {
  if (page.readonly) return () => {};
  let pendingTitle = "";
  let observedTitle: RootBlockModel["props"]["title"] | null = null;
  let stopObservingTitle: (() => void) | null = null;
  const commitTitle = debounce(
    ({ title, generation }: { title: string; generation: number }) => {
      void docsService
        .commitDocTitleIntent(page.id, title, generation)
        .catch((error) => {
          console.error("[doc-title] failed to sync dedicated diagram title", {
            docId: page.id,
            error,
          });
        })
        .finally(() => {
          if (pendingTitle === title) pendingTitle = "";
        });
    },
    250,
  );
  const dedicatedTitle = () => {
    const metadata = page.workspace.meta.getDocMeta(page.id);
    if (
      metadata?.docKind !== DIAGRAM_DOC_KIND ||
      (metadata.diagramFormat !== "mermaid" &&
        metadata.diagramFormat !== "bpmn")
    )
      return null;
    const blocks = page.getBlocksByFlavour(
      metadata.diagramFormat === "bpmn" ? "myoxus:bpmn" : "myoxus:mermaid",
    );
    return blocks.length === 1
      ? (blocks[0].model as BpmnBlockModel | MermaidBlockModel).props.title
      : null;
  };
  const projectTitle = (candidate?: string) => {
    const blockTitle = dedicatedTitle();
    if (!blockTitle) return;
    const title = String(candidate ?? blockTitle).trim();
    const rootTitle = String(
      (page.root as RootBlockModel | null)?.props.title ?? "",
    ).trim();
    if (!title || title === rootTitle || title === pendingTitle) return;
    pendingTitle = title;
    const generation = docsService.beginDocTitleIntent(page.id, title);
    commitTitle({ title, generation });
  };
  const bindTitle = () => {
    const title = dedicatedTitle();
    if (title !== observedTitle) {
      stopObservingTitle?.();
      observedTitle = title;
      stopObservingTitle = title?.yText
        ? observeDocumentTitle(title.yText, (value, local) => {
            if (local) projectTitle(value);
          })
        : null;
    }
    // Mounting or rebinding must not replay the block title over a document rename.
  };
  const readySubscription = page.slots.ready.subscribe(bindTitle);
  const blockSubscription = page.slots.blockUpdated.subscribe(bindTitle);
  bindTitle();
  return () => {
    readySubscription.unsubscribe();
    blockSubscription.unsubscribe();
    stopObservingTitle?.();
    commitTitle.flush();
    commitTitle.cancel();
  };
}
