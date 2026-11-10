import type { ServiceProvider } from "@virgultum/global/di";
import { projectDocumentFieldOutput } from "../utils/document-field-output";
import { DefaultTheme, NoteDisplayMode } from "@virgultum/model";
import {
  type AssetsManager,
  ASTWalker,
  BaseAdapter,
  type BlockSnapshot,
  BlockSnapshotSchema,
  type DocSnapshot,
  type ExtensionType,
  type FromBlockSnapshotPayload,
  type FromBlockSnapshotResult,
  type FromDocSnapshotPayload,
  type FromDocSnapshotResult,
  type FromSliceSnapshotPayload,
  type FromSliceSnapshotResult,
  nanoid,
  type SliceSnapshot,
  type Store,
  type ToBlockSnapshotPayload,
  type ToDocSnapshotPayload,
  type Transformer,
} from "@virgultum/store";
import DOMPurify from "dompurify";
import type { Root } from "hast";
import rehypeParse from "rehype-parse";
import rehypeStringify from "rehype-stringify";
import { unified } from "unified";
import { visit } from "unist-util-visit";

import {
  type AdapterContext,
  AdapterFactoryIdentifier,
  type HtmlAST,
} from "../types";
import { HastUtils } from "../utils/hast";
import {
  type BlockHtmlAdapterMatcher,
  BlockHtmlAdapterMatcherIdentifier,
} from "./block-adapter";
import {
  HtmlASTToDeltaMatcherIdentifier,
  HtmlDeltaConverter,
  InlineDeltaToHtmlAdapterMatcherIdentifier,
} from "./delta-converter";
import {
  rehypeInlineToBlock,
  rehypeWrapInlineElements,
} from "./rehype-plugins";
import { normalizeHtmlAnnotationBlocks } from "../markdown/annotation-deltas";
import {
  emptyMarkdownImportDiagnostics,
  hasMarkdownImportDiagnostics,
} from "../markdown/type";
import { DocEmbedProvider } from "../../services/doc-embed-service";
import { NotificationProvider } from "../../services/notification-service";
import { EditorI18nProvider } from "../../services/i18n-service";
import {
  prepareDocumentReferenceImport,
  assertQualifiedNativeExportReadable,
  needsMarkdownReferenceInventory,
} from "../middlewares/document-reference";
import { prepareLocalFootnoteImport } from "../markdown/local-footnote-import";
import {
  prepareHtmlFootnotes,
  inlineFootnoteHtmlAssets,
  linkLocalFootnoteHtml,
  prepareLocalFootnoteReading,
} from "./footnotes";

export type Html = string;

type HtmlToSliceSnapshotPayload = {
  file: Html;
  assets?: AssetsManager;
  workspaceId: string;
  pageId: string;
};

export class HtmlAdapter extends BaseAdapter<Html> {
  private readonly _importDiagnostics = emptyMarkdownImportDiagnostics();
  private _assertImportReferencesCurrent?: () => void;

  get importDiagnostics() {
    return { ...this._importDiagnostics };
  }

  override assertPreparedSliceCurrent() {
    this._assertImportReferencesCurrent?.();
  }

  override async prepareSliceSnapshot(
    payload: ToBlockSnapshotPayload<Html>,
    doc: Store,
  ) {
    this._assertImportReferencesCurrent = undefined;
    Object.assign(this._importDiagnostics, emptyMarkdownImportDiagnostics());
    this.deltaConverter.beginImport();
    const prepared = await prepareDocumentReferenceImport(
      doc,
      this.configs,
      {
        prepare: (loadReferences) =>
          this.toSliceSnapshot(
            {
              ...payload,
              workspaceId: doc.workspace.id,
              pageId: doc.id,
            },
            async (ast) => {
              let needsReferences = false;
              visit(ast, "element", (node) => {
                if (
                  node.tagName === "a" &&
                  typeof node.properties.href === "string" &&
                  needsMarkdownReferenceInventory(
                    node.properties.href,
                    this.configs,
                  )
                )
                  needsReferences = true;
              });
              if (needsReferences) await loadReferences();
            },
          ),
        referencedDocumentIds: this.deltaConverter.referencedDocumentIds,
        resolve: () => this.deltaConverter.resolveImportReferences(),
      },
      this.scopeProvider?.getOptional(DocEmbedProvider) ?? undefined,
    );
    const assertFootnotesCurrent = prepared
      ? prepareLocalFootnoteImport(prepared.snapshot, doc, this.job)
      : undefined;
    this._assertImportReferencesCurrent = () => {
      prepared?.assertCurrent();
      assertFootnotesCurrent?.();
    };
    if (prepared && hasMarkdownImportDiagnostics(this._importDiagnostics))
      this.scopeProvider
        ?.getOptional(NotificationProvider)
        ?.notifyMarkdownImportDiagnostics(this.importDiagnostics);
    return prepared?.snapshot ?? null;
  }

