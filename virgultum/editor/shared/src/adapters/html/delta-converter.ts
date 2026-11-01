import {
  createIdentifier,
  type ServiceIdentifier,
  type ServiceProvider,
} from "@virgultum/global/di";
import { AnnotationSchema } from "@virgultum/model";
import type { DeltaInsert, ExtensionType } from "@virgultum/store";

import type { MyoxusTextAttributes } from "../../types/index.js";
import {
  type ASTToDeltaMatcher,
  DeltaASTConverter,
  type DeltaASTConverterOptions,
  type InlineDeltaMatcher,
} from "../types/delta-converter.js";
import type { HtmlAST, InlineHtmlAST } from "../types/hast.js";
import { AdapterTextUtils } from "../utils/text.js";
import { recognizeAnnotationDeltas } from "../markdown/annotation-deltas.js";
import { MarkdownASTToDeltaMatcherIdentifier } from "../markdown/delta-converter.js";

export type InlineDeltaToHtmlAdapterMatcher = InlineDeltaMatcher<InlineHtmlAST>;

export const InlineDeltaToHtmlAdapterMatcherIdentifier =
  createIdentifier<InlineDeltaToHtmlAdapterMatcher>(
    "InlineDeltaToHtmlAdapterMatcher",
  );

export function InlineDeltaToHtmlAdapterExtension(
  matcher: InlineDeltaToHtmlAdapterMatcher,
): ExtensionType & {
  identifier: ServiceIdentifier<InlineDeltaToHtmlAdapterMatcher>;
} {
  const identifier = InlineDeltaToHtmlAdapterMatcherIdentifier(matcher.name);
  return {
    setup: (di) => {
      di.addImpl(identifier, () => matcher);
    },
    identifier,
  };
}

export type HtmlASTToDeltaMatcher = ASTToDeltaMatcher<HtmlAST>;

// Transient codec provenance, removed before returning persisted deltas. Keep
// one anchor's formatted label together without merging adjacent distinct links.
const linkSource = Symbol("html-link-source");
type HtmlSourceDelta = DeltaInsert<MyoxusTextAttributes> & {
  [linkSource]?: HtmlAST;
};

export const HtmlASTToDeltaMatcherIdentifier =
  createIdentifier<HtmlASTToDeltaMatcher>("HtmlASTToDeltaMatcher");

export function HtmlASTToDeltaExtension(
  matcher: HtmlASTToDeltaMatcher,
): ExtensionType & {
  identifier: ServiceIdentifier<HtmlASTToDeltaMatcher>;
} {
  const identifier = HtmlASTToDeltaMatcherIdentifier(matcher.name);
  return {
    setup: (di) => {
      di.addImpl(identifier, () => matcher);
    },
    identifier,
  };
}

export class HtmlDeltaConverter extends DeltaASTConverter<
  MyoxusTextAttributes,
  HtmlAST
