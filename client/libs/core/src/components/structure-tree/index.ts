/**
 * Structure tree — public re-exports for workspace hierarchy surfaces.
 *
 * The structure tree renders shared hierarchy surfaces for workspace chrome:
 * favourites, collections, folder structure, the current document, and tags.
 * It is composed of independently importable sub-systems:
 *
 * - **`StructureTreeRoot`** — the container that initialises the tree
 *   context and renders all enabled sections.
 * - **`StructureTreeContext`** — React context carrying shared tree
 *   state (selection, drag-and-drop state, etc.).
 * - **Section components** — each renders one collapsible group in the panel:
 *   - `StructureTreeFavorites` — user's starred documents
 *   - `StructureTreeMigrationFavorites` — legacy favourites during migration
 *   - `StructureTreeCollections` — saved filter collections
 *   - `StructureTreeOrganize` — folder-based structure
 *   - `StructureTreeTags` — tag browser
 * - **`CollapsibleSection`** — reusable layout primitive for any section with
 *   a toggle header and animated collapse.
 * - **Types** — `BaseStructureTreeNodeProps`, `StructureTreeNodeIcon`,
 *   `NodeOperation` are exported for consumers that build custom tree nodes.
 */
export { CollapsibleSection } from "./layouts/collapsible-section";
export { StructureTreeCollections } from "./sections/collections";
export { StructureTreeFavorites } from "./sections/favorites";
export { StructureTreeMigrationFavorites } from "./sections/migration-favorites";
export {
  StructureTreeOrganize,
  StructureTreeOrganizeTree,
} from "./sections/organize";
export { StructureTreeTags } from "./sections/tags";
export { StructureTreeRoot } from "./tree";
export { StructureTreeContext } from "./tree/context";
export type {
  BaseStructureTreeNodeProps,
  StructureTreeNodeIcon,
} from "./tree/node";
export type { NodeOperation } from "./tree/types";
