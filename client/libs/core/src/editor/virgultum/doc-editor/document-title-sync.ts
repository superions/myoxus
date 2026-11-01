// SPDX-License-Identifier: AGPL-3.0-or-later

import type { Text as YText, Transaction, YTextEvent } from "yjs";

export interface DocumentTitleSyncOwner {
  beginDocTitleIntent(docId: string, title: string): number;
  acknowledgeInlineDocTitle(
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