> {
  constructor(
    readonly configs: Map<string, string>,
    readonly inlineDeltaMatchers: InlineDeltaToHtmlAdapterMatcher[],
    readonly htmlASTToDeltaMatchers: HtmlASTToDeltaMatcher[],
    readonly provider: ServiceProvider,
  ) {
    super();
  }

  private _applyTextFormatting(
    delta: DeltaInsert<MyoxusTextAttributes>,
    initial?: InlineHtmlAST,
    referenceWriter?: (
      delta: DeltaInsert<MyoxusTextAttributes>,
    ) => InlineHtmlAST,
  ): InlineHtmlAST {
    let hast: InlineHtmlAST = initial ?? {
      type: "text",
      value: delta.insert,
    };

    const context: {
      configs: Map<string, string>;
      current: InlineHtmlAST;
    } = {
      configs: this.configs,
      current: hast,
    };
    for (const matcher of this.inlineDeltaMatchers) {
      if (matcher.match(delta)) {
        hast =
          matcher.name === "reference" && referenceWriter
            ? referenceWriter(delta)
            : matcher.toAST(delta, context, this.provider);
        context.current = hast;
      }
    }

    return hast;
  }

  private _spreadAstToDelta(
    ast: HtmlAST,
    options: DeltaASTConverterOptions = Object.create(null),
  ): DeltaInsert<MyoxusTextAttributes>[] {
    const context = {
      configs: this.configs,
      options,
      toDelta: (ast: HtmlAST, options?: DeltaASTConverterOptions) =>
        this._spreadAstToDelta(ast, options),
    };
    for (const matcher of this.htmlASTToDeltaMatchers) {
      if (matcher.match(ast)) {
        const deltas = matcher.toDelta(ast, context);
        if (ast.type === "element" && ast.tagName === "a")
          for (const delta of deltas)
            (delta as HtmlSourceDelta)[linkSource] = ast;
        return deltas;
      }
    }
    return "children" in ast
      ? ast.children.flatMap((child) => this._spreadAstToDelta(child, options))
      : [];
  }

  astToDelta(
    ast: HtmlAST,
    options: DeltaASTConverterOptions = Object.create(null),
  ): DeltaInsert<MyoxusTextAttributes>[] {
    return this.captureImportedDeltas(ast, options, () => {
      const deltas = this._spreadAstToDelta(ast, options);
      const matcher = this.provider.getOptional(
        MarkdownASTToDeltaMatcherIdentifier("link"),
      );
      const eligible = (delta: HtmlSourceDelta) =>
        !options.pre &&
        delta.attributes?.link &&
        !delta.attributes.code &&
        !delta.attributes.latex &&
        !delta.attributes.annotation &&
        !delta.attributes.reference &&
        !delta.attributes.footnote;
      const recognized: HtmlSourceDelta[] = options.pre
        ? deltas
        : recognizeAnnotationDeltas(deltas);
      const output: DeltaInsert<MyoxusTextAttributes>[] = [];
      for (let index = 0; index < recognized.length; index++) {
        const delta = recognized[index];
        const attributes = delta.attributes;
        const source = delta[linkSource];
        const group = [delta];
        if (source && eligible(delta))
          while (
            index + 1 < recognized.length &&
            recognized[index + 1][linkSource] === source &&
            eligible(recognized[index + 1])
          )
            group.push(recognized[++index]);
        for (const item of group) delete item[linkSource];
        if (!matcher || !eligible(delta)) {
          output.push(...group);
          continue;
        }
        output.push(
          ...matcher.toDelta(
            {
              type: "link",
              url: attributes!.link!,
              children: [
                {
                  type: "text",
                  value: group.map((item) => item.insert).join(""),
                },
              ],
            },
            {
              configs: this.configs,
              options,
              toDelta: () => group,
              markdownImportDiagnostics: this.importDiagnostics,
              onDocumentReference: (id) => this.referencedDocumentIds.add(id),
            },
          ),
        );
      }
      return output.reduce(
        (acc, cur) => AdapterTextUtils.mergeDeltas(acc, cur),
        [] as DeltaInsert<MyoxusTextAttributes>[],
      );
    });
  }

  /** Markdown tables may delegate references to their existing portable writer. */
  deltaToAST(
    deltas: DeltaInsert<MyoxusTextAttributes>[],
    depth = 0,
    referenceWriter?: (
      delta: DeltaInsert<MyoxusTextAttributes>,
    ) => InlineHtmlAST,
  ): InlineHtmlAST[] {
    if (depth > 0) {
      deltas.unshift({ insert: " ".repeat(4).repeat(depth) });
    }

    // HTML is a reading projection, including the HTML clipboard fallback.
    // Filter before formatters so a reference/formatting matcher cannot reveal
    // hidden canonical bodies. Native clipboard snapshots remain lossless.
    return deltas
      .filter(
        (delta) =>
          !AnnotationSchema.safeParse(delta.attributes?.annotation).success,
      )
      .flatMap((delta) =>
        // Ordinary rich-text hard breaks need HTML elements. A raw newline is
        // collapsed by HTML import; fenced code has its own pre/code writer.
        delta.insert.split("\n").flatMap((insert, index): InlineHtmlAST[] => [
          ...(index
            ? [
                this._applyTextFormatting(
                  { ...delta, insert: "\n" },
                  {
                    type: "element",
                    tagName: "br",
                    properties: {},
                    children: [],
                  },
                  referenceWriter,
                ),
              ]
            : []),
          this._applyTextFormatting(
            { ...delta, insert },
            undefined,
            referenceWriter,
          ),
        ]),
      );
  }
}