  private readonly _astToHtml = (ast: Root) => {
    return unified().use(rehypeStringify).stringify(ast);
  };

  private readonly _traverseHtml = async (
    html: HtmlAST,
    snapshot: BlockSnapshot,
    assets?: AssetsManager,
  ) => {
    const walker = new ASTWalker<HtmlAST, BlockSnapshot>();
    walker.setONodeTypeGuard(
      (node): node is HtmlAST =>
        "type" in (node as object) && (node as HtmlAST).type !== undefined,
    );
    walker.setEnter(async (o, context) => {
      for (const matcher of this.blockMatchers) {
        if (matcher.toMatch(o)) {
          const adapterContext: AdapterContext<
            HtmlAST,
            BlockSnapshot,
            HtmlDeltaConverter
          > = {
            walker,
            walkerContext: context,
            configs: this.configs,
            job: this.job,
            deltaConverter: this.deltaConverter,
            textBuffer: { content: "" },
            assets,
          };
          await matcher.toBlockSnapshot.enter?.(o, adapterContext);
        }
      }
    });
    walker.setLeave(async (o, context) => {
      for (const matcher of this.blockMatchers) {
        if (matcher.toMatch(o)) {
          const adapterContext: AdapterContext<
            HtmlAST,
            BlockSnapshot,
            HtmlDeltaConverter
          > = {
            walker,
            walkerContext: context,
            configs: this.configs,
            job: this.job,
            deltaConverter: this.deltaConverter,
            textBuffer: { content: "" },
            assets,
          };
          await matcher.toBlockSnapshot.leave?.(o, adapterContext);
        }
      }
    });
    return normalizeHtmlAnnotationBlocks(await walker.walk(html, snapshot));
  };

  private readonly _traverseSnapshot = async (
    snapshot: BlockSnapshot,
    html: HtmlAST,
    assets?: AssetsManager,
  ) => {
    const assetsIds: string[] = [];
    const walker = new ASTWalker<BlockSnapshot, HtmlAST>();
    walker.setONodeTypeGuard(
      (node): node is BlockSnapshot =>
        BlockSnapshotSchema.safeParse(node).success,
    );
    walker.setEnter(async (o, context) => {
      for (const matcher of this.blockMatchers) {
        if (matcher.fromMatch(o)) {
          const adapterContext: AdapterContext<
            BlockSnapshot,
            HtmlAST,
            HtmlDeltaConverter
          > = {
            walker,
            walkerContext: context,
            configs: this.configs,
            job: this.job,
            deltaConverter: this.deltaConverter,
            provider: this.provider,
            scopeProvider: this.scopeProvider ?? this.provider,
            textBuffer: { content: "" },
            assets,
            updateAssetIds: (assetsId: string) => {
              assetsIds.push(assetsId);
            },
          };
          await matcher.fromBlockSnapshot.enter?.(o, adapterContext);
        }
      }
    });
    walker.setLeave(async (o, context) => {
      for (const matcher of this.blockMatchers) {
        if (matcher.fromMatch(o)) {
          const adapterContext: AdapterContext<
            BlockSnapshot,
            HtmlAST,
            HtmlDeltaConverter
          > = {
            walker,
            walkerContext: context,
            configs: this.configs,
            job: this.job,
            deltaConverter: this.deltaConverter,
            provider: this.provider,
            scopeProvider: this.scopeProvider ?? this.provider,
            textBuffer: { content: "" },
            assets,
          };
          await matcher.fromBlockSnapshot.leave?.(o, adapterContext);
        }
      }
    });
    const ast = (await walker.walk(snapshot, html)) as Root;
    await assertQualifiedNativeExportReadable(
      this.configs,
      (this.scopeProvider ?? this.provider).getOptional(DocEmbedProvider) ??
        undefined,
    );
    return { ast, assetsIds };
  };

