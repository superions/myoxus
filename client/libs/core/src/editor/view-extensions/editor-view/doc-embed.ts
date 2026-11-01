// SPDX-License-Identifier: AGPL-3.0-or-later
import { CoreDocEmbedProvider, DocsService } from "@myoxus/core/modules/doc";
import { WorkspaceService } from "@myoxus/core/modules/workspace";
import { GuardService } from "@myoxus/core/modules/permissions";
import type { FrameworkProvider } from "@myoxus/infra";
import { type Container, createIdentifier } from "@virgultum/editor/global/di";
import { DocEmbedProvider } from "@virgultum/editor/shared/services";
import {
  type BlockStdScope,
  LifeCycleWatcher,
  LifeCycleWatcherIdentifier,
  StdIdentifier,
} from "@virgultum/editor/std";
import type { ExtensionType } from "@virgultum/editor/store";

export function patchDocEmbedService(
  framework: FrameworkProvider,
): ExtensionType & {
  new (std: BlockStdScope): LifeCycleWatcher & DocEmbedProvider;
} {
  const guard = framework.get(GuardService);
  const docs = framework.get(DocsService);
  const workspace = framework.get(WorkspaceService).workspace;
  const serviceIdentifier = createIdentifier<
    LifeCycleWatcher & DocEmbedProvider
  >("MyoxusDocEmbedService");
  return class MyoxusDocEmbedService
    extends LifeCycleWatcher
    implements DocEmbedProvider
  {
    static override key = "myoxus-doc-embed";
    readonly #access = new CoreDocEmbedProvider(guard, docs, workspace);
    static override setup(di: Container) {
      // Production minification can erase this returned class expression's name.
      // Register by explicit identity and share the lifecycle-owned instance.
      di.addImpl(serviceIdentifier, this, [StdIdentifier]);
      di.addImpl(LifeCycleWatcherIdentifier(this.key), (provider) =>
        provider.get(serviceIdentifier),
      );
      di.override(DocEmbedProvider, (provider) =>
        provider.get(serviceIdentifier),
      );
    }
    inWorkspace(workspaceId: string) {
      return this.#access.inWorkspace(workspaceId);
    }
    openReference(workspaceId: string | undefined, docId: string) {
      return this.#access.openReference(workspaceId, docId);
    }
    primaryMode(docId: string) {
      return this.#access.primaryMode(docId);
    }
    readable(docId: string) {
      return this.#access.readable(docId);
    }
    canRead(docId: string) {
      return this.#access.canRead(docId);
    }
    referenceTitleSignal(docId: string) {
      return this.#access.referenceTitleSignal(docId);
    }
    referenceTitle(docId: string) {
      return this.#access.referenceTitle(docId);
    }
    async waitForLoaded(docId: string, signal: AbortSignal) {
      return this.#access.waitForLoaded(docId, signal);
    }
    override unmounted() {
      this.#access.dispose();
    }
  };
}
