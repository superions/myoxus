import {
  BlockLinkIcon,
  DeleteIcon,
  EdgelessIcon,
  LinkIcon,
  PageIcon,
} from "@myoxus/icons/lit";
import {
  computed,
  type ReadonlySignal,
  type Signal,
  signal,
} from "@preact/signals-core";
import { type Container, createIdentifier } from "@virgultum/global/di";
import {
  type DisposableMember,
  disposeMember,
} from "@virgultum/global/disposable";
import type { AliasInfo, ReferenceParams } from "@virgultum/model";
import { LifeCycleWatcher, StdIdentifier } from "@virgultum/std";
import type { Store } from "@virgultum/store";
import type { TemplateResult } from "lit";

import { referenceToNode } from "../utils/reference.js";
import { DocModeProvider } from "./doc-mode-service.js";

export type DocDisplayMetaParams = {
  referenced?: boolean;
  params?: ReferenceParams;
} & AliasInfo;

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
  icon: (
    docId: string,
    referenceInfo?: DocDisplayMetaParams,
  ) => ReadonlySignal<TemplateResult>;
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
  static icons = {
    deleted: iconBuilder(DeleteIcon),
    page: iconBuilder(PageIcon),
    edgeless: iconBuilder(EdgelessIcon),
    linkedBlock: iconBuilder(BlockLinkIcon),
    linkedPage: iconBuilder(LinkIcon),
  } as const;

  static override key = "doc-display-meta";

  readonly disposables: DisposableMember[] = [];

  readonly iconMap = new WeakMap<Store, Signal<TemplateResult>>();

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

  icon(
    pageId: string,
    { params, referenced }: DocDisplayMetaParams = {},
  ): ReadonlySignal<TemplateResult> {
    const doc = this.std.workspace.getDoc(pageId);

    if (!doc) {
      return computed(() => DocDisplayMetaService.icons.deleted);
    }

    const store = doc.getStore();

    let icon$ = this.iconMap.get(store);

    if (!icon$) {
      icon$ = signal(
        this.std.get(DocModeProvider).getPrimaryMode(pageId) === "edgeless"
          ? DocDisplayMetaService.icons.edgeless
          : DocDisplayMetaService.icons.page,
      );

      const disposable = this.std
        .get(DocModeProvider)
        .onPrimaryModeChange((mode) => {
          icon$!.value =
            mode === "edgeless"
              ? DocDisplayMetaService.icons.edgeless
              : DocDisplayMetaService.icons.page;
        }, pageId);

      this.disposables.push(disposable);
      this.iconMap.set(store, icon$);
    }

    return computed(() => {
      if (referenceToNode({ pageId, params })) {
        return DocDisplayMetaService.icons.linkedBlock;
      }

      if (referenced) {
        return DocDisplayMetaService.icons.linkedPage;
      }

      return icon$.value;
    });
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

function iconBuilder(
  icon: typeof PageIcon,
  size = "1.25em",
  style = "user-select:none;flex-shrink:0;vertical-align:middle;font-size:inherit;",
) {
  return icon({ width: size, height: size, style });
}
