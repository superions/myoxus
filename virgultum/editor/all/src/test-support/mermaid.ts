// SPDX-License-Identifier: AGPL-3.0-or-later

// Source-only integration fixtures use Assembly's dependency direction. These
// private probes are not new supported package subpaths or production entries.
export { createMindmapCommandConsumer } from "../../../blocks/mermaid/src/families/mindmap/host-adapter.js";
export { MERMAID_GFX_TITLE_ROLE } from "../../../blocks/mermaid/src/families/runtime/gfx-element-roles.js";
export { collectEmbeddedMermaidRootExclusions } from "../../../blocks/mermaid/src/presentation/embedded-child-visibility.js";
export { createMermaidOwnerGfxQuery } from "../../../blocks/mermaid/src/presentation/owner-gfx-query.js";
export { resolveMermaidGfxProjection } from "../../../blocks/mermaid/src/presentation/gfx-projection-owner.js";
export { planLinkedMermaidOwnerMigration } from "../../../blocks/mermaid/src/presentation/migrate-linked-owners.js";
export { MermaidOwnerMigrationExtension } from "../../../blocks/mermaid/src/presentation/mermaid-owner-migration-extension.js";
export { writeMermaidSourceModelState } from "../../../blocks/mermaid/src/mermaid-source-write.js";
export {
  preserveMermaidProjectionOwnerGeometry,
  resolveMermaidProjectionOwnerBoundForVisualModel,
} from "../../../blocks/mermaid/src/commands/materialization.js";

// Await the same family module as the production queued migration, without a
// timer or a mocked planner standing in for the actual consuming lifecycle.
export function settleMermaidMigrationModule() {
  return import("../../../blocks/mermaid/src/presentation/migrate-linked-owners.js");
}
