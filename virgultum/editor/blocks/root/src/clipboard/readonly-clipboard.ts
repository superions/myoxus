import { DisposableGroup } from "@virgultum/global/disposable";
import {
  copyMiddleware,
  defaultImageProxyMiddleware,
  docLinkBaseURLMiddleware,
  prepareMarkdownDocumentExport,
  configureMarkdownReferenceMetas,
  configureMarkdownNativeTargets,
  markdownDocumentReferences,
  DOCUMENT_REFERENCE_CURRENT_DOCUMENT,
} from "@virgultum/shared/adapters";
import { DocEmbedProvider } from "@virgultum/shared/services";
import {
  copySelectedModelsCommand,
  draftSelectedModelsCommand,
  getSelectedModelsCommand,
} from "@virgultum/shared/commands";
import { LifeCycleWatcher, type UIEventHandler } from "@virgultum/std";

/**
 * ReadOnlyClipboard is a class that provides a read-only clipboard for the root block.
 * It is supported to copy models in the root block.
 */
export class ReadOnlyClipboard extends LifeCycleWatcher {
  static override key = "myoxus-readonly-clipboard";

  protected readonly _copySelectedInPage = (onCopy?: () => void) => {
    return this.std.command
      .chain()
      .with({ onCopy })
      .pipe(getSelectedModelsCommand, { types: ["block", "text", "image"] })
      .pipe(draftSelectedModelsCommand)
      .pipe(copySelectedModelsCommand);
  };

  protected _disposables = new DisposableGroup();

  protected _initAdapters = () => {
    const copy = copyMiddleware(this.std);
    const docLink = docLinkBaseURLMiddleware(this.std.store.workspace.id);
    this.std.clipboard.use(copy);
    this.std.clipboard.use(docLink);
    this.std.clipboard.use(defaultImageProxyMiddleware);
    const releasePreparation = this.std.clipboard.setCopyPreparation(
      async (snapshot, job) => {
        const workspace = this.std.store.workspace;
        if (snapshot.workspaceId !== workspace.id)
          throw new Error("Clipboard source identity changed");
        const access = this.std.getOptional(DocEmbedProvider) ?? undefined;
        if (!access || !(await access.canRead(snapshot.pageId)))
          throw new Error("Clipboard source access denied");
        // Converting a synced embed to native blocks duplicates a slice from
        // another already-loaded document in this workspace.
        const doc =
          snapshot.pageId === this.std.store.id
            ? this.std.store
            : workspace.getDoc(snapshot.pageId)?.getStore();
        if (!doc) throw new Error("Clipboard source unavailable");
        const root = {
          type: "block" as const,
          id: "clipboard-selection-root",
          flavour: "myoxus:page",
          props: {},
          children: snapshot.content,
        };
        let foreignReference = false;
        const references = markdownDocumentReferences(
          root,
          workspace.id,
          () => {
            foreignReference = true;
          },
        );
        if (!references.size && !foreignReference) {
          const readable = access.readable(doc.id);
          // The frozen selection has no target documents. Preserve the source
          // access fence without loading/checking every other workspace page.
          return async () => {
            if (
              !(await access.canRead(doc.id)) ||
              !workspace.meta.getDocMeta(doc.id) ||
              readable.value !== true
            )
              throw new Error("Clipboard source access lost");
          };
        }
        const prepared = await prepareMarkdownDocumentExport(doc, access, root);
        configureMarkdownReferenceMetas(job.adapterConfigs, prepared.metas);
        // A clipboard selection does not contain the complete target document.
        // Its precise references keep native URLs, not orphan portable fragments.
        configureMarkdownNativeTargets(
          job.adapterConfigs,
          prepared.nativeTargets,
        );
        job.adapterConfigs.delete(DOCUMENT_REFERENCE_CURRENT_DOCUMENT);
        for (const meta of prepared.metas.filter(
          (meta) => meta.workspaceId === undefined,
        ))
          job.adapterConfigs.set("title:" + meta.id, meta.title);
        const authorized = new Set(prepared.metas.map((meta) => meta.id));
        const ids = new Set([
          doc.id,
          ...[
            ...markdownDocumentReferences(root, doc.workspace.id).keys(),
          ].filter((id) => authorized.has(id)),
        ]);
        const permissions = new Map(
          [...ids].map((id) => [id, access.readable(id)]),
        );
        return async () => {
          await prepared.assertReadable();
          // Async checks yield between targets. Retain the host's live grant
          // through the last synchronous clipboard delivery boundary too.
          for (const id of ids)
            if (
              !doc.workspace.meta.getDocMeta(id) ||
              permissions.get(id)?.value !== true
            )
              throw new Error("Clipboard reference access lost");
        };
      },
    );

    this._disposables.add({
      dispose: () => {
        this.std.clipboard.unuse(copy);
        this.std.clipboard.unuse(docLink);
        this.std.clipboard.unuse(defaultImageProxyMiddleware);
        releasePreparation();
      },
    });
  };

  onPageCopy: UIEventHandler = (ctx) => {
    const e = ctx.get("clipboardState").raw;
    e.preventDefault();

    this._copySelectedInPage().run();
  };

  override mounted(): void {
    if (this._disposables.disposed) {
      this._disposables = new DisposableGroup();
    }
    // Internal slice conversion is also used by toolbar actions. Only OS
    // clipboard event handling depends on the browser's secure-context API.
    this._initAdapters();
    // Clipboard availability depends on the browser security context. Its
    // absence is a supported capability boundary, not a product error.
    if (!navigator.clipboard) return;
    this._disposables.add(this.std.event.add("copy", this.onPageCopy));
  }

  override unmounted() {
    this._disposables.dispose();
  }
}
