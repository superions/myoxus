// SPDX-License-Identifier: AGPL-3.0-or-later

export * from "./model.js";
export * from "./config.js";
export * from "./diagnostics.js";
export {
  parseMermaidC4Source,
  parseMermaidC4SourceWithDiagnostics,
} from "./parser.js";
export {
  generateMermaidC4Source,
  generateMermaidC4SourceWithBindings,
} from "./writer.js";
export {
  mermaidC4ArgumentValue,
  mermaidC4OptionalArgumentValue,
} from "./runtime-contract.js";
export * from "./commands/index.js";

export {
  c4CallPatch,
  c4RecordDeletionPatches,
  insertC4Record,
  insertC4StyleUpdate,
  type C4InsertTarget,
} from "./record-writer.js";

export {
  writeC4Patches,
  writeC4SourcePatches,
  type C4Patch,
} from "./patches.js";

export {
  C4_CONFIG_BOOLEAN_FIELDS,
  C4_CONFIG_GEOMETRY,
  type MermaidC4Config,
  c4RelationshipLabelOffset,
  C4_SHAPE_KEYWORDS,
  C4_RELATIONSHIP_KINDS,
  isC4RelationshipKind,
  type MermaidC4RelationshipKind,
  C4_HEADERS,
  type MermaidC4Header,
  C4_ELEMENT_KINDS,
  C4_BOUNDARY_KINDS,
  isC4BoundaryKind,
  type MermaidC4BoundaryKind,
  isC4ElementKind,
  type MermaidC4ElementKind,
} from "./runtime-contract.js";
