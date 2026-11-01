import type { ServiceProvider } from "@virgultum/global/di";
import {
  DefaultTheme,
  NoteDisplayMode,
  FootNoteSchema,
  footnotePlacement,
} from "@virgultum/model";
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
  getAssetName,
  type SliceSnapshot,
  type Store,
  type ToBlockSnapshotPayload,
  type ToDocSnapshotPayload,
  type Transformer,
} from "@virgultum/store";
import type { Root } from "mdast";
import type { Root as HtmlRoot } from "hast";
import { defaultHandlers } from "mdast-util-to-markdown";
import rehypeParse from "rehype-parse";
import remarkMath from "remark-math";
import remarkParse from "remark-parse";
import remarkStringify from "remark-stringify";
import { unified } from "unified";
import { visit } from "unist-util-visit";
import { encodeClipboardBlobs } from "../clipboard/utils.js";

import {
  HtmlASTToDeltaMatcherIdentifier,
  HtmlDeltaConverter,
  InlineDeltaToHtmlAdapterMatcherIdentifier,
} from "../html/delta-converter.js";
import { type AdapterContext, AdapterFactoryIdentifier } from "../types";
import { DocEmbedProvider } from "../../services/doc-embed-service";
import {
  prepareDocumentReferenceImport,
  assertQualifiedNativeExportReadable,
  needsMarkdownReferenceInventory,
} from "../middlewares/document-reference";
import {
  type BlockMarkdownAdapterMatcher,
  BlockMarkdownAdapterMatcherIdentifier,
} from "./block-adapter";
import {
  InlineDeltaToMarkdownAdapterMatcherIdentifier,
  MarkdownASTToDeltaMatcherIdentifier,
  MarkdownDeltaConverter,
} from "./delta-converter";
import { remarkGfm, remarkGfmAutolinks } from "./gfm";
import { MarkdownPreprocessorManager } from "./preprocessor";
import {
  admittedCalloutChildren,
  remarkCallout,
} from "./remark-plugins/remark-callout";
import {
  remarkWikilink,
  remarkDocumentEmbedWriter,
  remarkBlockAnchors,
} from "./remark-plugins/remark-wikilink";
import { remarkAnnotation } from "./remark-plugins/remark-annotation";
import {
  citationDefinition,
  LOCAL_FOOTNOTE_PREFIX,
  normalizeFootnoteLabel,
  validateFootnoteDefinitions,
} from "./footnotes";
import { prepareLocalFootnoteImport } from "./local-footnote-import";
import { serializeAnnotationBody } from "./annotation-syntax";
import { prepareAnnotationSource } from "./annotation-source";
import {
  emptyMarkdownImportDiagnostics,
  type Markdown,
  type MarkdownAST,
  type MarkdownImportDiagnostics,
} from "./type";

type MarkdownToSliceSnapshotPayload = {
  file: Markdown;
  assets?: AssetsManager;
  workspaceId: string;
  pageId: string;
};

export class MarkdownAdapter extends BaseAdapter<Markdown> {
  private readonly _importDiagnostics = emptyMarkdownImportDiagnostics();
  private _exportDiagnostics = emptyMarkdownImportDiagnostics();
  private _assertImportReferencesCurrent?: () => void;

  /** Fence materialization after asynchronous preparation, including batches. */
  assertImportReferencesCurrent() {
    this._assertImportReferencesCurrent?.();
  }

  override assertPreparedSliceCurrent() {
    this.assertImportReferencesCurrent();
  }

  get exportDiagnostics(): Readonly<MarkdownImportDiagnostics> {
    return { ...this._exportDiagnostics };
  }

  get importDiagnostics(): Readonly<MarkdownImportDiagnostics> {
    return { ...this._importDiagnostics };
  }

  private _clearFootnoteConfigs() {
    for (const key of this.configs.keys())
      if (
        key.startsWith(LOCAL_FOOTNOTE_PREFIX) ||
        key.startsWith("footnoteDefinition:")
      )
        this.configs.delete(key);
  }