  deltaConverter: HtmlDeltaConverter;

  readonly blockMatchers: BlockHtmlAdapterMatcher[];

  constructor(
    job: Transformer,
    provider: ServiceProvider,
    private readonly scopeProvider?: ServiceProvider,
  ) {
    super(job, provider);
    const blockMatchers = Array.from(
      provider.getAll(BlockHtmlAdapterMatcherIdentifier).values(),
    );
    const inlineDeltaToHtmlAdapterMatchers = Array.from(
      provider.getAll(InlineDeltaToHtmlAdapterMatcherIdentifier).values(),
    );
    const htmlInlineToDeltaMatchers = Array.from(
      provider.getAll(HtmlASTToDeltaMatcherIdentifier).values(),
    );
    this.blockMatchers = blockMatchers;
    this.deltaConverter = new HtmlDeltaConverter(
      job.adapterConfigs,
      inlineDeltaToHtmlAdapterMatchers,
      htmlInlineToDeltaMatchers,
      provider,
    );
    this.deltaConverter.importDiagnostics = this._importDiagnostics;
  }

  private _htmlToAst(html: Html) {
    const processor = unified()
      .use(rehypeParse)
      .use(rehypeInlineToBlock)
      .use(rehypeWrapInlineElements);
    const ast = processor.parse(html);
    const normalized = processor.runSync(ast) as Root;
    prepareHtmlFootnotes(normalized, this.configs);
    return normalized;
  }

  override async fromBlockSnapshot(
    payload: FromBlockSnapshotPayload,
  ): Promise<FromBlockSnapshotResult<string>> {
    payload = {
      ...payload,
      snapshot: await projectDocumentFieldOutput(
        payload.snapshot,
        this.scopeProvider,
      ),
    };
    prepareLocalFootnoteReading(
      [payload.snapshot],
      this.configs,
      this.scopeProvider?.getOptional(EditorI18nProvider),
    );
    const root: Root = {
      type: "root",
      children: [
        {
          type: "doctype",
        },
      ],
    };
    const { ast, assetsIds } = await this._traverseSnapshot(
      payload.snapshot,
      root,
      payload.assets,
    );
    linkLocalFootnoteHtml(ast, this.configs);
    return {
      file: this._astToHtml(ast),
      assetsIds,
    };
  }

  override async fromDocSnapshot(
    payload: FromDocSnapshotPayload,
  ): Promise<FromDocSnapshotResult<string>> {
    payload = {
      ...payload,
      snapshot: await projectDocumentFieldOutput(
        payload.snapshot,
        this.scopeProvider,
        payload.snapshot.meta.id,
      ),
    };
    const { file, assetsIds } = await this.fromBlockSnapshot({
      snapshot: payload.snapshot.blocks,
      assets: payload.assets,
    });
    return {
      file: file.replace(
        "<!--VirgultumDocTitlePlaceholder-->",
        `<h1>${payload.snapshot.meta.title}</h1>`,
      ),
      assetsIds,
    };
  }

  override async fromSliceSnapshot(
    payload: FromSliceSnapshotPayload,
  ): Promise<FromSliceSnapshotResult<string>> {
    payload = {
      ...payload,
      snapshot: await projectDocumentFieldOutput(
        payload.snapshot,
        this.scopeProvider,
        payload.snapshot.pageId,
        payload.snapshot.workspaceId,
      ),
    };
    prepareLocalFootnoteReading(
      payload.snapshot.content,
      this.configs,
      this.scopeProvider?.getOptional(EditorI18nProvider),
    );
    const combined: Root = { type: "root", children: [] };
    const sliceAssetsIds: string[] = [];
    for (const contentSlice of payload.snapshot.content) {
      const root: Root = {
        type: "root",
        children: [],
      };
      const { ast, assetsIds } = await this._traverseSnapshot(
        contentSlice,
        root,
        payload.assets,
      );
      sliceAssetsIds.push(...assetsIds);
      await inlineFootnoteHtmlAssets(ast, payload.assets, assetsIds);
      combined.children.push(...ast.children);
    }
    linkLocalFootnoteHtml(combined, this.configs);
    const html = this._astToHtml(combined);
    return {
      file: html,
      assetsIds: sliceAssetsIds,
    };
  }

