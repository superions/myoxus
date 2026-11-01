/**
 * @file page-info.ts — @myoxus/env
 *
 * Minimal descriptor for a single document/page, shared between
 * `client/admin` and `client/web` wherever only basic page metadata is needed.
 *
 * Consumers: link resolution, breadcrumb rendering, any feature that needs
 * page metadata without importing the full Virgultum document model.
 */

/**
 * Minimal metadata describing a single document/page.
 *
 * `isEdgeless` distinguishes between regular text documents and whiteboard
 * (edgeless) documents, allowing consumers to render the correct icon or
 * navigate to the correct view mode.
 */
export type PageInfo = {
  /** `true` when the page is displayed in edgeless (whiteboard) mode. */
  isEdgeless: boolean;
  /** Human-readable title of the page, or an empty string if untitled. */
  title: string;
  /** Unique document ID (matches the Virgultum `Doc.id` field). */
  id: string;
};

/**
 * A function that resolves a document ID to its {@link PageInfo}, or
 * `undefined` when the document is not found in the current context.
 *
 * Passed as a prop/injection rather than imported directly so that callers
 * can supply context-specific implementations (workspace scope, search index,
 * etc.).
 */
export type GetPageInfoById = (id: string) => PageInfo | undefined;