  private _resetImportDiagnostics() {
    this.deltaConverter.beginImport();
    this._clearFootnoteConfigs();
    this._importDiagnostics.unresolvedReferences = 0;
    this._importDiagnostics.unsupportedReferences = 0;
    delete this._importDiagnostics.unsupportedAnnotations;
    delete this._importDiagnostics.normalizedAnnotations;
    delete this._importDiagnostics.unsupportedCallouts;
    delete this._importDiagnostics.unsupportedMath;
    delete this._importDiagnostics.unsupportedTables;
    delete this._importDiagnostics.unreferencedFootnotes;
  }

  /** Call before materialization, after supplying the operation's native targets. */
  resolveImportReferences() {
    this.deltaConverter.resolveImportReferences();
  }

  get referencedDocumentIds(): ReadonlySet<string> {
    return this.deltaConverter.referencedDocumentIds;
  }

  private readonly _traverseMarkdown = (
    markdown: MarkdownAST,
    snapshot: BlockSnapshot,
    assets?: AssetsManager,
  ) => {
    const walker = new ASTWalker<MarkdownAST, BlockSnapshot>();
    walker.setONodeTypeGuard(
      (node): node is MarkdownAST =>
        !Array.isArray(node) &&
        "type" in (node as object) &&
        (node as MarkdownAST).type !== undefined,
    );
    walker.setEnter(async (o, context) => {
      for (const matcher of this.blockMatchers) {
        if (matcher.toMatch(o)) {
          const adapterContext: AdapterContext<
            MarkdownAST,
            BlockSnapshot,
            MarkdownDeltaConverter
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
            markdownImportDiagnostics: this._importDiagnostics,
          };
          await matcher.toBlockSnapshot.enter?.(o, adapterContext);
        }
      }
    });
    walker.setLeave(async (o, context) => {
      for (const matcher of this.blockMatchers) {
        if (matcher.toMatch(o)) {
          const adapterContext: AdapterContext<
            MarkdownAST,
            BlockSnapshot,
            MarkdownDeltaConverter
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
            markdownImportDiagnostics: this._importDiagnostics,
          };
          await matcher.toBlockSnapshot.leave?.(o, adapterContext);
        }
      }
    });
    return walker.walk(markdown, snapshot);
  };

  private readonly _traverseSnapshot = async (
    snapshot: BlockSnapshot,
    markdown: MarkdownAST,
    assets?: AssetsManager,
  ) => {
    const definitions = new Map<string, BlockSnapshot>();
    const labels = new Set<string>();
    const markers: { label: string; definitionId: string }[] = [];
    const citations = new Map<string, { label: string; reference: object }>();
    const citedLabels = new Set<string>();
    const inspectCitation = (
      label: string,
      reference: unknown,
      marker: boolean,
    ) => {
      const normalized = normalizeFootnoteLabel(label);
      const parsed = citationDefinition({
        type: "footnoteDefinition",
        identifier: label,
        label,
        children: [
          {
            type: "paragraph",
            children: [{ type: "text", value: JSON.stringify(reference) }],
          },
        ],
      });
      if (!normalized || !parsed)
        throw new Error(`Invalid citation definition: ${label}`);
      const existing = citations.get(normalized);
      if (
        existing &&
        (marker ? citedLabels.has(normalized) : !citedLabels.has(normalized)) &&
        JSON.stringify(existing?.reference) !== JSON.stringify(parsed)
      )
        throw new Error(`Conflicting citation definition: ${label}`);
      // Inline citation metadata owns referenced cards; cards retain otherwise unreferenced definitions.
      if (!existing || marker)
        citations.set(normalized, { label, reference: parsed });
      if (marker) citedLabels.add(normalized);
    };
    const inspect = (
      node: BlockSnapshot,
      insideDefinition = false,
      parent?: BlockSnapshot,
    ) => {
      if (node.flavour === "myoxus:footnote-definition") {
        if (!footnotePlacement(node.props.placement))
          throw new Error("Invalid native footnote placement");
        const label = String(node.props.label ?? "");
        const normalized = normalizeFootnoteLabel(label);
        if (
          !normalized ||
          labels.has(normalized) ||
          insideDefinition ||
          parent?.flavour !== "myoxus:note" ||
          definitions.has(node.id)
        )
          throw new Error(`Conflicting footnote definition: ${label}`);
        labels.add(normalized);
        definitions.set(node.id, node);
        insideDefinition = true;
      }
      const inspectValue = (value: unknown) => {
        if (!value || typeof value !== "object") return;
        if (Array.isArray(value)) {
          for (const child of value) inspectValue(child);
          return;
        }
        const record = value as Record<string, unknown>;
        const rawFootnote = (
          record.attributes as { footnote?: unknown } | undefined
        )?.footnote;
        if (rawFootnote !== undefined && rawFootnote !== null) {
          const parsed = FootNoteSchema.safeParse(rawFootnote);
          if (!parsed.success)
            throw new Error("Invalid native footnote metadata");
          const footnote = parsed.data;
          if (insideDefinition)
            throw new Error(`Nested footnote reference: ${footnote.label}`);
          if (footnote.definitionId !== undefined)
            markers.push({
              label: footnote.label,
              definitionId: footnote.definitionId,
            });
          else inspectCitation(footnote.label, footnote.reference, true);
        }
        for (const child of Object.values(record)) inspectValue(child);
      };
      inspectValue(node.props);
      for (const child of node.children) inspect(child, insideDefinition, node);
    };
    inspect(snapshot);
    for (const marker of markers) {
      const target = definitions.get(marker.definitionId);
      if (
        !target ||
        normalizeFootnoteLabel(String(target.props.label)) !==
          normalizeFootnoteLabel(marker.label)
      )
        throw new Error(`Unresolved footnote definition: ${marker.label}`);
    }
    const preserveCitations = (node: BlockSnapshot) => {
      if (
        node.props.style === "citation" &&
        typeof node.props.footnoteIdentifier === "string"
      ) {
        const label = node.props.footnoteIdentifier;
        if (!citedLabels.has(normalizeFootnoteLabel(label))) {
          const reference =
            node.flavour === "myoxus:bookmark"
              ? {
                  type: "url",
                  url: node.props.url,
                  title: node.props.title,
                  description: node.props.description,
                  favicon: node.props.icon,
                }
              : node.flavour === "myoxus:attachment"
                ? {
                    type: "attachment",
                    blobId: node.props.sourceId,
                    fileName: node.props.name,
                  }
                : node.flavour === "myoxus:embed-linked-doc"
                  ? { type: "doc", docId: node.props.pageId }
                  : undefined;
          if (reference)
            inspectCitation(
              label,
              Object.fromEntries(
                Object.entries(reference).filter(
                  ([, value]) => value !== null && value !== undefined,
                ),
              ),
              false,
            );
        }
      }
      for (const child of node.children) preserveCitations(child);
    };
    preserveCitations(snapshot);
    for (const [normalized, { label, reference }] of citations) {
      if (labels.has(normalized))
        throw new Error(`Conflicting footnote definition: ${label}`);
      const encoded = { ...reference } as Record<string, unknown>;
      for (const key of ["url", "favicon"])
        if (typeof encoded[key] === "string" && encoded[key])
          encoded[key] = encodeURIComponent(encoded[key]);
      this.configs.set(
        "footnoteDefinition:" + normalized,
        JSON.stringify(encoded),
      );
    }
    const referencedIds = new Set(markers.map((marker) => marker.definitionId));
    const normalizedEndnotes = [...definitions.values()].filter(
      (node) => footnotePlacement(node.props.placement) === "endnote",
    ).length;
    if (normalizedEndnotes)
      this._exportDiagnostics.normalizedEndnotes =
        (this._exportDiagnostics.normalizedEndnotes ?? 0) + normalizedEndnotes;
    const unreferencedFootnotes =
      [...definitions.keys()].filter((id) => !referencedIds.has(id)).length +
      [...citations.keys()].filter((label) => !citedLabels.has(label)).length;
    if (unreferencedFootnotes)
      this._exportDiagnostics.unreferencedFootnotes = unreferencedFootnotes;
    const assetsIds: string[] = [];
    const walker = new ASTWalker<BlockSnapshot, MarkdownAST>();
    walker.setONodeTypeGuard(
      (node): node is BlockSnapshot =>
        BlockSnapshotSchema.safeParse(node).success,
    );
    walker.setEnter(async (o, context) => {
      for (const matcher of this.blockMatchers) {
        if (matcher.fromMatch(o)) {
          const adapterContext: AdapterContext<
            BlockSnapshot,
            MarkdownAST,
            MarkdownDeltaConverter
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
            markdownImportDiagnostics: this._exportDiagnostics,
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
            MarkdownAST,
            MarkdownDeltaConverter
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
    // Sources metadata was collected above. Emit each citation only as its
    // definition, and group local bodies after ordinary content without
    // changing the live parent tree or duplicating source cards as links.
    const contentOnly = (node: BlockSnapshot): BlockSnapshot => {
      const children = node.children
        .filter(
          (child) =>
            child.props.style !== "citation" ||
            typeof child.props.footnoteIdentifier !== "string",
        )
        .map(contentOnly);
      if (node.flavour === "myoxus:note")
        children.sort(
          (left, right) =>
            Number(left.flavour === "myoxus:footnote-definition") -
            Number(right.flavour === "myoxus:footnote-definition"),
        );
      return { ...node, children };
    };
    const ast = (await walker.walk(contentOnly(snapshot), markdown)) as Root;
    await assertQualifiedNativeExportReadable(
      this.configs,
      (this.scopeProvider ?? this.provider).getOptional(DocEmbedProvider) ??
        undefined,
    );
    return { ast, assetsIds };
  };

  deltaConverter: MarkdownDeltaConverter;
  preprocessorManager: MarkdownPreprocessorManager;

  readonly blockMatchers: BlockMarkdownAdapterMatcher[];

  constructor(
    job: Transformer,
    provider: ServiceProvider,
    private readonly scopeProvider?: ServiceProvider,
  ) {
    super(job, provider);
    const blockMatchers = Array.from(
      provider.getAll(BlockMarkdownAdapterMatcherIdentifier).values(),
    );
    const inlineDeltaToMarkdownAdapterMatchers = Array.from(
      provider.getAll(InlineDeltaToMarkdownAdapterMatcherIdentifier).values(),
    );
    const markdownInlineToDeltaMatchers = Array.from(
      provider.getAll(MarkdownASTToDeltaMatcherIdentifier).values(),
    );
    const inlineDeltaToHtmlAdapterMatchers = Array.from(
      provider.getAll(InlineDeltaToHtmlAdapterMatcherIdentifier).values(),
    );
    const htmlInlineToDeltaMatchers = Array.from(
      provider.getAll(HtmlASTToDeltaMatcherIdentifier).values(),
    );
    const htmlDeltaConverter = new HtmlDeltaConverter(
      job.adapterConfigs,
      inlineDeltaToHtmlAdapterMatchers,
      htmlInlineToDeltaMatchers,
      provider,
    );
    this.blockMatchers = blockMatchers;
    this.deltaConverter = new MarkdownDeltaConverter(
      job.adapterConfigs,
      inlineDeltaToMarkdownAdapterMatchers,
      markdownInlineToDeltaMatchers,
      htmlDeltaConverter,
      this._importDiagnostics,
    );
    this.preprocessorManager = new MarkdownPreprocessorManager(provider);
  }

  /**
   * Prepare normal editor/AI Markdown against the host's current authorized
   * documents. Batch file imports supply their planned inventory separately.
   * The reference context may differ from an AI scratch store's destination.
   */
  async toSliceSnapshotWithReferences(
    payload: MarkdownToSliceSnapshotPayload,
    referenceStore: Store,
    options?: {
      access?: DocEmbedProvider;
      /** An override must not resolve to blocks that it is about to remove. */
      replaceExistingTargets?: boolean;
      /** Scratch output cannot introduce targets into the source document. */
      includeIncomingTargets?: boolean;
      /** Scratch conversion keeps local identities scoped to its destination. */
      destination?: Store;
    },
  ) {
    this._assertImportReferencesCurrent = undefined;
    const access =
      options?.access ??
      this.scopeProvider?.getOptional(DocEmbedProvider) ??
      undefined;
    const prepared = await prepareDocumentReferenceImport(
      referenceStore,
      this.configs,
      {
        prepare: (loadReferences) =>
          this.toSliceSnapshot(payload, async (ast) => {
            let needsReferences = false;
            const htmlParser = unified().use(rehypeParse, { fragment: true });
            visit(ast, (node) => {
              if (
                node.type === "myoxusDocumentEmbed" ||
                (node.type === "link" &&
                  needsMarkdownReferenceInventory(node.url, this.configs))
              )
                needsReferences = true;
              if (node.type === "html")
                visit(
                  htmlParser.parse(node.value) as HtmlRoot,
                  "element",
                  (element) => {
                    if (
                      element.tagName === "a" &&
                      typeof element.properties.href === "string" &&
                      needsMarkdownReferenceInventory(
                        element.properties.href,
                        this.configs,
                      )
                    )
                      needsReferences = true;
                  },
                );
            });
            if (needsReferences) await loadReferences();
          }),
        referencedDocumentIds: this.referencedDocumentIds,
        resolve: () => this.resolveImportReferences(),
      },
      access,
      options,
    );
    const assertFootnotesCurrent = prepared
      ? prepareLocalFootnoteImport(
          prepared.snapshot,
          options?.destination ?? referenceStore,
          this.job,
        )
      : undefined;
    this._assertImportReferencesCurrent = () => {
      prepared?.assertCurrent();
      assertFootnotesCurrent?.();
    };
    return prepared?.snapshot ?? null;
  }

  override async prepareSliceSnapshot(
    payload: ToBlockSnapshotPayload<Markdown>,
    doc: Store,
  ) {
    // Resolve before the paste middleware can merge text into live Yjs models.
    return this.toSliceSnapshotWithReferences(
      {
        ...payload,
        workspaceId: doc.workspace.id,
        pageId: doc.id,
      },
      doc,
    );
  }

  private _astToMarkdown(ast: Root) {
    // Validate with the same literal grammar, not an assumed escape recipe.
    // Unsupported bodies remain complete inert source text in the file and
    // are explicitly reported; this conversion never changes persisted content.
    const prepare = (node: MarkdownAST): MarkdownAST => {
      if (node.type === "math" || node.type === "inlineMath") {
        const display = node.type === "math";
        const source = display ? `$$\n${node.value}\n$$` : `$${node.value}$`;
        const parsed = unified().use(remarkParse).use(remarkMath).parse(source);
        const first = parsed.children[0];
        const math =
          first?.type === "paragraph" && first.children.length === 1
            ? first.children[0]
            : first;
        if (
          parsed.children.length === 1 &&
          math?.type === node.type &&
          "value" in math &&
          math.value === node.value &&
          (display || !node.value.includes("\n"))
        )
          return node;
        this._exportDiagnostics.unsupportedMath =
          (this._exportDiagnostics.unsupportedMath ?? 0) + 1;
        return display
          ? { type: "code", lang: "latex", value: node.value }
          : { type: "text", value: node.value };
      }
      if (
        node.type === "myoxusAnnotation" ||
        node.type === "myoxusAnnotationBlock"
      ) {
        const source = serializeAnnotationBody(node.value);
        const spans = prepareAnnotationSource(source).bodies;
        if (
          spans.size === 1 &&
          spans.get(0)?.end === source.length &&
          spans.get(0)?.body === node.value
        ) {
          // Obsidian 1.13.7 hides multiline standalone comments, but exposes
          // multiline inline comments. Keep the complete native source and
          // report the dialect loss rather than flattening its current body.
          if (node.type === "myoxusAnnotation" && node.value.includes("\n"))
            this._exportDiagnostics.unsupportedAnnotations =
              (this._exportDiagnostics.unsupportedAnnotations ?? 0) + 1;
          return node;
        }
        this._exportDiagnostics.unsupportedAnnotations =
          (this._exportDiagnostics.unsupportedAnnotations ?? 0) + 1;
        const literal = { type: "text" as const, value: `%%${node.value}%%` };
        return node.type === "myoxusAnnotationBlock"
          ? { type: "paragraph", children: [literal] }
          : literal;
      }
      if ("children" in node) {
        if (
          node.type === "paragraph" &&
          node.children.filter(
            (child) => child.type !== "text" || child.value.trim(),
          ).length === 1 &&
          node.children.some((child) => child.type === "myoxusAnnotation")
        ) {
          const annotation = node.children.find(
            (child) => child.type === "myoxusAnnotation",
          )!;
          if (annotation.type === "myoxusAnnotation") {
            const block = prepare({
              type: "myoxusAnnotationBlock",
              value: annotation.value,
            });
            if (block.type === "myoxusAnnotationBlock")
              this._exportDiagnostics.normalizedAnnotations =
                (this._exportDiagnostics.normalizedAnnotations ?? 0) + 1;
            return block;
          }
        }
        node.children = node.children.map((child) =>
          prepare(child as MarkdownAST),
        ) as typeof node.children;
      }
      return node;
    };
    prepare(ast);
    visit(ast, "footnoteDefinition", (node) => {
      if (!citationDefinition(node)) return;
      const paragraph = node.children[0];
      if (paragraph?.type === "paragraph")
        for (const child of paragraph.children)
          if (child.type === "text")
            child.data = { ...child.data, citationMetadata: true };
    });
    visit(ast, "blockquote", (node) => {
      const first = node.children[0];
      const header =
        first?.type === "paragraph" ? first.children[0] : undefined;
      if (
        header?.type === "myoxusCalloutHeader" &&
        header.value.startsWith("[!") &&
        (!admittedCalloutChildren(node) ||
          /[\r\n]/.test(header.value) ||
          !/^\[!(?:[a-zA-Z][a-zA-Z0-9_-]*|[\p{Extended_Pictographic}]?)\]/u.test(
            header.value,
          ))
      ) {
        this._exportDiagnostics.unsupportedCallouts =
          (this._exportDiagnostics.unsupportedCallouts ?? 0) + 1;
      }
    });
    return unified()
      .use(remarkGfm)
      .use(remarkAnnotation)
      .use(remarkCallout)
      .use(remarkDocumentEmbedWriter)
      .use(remarkStringify, {
        resourceLink: true,
        handlers: {
          text(node, parent, state, info) {
            if (!node.data?.citationMetadata)
              return defaultHandlers.text(node, parent, state, info);
            // Percent-encoded deployed citation URLs are literal metadata,
            // not annotation delimiters. Keep all other Markdown escaping.
            const unsafe = state.unsafe;
            state.unsafe = unsafe.filter(
              (pattern) => pattern.character !== "%",
            );
            try {
              return defaultHandlers.text(node, parent, state, info);
            } finally {
              state.unsafe = unsafe;
            }
          },
        },
      })
      .use(remarkMath)
      .stringify(ast)
      .replace(/&#x20;\n/g, " \n");
  }

  private _markdownToAst(markdown: Markdown) {
    const unsupported =
      prepareAnnotationSource(markdown).unsupportedRanges.length;
    if (unsupported)
      this._importDiagnostics.unsupportedAnnotations = unsupported;
    const processor = unified()
      .use(remarkParse)
      .use(remarkGfm, { deferAutolinks: true, rejectMissingFootnotes: true })
      .use(remarkAnnotation)
      .use(remarkMath)
      .use(remarkWikilink)
      .use(remarkGfmAutolinks)
      .use(remarkCallout)
      .use(remarkBlockAnchors);
    const ast = processor.parse(markdown);
    const result = processor.runSync(ast, { value: markdown });
    const definitions = validateFootnoteDefinitions(result);
    const referenced = new Set<string>();
    visit(result, "footnoteReference", (node) => {
      referenced.add(normalizeFootnoteLabel(node.identifier));
    });
    const unreferencedFootnotes = [...definitions.keys()].filter(
      (key) => !referenced.has(key),
    ).length;
    if (unreferencedFootnotes)
      this._importDiagnostics.unreferencedFootnotes = unreferencedFootnotes;
    visit(result, "paragraph", (node, index, parent) => {
      const math = node.children.length === 1 ? node.children[0] : undefined;
      const start = math?.position?.start.offset;
      const end = math?.position?.end.offset;
      if (
        math?.type !== "inlineMath" ||
        start === undefined ||
        end === undefined ||
        index === undefined ||
        !parent ||
        !markdown.slice(start, end).startsWith("$$")
      )
        return;
      parent.children[index] = {
        type: "math",
        value: math.value,
        position: node.position,
      };
    });
    visit(result, "inlineMath", (node, index, parent) => {
      const start = node.position?.start.offset;
      const end = node.position?.end.offset;
      if (
        start === undefined ||
        end === undefined ||
        index === undefined ||
        !parent
      )
        return;
      const raw = markdown.slice(start, end);
      const currency = /^\d/.test(markdown.slice(end));
      const unsupported =
        raw.startsWith("$$") ||
        node.value.includes("\n") ||
        parent.type === "link";
      if (!currency && !unsupported) return;
      parent.children[index] = {
        type: "text",
        value: raw,
        position: node.position,
      };
      if (unsupported && !currency)
        this._importDiagnostics.unsupportedMath =
          (this._importDiagnostics.unsupportedMath ?? 0) + 1;
    });
    visit(result, "blockquote", (node) => {
      if (node.data?.unsupportedCallout)
        this._importDiagnostics.unsupportedCallouts =
          (this._importDiagnostics.unsupportedCallouts ?? 0) + 1;
    });
    return result;
  }

  async fromBlockSnapshot({
    snapshot,
    assets,
  }: FromBlockSnapshotPayload): Promise<FromBlockSnapshotResult<Markdown>> {
    this._clearFootnoteConfigs();
    this._exportDiagnostics = emptyMarkdownImportDiagnostics();
    this.deltaConverter.exportDiagnostics = this._exportDiagnostics;
    const root: Root = {
      type: "root",
      children: [],
    };
    const { ast, assetsIds } = await this._traverseSnapshot(
      snapshot,
      root,
      assets,
    );
    return {
      file: this._astToMarkdown(ast),
      assetsIds,
    };
  }

  async fromDocSnapshot({
    snapshot,
    assets,
  }: FromDocSnapshotPayload): Promise<FromDocSnapshotResult<Markdown>> {
    let buffer = "";
    const { file, assetsIds } = await this.fromBlockSnapshot({
      snapshot: snapshot.blocks,
      assets,
    });
    buffer += file;
    return {
      file: buffer,
      assetsIds,
    };
  }

  async fromSliceSnapshot({
    snapshot,
    assets,
    inlineFootnoteAssets = false,
  }: FromSliceSnapshotPayload & {
    inlineFootnoteAssets?: boolean;
  }): Promise<FromSliceSnapshotResult<Markdown>> {
    this._clearFootnoteConfigs();
    this._exportDiagnostics = emptyMarkdownImportDiagnostics();
    this.deltaConverter.exportDiagnostics = this._exportDiagnostics;
    let buffer = "";
    const sliceAssetsIds: string[] = [];
    for (const contentSlice of snapshot.content) {
      const root: Root = {
        type: "root",
        children: [],
      };
      const { ast, assetsIds } = await this._traverseSnapshot(
        contentSlice,
        root,
        assets,
      );
      sliceAssetsIds.push(...assetsIds);
      if (inlineFootnoteAssets) {
        // Plain clipboard data has no archive; preserve images through the
        // same bounded byte encoder used by native and HTML clipboard data.
        const available = assets?.getAssets() ?? new Map<string, Blob>();
        const selected = new Map(
          assetsIds.flatMap((id) => {
            const blob = available.get(id);
            return blob ? [[id, blob] as const] : [];
          }),
        );
        const encoded = await encodeClipboardBlobs(selected);
        const byPath = new Map(
          Object.entries(encoded).map(([id, blob]) => [
            `assets/${getAssetName(available, id)}`,
            `data:${blob.type};base64,${blob.content}`,
          ]),
        );
        visit(ast, "footnoteDefinition", (definition) => {
          visit(definition, "image", (image) => {
            const source = byPath.get(image.url);
            if (!source)
              throw new Error(
                `Footnote clipboard image unavailable: ${definition.label ?? definition.identifier}`,
              );
            image.url = source;
          });
        });
      }
      buffer += this._astToMarkdown(ast);
    }
    const markdown =
      buffer.match(/\n/g)?.length === 1 ? buffer.trimEnd() : buffer;
    return {
      file: markdown,
      assetsIds: sliceAssetsIds,
    };
  }

  async toBlockSnapshot(
    payload: ToBlockSnapshotPayload<Markdown>,
  ): Promise<BlockSnapshot> {
    this._resetImportDiagnostics();
    const markdownFile = this.preprocessorManager.process(
      "block",
      payload.file,
    );
    const markdownAst = this._markdownToAst(markdownFile);
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
    return this._traverseMarkdown(
      markdownAst,
      blockSnapshotRoot as BlockSnapshot,
      payload.assets,
    );
  }

  async toDocSnapshot(
    payload: ToDocSnapshotPayload<Markdown>,
  ): Promise<DocSnapshot> {
    this._resetImportDiagnostics();
    const markdownFile = this.preprocessorManager.process("doc", payload.file);
    const markdownAst = this._markdownToAst(markdownFile);
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
        title: "Untitled",
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
            delta: [
              {
                insert: "Untitled",
              },
            ],
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
          await this._traverseMarkdown(
            markdownAst,
            blockSnapshotRoot as BlockSnapshot,
            payload.assets,
          ),
        ],
      },
    };
  }

  async toSliceSnapshot(
    payload: MarkdownToSliceSnapshotPayload,
    beforeTraverse?: (ast: MarkdownAST) => Promise<void>,
  ): Promise<SliceSnapshot | null> {
    this._resetImportDiagnostics();
    const markdownFile = this.preprocessorManager.process(
      "slice",
      payload.file,
    );
    const markdownAst = this._markdownToAst(markdownFile);
    await beforeTraverse?.(markdownAst);
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
    } as BlockSnapshot;
    const contentSlice = (await this._traverseMarkdown(
      markdownAst,
      blockSnapshotRoot,
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

export const MarkdownAdapterFactoryIdentifier =
  AdapterFactoryIdentifier("Markdown");

export const MarkdownAdapterFactoryExtension: ExtensionType = {
  setup: (di) => {
    di.addImpl(MarkdownAdapterFactoryIdentifier, (provider) => ({
      get: (job: Transformer, scopeProvider) =>
        new MarkdownAdapter(job, provider, scopeProvider),
    }));
  },
};