  override toBlockSnapshot(
    payload: ToBlockSnapshotPayload<string>,
  ): Promise<BlockSnapshot> {
    const htmlAst = this._htmlToAst(payload.file);
    const blockSnapshotRoot = {
      type: "block",
      id: nanoid(),
      flavour: "myoxus:note",
      props: {
        xywh: "[0,0,800,95]",
        background: DefaultTheme.noteBackgrounColor,
        index: "a0",
        hidden: false,
        displayMode: NoteDisplayMode.DocAndEdgeless,
      },
      children: [],
    };
    return this._traverseHtml(
      htmlAst,
      blockSnapshotRoot as BlockSnapshot,
      payload.assets,
    );
  }

  override async toDocSnapshot(
    payload: ToDocSnapshotPayload<string>,
  ): Promise<DocSnapshot> {
    const sanitized = DOMPurify.sanitize(payload.file, {
      FORBID_TAGS: ["svg", "use"],
      USE_PROFILES: { html: true },
    });
    const htmlAst = this._htmlToAst(sanitized);
    const titleAst = HastUtils.querySelector(htmlAst, "title");
    const blockSnapshotRoot = {
      type: "block",
      id: nanoid(),
      flavour: "myoxus:note",
      props: {
        xywh: "[0,0,800,95]",
        background: DefaultTheme.noteBackgrounColor,
        index: "a0",
        hidden: false,
        displayMode: NoteDisplayMode.DocAndEdgeless,
      },
      children: [],
    };
    return {
      type: "page",
      meta: {
        id: nanoid(),
        title: HastUtils.getTextContent(titleAst, "Untitled"),
        createDate: Date.now(),
        tags: [],
      },
      blocks: {
        type: "block",
        id: nanoid(),
        flavour: "myoxus:page",
        props: {
          title: {
            "$virgultum:internal:text$": true,
            delta: this.deltaConverter.astToDelta(
              titleAst ?? {
                type: "text",
                value: "Untitled",
              },
            ),
          },
        },
        children: [
          {
            type: "block",
            id: nanoid(),
            flavour: "myoxus:surface",
            props: {
              elements: {},
            },
            children: [],
          },
          await this._traverseHtml(
            htmlAst,
            blockSnapshotRoot as BlockSnapshot,
            payload.assets,
          ),
        ],
      },
    };
  }

  override async toSliceSnapshot(
    payload: HtmlToSliceSnapshotPayload,
    beforeTraverse?: (ast: Root) => Promise<void>,
  ): Promise<SliceSnapshot | null> {
    const htmlAst = this._htmlToAst(payload.file);
    await beforeTraverse?.(htmlAst);
    const blockSnapshotRoot = {
      type: "block",
      id: nanoid(),
      flavour: "myoxus:note",
      props: {
        xywh: "[0,0,800,95]",
        background: DefaultTheme.noteBackgrounColor,
        index: "a0",
        hidden: false,
        displayMode: NoteDisplayMode.DocAndEdgeless,
      },
      children: [],
    };
    const contentSlice = (await this._traverseHtml(
      htmlAst,
      blockSnapshotRoot as BlockSnapshot,
      payload.assets,
    )) as BlockSnapshot;
    if (contentSlice.children.length === 0) {
      return null;
    }
    return {
      type: "slice",
      content: [contentSlice],
      workspaceId: payload.workspaceId,
      pageId: payload.pageId,
    };
  }
}

export const HtmlAdapterFactoryIdentifier = AdapterFactoryIdentifier("Html");

export const HtmlAdapterFactoryExtension: ExtensionType = {
  setup: (di) => {
    di.addImpl(HtmlAdapterFactoryIdentifier, (provider) => ({
      get: (job, scopeProvider) =>
        new HtmlAdapter(job, provider, scopeProvider),
    }));
  },
};
