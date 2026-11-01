import { DocDisplayMetaService } from "@myoxus/core/modules/doc-display-meta";
import { LinkIcon, PageIcon } from "@myoxus/icons/lit";
import { type FrameworkProvider } from "@myoxus/infra";
import { computed, type ReadonlySignal } from "@preact/signals-core";
import type { Container } from "@virgultum/editor/global/di";
import {
  type DocDisplayMetaExtension,
  type DocDisplayMetaParams,
  DocDisplayMetaProvider,
} from "@virgultum/editor/shared/services";
import {
  createSignalFromObservable,
  referenceToNode,
} from "@virgultum/editor/shared/utils";
import { LifeCycleWatcher, StdIdentifier } from "@virgultum/editor/std";
import type { TemplateResult } from "lit";

export function buildDocDisplayMetaExtension(framework: FrameworkProvider) {
  const docDisplayMetaService = framework.get(DocDisplayMetaService);

  function iconBuilder(
    icon: typeof PageIcon,
    size = "1.25em",
    style = "user-select:none;flex-shrink:0;vertical-align:middle;font-size:inherit;margin-bottom:0.1em;",
  ) {
    return icon({
      width: size,
      height: size,
      style,
    });
  }

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

    icon(
      docId: string,
      { params, title, referenced }: DocDisplayMetaParams = {},
    ): ReadonlySignal<TemplateResult> {
      const icon$ = docDisplayMetaService
        .icon$(docId, {
          type: "lit",
          title,
          reference: referenced,
          referenceToNode: referenceToNode({ pageId: docId, params }),
        })
        .map(iconBuilder);

      const { signal: iconSignal, cleanup } = createSignalFromObservable(
        icon$,
        iconBuilder(referenced ? LinkIcon : PageIcon),
      );

      this.disposables.push(cleanup);

      return computed(() => iconSignal.value);
    }

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
