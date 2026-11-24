import { DocDisplayMetaService } from "@myoxus/core/modules/doc-display-meta";
import { type FrameworkProvider } from "@myoxus/infra";
import { computed, type ReadonlySignal } from "@preact/signals-core";
import type { Container } from "@virgultum/editor/global/di";
import {
  type DocDisplayMetaExtension,
  type DocDisplayMetaParams,
  DocDisplayMetaProvider,
  referenceIconName,
} from "@virgultum/editor/shared/services";
import { createSignalFromObservable } from "@virgultum/editor/shared/utils";
import { LifeCycleWatcher, StdIdentifier } from "@virgultum/editor/std";

export function buildDocDisplayMetaExtension(framework: FrameworkProvider) {
  const docDisplayMetaService = framework.get(DocDisplayMetaService);

  class MyoxusDocDisplayMetaService
    extends LifeCycleWatcher
    implements DocDisplayMetaExtension
  {
    static override key = "doc-display-meta";

    readonly disposables: (() => void)[] = [];

    static override setup(di: Container) {
      super.setup(di);
      di.override(DocDisplayMetaProvider, this, [StdIdentifier]);
    }

    dispose() {
      while (this.disposables.length > 0) {
        this.disposables.pop()?.();
      }
    }

    readonly referenceIcon = referenceIconName;

    title(
      docId: string,
      { title, referenced }: DocDisplayMetaParams = {},
    ): ReadonlySignal<string> {
      const title$ = docDisplayMetaService.title$(docId, {
        title,
        reference: referenced,
      });

      const { signal: titleSignal, cleanup } =
        createSignalFromObservable<string>(title$, title ?? "");

      this.disposables.push(cleanup);

      return computed(() => titleSignal.value);
    }

    override unmounted() {
      this.dispose();
    }
  }

  return MyoxusDocDisplayMetaService;
}
