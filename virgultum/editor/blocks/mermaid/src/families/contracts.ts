import type { MermaidDiagramType } from "../engine/diagram-types.js";
import type {
  MermaidProductDiagramType,
  MermaidProductFamilyId,
} from "../engine/product-types.js";

export type MermaidFamilyDiagnosticSeverity = "error" | "info" | "warning";

export type MermaidFamilyDiagnostic = {
  readonly code: string;
  readonly message: string;
  readonly severity: MermaidFamilyDiagnosticSeverity;
};

export type MermaidFamilyParseResult<TModel> = {
  readonly diagnostics: ReadonlyArray<MermaidFamilyDiagnostic>;
  readonly diagramType: MermaidProductDiagramType;
  readonly model: TModel | null;
  readonly source: string;
};

export type MermaidFamilyVisualState<TVisualModel> =
  | {
      readonly diagnostics: ReadonlyArray<MermaidFamilyDiagnostic>;
      readonly kind: "editable";
      readonly visualModel: TVisualModel;
    }
  | {
      readonly diagnostics: ReadonlyArray<MermaidFamilyDiagnostic>;
      readonly kind: "source-only";
      readonly reason: string;
    }
  | {
      readonly diagnostics: ReadonlyArray<MermaidFamilyDiagnostic>;
      readonly kind: "unsupported";
      readonly reason: string;
    };

export type MermaidFamilyCommandRole =
  "create" | "delete" | "edit" | "reconnect" | "reorder" | "resize";

export type MermaidFamilyCommandDescriptor = {
  readonly id: string;
  readonly label: string;
  readonly role: MermaidFamilyCommandRole;
};

export type MermaidFamilyInspectorField = {
  readonly id: string;
  readonly label: string;
  readonly readonly?: boolean;
  readonly valueKind: "number" | "select" | "text" | "toggle";
};

export type MermaidFamilyToolbarAction = {
  readonly commandId: string;
  readonly id: string;
  readonly label: string;
};

export type MermaidFamilySourceApplyResult = {
  readonly diagnostics: ReadonlyArray<MermaidFamilyDiagnostic>;
  readonly source: string;
};

/**
 * Product-oriented boundary between the Mermaid block host and a diagram
 * family. The host may own block lifecycle, mode switching, readonly/error
 * orchestration and top-level rendering; family modules own syntax semantics,
 * visual materialization, commands, inspector metadata and source writes.
 */
export type MermaidFamilyModule<
  TModel,
  TVisualModel,
  TFrameContext = unknown,
> = {
  readonly commands: ReadonlyArray<MermaidFamilyCommandDescriptor>;
  readonly diagramTypes: ReadonlyArray<MermaidProductDiagramType>;
  readonly id: MermaidProductFamilyId;
  readonly inspector: ReadonlyArray<MermaidFamilyInspectorField>;
  readonly toolbar: ReadonlyArray<MermaidFamilyToolbarAction>;
  readonly applyVisualToSource: (
    visualModel: TVisualModel,
    previousSource: string,
  ) => MermaidFamilySourceApplyResult;
  readonly materializeFrame: (
    visualModel: TVisualModel,
    context: TFrameContext,
  ) => void;
  readonly parseSource: (
    source: string,
    diagramType: MermaidDiagramType,
  ) => MermaidFamilyParseResult<TModel>;
  readonly readFrame: (context: TFrameContext) => TVisualModel | null;
  readonly toVisualModel: (
    parseResult: MermaidFamilyParseResult<TModel>,
  ) => MermaidFamilyVisualState<TVisualModel>;
};
