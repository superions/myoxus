import type { ServiceProvider } from "@virgultum/global/di";
import type { BaseTextAttributes, DeltaInsert } from "@virgultum/store";

import type { MyoxusTextAttributes } from "../../types";
import type { MarkdownImportDiagnostics } from "../markdown/type.js";

export type DeltaASTConverterOptions = {
  trim?: boolean;
  pre?: boolean;
  pageMap?: Map<string, string>;
  removeLastBr?: boolean;
};

export abstract class DeltaASTConverter<
  TextAttributes extends BaseTextAttributes = BaseTextAttributes,
  AST = unknown,
> {
  importDiagnostics?: MarkdownImportDiagnostics;
  readonly referencedDocumentIds = new Set<string>();
  private _conversionDepth = 0;
  private _captureImportRoots = false;
  private _importRoots: Array<{
    ast: AST;
    options: unknown;
    deltas: DeltaInsert<TextAttributes>[];
  }> = [];

  beginImport() {
    this.referencedDocumentIds.clear();
    this._importRoots = [];
    this._captureImportRoots = true;
  }

  /** Rebind retained inline ASTs, never reparse blocks or refetch their assets. */
  resolveImportReferences() {
    const diagnostics = this.importDiagnostics;
    const rebound: MarkdownImportDiagnostics = {
      unresolvedReferences: 0,
      unsupportedReferences: 0,
    };
    this._captureImportRoots = false;
    this.importDiagnostics = rebound;
    try {
      for (const { ast, options, deltas } of this._importRoots) {
        const resolved = this.astToDelta(ast, options);
        deltas.length = 0;
        for (const delta of resolved) deltas.push(delta);
      }
      if (diagnostics) {
        diagnostics.unresolvedReferences = rebound.unresolvedReferences;
        diagnostics.unsupportedReferences = rebound.unsupportedReferences;
      }
    } finally {
      this.importDiagnostics = diagnostics;
    }
  }

  protected captureImportedDeltas(
    ast: AST,
    options: unknown,
    convert: () => DeltaInsert<TextAttributes>[],
  ) {
    const root = this._conversionDepth++ === 0;
    try {
      const deltas = convert();
      if (root && this._captureImportRoots)
        this._importRoots.push({ ast, options, deltas });
      return deltas;
    } finally {
      this._conversionDepth--;
    }
  }

  /**
   * Convert AST format to delta format
   */
  abstract astToDelta(
    ast: AST,
    options?: unknown,
  ): DeltaInsert<TextAttributes>[];

  /**
   * Convert delta format to AST format
   */
  abstract deltaToAST(
    deltas: DeltaInsert<TextAttributes>[],
    options?: unknown,
  ): AST[];
}

export type InlineDeltaMatcher<TNode extends object = never> = {
  name: keyof MyoxusTextAttributes | string;
  match: (delta: DeltaInsert<MyoxusTextAttributes>) => boolean;
  toAST: (
    delta: DeltaInsert<MyoxusTextAttributes>,
    context: {
      configs: Map<string, string>;
      current: TNode;
      markdownExportDiagnostics?: MarkdownImportDiagnostics;
    },
    provider?: ServiceProvider,
  ) => TNode;
};

export type ASTToDeltaMatcher<AST> = {
  name: string;
  match: (ast: AST) => boolean;
  toDelta: (
    ast: AST,
    context: {
      configs: Map<string, string>;
      options: DeltaASTConverterOptions;
      toDelta: (
        ast: AST,
        options?: DeltaASTConverterOptions,
      ) => DeltaInsert<MyoxusTextAttributes>[];
      htmlToDelta?: (html: string) => DeltaInsert<MyoxusTextAttributes>[];
      markdownImportDiagnostics?: MarkdownImportDiagnostics;
      onDocumentReference?: (docId: string) => void;
    },
  ) => DeltaInsert<MyoxusTextAttributes>[];
};
