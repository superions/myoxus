import {
  computed,
  type ReadonlySignal,
  type Signal,
  signal,
} from "@preact/signals-core";
import { type Container, createIdentifier } from "../primitives/di/index";
import {
  type DisposableMember,
  disposeMember,
} from "../primitives/disposable/index";
import type { AliasInfo, ReferenceParams } from "../models/index";
import { LifeCycleWatcher, StdIdentifier } from "../runtime/index";
import type { Store } from "../store/index";

import { referenceToNode } from "../utils/reference.js";

export type DocDisplayMetaParams = {
  referenced?: boolean;
  params?: ReferenceParams;
} & AliasInfo;

export type ReferenceIconName = "LinkIcon" | "BlockLinkIcon" | "DeleteIcon";

/** Only the addressed object determines an inline or embedded reference glyph. */
export function referenceIconName(
  pageId: string,
  params?: ReferenceParams,
): ReferenceIconName {
  return referenceToNode({ pageId, params }) ? "BlockLinkIcon" : "LinkIcon";
}

/**
 * Customize document display title and icon.
 *
 * Supports the following blocks:
 *
 * * Inline View:
 *      `MyoxusReference`
 * * Card View:
 *      `EmbedLinkedDocBlockComponent`
 *      `EmbedEdgelessLinkedDocBlockComponent`
 * * Embed View:
 *      `EmbedSyncedDocBlockComponent`
 *      `EmbedEdgelessSyncedDocBlockComponent`
 */
export interface DocDisplayMetaExtension {
  referenceIcon: (
    pageId: string,
    params?: ReferenceParams,
  ) => ReferenceIconName;
  title: (
    docId: string,
    referenceInfo?: DocDisplayMetaParams,
  ) => ReadonlySignal<string>;
}

export const DocDisplayMetaProvider = createIdentifier<DocDisplayMetaExtension>(
  "DocDisplayMetaService",
);

export class DocDisplayMetaService
  extends LifeCycleWatcher
  implements DocDisplayMetaExtension
{
  static override key = "doc-display-meta";

  readonly disposables: DisposableMember[] = [];

  readonly titleMap = new WeakMap<Store, Signal<string>>();

  static override setup(di: Container) {
    di.addImpl(DocDisplayMetaProvider, this, [StdIdentifier]);
  }

  dispose() {
    while (this.disposables.length > 0) {
      const disposable = this.disposables.pop();
      if (disposable) {
        disposeMember(disposable);
      }
    }
  }

  referenceIcon(pageId: string, params?: ReferenceParams): ReferenceIconName {
    return this.std.workspace.getDoc(pageId)
      ? referenceIconName(pageId, params)
      : "DeleteIcon";
  }

  title(
    pageId: string,
    { title }: DocDisplayMetaParams = {},
  ): ReadonlySignal<string> {
    const doc = this.std.workspace.getDoc(pageId);

    if (!doc) {
      return computed(() => title || "Deleted doc");
    }

    const store = doc.getStore();

    let title$ = this.titleMap.get(store);
    if (!title$) {
      title$ = signal(doc.meta?.title || "Untitled");

      const disposable = this.std.workspace.slots.docListUpdated.subscribe(
        () => {
          title$!.value = doc.meta?.title || "Untitled";
        },
      );

      this.disposables.push(disposable);
      this.titleMap.set(store, title$);
    }

    return computed(() => {
      return title || title$.value;
    });
  }

  override unmounted() {
    this.dispose();
  }
}
